import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/provider-dependency-telemetry', () => ({ recordProviderDependencyEvent: vi.fn() }));
import { processPendingMobilePushReceipts } from '@/lib/mobile-notifications';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('push receipt recovery with actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let owner: string;
  let token: string;
  let notification: string;
  let delivery: string;
  let ticket: string;
  let failTable: string | null;
  let config: { API_URL: string; SERVICE_ROLE_KEY: string };
  const now = new Date();
  const provider = (unregistered = false) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: {
    [ticket]: unregistered ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' },
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const state = async () => (await db.query('select receipt_status from public.mobile_push_deliveries where id=$1', [delivery])).rows[0].receipt_status;
  const tokenState = async () => (await db.query('select is_active,disabled_at from public.mobile_push_tokens where id=$1', [token])).rows[0];
  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [owner, token, notification, delivery, ticket] = Array.from({ length: 5 }, () => randomUUID());
    failTable = null;
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'PATCH' && url.pathname === '/rest/v1/' + failTable) {
        return new Response(JSON.stringify({ code: 'XX000', message: 'Injected receipt write failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(input, init);
    } } });
    await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [owner, owner + '@example.invalid']);
    await db.query("insert into public.mobile_push_tokens(id,user_id,expo_push_token,platform,is_active) values($1,$2,$3,'ios',true)", [token, owner, 'ExponentPushToken[audit-' + token + ']']);
    await db.query("insert into public.mobile_notifications(id,user_id,type,category,title,body) values($1,$2,'post_saved','social','Audit fixture','Receipt test')", [notification, owner]);
    await db.query("insert into public.mobile_push_deliveries(id,notification_id,user_id,token_id,expo_push_token,platform,push_ticket_id,send_status,receipt_status,sent_at) values($1,$2,$3,$4,$5,'ios',$6,'sent','pending',$7)", [delivery, notification, owner, token, 'ExponentPushToken[audit-' + token + ']', ticket, new Date(now.getTime() - 3600000)]);
  });
  afterEach(async () => {
    await db.query('delete from auth.users where id=$1', [owner]);
    expect((await db.query('select id from public.mobile_push_deliveries where id=$1', [delivery])).rows).toEqual([]);
    expect((await db.query('select id from public.mobile_push_tokens where id=$1', [token])).rows).toEqual([]);
  });

  it.each(['ok', 'stale'] as const)('surfaces a failed %s write and retries the pending row', async (status) => {
    if (status === 'stale') await db.query("update public.mobile_push_deliveries set sent_at=$2 where id=$1", [delivery, new Date(now.getTime() - 25 * 3600000)]);
    const fetcher = provider();
    failTable = 'mobile_push_deliveries';
    await expect(processPendingMobilePushReceipts(admin, { fetcher, now })).rejects.toThrow();
    expect(await state()).toBe('pending');
    failTable = null;
    expect(await processPendingMobilePushReceipts(admin, { fetcher, now })).toMatchObject(status === 'stale' ? { staleCount: 1 } : { updatedCount: 1 });
    expect(await state()).toBe(status);
    if (status === 'stale') expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps a DeviceNotRegistered receipt retryable until token retirement succeeds', async () => {
    const fetcher = provider(true);
    failTable = 'mobile_push_tokens';
    const outcome = await processPendingMobilePushReceipts(admin, { fetcher, now }).then(summary => ({ summary }), error => ({ error }));
    expect({ outcome, status: await state(), token: await tokenState() }).toMatchObject({
      outcome: { error: expect.any(Error) }, status: 'pending', token: { is_active: true, disabled_at: null },
    });
    failTable = null;
    expect(await processPendingMobilePushReceipts(admin, { fetcher, now })).toMatchObject({ updatedCount: 1, disabledTokenCount: 1 });
    expect(await state()).toBe('error');
    expect(await tokenState()).toMatchObject({ is_active: false, disabled_at: now });
  });

  it('preserves token retirement when the later receipt write fails and retries safely', async () => {
    const fetcher = provider(true);
    failTable = 'mobile_push_deliveries';
    await expect(processPendingMobilePushReceipts(admin, { fetcher, now })).rejects.toThrow();
    expect(await state()).toBe('pending');
    expect(await tokenState()).toMatchObject({ is_active: false, disabled_at: now });
    failTable = null;
    expect(await processPendingMobilePushReceipts(admin, { fetcher, now: new Date(now.getTime() + 1000) })).toMatchObject({ updatedCount: 1, disabledTokenCount: 0 });
    expect(await state()).toBe('error');
    expect(await tokenState()).toMatchObject({ disabled_at: now });
  });
});
