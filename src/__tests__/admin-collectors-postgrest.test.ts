// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectAdminOverview } from '@/lib/admin-overview-service';
import { collectAdminRevenueReport } from '@/lib/admin-revenue-service';
import { collectAdminSystemSnapshot } from '@/lib/admin-system-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('admin collectors through real PostgREST and SQL', () => {
  let db: Client;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let owner: string;
  let transactionIds: string[];
  let jobIds: string[];
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
    const result = await admin.auth.admin.createUser({ email: 'collector-' + randomUUID() + '@audit.invalid', password: randomUUID(), email_confirm: true });
    expect(result.error).toBeNull();
    owner = result.data.user!.id;
  });
  afterEach(async () => {
    await db.query('delete from public.transactions where id=any($1::uuid[])', [transactionIds]);
    await db.query('delete from public.backend_job_runs where id=any($1::uuid[])', [jobIds]);
    expect((await admin.auth.admin.deleteUser(owner)).error).toBeNull();
    expect((await db.query('select id from public.transactions where id=any($1::uuid[])', [transactionIds])).rows).toEqual([]);
    expect((await db.query('select id from auth.users where id=$1', [owner])).rows).toEqual([]);
    expect((await db.query('select id from public.profiles where id=$1', [owner])).rows).toEqual([]);
    expect((await db.query('select id from public.backend_job_runs where id=any($1::uuid[])', [jobIds])).rows).toEqual([]);
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
});
