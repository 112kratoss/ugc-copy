// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectAdminOverview } from '@/lib/admin-overview-service';
import { collectAdminRevenueReport } from '@/lib/admin-revenue-service';
import { collectAdminSystemSnapshot } from '@/lib/admin-system-service';
import { collectAdminActivity } from '@/lib/admin-activity-service';
import { collectAdminContentSnapshot } from '@/lib/admin-content-service';
import { getAdminUserDetail, searchAdminUsers } from '@/lib/admin-users-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('admin collectors through real PostgREST and SQL', () => {
  let db: Client;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let owner: string;
  let transactionIds: string[];
  let jobIds: string[];
  let catalogIds: string[];
  let otherUsers: string[];
  let postIds: string[];
  let generationIds: string[];
  let contactIds: string[];
  let walletOwnerIds: string[];
  const now = new Date();
  const snapshot = () => collectAdminOverview(admin, { now });

  const insert = async (options: { mobile?: boolean; sandbox?: boolean; status?: string; old?: boolean } = {}) => {
    const id = randomUUID();
    transactionIds.push(id);
    const createdAt = new Date(now.getTime() - (options.old ? 31 : 1) * 86400_000);
    await db.query('insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,mobile_product_id,is_test,created_at) values($1,$2,$3,100,10,$4,$5,$6,$7)', [
      id, owner, 'audit-collector-' + id, options.status ?? 'success', options.mobile ? 'audit.credit.pack' : null, options.sandbox ?? false, createdAt,
    ]);
    return id;
  };
  const insertBulkOrders = async (count: number) => {
    const inserted = await db.query("insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,is_test,created_at) select gen_random_uuid(),$1,$2||i,100,10,'success',false,$3 from generate_series(1,$4) i returning id", [owner, 'audit-collector-' + randomUUID(), new Date(now.getTime() - 1000), count]);
    transactionIds.push(...inserted.rows.map(row => row.id));
  };
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['127.0.0.1', 'localhost']).toContain(new URL(config.API_URL).hostname);
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    const options = { auth: { persistSession: false, autoRefreshToken: false } };
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options);
    anon = createClient(config.API_URL, config.ANON_KEY, options);
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  beforeEach(async () => {
    transactionIds = [];
    jobIds = [];
    catalogIds = [];
    otherUsers = []; postIds = []; generationIds = []; contactIds = [];
    walletOwnerIds = [];
    const result = await admin.auth.admin.createUser({ email: 'collector-' + randomUUID() + '@audit.invalid', password: randomUUID(), email_confirm: true });
    expect(result.error).toBeNull();
    owner = result.data.user!.id;
  });
  afterEach(async () => {
    await db.query('delete from public.transactions where id=any($1::uuid[])', [transactionIds]);
    await db.query('delete from public.backend_job_runs where id=any($1::uuid[])', [jobIds]);
    await db.query('delete from public.generation_model_catalog_releases where id=any($1::uuid[])', [catalogIds]);
    await db.query('delete from public.contact_messages where id=any($1::uuid[])', [contactIds]);
    await db.query('delete from public.posts where id=any($1::uuid[])', [postIds]);
    await db.query('delete from public.generations where id=any($1::uuid[])', [generationIds]);
    await db.query('delete from public.creator_resource_wallets where user_id=any($1::uuid[])', [walletOwnerIds]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [walletOwnerIds]);
    for (const id of otherUsers) expect((await admin.auth.admin.deleteUser(id)).error).toBeNull();
    expect((await admin.auth.admin.deleteUser(owner)).error).toBeNull();
    expect((await db.query('select id from public.transactions where id=any($1::uuid[])', [transactionIds])).rows).toEqual([]);
    expect((await db.query('select id from auth.users where id=$1', [owner])).rows).toEqual([]);
    expect((await db.query('select id from public.profiles where id=$1', [owner])).rows).toEqual([]);
    expect((await db.query('select id from public.backend_job_runs where id=any($1::uuid[])', [jobIds])).rows).toEqual([]);
    expect((await db.query('select id from public.generation_model_catalog_releases where id=any($1::uuid[])', [catalogIds])).rows).toEqual([]);
    for (const table of ['posts', 'generations', 'contact_messages']) {
      const ids = table === 'posts' ? postIds : table === 'generations' ? generationIds : contactIds;
      expect((await db.query(`select id from public.${table} where id=any($1::uuid[])`, [ids])).rows).toEqual([]);
    }
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [otherUsers])).rows).toEqual([]);
    expect((await db.query('select id from public.profiles where id=any($1::uuid[])', [otherUsers])).rows).toEqual([]);
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [walletOwnerIds])).rows).toEqual([]);
    expect((await db.query('select id from public.profiles where id=any($1::uuid[])', [walletOwnerIds])).rows).toEqual([]);
    expect((await db.query('select user_id from public.creator_resource_wallets where user_id=any($1::uuid[])', [walletOwnerIds])).rows).toEqual([]);
  });
  afterAll(async () => { await db.end(); });

  it('excludes a successful mobile credit mirror from the Razorpay paid-order counter', async () => {
    const before = await snapshot();
    const revenueBefore = await collectAdminRevenueReport(admin, { now });
    const id = await insert({ mobile: true });
    const after = await snapshot();
    expect(after.dashboardError).toBeNull();
    const revenueAfter = await collectAdminRevenueReport(admin, { now });
    expect(revenueAfter.recentOrders.some(row => row.id === id)).toBe(false);
    expect(revenueAfter.rails.find(row => row.key === 'razorpay-credits')!.succeededCount)
      .toBe(revenueBefore.rails.find(row => row.key === 'razorpay-credits')!.succeededCount);
    expect(after.counters.paidOrders30d).toBe(before.counters.paidOrders30d);
  });
  it('counts only the genuine web rail in a mixed recent fixture', async () => {
    const before = await snapshot();
    await insert();
    await insert({ mobile: true });
    await insert({ mobile: true, sandbox: true });
    await insert({ sandbox: true });
    await insert({ status: 'created' });
    await insert({ status: 'failed' });
    await insert({ old: true });
    expect((await snapshot()).counters.paidOrders30d).toBe(before.counters.paidOrders30d + 1);
  });
  it.each([{ sandbox: true }, { status: 'created' }, { status: 'failed' }, { old: true }])('retains the existing exclusion for $sandbox $status $old', async options => {
    const before = await snapshot();
    await insert(options);
    expect((await snapshot()).counters.paidOrders30d).toBe(before.counters.paidOrders30d);
  });
  it('denies the population collector RPC to an anonymous API client', async () => {
    const result = await anon.rpc('admin_user_population_counts', { p_since: now.toISOString() });
    expect(result.error).not.toBeNull();
  });

  it('reports all 1001 web orders within its 2000-row rail budget despite the API row cap', async () => {
    const before = await collectAdminRevenueReport(admin, { now });
    await insertBulkOrders(1001);
    const after = await collectAdminRevenueReport(admin, { now, orderOffset: 1000 });
    const web = (report: typeof before) => report.rails.find(row => row.key === 'razorpay-credits')!;
    expect(web(after).succeededCount).toBe(web(before).succeededCount + 1001);
    expect(after.orderTotal).toBe(before.orderTotal + 1001);
    expect(after.ordersTruncated).toBe(false);
    expect(after.orderOffset).toBe(1000);
    expect(after.recentOrders).toHaveLength(1);
  });

  it.each([1000, 2000, 2001])('reports the rail budget and truncation accurately for %i orders', async count => {
    await insertBulkOrders(count);
    const report = await collectAdminRevenueReport(admin, { now });
    expect(report.rails.find(row => row.key === 'razorpay-credits')!.succeededCount).toBe(Math.min(count, 2000));
    expect(report.orderTotal).toBe(Math.min(count, 2000));
    expect(report.ordersTruncated).toBe(count > 2000);
    expect(new Set(report.recentOrders.map(row => row.id)).size).toBe(report.recentOrders.length);
  });

  it('surfaces a second-page API outage instead of reporting the first page as a complete total', async () => {
    await insertBulkOrders(1001);
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    const failing = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/rest/v1/transactions' && url.searchParams.get('offset') === '1000') {
          return Response.json({ code: 'XX000', message: 'Isolated second-page outage' }, { status: 503 });
        }
        return fetch(input, init);
      } },
    });
    await expect(collectAdminRevenueReport(failing, { now })).rejects.toMatchObject({ message: 'Isolated second-page outage' });
  }, 20000); // The real SDK retries idempotent 503 requests with 1/2/4s backoff.

  it('includes a job failure after the API row cap in the 24-hour summary', async () => {
    const name = 'audit-collector-' + randomUUID();
    const inserted = await db.query("insert into public.backend_job_runs(job_name,route,request_id,lock_owner,status,started_at) select $1,'/audit/local',$1||i,$1,case when i=1001 then 'failed' else 'succeeded' end,$2::timestamptz-(1001-i)*interval '1 second' from generate_series(1,1001) i returning id", [name, new Date(now.getTime() - 1000)]);
    jobIds.push(...inserted.rows.map(row => row.id));
    const system = await collectAdminSystemSnapshot(admin, { now });
    expect(system.jobSummaries.find(row => row.jobName === name)).toMatchObject({
      runCount24h: 1001, failureCount24h: 1, lastStatus: 'failed',
    });
  });

  it('denies the daily job summary RPC to an anonymous API client', async () => {
    expect((await anon.rpc('admin_job_run_summary', { p_since: now.toISOString() })).error).not.toBeNull();
  });

  it('keeps the active catalog visible after eleven newer shadow releases', async () => {
    const before = await collectAdminSystemSnapshot(admin, { now });
    expect(before.catalog.activeRevision).toBeTruthy();
    const inserted = await db.query("insert into public.generation_model_catalog_releases(id,schema_version,revision,status,defaults,created_at) select gen_random_uuid(),r.schema_version,$1||i,'shadow',r.defaults,$2::timestamptz+i*interval '1 millisecond' from public.generation_model_catalog_releases r cross join generate_series(1,11) i where r.revision=$3 returning id", ['audit-collector-' + randomUUID(), now, before.catalog.activeRevision]);
    expect(inserted.rows).toHaveLength(11);
    catalogIds.push(...inserted.rows.map(row => row.id));
    const after = await collectAdminSystemSnapshot(admin, { now });
    expect(after.catalog.releases).toHaveLength(10);
    expect(after.catalog.activeRevision).toBe(before.catalog.activeRevision);
    expect(after.catalog.activeStatus).toBe('active');
    expect(after.catalog.entryCount).toBe(before.catalog.entryCount);
  });

  it('keeps registered accounts and anonymous guests in separate overview counts', async () => {
    const before = await snapshot();
    const registered = await admin.auth.admin.createUser({ email: 'collector-' + randomUUID() + '@audit.invalid', password: randomUUID(), email_confirm: true });
    expect(registered.error).toBeNull(); otherUsers.push(registered.data.user!.id);
    const guest = await anon.auth.signInAnonymously();
    expect(guest.error).toBeNull(); otherUsers.push(guest.data.user!.id);
    const after = await snapshot();
    expect(after.counters.totalUsers).toBe(before.counters.totalUsers + 1);
    expect(after.counters.newUsers7d).toBe(before.counters.newUsers7d + 1);
    expect(after.counters.guestSessions).toBe(before.counters.guestSessions + 1);
    expect(after.counters.newGuestSessions7d).toBe(before.counters.newGuestSessions7d + 1);
    await anon.auth.signOut();
  });

  it('pages equal-timestamp content without duplicates and recovers an out-of-range page', async () => {
    for (const visibility of ['public', 'private', 'public']) {
      const id = randomUUID(); postIds.push(id);
      await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,post_format,review_status,body,created_at) values($1,$2,$3,'image','magicbooklet','text','visible','Local collector fixture',$4)", [id, owner, visibility, now]);
    }
    const first = await collectAdminContentSnapshot(admin, { now, limit: 2 });
    const second = await collectAdminContentSnapshot(admin, { now, limit: 2, postOffset: 2 });
    expect(first.pageTotals.posts).toBe(3);
    expect([...first.posts, ...second.posts].map(row => row.id)).toEqual([...postIds].sort().reverse());
    expect(first.totals.hiddenPosts).toBe(1);
    expect((await collectAdminContentSnapshot(admin, { now, postFilter: 'hidden' })).posts.map(row => row.id)).toEqual([postIds[1]]);
    const recovered = await collectAdminContentSnapshot(admin, { now, limit: 2, postOffset: 999 });
    expect(recovered.pageOffsets.posts).toBe(0);
    expect(recovered.posts.map(row => row.id)).toEqual(first.posts.map(row => row.id));
  });

  it('filters pending/processing generations and excludes older failures from daily counters', async () => {
    for (const status of ['pending', 'processing', 'waiting', 'failed', 'succeeded', 'failed']) {
      const id = randomUUID(); generationIds.push(id);
      await db.query("insert into public.generations(id,user_id,status,model,category,created_at) values($1,$2,$3,'audit-inert','image',$4)", [id, owner, status, generationIds.length === 6 ? new Date(now.getTime() - 2 * 86400_000) : now]);
    }
    const processing = await collectAdminContentSnapshot(admin, { now, generationFilter: 'processing' });
    expect(processing.generations.map(row => row.id).sort()).toEqual(generationIds.slice(0, 2).sort());
    expect(processing.totals.generations24h).toBe(5);
    expect(processing.totals.failedGenerations24h).toBe(1);
    const overview = await snapshot();
    expect(overview.counters.generations24h).toBe(5);
    expect(overview.counters.failedGenerations24h).toBe(1);
  });

  it('scopes a user search/detail and omits the mirrored mobile web ledger entry', async () => {
    const web = await insert();
    const mirror = await insert({ mobile: true });
    const search = await searchAdminUsers(admin, { term: owner });
    expect(search.total).toBe(1);
    expect(search.users.map(row => row.id)).toEqual([owner]);
    const detail = await getAdminUserDetail(admin, owner);
    expect(detail!.profile.id).toBe(owner);
    expect(detail!.email).toContain('@audit.invalid');
    expect(detail!.purchases.map(row => row.id)).toContain(web);
    expect(detail!.purchases.map(row => row.id)).not.toContain(mirror);
    expect(await getAdminUserDetail(admin, randomUUID())).toBeNull();
    await expect(getAdminUserDetail(admin, 'invalid-id')).rejects.toThrow('UUID');
  });

  it('keeps contact queue filters and the activity feed aligned with current triage state', async () => {
    contactIds.push(randomUUID(), randomUUID());
    const handledAt = new Date(now.getTime() - 1000);
    await db.query("insert into public.contact_messages(id,name,email,subject,message,handled_at,handled_by,handled_note) values($1,'Local fixture','fixture@audit.invalid','Open fixture','Open body',null,null,null),($2,'Local fixture','fixture@audit.invalid','Handled fixture','Handled body',$3,$4,'Fixture triage')", [contactIds[0], contactIds[1], handledAt, owner]);
    const open = await collectAdminSystemSnapshot(admin, { now });
    const handled = await collectAdminSystemSnapshot(admin, { now, contactFilter: 'handled' });
    expect(open.contactMessages.map(row => row.id)).toEqual([contactIds[0]]);
    expect(handled.contactMessages.map(row => row.id)).toEqual([contactIds[1]]);
    expect(handled.contactMessages[0].message).toBe('Handled body');
    const activity = await collectAdminActivity(admin);
    expect(activity.entries.find(row => row.id === 'contact-' + contactIds[1])).toMatchObject({ reviewerId: owner, rationale: 'Fixture triage' });
    expect(activity.entries.some(row => row.id === 'contact-' + contactIds[0])).toBe(false);
    await db.query('update public.contact_messages set handled_at=null,handled_by=null,handled_note=null where id=$1', [contactIds[1]]);
    expect((await collectAdminActivity(admin)).entries.some(row => row.id === 'contact-' + contactIds[1])).toBe(false);
  });

  it('does not expose private collector tables to an anonymous API client', async () => {
    for (const table of ['admin_credit_adjustments', 'admin_sessions', 'backend_job_runs', 'contact_messages']) {
      const result = await anon.from(table).select('*').limit(1);
      expect(result.error).not.toBeNull();
      expect(result.data ?? []).toEqual([]);
    }
  });

  it('reports creator wallet totals across the actual API row cap', async () => {
    const before = (await collectAdminRevenueReport(admin, { now })).creatorPayouts;
    // SQL identities serve only valid wallet foreign keys: no Auth sessions,
    // payment settlement, provider requests or real customer balance changes.
    const created = await db.query("insert into auth.users(id,email,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,is_anonymous) select id,id::text||'@audit.invalid',now(),now(),'{\"provider\":\"email\",\"providers\":[\"email\"]}'::jsonb,jsonb_build_object('username','cw'||substring(replace(id::text,'-',''),1,20)),false from (select gen_random_uuid() id from generate_series(1,1001)) t returning id");
    walletOwnerIds.push(...created.rows.map(row => row.id));
    await db.query('insert into public.creator_resource_wallets(user_id,available_token_subunits,lifetime_earned_token_subunits) select id,1,1 from unnest($1::uuid[]) id', [walletOwnerIds]);
    const after = (await collectAdminRevenueReport(admin, { now })).creatorPayouts;
    expect(after).toEqual({
      walletCount: before.walletCount + 1001,
      availableTokenSubunits: before.availableTokenSubunits + 1001,
      lifetimeEarnedTokenSubunits: before.lifetimeEarnedTokenSubunits + 1001,
    });
  }, 20000);

  it('denies the all-wallet aggregate to an anonymous API client', async () => {
    expect((await anon.rpc('admin_creator_wallet_totals')).error).not.toBeNull();
  });

  it('surfaces an unavailable wallet aggregate instead of reporting zero money', async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    const failing = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        if (new URL(String(input)).pathname === '/rest/v1/rpc/admin_creator_wallet_totals') {
          return Response.json({ code: 'XX000', message: 'Isolated wallet aggregate outage' }, { status: 503 });
        }
        return fetch(input, init);
      } },
    });
    await expect(collectAdminRevenueReport(failing, { now })).rejects.toMatchObject({ message: 'Isolated wallet aggregate outage' });
  });

  it.each([
    ['spend aggregate', '/rest/v1/rpc/get_user_ai_usage_cost_total', ''],
    ['web purchases', '/rest/v1/transactions', ''],
    ['mobile purchases', '/rest/v1/mobile_store_transactions', ''],
    ['credit grants', '/rest/v1/credit_grants', ''],
    ['creator wallet', '/rest/v1/creator_resource_wallets', ''],
    ['moderation count', '/rest/v1/moderation_reports', ''],
    ['recent generation count', '/rest/v1/generations', 'created_at'],
    ['recent generation list', '/rest/v1/generations', 'limit'],
    ['follower count', '/rest/v1/follows', 'following_id'],
    ['following count', '/rest/v1/follows', 'follower_id'],
  ])('rejects a user detail when its %s read fails', async (_label, pathname, parameter) => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    const failing = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === pathname && (!parameter || url.searchParams.has(parameter))) {
          return Response.json({ code: '42501', message: 'Isolated user-detail read denied' }, { status: 403 });
        }
        return fetch(input, init);
      } },
    });
    await expect(getAdminUserDetail(failing, owner)).rejects.toMatchObject({ message: 'Isolated user-detail read denied' });
  });

  it('rejects a user detail when its authoritative Auth read fails', async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    const failing = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        if (new URL(String(input)).pathname === '/auth/v1/admin/users/' + owner) {
          return Response.json({ code: 'unexpected_failure', msg: 'Isolated user Auth read failed' }, { status: 403 });
        }
        return fetch(input, init);
      } },
    });
    await expect(getAdminUserDetail(failing, owner)).rejects.toMatchObject({ message: 'Isolated user Auth read failed' });
  });

  it.each([
    { label: 'overview population', pathname: '/rest/v1/rpc/admin_user_population_counts', collect: collectAdminOverview },
    { label: 'revenue rail', pathname: '/rest/v1/mobile_store_transactions', collect: collectAdminRevenueReport },
    { label: 'content totals', pathname: '/rest/v1/posts', collect: collectAdminContentSnapshot },
    { label: 'system catalog entries', pathname: '/rest/v1/generation_model_catalog_entries', collect: collectAdminSystemSnapshot },
    { label: 'activity source', pathname: '/rest/v1/admin_user_sanctions', collect: collectAdminActivity },
    { label: 'user search', pathname: '/rest/v1/profiles', collect: searchAdminUsers },
  ])('surfaces a partial $label failure instead of an empty collector result', async ({ pathname, collect }) => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    const failing = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        if (new URL(String(input)).pathname === pathname) {
          return Response.json({ code: '42501', message: 'Isolated partial collector read denied' }, { status: 403 });
        }
        return fetch(input, init);
      } },
    });
    await expect(collect(failing)).rejects.toMatchObject({ message: 'Isolated partial collector read denied' });
  });
});
