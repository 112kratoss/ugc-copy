import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/provider-dependency-telemetry', () => ({ recordProviderDependencyEvent: vi.fn() }));
import { processMobilePushMaintenance } from '@/lib/mobile-notifications';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('push send retry persistence with actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let owner: string;
  let token: string;
  let notification: string;
  let delivery: string;
  let ticket: string;
  let failTable: string | null;
  let failOnce: boolean;
  let writes: string[];
  let config: { API_URL: string; SERVICE_ROLE_KEY: string };
  const now = new Date();
  const provider = (unregistered = false) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data:
    unregistered ? { status: 'error', message: 'Gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: ticket },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const state = async () => (await db.query('select receipt_status,send_status,attempt_count,push_ticket_id from public.mobile_push_deliveries where id=$1', [delivery])).rows[0];
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
    failOnce = false;
    writes = [];
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/rest/v1/rpc/prune_mobile_notification_retention') return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      if (init?.method === 'PATCH') writes.push(url.pathname);
      if (init?.method === 'PATCH' && url.pathname === '/rest/v1/' + failTable) {
        if (failOnce) failTable = null;
        return new Response(JSON.stringify({ code: 'XX000', message: 'Injected receipt write failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(input, init);
    } } });
    await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [owner, owner + '@example.invalid']);
    await db.query("insert into public.mobile_push_tokens(id,user_id,expo_push_token,platform,is_active) values($1,$2,$3,'ios',true)", [token, owner, 'ExponentPushToken[audit-' + token + ']']);
    await db.query("insert into public.mobile_notifications(id,user_id,type,category,title,body) values($1,$2,'post_saved','social','Audit fixture','Receipt test')", [notification, owner]);
    await db.query("insert into public.mobile_push_deliveries(id,notification_id,user_id,token_id,expo_push_token,platform,push_ticket_id,send_status,receipt_status,attempt_count,sent_at) values($1,$2,$3,$4,$5,'ios',$6,'error','error',1,$7)", [delivery, notification, owner, token, 'ExponentPushToken[audit-' + token + ']', null, new Date(now.getTime() - 3600000)]);
  });
  afterEach(async () => {
    await db.query('delete from auth.users where id=$1', [owner]);
    expect((await db.query('select id from public.mobile_push_deliveries where id=$1', [delivery])).rows).toEqual([]);
    expect((await db.query('select id from public.mobile_push_tokens where id=$1', [token])).rows).toEqual([]);
  });

  it.each(['paused', 'inactive'] as const)('rejects failed closure for a %s delivery, then closes it without sending', async (reason) => {
    if (reason === 'paused') await db.query('insert into public.mobile_notification_preferences(user_id,push_enabled) values($1,false) on conflict(user_id) do update set push_enabled=false', [owner]);
    else await db.query('update public.mobile_push_tokens set is_active=false where id=$1', [token]);
    const fetcher = provider();
    failTable = 'mobile_push_deliveries';
    await expect(processMobilePushMaintenance(admin, { fetcher, now })).rejects.toThrow('Failed to close unsent push delivery.');
    expect(await state()).toMatchObject({ receipt_status: 'error', attempt_count: 1 });
    expect(fetcher).not.toHaveBeenCalled();
    failTable = null;
    expect(await processMobilePushMaintenance(admin, { fetcher, now })).toMatchObject({ retrySkippedCount: 1 });
    expect(await state()).toMatchObject({ receipt_status: 'stale', attempt_count: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not convert failed accepted-ticket persistence into a provider failure', async () => {
    const fetcher = provider();
    failTable = 'mobile_push_deliveries';
    failOnce = true;
    await expect(processMobilePushMaintenance(admin, { fetcher, now })).rejects.toThrow('Failed to record push retry.');
    expect(writes).toEqual(['/rest/v1/mobile_push_deliveries']);
    expect(await state()).toMatchObject({ receipt_status: 'error', send_status: 'error', attempt_count: 1, push_ticket_id: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The accepted ticket is not durable. This test proves truthful failure,
    // not exactly-once sending: a later run still sends this row again.
    expect(await processMobilePushMaintenance(admin, { fetcher, now })).toMatchObject({ resentCount: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await state()).toMatchObject({ send_status: 'sent', push_ticket_id: ticket, attempt_count: 2 });
  });

  it('surfaces a failed provider-refusal write', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 400 }));
    failTable = 'mobile_push_deliveries';
    await expect(processMobilePushMaintenance(admin, { fetcher, now })).rejects.toThrow('Failed to record push retry.');
    expect(await state()).toMatchObject({ receipt_status: 'error', attempt_count: 1 });
    failTable = null;
    await processMobilePushMaintenance(admin, { fetcher, now });
    expect(await state()).toMatchObject({ receipt_status: 'stale', attempt_count: 2 });
  });

  it('keeps failed token retirement recoverable instead of consuming the remaining attempt budget', async () => {
    const fetcher = provider(true);
    failTable = 'mobile_push_tokens';
    await expect(processMobilePushMaintenance(admin, { fetcher, now })).rejects.toThrow('Failed to retire unregistered push tokens.');
    expect(await state()).toMatchObject({ receipt_status: 'error', attempt_count: 1 });
    expect(await tokenState()).toMatchObject({ is_active: true });
    failTable = null;
    expect(await processMobilePushMaintenance(admin, { fetcher, now })).toMatchObject({ retryDisabledTokenCount: 1, retryFailedCount: 1 });
    expect(await state()).toMatchObject({ receipt_status: 'stale', attempt_count: 2 });
    expect(await tokenState()).toMatchObject({ is_active: false, disabled_at: now });
  });

  it('retires an invalid token before a failed delivery write and closes on retry without another send', async () => {
    const fetcher = provider(true);
    failTable = 'mobile_push_deliveries';
    await expect(processMobilePushMaintenance(admin, { fetcher, now })).rejects.toThrow('Failed to record push retry.');
    expect(await tokenState()).toMatchObject({ is_active: false, disabled_at: now });
    expect(await state()).toMatchObject({ receipt_status: 'error', attempt_count: 1 });
    failTable = null;
    expect(await processMobilePushMaintenance(admin, { fetcher, now: new Date(now.getTime() + 1000) })).toMatchObject({ retrySkippedCount: 1 });
    expect(await state()).toMatchObject({ receipt_status: 'stale' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await tokenState()).toMatchObject({ disabled_at: now });
  });
});
