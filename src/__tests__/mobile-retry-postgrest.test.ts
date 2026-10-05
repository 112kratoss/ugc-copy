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

});
