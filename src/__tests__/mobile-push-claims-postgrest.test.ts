import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/provider-dependency-telemetry', () => ({ recordProviderDependencyEvent: vi.fn() }));

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('push retry claims with actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let owner: string;
  let token: string;
  let notification: string;
  let delivery: string;
  let ticket: string;
  let failTable: string | null;
  let failOnce: boolean;
  let writes: string[];
  let config: { API_URL: string; SERVICE_ROLE_KEY: string; ANON_KEY: string };
  const now = new Date();
  const state = async () => (await db.query('select receipt_status,send_status,attempt_count,push_ticket_id from public.mobile_push_deliveries where id=$1', [delivery])).rows[0];
  const tokenState = async () => (await db.query('select is_active,disabled_at from public.mobile_push_tokens where id=$1', [token])).rows[0];
  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    anon = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false } });
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

  const claim = (count = 1) => admin.rpc('claim_mobile_push_retry', { p_delivery_id: delivery, p_expected_attempt_count: count });
  const finish = async (id: string, outcome: Record<string, unknown>) => {
    const recorded = await admin.rpc('record_mobile_push_retry_outcome', { p_delivery_id: delivery, p_claim_id: id, p_outcome: outcome });
    if (recorded.error) return recorded;
    return admin.rpc('finish_mobile_push_retry', { p_delivery_id: delivery, p_claim_id: id });
  };

  it('admits one of eight contenders and accounts before any provider call', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claim()));
    expect(results.every(r => r.error === null)).toBe(true);
    expect(results.filter(r => typeof r.data === 'string')).toHaveLength(1);
    expect(await state()).toMatchObject({ attempt_count: 2, send_status: 'error' });
    expect(await claim(2)).toMatchObject({ data: null, error: null });
  });

  it('recovers an expired claim without letting the old worker overwrite the replacement', async () => {
    const first = await claim(); expect(first.error).toBeNull();
    await db.query("update public.mobile_push_deliveries set retry_claim_until=now()-interval '1 second' where id=$1", [delivery]);
    const second = await claim(2); expect(second.error).toBeNull(); expect(second.data).toEqual(expect.any(String));
    expect(await finish(first.data, { status: 'sent', ticket_id: 'old-ticket' })).toMatchObject({ data: { applied: false }, error: null });
    expect(await finish(second.data, { status: 'sent', ticket_id: ticket })).toMatchObject({ data: { applied: true }, error: null });
    expect(await state()).toMatchObject({ attempt_count: 3, push_ticket_id: ticket, send_status: 'sent' });
    expect(await finish(first.data, { status: 'refused', error_code: 'DeviceNotRegistered' })).toMatchObject({ data: { applied: false } });
    expect(await tokenState()).toMatchObject({ is_active: true });
  });

  it('never restores the budget when unknown claims expire', async () => {
    expect((await claim()).error).toBeNull();
    await db.query("update public.mobile_push_deliveries set retry_claim_until=now()-interval '1 second' where id=$1", [delivery]);
    expect((await claim(2)).data).toEqual(expect.any(String));
    await db.query("update public.mobile_push_deliveries set retry_claim_until=now()-interval '1 second' where id=$1", [delivery]);
    expect((await claim(3)).error?.code).toBe('22023');
    expect((await claim(2)).data).toBeNull();
    expect(await state()).toMatchObject({ attempt_count: 3, send_status: 'error' });
  });

  it('atomically retires a token and finalizes its refusal even at the final budget slot', async () => {
    await db.query('update public.mobile_push_deliveries set attempt_count=2 where id=$1', [delivery]);
    const result = await claim(2); expect(result.error).toBeNull();
    expect(await finish(result.data, { status: 'refused', error_code: 'DeviceNotRegistered', message: 'Gone' })).toMatchObject({ data: { applied: true, disabledTokenCount: 1 }, error: null });
    expect(await state()).toMatchObject({ attempt_count: 3, receipt_status: 'stale' });
    const retired = await tokenState(); expect(retired.is_active).toBe(false);
    expect(await finish(result.data, { status: 'refused', error_code: 'DeviceNotRegistered' })).toMatchObject({ data: { applied: false, disabledTokenCount: 0 } });
    expect(await tokenState()).toEqual(retired);
  });

  it('refuses malformed outcomes without releasing the claim or retiring a token', async () => {
    const result = await claim(); expect(result.error).toBeNull();
    for (const outcome of [{}, {status:'sent'}, {status:'retryable',error_code:'DeviceNotRegistered'}]) {
      expect((await finish(result.data, outcome)).error?.code).toBe('22023');
    }
    expect(await tokenState()).toMatchObject({ is_active: true });
    expect(await finish(result.data, {status:'retryable',message:'Transient'})).toMatchObject({data:{applied:true},error:null});
    expect((await claim(2)).data).toEqual(expect.any(String));
  });

  it('binds a recovered live token row before retiring a refusal', async () => {
    await db.query('update public.mobile_push_deliveries set token_id=null where id=$1', [delivery]);
    const result = await claim(); expect(result.error).toBeNull();
    expect(await finish(result.data, {status:'refused',error_code:'DeviceNotRegistered'})).toMatchObject({data:{applied:true,disabledTokenCount:1},error:null});
    expect(await tokenState()).toMatchObject({is_active:false});
  });

  it('rolls back refusal finalization if token retirement fails, then retries the same claim', async () => {
    await db.query('update public.mobile_push_deliveries set attempt_count=2 where id=$1', [delivery]);
    const result = await claim(2); expect(result.error).toBeNull();
    const trigger = 'audit_push_' + token.replaceAll('-', '');
    try {
      await db.query(`create function public.${trigger}() returns trigger language plpgsql as $$ begin if old.id='${token}'::uuid then raise exception 'Injected retirement failure'; end if; return new; end $$;
        create trigger ${trigger} before update on public.mobile_push_tokens for each row execute function public.${trigger}()`);
      expect((await finish(result.data, {status:'refused',error_code:'DeviceNotRegistered'})).error).not.toBeNull();
      expect(await state()).toMatchObject({receipt_status:'error',attempt_count:3});
      expect(await tokenState()).toMatchObject({is_active:true});
    } finally {
      await db.query(`drop trigger if exists ${trigger} on public.mobile_push_tokens; drop function if exists public.${trigger}()`);
    }
    expect(await finish(result.data, {status:'refused',error_code:'DeviceNotRegistered'})).toMatchObject({data:{applied:true,disabledTokenCount:1},error:null});
    expect(await tokenState()).toMatchObject({is_active:false});
  });

  it('denies authenticated direct SQL execution', async () => {
    await db.query('begin');
    try {
      await db.query('set local role authenticated');
      await expect(db.query('select public.claim_mobile_push_retry($1,1)', [delivery])).rejects.toMatchObject({code:'42501'});
    } finally { await db.query('rollback'); }
    await db.query('begin');
    try {
      await db.query('set local role authenticated');
      await expect(db.query("select public.finish_mobile_push_retry($1,$2)", [delivery,randomUUID()])).rejects.toMatchObject({code:'42501'});
    } finally { await db.query('rollback'); }
  });

  it('uses real wall-clock claim expiry before admitting a replacement', async () => {
    const started = Date.now();
    const first = await claim(); expect(first.error).toBeNull();
    expect(await claim(2)).toMatchObject({data:null,error:null});
    await new Promise(resolve => setTimeout(resolve, 61000));
    expect(Date.now() - started).toBeGreaterThanOrEqual(60000);
    const replacement = await claim(2);
    expect(replacement.error).toBeNull(); expect(replacement.data).toEqual(expect.any(String));
    expect(replacement.data).not.toBe(first.data);
    expect(await finish(first.data, {status:'sent',ticket_id:'late'})).toMatchObject({data:{applied:false}});
    expect(await finish(replacement.data, {status:'sent',ticket_id:ticket})).toMatchObject({data:{applied:true}});
  }, 75000);

  it('denies anonymous claims and completions', async () => {
    expect((await anon.rpc('claim_mobile_push_retry', {p_delivery_id:delivery,p_expected_attempt_count:1})).error?.code).toBe('42501');
    expect((await anon.rpc('finish_mobile_push_retry', {p_delivery_id:delivery,p_claim_id:randomUUID()})).error?.code).toBe('42501');
    expect((await anon.rpc('record_mobile_push_retry_outcome', {p_delivery_id:delivery,p_claim_id:randomUUID(),p_outcome:{status:'refused'}})).error?.code).toBe('42501');
    expect(await state()).toMatchObject({attempt_count:1});
  });
});
