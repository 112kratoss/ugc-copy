import { readFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeInitialAccountDeletion, markAccountDeletionStage, processAccountDeletionCleanup } from '@/lib/account-deletion-service';
import { deleteAccountRouteResponse } from '@/lib/account-deletion-route-adapter-service';
import { createViewerUnlockFileUrl } from '@/lib/viewer-unlock-file-url-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');

describe.skipIf(!configPath || !connectionString)('account deletion with actual Auth, Storage and SQL', () => {
  let db: Client, admin: SupabaseClient;
  let userClient: SupabaseClient;
  let owners: string[], accessToken: string;
  let fail: 'storage' | 'auth' | 'copy' | 'mapping' | null;
  let bundle: string | null, post: string | null, order: string | null, purchase: string | null, revision: string | null;
  let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  const objects = async (owner = owners[0]) => (await db.query('select bucket_id,name from storage.objects where name like $1 order by bucket_id,name', [owner + '/%'])).rows;
  const job = async () => (await db.query('select status,last_error,resweep_after,next_attempt_at from public.account_deletion_jobs where user_id=$1', [owners[0]])).rows[0];
  const authExists = async (owner = owners[0]) => (await db.query('select id from auth.users where id=$1', [owner])).rows.length > 0;
  const initial = () => executeInitialAccountDeletion({ admin, userId: owners[0], accessToken });
  const sold = async () => {
    [bundle, post, order] = [randomUUID(), randomUUID(), randomUUID()];
    expect((await admin.storage.from('post_resource_files').upload(owners[0] + '/audit-fixture.png', png, { contentType: 'image/png' })).error).toBeNull();
    await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,post_format,review_status,body) values($1,$2,'public','image','magicbooklet','text','visible','Local deletion retention fixture')", [post, owners[0]]);
    await db.query("insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,price_usd_cents,attachments) values($1,$2,$3,'paid','published','Local retained file',100,$4)", [bundle, post, owners[0], JSON.stringify([{ id: 'fixture-file', kind: 'file', name: 'Reference', storagePath: owners[0] + '/audit-fixture.png', contentType: 'image/png' }])]);
    await db.query("insert into public.post_resource_bundle_orders(id,bundle_id,buyer_user_id,razorpay_order_id,amount_subunits,currency,status) values($1,$2,$3,$4,100,'INR','paid')", [order, bundle, owners[1], 'audit-local-' + order]);
    const row = (await db.query("insert into public.post_resource_bundle_purchases(bundle_id,buyer_user_id,order_id,price_usd_cents,amount_subunits,currency) values($1,$2,$3,100,100,'INR') returning id,revision_id", [bundle, owners[1], order])).rows[0];
    purchase = row.id; revision = row.revision_id;
    expect(revision).toBeTruthy();
  };
  const retained = async () => (await db.query("select name from storage.objects where bucket_id='post_resource_files' and name like $1", [`retained/${revision}/%`])).rows;
  const buyerFile = async () => {
    const result = await createViewerUnlockFileUrl({ adminSupabase: admin, body: { storagePath: owners[0] + '/audit-fixture.png' }, countryCode: 'IN', rateLimitKey: 'audit-' + owners[1], unlockId: purchase!, viewerUserId: owners[1] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('Purchased file unavailable');
    expect(['localhost', '127.0.0.1']).toContain(new URL(result.body.signedUrl).hostname);
    const response = await fetch(result.body.signedUrl);
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  };
  const cleanup = () => processAccountDeletionCleanup({ admin, workerId: 'audit-delete-' + owners[0], limit: 1, leaseSeconds: 60 });
  const route = (body: unknown, options: { anonymous?: boolean; now?: Date } = {}) => deleteAccountRouteResponse({
    request: new Request('http://audit.local/api/account/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...(options.anonymous ? {} : { Authorization: 'Bearer ' + accessToken }) }, body: JSON.stringify(body) }),
    dependencies: {
      createServiceClient: () => admin,
      createUserClient: () => options.anonymous ? createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false } }) : userClient,
      invalidateShowcaseFeedCache: () => {}, logError: () => {},
      ...(options.now ? { now: () => options.now! } : {}),
    },
  });
  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    // Claims are global: refuse to interfere with any preexisting local cleanup.
    expect((await db.query("select user_id from public.account_deletion_jobs where status<>'completed'")).rows).toEqual([]);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'DELETE' && ((fail === 'storage' && path.startsWith('/storage/v1/object/')) || (fail === 'auth' && path.startsWith('/auth/v1/admin/users/')))) {
        return new Response(JSON.stringify({ statusCode: '503', error: 'Injected outage', message: 'Injected ' + fail + ' deletion outage' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      if ((fail === 'copy' && path === '/storage/v1/object/copy') || (fail === 'mapping' && path === '/rest/v1/post_resource_bundle_revision_files' && init?.method === 'POST')) {
        return new Response(JSON.stringify({ statusCode: '503', code: 'XX000', error: 'Injected outage', message: 'Injected retention ' + fail + ' outage' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(input, init);
    } } });
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    owners = []; fail = null; bundle = null; post = null; order = null; purchase = null; revision = null;
    for (let index = 0; index < 2; index++) {
      const email = randomUUID() + '@example.invalid', password = randomUUID() + 'aZ!7';
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull(); owners.push(created.data.user!.id);
      if (index === 0) {
        const client = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        const signedIn = await client.auth.signInWithPassword({ email, password });
        expect(signedIn.error).toBeNull(); accessToken = signedIn.data.session!.access_token; userClient = client;
      }
      for (const bucket of ['profiles', 'uploads']) expect((await admin.storage.from(bucket).upload(owners[index] + '/audit-fixture.png', png, { contentType: 'image/png' })).error).toBeNull();
    }
  });
  afterEach(async () => {
    fail = null;
    if (revision) {
      const paths = (await retained()).map(row => row.name);
      if (paths.length) expect((await admin.storage.from('post_resource_files').remove(paths)).error).toBeNull();
    }
    if (purchase) await db.query('delete from public.post_resource_bundle_purchases where id=$1', [purchase]);
    if (order) await db.query('delete from public.post_resource_bundle_orders where id=$1', [order]);
    if (bundle) await db.query('delete from public.post_resource_bundles where id=$1', [bundle]);
    if (revision) await db.query('delete from public.post_resource_bundle_revisions where id=$1', [revision]);
    if (post) await db.query('delete from public.posts where id=$1', [post]);
    for (const owner of owners) {
      for (const bucket of ['profiles', 'uploads', 'post_resource_files']) {
        expect((await admin.storage.from(bucket).remove([owner + '/audit-fixture.png', owner + '/audit-late.png'])).error).toBeNull();
      }
    }
    await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
    await db.query('delete from public.account_deletion_jobs where user_id=any($1::uuid[])', [owners]);
    await db.query('delete from public.upload_path_tombstones where owner_user_id=any($1::uuid[])', [owners]);
    await db.query('delete from public.blocked_upload_owners where owner_user_id=any($1::uuid[])', [owners]);
    const rateKeys = owners.flatMap(owner => [owner, 'audit-' + owner]);
    await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [rateKeys]);
    for (const owner of owners) { expect(await objects(owner)).toEqual([]); expect(await authExists(owner)).toBe(false); }
    expect(await job()).toBeUndefined();
    expect((await db.query('select owner_user_id from public.blocked_upload_owners where owner_user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
    expect((await db.query('select owner_user_id from public.upload_path_tombstones where owner_user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
    expect((await db.query('select subject_key from public.backend_rate_limits where subject_key=any($1::text[])', [rateKeys])).rows).toEqual([]);
    if (revision) {
      expect(await retained()).toEqual([]);
      expect((await db.query('select id from public.post_resource_bundle_revisions where id=$1', [revision])).rows).toEqual([]);
    }
    if (purchase) expect((await db.query('select id from public.post_resource_bundle_purchases where id=$1', [purchase])).rows).toEqual([]);
  });
  it('removes only the owner files and Auth, then completes a delayed resweep', async () => {
    const signed = await admin.storage.from('uploads').createSignedUploadUrl(owners[0] + '/audit-late.png');
    expect(signed.error).toBeNull();
    expect((await admin.storage.from('uploads').uploadToSignedUrl(owners[0] + '/audit-late.png', signed.data!.token, png, { contentType: 'image/png' })).error).toBeNull();
    expect(await initial()).toMatchObject({ cleanupPending: true, storage: { objectsRemoved: 3 } });
    expect(await authExists()).toBe(false); expect(await objects()).toEqual([]);
    expect(await authExists(owners[1])).toBe(true); expect(await objects(owners[1])).toHaveLength(2);
    expect(await job()).toMatchObject({ status: 'resweep_waiting' });
    expect(await cleanup()).toMatchObject({ initial: { claimed: 0 }, resweeps: { claimed: 0 } });
    // Deletion permanently blocks the owner, including already issued capabilities.
    expect((await admin.storage.from('uploads').uploadToSignedUrl(owners[0] + '/audit-late.png', signed.data!.token, png, { contentType: 'image/png' })).error).not.toBeNull();
    expect(await objects()).toEqual([]);
    // Advance only this fixture's durable schedule; this does not test token expiry.
    await db.query("update public.account_deletion_jobs set resweep_after=now()-interval '1 second',next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
    expect(await cleanup()).toMatchObject({ resweeps: { claimed: 1, completed: 1, objectsRemoved: 0 } });
    expect(await job()).toMatchObject({ status: 'completed' }); expect(await objects()).toEqual([]);
    expect(await initial()).toMatchObject({ alreadyCompleted: true, cleanupPending: false });
  });
  it('keeps Auth intact after Storage deletion fails and recovers the persisted failure', async () => {
    fail = 'storage';
    await expect(initial()).rejects.toThrow('Could not remove profiles account files.');
    await markAccountDeletionStage(admin, owners[0], 'failed', new Error('Injected Storage outage'));
    expect(await authExists()).toBe(true); expect(await objects()).toHaveLength(2);
    expect(await job()).toMatchObject({ status: 'failed' });
    fail = null;
    await db.query("update public.account_deletion_jobs set next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
    expect(await cleanup()).toMatchObject({ initial: { claimed: 1, resweepScheduled: 1 } });
    expect(await authExists()).toBe(false); expect(await objects()).toEqual([]);
    expect(await job()).toMatchObject({ status: 'resweep_waiting' });
    expect(await authExists(owners[1])).toBe(true); expect(await objects(owners[1])).toHaveLength(2);
  });
  it('retries Auth deletion after Storage has already been removed', async () => {
    fail = 'auth';
    await expect(initial()).rejects.toMatchObject({ status: 503 });
    await markAccountDeletionStage(admin, owners[0], 'failed', new Error('Injected Auth outage'));
    expect(await authExists()).toBe(true); expect(await objects()).toEqual([]);
    fail = null;
    await db.query("update public.account_deletion_jobs set next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
    expect(await cleanup()).toMatchObject({ initial: { claimed: 1, resweepScheduled: 1 } });
    expect(await authExists()).toBe(false); expect(await job()).toMatchObject({ status: 'resweep_waiting' });
  });
  it('rejects anonymous deletion before changing either identity', async () => {
    expect((await route({ confirmation: 'DELETE' }, { anonymous: true })).status).toBe(401);
    expect(await authExists()).toBe(true); expect(await objects()).toHaveLength(2);
    expect(await job()).toBeUndefined();
  });
  it('requires exact deletion confirmation for a real signed-in identity', async () => {
    expect((await route({ confirmation: 'delete' })).status).toBe(400);
    expect(await authExists()).toBe(true); expect(await objects()).toHaveLength(2);
    expect(await job()).toBeUndefined();
  });
  it('requires recent authentication before creating destructive work', async () => {
    const response = await route({ confirmation: 'DELETE' }, { now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reauthenticate: true });
    expect(await authExists()).toBe(true); expect(await objects()).toHaveLength(2);
    expect(await job()).toBeUndefined();
  });
  it('deletes the verified caller and ignores a forged target identity in the body', async () => {
    const response = await route({ confirmation: 'DELETE', userId: owners[1] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, deleted: true, cleanupPending: true });
    expect(await authExists()).toBe(false); expect(await objects()).toEqual([]);
    expect(await authExists(owners[1])).toBe(true); expect(await objects(owners[1])).toHaveLength(2);
    expect(await job()).toMatchObject({ status: 'resweep_waiting' });
  });
  it('preserves a purchased file in neutral Storage after the creator is deleted', async () => {
    await sold();
    expect(await initial()).toMatchObject({ cleanupPending: true });
    expect(await authExists()).toBe(false); expect(await objects()).toEqual([]);
    expect(await retained()).toHaveLength(1);
    await buyerFile();
    expect((await db.query('select buyer_user_id,revision_id from public.post_resource_bundle_purchases where id=$1', [purchase])).rows[0]).toMatchObject({ buyer_user_id: owners[1], revision_id: revision });
  });
  it.each(['copy', 'mapping'] as const)('halts deletion after retained-file %s failure and recovers the buyer file', async failure => {
    await sold(); fail = failure;
    await expect(initial()).rejects.toThrow(failure === 'copy' ? 'Could not retain purchased resource' : 'Could not record retained resource mapping.');
    await markAccountDeletionStage(admin, owners[0], 'failed', new Error('Injected retention failure'));
    expect(await authExists()).toBe(true); expect(await objects()).toHaveLength(3);
    expect(await retained()).toHaveLength(failure === 'mapping' ? 1 : 0);
    fail = null;
    await db.query("update public.account_deletion_jobs set next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
    expect(await cleanup()).toMatchObject({ initial: { claimed: 1, resweepScheduled: 1 } });
    expect(await authExists()).toBe(false); expect(await objects()).toEqual([]);
    expect(await retained()).toHaveLength(1); await buyerFile();
  });
  it.each(['copy-committed', 'auth-deleted'])('recovers a real worker killed after %s', async checkpoint => {
    await sold();
    const child = fork('src/__tests__/account-deletion-worker.cjs', [], {
      execArgv: ['--import', 'tsx'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tsconfig.mobile-push-worker.json', AUDIT_STORAGE_CONFIG: configPath, AUDIT_OWNER_ID: owners[0], AUDIT_STOP_PHASE: checkpoint },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child never reached deletion checkpoint')), 8000);
        child.once('message', message => { clearTimeout(timer); if ((message as { stage: string }).stage === checkpoint) resolve(); else reject(new Error('Worker failed')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited early')); });
      });
      const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
      child.kill('SIGKILL'); expect(await exited).toBe('SIGKILL');
      expect(await retained()).toHaveLength(1);
      if (checkpoint === 'copy-committed') {
        expect(await authExists()).toBe(true); expect(await objects()).toHaveLength(3);
        expect(await job()).toMatchObject({ status: 'storage_deleting' });
        expect((await db.query('select revision_id from public.post_resource_bundle_revision_files where revision_id=$1', [revision])).rows).toEqual([]);
        // The process is confirmed dead. Make only this fixture's stale work due.
        await db.query("update public.account_deletion_jobs set updated_at=now()-interval '3 minutes',next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
        expect(await cleanup()).toMatchObject({ initial: { claimed: 1, resweepScheduled: 1 } });
      } else {
        expect(await authExists()).toBe(false); expect(await objects()).toEqual([]);
        expect(await job()).toMatchObject({ status: 'resweep_waiting' });
        await db.query("update public.account_deletion_jobs set resweep_after=now()-interval '1 second',next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
        expect(await cleanup()).toMatchObject({ resweeps: { claimed: 1, completed: 1 } });
      }
      expect(await authExists()).toBe(false); expect(await objects()).toEqual([]);
      expect(await retained()).toHaveLength(1); await buyerFile();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      }
    }
  }, 15000);
});
