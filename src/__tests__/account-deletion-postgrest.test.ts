import { readFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeInitialAccountDeletion, markAccountDeletionStage, processAccountDeletionCleanup } from '@/lib/account-deletion-service';
import { deleteAccountRouteResponse } from '@/lib/account-deletion-route-adapter-service';
import { createViewerUnlockFileUrl } from '@/lib/viewer-unlock-file-url-service';
import { deriveAccountIdentityFingerprints } from '@/lib/account-identity-fingerprint';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
const ownerBuckets = ['profiles', 'uploads', 'generated_images', 'generated_videos', 'generated_audio', 'generation_inputs', 'post_resource_files', 'template_inputs'];
let png: Buffer;

describe.skipIf(!configPath || !connectionString)('account deletion with actual Auth, Storage and SQL', () => {
  let db: Client, admin: SupabaseClient;
  let userClient: SupabaseClient;
  let owners: string[], accessToken: string;
  let fail: 'storage' | 'auth' | 'copy' | 'mapping' | 'list' | 'fingerprint' | 'target-auth' | 'revision-list' | 'supplement-read' | 'supplement-write' | 'mapping-read' | null;
  let deletedAuth: string[], fixtureFingerprints: string[];
  let extraObjects: { bucket: string; path: string }[], postIds: string[], templateIds: string[], generationIds: string[];
  let bundle: string | null, post: string | null, order: string | null, purchase: string | null, revision: string | null;
  let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  const objects = async (owner = owners[0]) => (await db.query('select bucket_id,name from storage.objects where name like $1 order by bucket_id,name', [owner + '/%'])).rows;
  const job = async () => (await db.query('select status,last_error,resweep_after,next_attempt_at from public.account_deletion_jobs where user_id=$1', [owners[0]])).rows[0];
  const authExists = async (owner = owners[0]) => (await db.query('select id from auth.users where id=$1', [owner])).rows.length > 0;
  const initial = () => executeInitialAccountDeletion({ admin, userId: owners[0], accessToken });
  const sold = async (options: { legacy?: boolean } = {}) => {
    [bundle, post, order] = [randomUUID(), randomUUID(), randomUUID()];
    expect((await admin.storage.from('post_resource_files').upload(owners[0] + '/audit-fixture.png', new Blob([Uint8Array.from(png)], { type: 'image/png' }), { contentType: 'image/png' })).error).toBeNull();
    let generation: string | null = null;
    if (options.legacy) {
      generation = randomUUID(); generationIds.push(generation);
      await db.query("insert into public.generations(id,user_id,model,status,category) values($1,$2,'audit-inert','succeeded','image')", [generation, owners[0]]);
      const path = owners[0] + '/' + generation + '/reference.png';
      await extraUpload('generation_inputs', path);
      await db.query("insert into public.generation_input_media(generation_id,user_id,media_type,role,label,storage_path,sort_order) values($1,$2,'image','reference_image','Legacy reference',$3,0)", [generation, owners[0], 'generation_inputs/' + path]);
    }
    await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,post_format,review_status,body,generation_id) values($1,$2,'public','image','magicbooklet','text','visible','Local deletion retention fixture',$3)", [post, owners[0], generation]);
    await db.query("insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,price_usd_cents,attachments,allow_remix) values($1,$2,$3,'paid','published','Local retained file',100,$4,$5)", [bundle, post, owners[0], JSON.stringify([{ id: 'fixture-file', kind: 'file', name: 'Reference', storagePath: owners[0] + '/audit-fixture.png', contentType: 'image/png' }]), options.legacy ?? false]);
    await db.query("insert into public.post_resource_bundle_orders(id,bundle_id,buyer_user_id,razorpay_order_id,amount_subunits,currency,status) values($1,$2,$3,$4,100,'INR','paid')", [order, bundle, owners[1], 'audit-local-' + order]);
    const row = (await db.query("insert into public.post_resource_bundle_purchases(bundle_id,buyer_user_id,order_id,price_usd_cents,amount_subunits,currency) values($1,$2,$3,100,100,'INR') returning id,revision_id", [bundle, owners[1], order])).rows[0];
    purchase = row.id; revision = row.revision_id;
    expect(revision).toBeTruthy();
  };
  const retained = async () => (await db.query("select name from storage.objects where bucket_id='post_resource_files' and name like $1", [`retained/${revision}/%`])).rows;
  const buyerFile = async (storagePath = owners[0] + '/audit-fixture.png') => {
    const result = await createViewerUnlockFileUrl({ adminSupabase: admin, body: { storagePath }, countryCode: 'IN', rateLimitKey: 'audit-' + owners[1], unlockId: purchase!, viewerUserId: owners[1] });
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
    png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
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
      if ((fail === 'revision-list' && path === '/rest/v1/rpc/list_creator_purchased_revisions_for_retention') ||
          (fail === 'supplement-read' && path === '/rest/v1/post_resource_bundle_revision_supplements' && init?.method === 'GET') ||
          (fail === 'supplement-write' && path === '/rest/v1/post_resource_bundle_revision_supplements' && init?.method === 'POST') ||
          (fail === 'mapping-read' && path === '/rest/v1/post_resource_bundle_revision_files' && init?.method === 'GET')) {
        return new Response(JSON.stringify({ code: 'XX000', message: 'Injected retention read/write outage' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      if ((fail === 'list' && path.startsWith('/storage/v1/object/list-v2/')) ||
          (fail === 'fingerprint' && path === '/rest/v1/credit_grant_identity_fingerprints' && init?.method === 'POST') ||
          (fail === 'target-auth' && path === '/auth/v1/admin/users/' + owners[0] && init?.method === 'DELETE')) {
        return new Response(JSON.stringify({ statusCode: '503', code: 'XX000', error: 'Injected outage', message: 'Injected ' + fail + ' outage' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      const response = await fetch(input, init);
      if (init?.method === 'DELETE' && path.startsWith('/auth/v1/admin/users/') && response.ok) deletedAuth.push(path.split('/').pop()!);
      return response;
    } } });
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    owners = []; deletedAuth = []; fixtureFingerprints = []; extraObjects = []; postIds = []; templateIds = []; generationIds = []; fail = null; bundle = null; post = null; order = null; purchase = null; revision = null;
    for (let index = 0; index < 2; index++) {
      const email = randomUUID() + '@example.invalid', password = randomUUID() + 'aZ!7';
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull(); owners.push(created.data.user!.id);
      if (index === 0) {
        const client = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        const signedIn = await client.auth.signInWithPassword({ email, password });
        expect(signedIn.error).toBeNull(); accessToken = signedIn.data.session!.access_token; userClient = client;
      }
      for (const bucket of ['profiles', 'uploads']) expect((await admin.storage.from(bucket).upload(owners[index] + '/audit-fixture.png', new Blob([Uint8Array.from(png)], { type: 'image/png' }), { contentType: 'image/png' })).error).toBeNull();
    }
  });
  afterEach(async () => {
    fail = null;
    for (const object of extraObjects) expect((await admin.storage.from(object.bucket).remove([object.path])).error).toBeNull();
    await db.query('delete from public.posts where id=any($1::uuid[])', [postIds]);
    await db.query('delete from public.generations where id=any($1::uuid[])', [generationIds]);
    await db.query('delete from public.templates where id=any($1::uuid[])', [templateIds]);
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
      for (const bucket of ownerBuckets) {
        expect((await admin.storage.from(bucket).remove([owner + '/audit-fixture.png', owner + '/audit-fixture.webp', owner + '/audit-fixture.wav', owner + '/audit-late.png'])).error).toBeNull();
      }
    }
    await db.query('delete from public.credit_grant_identity_fingerprints where program_key=$1 and fingerprint=any($2::text[])', ['welcome_credits_v1', fixtureFingerprints]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
    await db.query('delete from public.account_deletion_jobs where user_id=any($1::uuid[])', [owners]);
    await db.query('delete from public.upload_path_tombstones where owner_user_id=any($1::uuid[])', [owners]);
    await db.query('delete from public.blocked_upload_owners where owner_user_id=any($1::uuid[])', [owners]);
    const rateKeys = owners.flatMap(owner => [owner, 'audit-' + owner]);
    await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [rateKeys]);
    for (const owner of owners) { expect(await objects(owner)).toEqual([]); expect(await authExists(owner)).toBe(false); }
    expect(await job()).toBeUndefined();
    expect((await db.query('select fingerprint from public.credit_grant_identity_fingerprints where fingerprint=any($1::text[])', [fixtureFingerprints])).rows).toEqual([]);
    expect((await db.query('select owner_user_id from public.blocked_upload_owners where owner_user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
    expect((await db.query('select owner_user_id from public.upload_path_tombstones where owner_user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
    expect((await db.query('select subject_key from public.backend_rate_limits where subject_key=any($1::text[])', [rateKeys])).rows).toEqual([]);
    if (revision) {
      expect(await retained()).toEqual([]);
      expect((await db.query('select id from public.post_resource_bundle_revisions where id=$1', [revision])).rows).toEqual([]);
    }
    for (const object of extraObjects) expect((await db.query('select name from storage.objects where bucket_id=$1 and name=$2', [object.bucket, object.path])).rows).toEqual([]);
    expect((await db.query('select id from public.posts where id=any($1::uuid[])', [postIds])).rows).toEqual([]);
    expect((await db.query('select id from public.generations where id=any($1::uuid[])', [generationIds])).rows).toEqual([]);
    expect((await db.query('select id from public.templates where id=any($1::uuid[])', [templateIds])).rows).toEqual([]);
    if (purchase) expect((await db.query('select id from public.post_resource_bundle_purchases where id=$1', [purchase])).rows).toEqual([]);
  });
  const linkGuest = async () => {
    const client = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false } });
    const result = await client.auth.signInAnonymously();
    expect(result.error).toBeNull();
    const guest = result.data.user!.id; owners.push(guest);
    expect(result.data.user!.is_anonymous).toBe(true);
    expect((await admin.storage.from('uploads').upload(guest + '/audit-fixture.png', new Blob([Uint8Array.from(png)], { type: 'image/png' }))).error).toBeNull();
    await db.query('update public.profiles set merged_into_user_id=$1,merged_at=now() where id=$2', [owners[0], guest]);
    expect((await db.query('select identity_state from public.profiles where id=$1', [guest])).rows[0].identity_state).toBe('merged');
    return guest;
  };
  const fingerprints = async (owner = owners[0]) => {
    const result = await admin.auth.admin.getUserById(owner); expect(result.error).toBeNull();
    const values = deriveAccountIdentityFingerprints(result.data.user!);
    fixtureFingerprints.push(...values); return values;
  };
  const claim = async (owner: string, values: string[]) => {
    await db.query('update public.profiles set username=$1,display_name=$2 where id=$3', ['audit-' + owner.replaceAll('-', '').slice(0, 16), 'Audit claimant', owner]);
    const result = await admin.rpc('claim_credit_grant_program', { p_user_id: owner, p_program_key: 'welcome_credits_v1', p_source_surface: 'web', p_identity_fingerprints: values });
    expect(result.error).toBeNull(); return result.data;
  };
  const extraUpload = async (bucket: string, path: string) => {
    extraObjects.push({ bucket, path });
    expect((await admin.storage.from(bucket).upload(path, new Blob([Uint8Array.from(png)], { type: 'image/png' }))).error).toBeNull();
  };
  const extraPresent = async (bucket: string, path: string) => (await db.query('select name from storage.objects where bucket_id=$1 and name=$2', [bucket, path])).rows.length > 0;
  it('removes owned template asset prefixes and anonymizes snapshots without touching another creator', async () => {
    for (const owner of owners) {
      const id = randomUUID(); templateIds.push(id);
      await db.query("insert into public.templates(id,name,creator_user_id,status,is_active) values($1,'Audit deletion template',$2,'draft',true)", [id, owner]);
      await extraUpload('template_assets', id + '/main.png'); await extraUpload('template_assets', id + '/nested/extra.png');
    }
    expect(await initial()).toMatchObject({ cleanupPending: true, storage: { objectsRemoved: 4 } });
    for (const suffix of ['/main.png', '/nested/extra.png']) {
      expect(await extraPresent('template_assets', templateIds[0] + suffix)).toBe(false);
      expect(await extraPresent('template_assets', templateIds[1] + suffix)).toBe(true);
    }
    const rows = (await db.query('select id,creator_user_id from public.templates where id=any($1::uuid[])', [templateIds])).rows;
    expect(rows.find(row => row.id === templateIds[0])).toMatchObject({ creator_user_id: null });
    expect(rows.find(row => row.id === templateIds[1])).toMatchObject({ creator_user_id: owners[1] });
  });
  it('removes owned public and discovered private post media while preserving another post', async () => {
    for (const owner of owners) {
      const id = randomUUID(); postIds.push(id);
      await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,showcase_asset_path) values($1,$2,'private','image','external',$3)", [id, owner, 'posts/' + id + '/main.png']);
      await extraUpload('showcase_media', 'posts/' + id + '/main.png');
      await extraUpload('post_media', 'private-posts/' + id + '/main.png');
      await extraUpload('post_media', 'private-posts/' + id + '/nested/extra.png');
    }
    expect(await initial()).toMatchObject({ cleanupPending: true, storage: { objectsRemoved: 5 } });
    expect(await extraPresent('showcase_media', 'posts/' + postIds[0] + '/main.png')).toBe(false);
    expect(await extraPresent('showcase_media', 'posts/' + postIds[1] + '/main.png')).toBe(true);
    for (const suffix of ['/main.png', '/nested/extra.png']) {
      expect(await extraPresent('post_media', 'private-posts/' + postIds[0] + suffix)).toBe(false);
      expect(await extraPresent('post_media', 'private-posts/' + postIds[1] + suffix)).toBe(true);
    }
    expect((await db.query('select id from public.posts where id=any($1::uuid[])', [postIds])).rows.map(row => row.id)).toEqual([postIds[1]]);
  });
  it('preserves another creator generation namespace referenced by an owned post', async () => {
    const generation = randomUUID(); generationIds.push(generation);
    const path = 'showcase/' + generation + '/main.png';
    await db.query("insert into public.generations(id,user_id,model,status,is_public,showcase_asset_path) values($1,$2,'audit-inert','succeeded',true,$3)", [generation, owners[1], path]);
    await extraUpload('showcase_media', path);
    const id = randomUUID(); postIds.push(id);
    await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,generation_id,showcase_asset_path) values($1,$2,'private','image','external',$3,$4)", [id, owners[0], generation, path]);
    expect(await initial()).toMatchObject({ cleanupPending: true, storage: { objectsRemoved: 2 } });
    expect(await extraPresent('showcase_media', path)).toBe(true);
    expect((await db.query('select user_id from public.generations where id=$1', [generation])).rows[0].user_id).toBe(owners[1]);
    expect(await authExists(owners[1])).toBe(true);
  });
  it('removes owner objects in all eight buckets while preserving another owner', async () => {
    const webp = await sharp(png).webp().toBuffer();
    const wav = Buffer.alloc(46); wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
    for (const owner of owners) for (const bucket of ownerBuckets.slice(2)) {
      const file = bucket === 'generated_videos' ? { data: webp, type: 'image/webp', ext: 'webp' } : bucket === 'generated_audio' ? { data: wav, type: 'audio/wav', ext: 'wav' } : { data: png, type: 'image/png', ext: 'png' };
      expect((await admin.storage.from(bucket).upload(owner + '/audit-fixture.' + file.ext, new Blob([Uint8Array.from(file.data)], { type: file.type }))).error).toBeNull();
    }
    expect(await objects()).toHaveLength(8);
    expect(await initial()).toMatchObject({ storage: { objectsRemoved: 8 } });
    expect(await objects()).toEqual([]); expect(await objects(owners[1])).toHaveLength(8);
    expect(await authExists()).toBe(false); expect(await authExists(owners[1])).toBe(true);
  });
  it('deletes linked guest Auth before its target and preserves the unrelated identity', async () => {
    const guest = await linkGuest();
    expect(await initial()).toMatchObject({ cleanupPending: true, storage: { objectsRemoved: 3 } });
    expect(deletedAuth).toEqual([guest, owners[0]]);
    expect(await authExists(guest)).toBe(false); expect(await objects(guest)).toEqual([]);
    expect(await authExists(owners[1])).toBe(true); expect(await objects(owners[1])).toHaveLength(2);
    const manifest = (await db.query('select storage_manifest from public.account_deletion_jobs where user_id=$1', [owners[0]])).rows[0].storage_manifest;
    expect(manifest.owner_user_ids.sort()).toEqual([owners[0], guest].sort());
  });
  it('recovers target Auth failure after linked guest deletion has committed', async () => {
    const guest = await linkGuest(); fail = 'target-auth';
    await expect(initial()).rejects.toMatchObject({ status: 503 });
    expect(deletedAuth).toEqual([guest]); expect(await authExists(guest)).toBe(false);
    expect(await authExists()).toBe(true); expect(await objects()).toEqual([]);
    await markAccountDeletionStage(admin, owners[0], 'failed', new Error('Injected target Auth outage'));
    fail = null;
    await db.query("update public.account_deletion_jobs set next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
    expect(await cleanup()).toMatchObject({ initial: { claimed: 1, resweepScheduled: 1 } });
    expect(deletedAuth).toEqual([guest, owners[0]]); expect(await authExists()).toBe(false);
    expect(await objects(guest)).toEqual([]); expect(await authExists(owners[1])).toBe(true);
  });
  it('stops before Auth deletion when actual Storage enumeration fails, then retries', async () => {
    fail = 'list'; await expect(initial()).rejects.toThrow('Could not inspect profiles account files.');
    expect(await authExists()).toBe(true); expect(await objects()).toHaveLength(2); expect(deletedAuth).toEqual([]);
    await markAccountDeletionStage(admin, owners[0], 'failed', new Error('Injected list outage')); fail = null;
    await db.query("update public.account_deletion_jobs set next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
    expect(await cleanup()).toMatchObject({ initial: { claimed: 1, resweepScheduled: 1 } });
    expect(await authExists()).toBe(false); expect(await objects()).toEqual([]);
  });
  it('preserves changed-email welcome fingerprints and denies a recycled claim', async () => {
    const old = await fingerprints(); expect(await claim(owners[0], old)).toMatchObject({ status: 'claimed' });
    const changedEmail = randomUUID() + '@example.invalid';
    expect((await admin.auth.admin.updateUserById(owners[0], { email: changedEmail, email_confirm: true })).error).toBeNull();
    const changed = await fingerprints(); expect(changed).not.toEqual(old);
    expect(await initial()).toMatchObject({ cleanupPending: true });
    expect((await db.query('select user_id from public.credit_grants where user_id=$1', [owners[0]])).rows).toEqual([]);
    const rows = (await db.query('select fingerprint,recorded_via from public.credit_grant_identity_fingerprints where fingerprint=any($1::text[])', [fixtureFingerprints])).rows;
    expect(rows.some(row => row.recorded_via === 'deletion' && changed.includes(row.fingerprint))).toBe(true);
    const recycled = await admin.auth.admin.createUser({ email: changedEmail, password: randomUUID() + 'aZ!7', email_confirm: true });
    expect(recycled.error).toBeNull(); owners.push(recycled.data.user!.id);
    const baseline = (await db.query('select credits from public.profiles where id=$1', [recycled.data.user!.id])).rows[0].credits;
    expect(await claim(recycled.data.user!.id, await fingerprints(recycled.data.user!.id))).toMatchObject({ status: 'identity_already_claimed' });
    expect((await db.query('select credits from public.profiles where id=$1', [recycled.data.user!.id])).rows[0].credits).toBe(baseline);
  });
  it('keeps Auth after fingerprint persistence fails and records the ledger on retry', async () => {
    const values = await fingerprints();
    expect(await claim(owners[0], values)).toMatchObject({ status: 'claimed' });
    fail = 'fingerprint'; await expect(initial()).rejects.toMatchObject({ message: 'Injected fingerprint outage' });
    expect(await authExists()).toBe(true); expect(await objects()).toEqual([]); expect(deletedAuth).toEqual([]);
    await markAccountDeletionStage(admin, owners[0], 'failed', new Error('Injected fingerprint outage')); fail = null;
    await db.query("update public.account_deletion_jobs set next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
    expect(await cleanup()).toMatchObject({ initial: { claimed: 1, resweepScheduled: 1 } });
    expect(await authExists()).toBe(false);
    expect((await db.query('select fingerprint from public.credit_grant_identity_fingerprints where fingerprint=any($1::text[])', [values])).rows.map(row => row.fingerprint).sort()).toEqual(values.sort());
  });
  it('removes only the owner files and Auth, then completes a delayed resweep', async () => {
    const signed = await admin.storage.from('uploads').createSignedUploadUrl(owners[0] + '/audit-late.png');
    expect(signed.error).toBeNull();
    expect((await admin.storage.from('uploads').uploadToSignedUrl(owners[0] + '/audit-late.png', signed.data!.token, new Blob([Uint8Array.from(png)], { type: 'image/png' }), { contentType: 'image/png' })).error).toBeNull();
    expect(await initial()).toMatchObject({ cleanupPending: true, storage: { objectsRemoved: 3 } });
    expect(await authExists()).toBe(false); expect(await objects()).toEqual([]);
    expect(await authExists(owners[1])).toBe(true); expect(await objects(owners[1])).toHaveLength(2);
    expect(await job()).toMatchObject({ status: 'resweep_waiting' });
    expect(await cleanup()).toMatchObject({ initial: { claimed: 0 }, resweeps: { claimed: 0 } });
    // Deletion permanently blocks the owner, including already issued capabilities.
    expect((await admin.storage.from('uploads').uploadToSignedUrl(owners[0] + '/audit-late.png', signed.data!.token, new Blob([Uint8Array.from(png)], { type: 'image/png' }), { contentType: 'image/png' })).error).not.toBeNull();
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
  it('retains actual legacy generation inputs in the purchased revision supplement', async () => {
    await sold({ legacy: true });
    const source = 'generation_inputs/' + owners[0] + '/' + generationIds[0] + '/reference.png';
    expect(await initial()).toMatchObject({ cleanupPending: true, storage: { objectsRemoved: 4 } });
    expect(await authExists()).toBe(false); expect(await retained()).toHaveLength(2);
    const supplements = (await db.query('select resource_items from public.post_resource_bundle_revision_supplements where revision_id=$1', [revision])).rows;
    expect(supplements).toHaveLength(1);
    expect(supplements[0].resource_items).toHaveLength(1);
    expect(supplements[0].resource_items[0]).toMatchObject({ type: 'reference_image', storagePath: source });
    await buyerFile(); await buyerFile(source);
    expect((await db.query('select id from public.generation_input_media where generation_id=$1', [generationIds[0]])).rows).toEqual([]);
  });
  it.each(['revision-list', 'supplement-read', 'supplement-write', 'mapping-read'] as const)('halts deletion on %s failure and retains both files on retry', async boundary => {
    await sold({ legacy: true });
    const source = 'generation_inputs/' + owners[0] + '/' + generationIds[0] + '/reference.png';
    fail = boundary; await expect(initial()).rejects.toThrow(/Could not (enumerate|inspect|preserve)/);
    expect(await authExists()).toBe(true); expect(await objects()).toHaveLength(4); expect(await retained()).toEqual([]);
    await markAccountDeletionStage(admin, owners[0], 'failed', new Error('Injected retention boundary outage')); fail = null;
    await db.query("update public.account_deletion_jobs set next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
    expect(await cleanup()).toMatchObject({ initial: { claimed: 1, resweepScheduled: 1 } });
    expect(await authExists()).toBe(false); expect(await retained()).toHaveLength(2);
    await buyerFile(); await buyerFile(source);
    expect((await db.query('select revision_id from public.post_resource_bundle_revision_supplements where revision_id=$1', [revision])).rows).toHaveLength(1);
  }, 30000);
  it('preserves a buyer file when a live old cleanup worker resumes after real lease expiry', async () => {
    await sold(); fail = 'copy';
    await expect(initial()).rejects.toThrow('Could not retain purchased resource');
    await markAccountDeletionStage(admin, owners[0], 'failed', new Error('Injected copy outage')); fail = null;
    await db.query("update public.account_deletion_jobs set next_attempt_at=now()-interval '1 second' where user_id=$1", [owners[0]]);
    const child = fork('src/__tests__/account-deletion-worker.cjs', [], {
      execArgv: ['--import', 'tsx'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tsconfig.mobile-push-worker.json', AUDIT_STORAGE_CONFIG: configPath, AUDIT_OWNER_ID: owners[0], AUDIT_STOP_PHASE: 'copy-committed', AUDIT_ALLOW_RESUME: '1', AUDIT_WORKER_MODE: 'cleanup' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Cleanup child did not reach copy commit')), 8000);
        child.once('message', message => { clearTimeout(timer); if ((message as { stage: string }).stage === 'copy-committed') resolve(); else reject(new Error('Cleanup child failed')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Cleanup child exited early')); });
      });
      expect(await retained()).toHaveLength(1); expect(await authExists()).toBe(true);
      expect(await cleanup()).toMatchObject({ initial: { claimed: 0 } });
      const lease = (await db.query('select extract(epoch from (lease_expires_at-clock_timestamp()))*1000 as remaining from public.account_deletion_jobs where user_id=$1', [owners[0]])).rows[0];
      expect(Number(lease.remaining)).toBeGreaterThan(25000);
      await new Promise(resolve => setTimeout(resolve, Number(lease.remaining) + 100));
      expect((await db.query('select lease_expires_at<clock_timestamp() as expired from public.account_deletion_jobs where user_id=$1', [owners[0]])).rows[0].expired).toBe(true);
      expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
      // A separate, real two-minute route grace still prevents reclaim after the
      // short fixture lease expires; neither durable timestamp is edited.
      expect(await cleanup()).toMatchObject({ initial: { claimed: 0 } });
      const grace = (await db.query("select extract(epoch from (updated_at+interval '2 minutes'-clock_timestamp()))*1000 as remaining from public.account_deletion_jobs where user_id=$1", [owners[0]])).rows[0];
      expect(Number(grace.remaining)).toBeGreaterThan(80000);
      await new Promise(resolve => setTimeout(resolve, Number(grace.remaining) + 100));
      expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
      expect(await cleanup()).toMatchObject({ initial: { claimed: 1, resweepScheduled: 1 } });
      expect(await authExists()).toBe(false); expect(await retained()).toHaveLength(1); await buyerFile();
      const exited = new Promise(resolve => child.once('exit', resolve));
      const finished = new Promise<{ stage: string; authDeletes: number; summary: { initial: { resweepScheduled: number } } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Old worker did not finish')), 8000);
        child.once('message', message => { clearTimeout(timer); resolve(message as never); });
      });
      child.send('resume');
      expect(await finished).toMatchObject({ stage: 'completed', authDeletes: 0, summary: { initial: { resweepScheduled: 1 } } });
      expect(await exited).toBe(0); expect(await retained()).toHaveLength(1); await buyerFile();
      expect(await job()).toMatchObject({ status: 'resweep_waiting' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      }
    }
  }, 145000);
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
