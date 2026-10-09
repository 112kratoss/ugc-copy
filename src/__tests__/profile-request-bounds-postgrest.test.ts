import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { patchProfileRouteResult } from '@/lib/profile-route-adapter-service';
import { postProfileValidateRouteResponse } from '@/lib/profile-validate-route-adapter-service';
import { postProfileMediaSignRouteResponse, postProfileMediaCleanupRouteResponse } from '@/lib/profile-media-route-adapter-service';
import { updateProfileForRoute } from '@/lib/profile-route-service';
import { PROFILE_REQUEST_BODY_MAX_BYTES } from '@/lib/profile-request-body';
import mobileApiContract from '../../contracts/mobile-api-v1.json';

describe.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL)('profile request byte bounds with actual Auth and SQL', () => {
  let db: Client, admin: SupabaseClient, signed: SupabaseClient, unsigned: SupabaseClient, owner: string;
  beforeAll(async () => {
    const cfg = JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!, 'utf8'));
    const connectionString = process.env.SUPABASE_TEST_DB_URL!;
    expect(['localhost', '127.0.0.1']).toContain(new URL(cfg.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString).hostname);
    const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).origin !== new URL(cfg.API_URL).origin) throw Error('External calls forbidden');
      return fetch(input, init);
    } } };
    admin = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, options);
    signed = createClient(cfg.API_URL, cfg.ANON_KEY, options);
    unsigned = createClient(cfg.API_URL, cfg.ANON_KEY, options);
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    const email = randomUUID() + '@profile-bounds.invalid', password = randomUUID() + randomUUID();
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull(); if (!created.data.user) throw Error('Fixture Auth failed'); owner = created.data.user.id;
    expect((await signed.auth.signInWithPassword({ email, password })).error).toBeNull();
  });
  afterEach(async () => {
    // Local teardown only; the baseline signer may have issued capabilities.
    await db.query('begin');
    try {
      await db.query('alter table public.upload_byte_reservations disable trigger upload_byte_reservations_guard_delete');
      await db.query('delete from public.upload_byte_reservations where user_id=$1', [owner]);
      await db.query('alter table public.upload_byte_reservations enable trigger upload_byte_reservations_guard_delete');
      await db.query('delete from public.upload_byte_user_counters where user_id=$1 and outstanding_bytes=0', [owner]);
      await db.query('delete from public.backend_rate_limits where subject_key=$1', [owner]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
  });
  afterAll(async () => {
    if (owner) {
      expect((await admin.auth.admin.deleteUser(owner)).error).toBeNull();
      expect((await db.query('select (select count(*) from auth.users where id=$1)::int users,(select count(*) from public.upload_byte_reservations where user_id=$1)::int reservations,(select count(*) from public.backend_rate_limits where subject_key=$1::text)::int rates', [owner])).rows).toEqual([{ users: 0, reservations: 0, rates: 0 }]);
      expect((await db.query('select public.reconcile_upload_byte_admission_counters(false) result')).rows[0].result.status).toBe('ok');
    }
    await db?.end();
  });
  for (const operation of ['patch', 'validate', 'sign', 'cleanup'] as const) {
    const payload = () => ({ username: 'audit-' + owner.slice(0, 12), displayName: 'Bounded fixture', role: 'avatar', fileName: 'fixture.png', mimeType: 'image/png', sizeBytes: 68, paths: [owner + '/absent.png'] });
    const invoke = async (request: Request, authClient = signed) => {
      const dependencies = { createUserClient: () => authClient, createServiceClient: () => admin };
      return operation === 'patch' ? patchProfileRouteResult({ request, dependencies: { ...dependencies, updateProfileForRoute: (input) => updateProfileForRoute({ ...input, invalidateFeedCache: () => {} }) } })
        : operation === 'validate' ? postProfileValidateRouteResponse({ request, dependencies })
          : operation === 'sign' ? postProfileMediaSignRouteResponse({ request, dependencies })
            : postProfileMediaCleanupRouteResponse({ request, dependencies });
    };
    it.each(['absent', 'honest', 'understated'] as const)(operation + ' bounds an oversized body with %s Content-Length', async (length) => {
      const body = JSON.stringify({ ...payload(), padding: 'x'.repeat(128 * 1024) });
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (length !== 'absent') headers.set('Content-Length', length === 'honest' ? String(Buffer.byteLength(body)) : '2');
      const request = new Request('http://localhost/api/profile', { method: operation === 'patch' ? 'PATCH' : 'POST', headers, body });
      const before = (await db.query('select username,display_name from public.profiles where id=$1', [owner])).rows;
      const result = await invoke(request);
      expect(result.status).toBe(mobileApiContract.profileRequestTooLarge.status);
      expect(result instanceof Response ? await result.json() : result.body).toEqual(mobileApiContract.profileRequestTooLarge.response);
      expect(result.headers.get('Cache-Control')).toBe('private, no-store');
      expect((await db.query('select username,display_name from public.profiles where id=$1', [owner])).rows).toEqual(before);
      expect((await db.query('select id from public.upload_byte_reservations where user_id=$1', [owner])).rows).toEqual([]);
    });
    it(operation + ' accepts valid JSON exactly at the byte limit', async () => {
      expect(PROFILE_REQUEST_BODY_MAX_BYTES).toBe(mobileApiContract.profileRequestTooLarge.maxBytes);
      const empty = JSON.stringify({ ...payload(), padding: '' });
      const body = JSON.stringify({ ...payload(), padding: 'x'.repeat(PROFILE_REQUEST_BODY_MAX_BYTES - Buffer.byteLength(empty)) });
      expect(Buffer.byteLength(body)).toBe(PROFILE_REQUEST_BODY_MAX_BYTES);
      expect((await invoke(new Request('http://localhost/api/profile', { method: 'POST', body }))).status).toBe(200);
    });
    it(operation + ' counts UTF-8 bytes rather than characters', async () => {
      const body = JSON.stringify({ ...payload(), padding: '€'.repeat(24000) });
      expect(body.length).toBeLessThan(PROFILE_REQUEST_BODY_MAX_BYTES);
      expect((await invoke(new Request('http://localhost/api/profile', { method: 'POST', body }))).status).toBe(413);
    });
    it(operation + ' authenticates before reading an oversized body', async () => {
      const request = new Request('http://localhost/api/profile', { method: 'POST', body: 'x'.repeat(128 * 1024) });
      expect((await invoke(request, unsigned)).status).toBe(401);
      expect(request.bodyUsed).toBe(false);
    });
    it(operation + ' cancels the stream before consuming the oversized tail', async () => {
      let bytesPulled = 0, cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (bytesPulled >= 128 * 1024) { controller.close(); return; }
          controller.enqueue(new Uint8Array(8192).fill(32)); bytesPulled += 8192;
        },
        cancel() { cancelled = true; },
      });
      const request = new Request('http://localhost/api/profile', { method: 'POST', body, duplex: 'half' } as RequestInit);
      expect((await invoke(request)).status).toBe(413);
      expect(cancelled).toBe(true);
      expect(bytesPulled).toBeLessThanOrEqual(PROFILE_REQUEST_BODY_MAX_BYTES + 16384);
    });
  }
});
