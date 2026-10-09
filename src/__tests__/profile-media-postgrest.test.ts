import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { createProfileMediaUploadIntent } from '@/lib/profile-media-upload-sign';
import { cleanupProfileMedia } from '@/lib/profile-media-cleanup-service';
import { finalizeUploadById } from '@/lib/upload-finalization';
import { updateProfileForRoute } from '@/lib/profile-route-service';
import sharp from 'sharp';

const enabled = process.env.AUDIT_STORAGE_CONFIG && process.env.SUPABASE_TEST_DB_URL;
const modes = ['avatar', 'cover', 'resave', 'metadata', 'ownership', 'remove-error', 'lost-ack', 'duplicate'] as const;

it.skipIf(!enabled).each(modes)('profile media with actual Storage and SQL: %s', async (mode) => {
  const config = JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!, 'utf8'));
  const connectionString = process.env.SUPABASE_TEST_DB_URL!;
  expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
  expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString).hostname);
  const db = new Client({ connectionString, statement_timeout: 10000 });
  await db.connect();
  let armed = false;
  let injected = false;
  let removals = 0;
  const localFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(config.API_URL).origin) throw Error('External calls forbidden');
    if (init?.method === 'DELETE' && url.pathname === '/storage/v1/object/profiles') {
      removals++;
      if (armed && !injected) {
        injected = true;
        if (mode === 'lost-ack') expect((await fetch(input, init)).ok).toBe(true);
        return new Response(JSON.stringify({ message: 'Injected Storage failure', statusCode: 503 }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return fetch(input, init);
  };
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: localFetch } };
  const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options);
  const anon = createClient(config.API_URL, config.ANON_KEY, options);
  const owner = randomUUID(), other = randomUUID();
  const paths = [owner + '/cleanup.png', other + '/preserved.png'];
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl8sAAAAASUVORK5CYII=', 'base64'));
  const file = () => new Blob([png], { type: 'image/png' });
  const metadata = { role: 'avatar', fileName: 'fixture.png', mimeType: 'image/png', sizeBytes: png.byteLength };
  const cleanup = (value: unknown = { paths: [paths[0]] }) => cleanupProfileMedia({ userId: owner, body: value, client: admin });
  try {
    for (const user of [owner, other]) {
      await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [user, user + '@profile-media.invalid']);
    }
    for (const path of paths) expect((await admin.storage.from('profiles').upload(path, file())).error).toBeNull();
    if (mode === 'resave') {
      const pixels = Buffer.alloc(1024 * 1024 * 3);
      let state = 0x9e3779b9;
      for (let index = 0; index < pixels.length; index++) {
        state ^= state << 13; state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5; state >>>= 0;
        pixels[index] = state & 0xff;
      }
      const largePng = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
      const result = await createProfileMediaUploadIntent({ body: { ...metadata, sizeBytes: largePng.byteLength }, userId: owner, client: admin });
      expect(result.ok).toBe(true);
      if (!result.ok) throw Error('Signing failed');
      const intent = result.body;
      paths.push(intent.path);
      expect((await anon.storage.from('profiles').uploadToSignedUrl(intent.path, intent.token, new Blob([Uint8Array.from(largePng)], { type: 'image/png' }))).error).toBeNull();
      expect((await finalizeUploadById(admin, { uploadId: intent.uploadId, userId: owner })).ok).toBe(true);
      // Only the URL spelling uses HTTPS; all actual reads/writes use the
      // injected local Storage client, whose fetch rejects external origins.
      const avatarUrl = 'https://profile-fixture.invalid/storage/v1/object/public/profiles/' + intent.path;
      const body = { username: 'audit-' + owner.slice(0, 12), displayName: 'Profile fixture', avatarUrl };
      expect(await updateProfileForRoute({ userId: owner, body, client: admin, invalidateFeedCache: () => {} })).toMatchObject({ ok: true });
      const stored = await admin.storage.from('profiles').download(intent.path);
      expect(stored.error).toBeNull();
      // The existing Storage write guard rejects an in-place rewrite after
      // finalization. Normalization is best-effort; the exact image survives.
      expect(Buffer.from(await stored.data!.arrayBuffer()).equals(largePng)).toBe(true);
      expect((await db.query('select r.finalization_status,r.consumption_disposition,r.actual_storage_version=o.version::text version_matches from public.upload_byte_reservations r join storage.objects o on o.bucket_id=r.bucket_id and o.name=r.storage_path where r.id=$1', [intent.uploadId])).rows)
        .toEqual([{ finalization_status: 'consumed', consumption_disposition: 'preserve', version_matches: true }]);
      expect(await updateProfileForRoute({ userId: owner, body: { ...body, displayName: 'Edited fixture' }, client: admin, invalidateFeedCache: () => {} })).toMatchObject({ ok: true });
      expect((await admin.storage.from('profiles').download(intent.path)).error).toBeNull();
      expect((await db.query('select avatar_url,display_name from public.profiles where id=$1', [owner])).rows).toEqual([{ avatar_url: avatarUrl, display_name: 'Edited fixture' }]);
    } else if (mode === 'avatar' || mode === 'cover') {
      const result = await createProfileMediaUploadIntent({ body: { ...metadata, role: mode, userId: other, path: paths[1] }, userId: owner, client: admin });
      expect(result.ok).toBe(true);
      if (!result.ok) throw Error('Signing failed');
      const intent = result.body;
      paths.push(intent.path);
      expect(intent.path.startsWith(owner + '/' + mode + '-')).toBe(true);
      expect(intent.bucket).toBe('profiles');
      expect((await db.query('select user_id,bucket_id,storage_path,finalization_status,issued_at is not null issued,released_at is null charged from public.upload_byte_reservations where id=$1', [intent.uploadId])).rows)
        .toEqual([{ user_id: owner, bucket_id: 'profiles', storage_path: intent.path, finalization_status: 'issued', issued: true, charged: true }]);
      const rebound = await anon.storage.from('profiles').uploadToSignedUrl(intent.path.replace(owner, other), intent.token, file());
      expect(rebound.error).not.toBeNull();
      expect((await anon.storage.from('profiles').uploadToSignedUrl(intent.path, intent.token, file())).error).toBeNull();
      expect((await anon.storage.from('profiles').uploadToSignedUrl(intent.path, intent.token, file())).error).not.toBeNull();
      const downloaded = await admin.storage.from('profiles').download(intent.path);
      expect(downloaded.error).toBeNull();
      expect(new Uint8Array(await downloaded.data!.arrayBuffer())).toEqual(png);
      expect(await finalizeUploadById(admin, { uploadId: intent.uploadId, userId: other }))
        .toMatchObject({ ok: false, status: 404, code: 'UPLOAD_NOT_FOUND' });
      const finalized = await finalizeUploadById(admin, { uploadId: intent.uploadId, userId: owner });
      expect(finalized).toMatchObject({ ok: true, descriptor: { bucket: 'profiles', path: intent.path, sizeBytes: png.byteLength } });
      expect(await finalizeUploadById(admin, { uploadId: intent.uploadId, userId: owner })).toEqual(finalized);
      expect(await cleanup({ paths: [intent.path] })).toEqual({ ok: true, body: { success: true } });
      // Deleting an object cannot release a still-live signed upload's capacity.
      expect((await db.query('select released_at is null charged from public.upload_byte_reservations where id=$1', [intent.uploadId])).rows).toEqual([{ charged: true }]);
      // Explicit finalization closes Storage admission, so even the original
      // live capability cannot recreate this finalized object after deletion.
      expect((await anon.storage.from('profiles').uploadToSignedUrl(intent.path, intent.token, file())).error).not.toBeNull();
      expect(await cleanup({ paths: [intent.path] })).toEqual({ ok: true, body: { success: true } });
    } else if (mode === 'metadata') {
      for (const body of [null, [], { ...metadata, role: 'other' }, { ...metadata, mimeType: 'image/svg+xml' }, { ...metadata, fileName: 'bad.svg' }, { ...metadata, sizeBytes: 5 * 1024 * 1024 + 1 }]) {
        expect(await createProfileMediaUploadIntent({ body, userId: owner, client: admin })).toMatchObject({ ok: false, status: 400 });
      }
      expect((await db.query('select id from public.upload_byte_reservations where user_id=$1', [owner])).rows).toEqual([]);
    } else if (mode === 'ownership') {
      for (const body of [null, { paths: [] }, { paths: [paths[0], paths[1]] }, { paths: [owner + '/../' + paths[1]] }, { paths: [owner + '%2fcleanup.png'] }, { paths: [owner + '/%252e%252e/' + paths[1]] }, { paths: [paths[0], 1] }, { paths: Array(5).fill(paths[0]) }]) {
        expect(await cleanup(body)).toMatchObject({ ok: false, status: 400 });
      }
      expect(removals).toBe(0);
      expect((await admin.storage.from('profiles').download(paths[0])).error).toBeNull();
    } else {
      armed = mode !== 'duplicate';
      const first = await cleanup();
      if (armed) {
        expect(injected).toBe(true);
        expect(first).toMatchObject({ ok: false, status: 500 });
        expect((await admin.storage.from('profiles').download(paths[0])).error === null).toBe(mode === 'remove-error');
      } else expect(first.ok).toBe(true);
      armed = false;
      expect(await cleanup()).toEqual({ ok: true, body: { success: true } });
      expect(await cleanup()).toEqual({ ok: true, body: { success: true } });
      expect((await admin.storage.from('profiles').download(paths[0])).error).not.toBeNull();
    }
    expect((await admin.storage.from('profiles').download(paths[1])).error).toBeNull();
  } finally {
    armed = false;
    expect((await admin.storage.from('profiles').remove(paths)).error).toBeNull();
    // Isolated fixture teardown: retain the accounting DELETE trigger, and
    // bypass only the reservation retention guard for these exact owners.
    await db.query('begin');
    try {
      await db.query('alter table public.upload_byte_reservations disable trigger upload_byte_reservations_guard_delete');
      await db.query('delete from public.upload_byte_reservations where user_id=any($1::uuid[])', [[owner, other]]);
      await db.query('alter table public.upload_byte_reservations enable trigger upload_byte_reservations_guard_delete');
      await db.query('delete from public.upload_path_tombstones where owner_user_id=any($1::uuid[])', [[owner, other]]);
      await db.query('delete from public.upload_byte_user_counters where user_id=any($1::uuid[]) and outstanding_bytes=0', [[owner, other]]);
      await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [[owner, other]]);
      await db.query('delete from auth.users where id=any($1::uuid[])', [[owner, other]]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    expect((await db.query("select (select count(*) from auth.users where id=any($1::uuid[]))::int users,(select count(*) from public.upload_byte_reservations where user_id=any($1::uuid[]))::int reservations,(select count(*) from storage.objects where bucket_id='profiles' and name=any($2::text[]))::int objects,(select count(*) from public.backend_rate_limits where subject_key=any($1::text[]))::int rates", [[owner, other], paths])).rows)
      .toEqual([{ users: 0, reservations: 0, objects: 0, rates: 0 }]);
    expect((await db.query('select public.reconcile_upload_byte_admission_counters(false) result')).rows[0].result.status).toBe('ok');
    await db.end();
  }
}, 30000);
