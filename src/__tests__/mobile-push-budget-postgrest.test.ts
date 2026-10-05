import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/provider-dependency-telemetry', () => ({ recordProviderDependencyEvent: vi.fn() }));
import { processMobilePushMaintenance } from '@/lib/mobile-notifications';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('push retry budget investigation with actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let owner: string;
  let token: string;
  let notification: string;
  let delivery: string;
  let ticket: string;
  let failTable: string | null;
  let failOnce: boolean;
  let loseRecordAcknowledgement: boolean;
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
    loseRecordAcknowledgement = false;
    writes = [];
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (loseRecordAcknowledgement && url.pathname === '/rest/v1/rpc/record_mobile_push_retry_outcome') {
        const persisted = await fetch(input, init);
        expect(persisted.ok).toBe(true);
        return new Response(JSON.stringify({message:'Injected lost acknowledgement'}), {status:503,headers:{'Content-Type':'application/json'}});
      }
      if (url.pathname === '/rest/v1/rpc/prune_mobile_notification_retention') return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      if (init?.method === 'PATCH') writes.push(url.pathname);
      if ((init?.method === 'PATCH' && url.pathname === '/rest/v1/' + failTable) || (init?.method === 'POST' && url.pathname === '/rest/v1/rpc/' + failTable)) {
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

  it('sends once when two maintenance callers overlap at the provider boundary', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => {
      entered(); await waiting;
      return new Response(JSON.stringify({ data: { status: 'ok', id: ticket } }), { headers: { 'Content-Type': 'application/json' } });
    });
    const first = processMobilePushMaintenance(admin, { fetcher, now });
    try {
      await started;
      expect(await processMobilePushMaintenance(admin, { fetcher, now })).toMatchObject({ resentCount: 0 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await state()).toMatchObject({ attempt_count: 2 });
    } finally { release(); await first; }
    expect(await state()).toMatchObject({ send_status: 'sent', attempt_count: 2 });
  });

  it('keeps accepted sends within the cap when every completion write fails', async () => {
    const fetcher = provider(); failTable = 'record_mobile_push_retry_outcome';
    await expect(processMobilePushMaintenance(admin, { fetcher, now })).rejects.toThrow('Failed to record push retry.');
    expect(await state()).toMatchObject({ attempt_count: 2 });
    // A live claim cannot be sent again, even by a new maintenance invocation.
    expect(await processMobilePushMaintenance(admin, { fetcher, now })).toMatchObject({ resentCount: 0 });
    await db.query("update public.mobile_push_deliveries set retry_claim_until=now()-interval '1 second' where id=$1", [delivery]);
    await expect(processMobilePushMaintenance(admin, { fetcher, now })).rejects.toThrow('Failed to record push retry.');
    for (let run = 0; run < 3; run++) expect(await processMobilePushMaintenance(admin, { fetcher, now })).toMatchObject({ resentCount: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await state()).toMatchObject({ attempt_count: 3, send_status: 'error' });
  });

  it('sends nothing when the durable claim fails', async () => {
    const fetcher = provider(); failTable = 'claim_mobile_push_retry';
    await expect(processMobilePushMaintenance(admin, {fetcher,now})).rejects.toThrow('Failed to claim push retry.');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({attempt_count:1});
  });

  it('recovers an accepted outcome whose write acknowledgement was lost without another send', async () => {
    const fetcher = provider(); loseRecordAcknowledgement = true;
    await expect(processMobilePushMaintenance(admin, {fetcher,now})).rejects.toThrow('Failed to record push retry.');
    expect(await state()).toMatchObject({attempt_count:2,send_status:'error'});
    loseRecordAcknowledgement = false;
    expect(await processMobilePushMaintenance(admin, {fetcher,now})).toMatchObject({recoveredRetryCount:1});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await state()).toMatchObject({attempt_count:2,send_status:'sent',push_ticket_id:ticket});
  });

  it('recovers a recorded final refusal after cleanup fails without sending again', async () => {
    await db.query('update public.mobile_push_deliveries set attempt_count=2 where id=$1', [delivery]);
    const fetcher = provider(true); failTable = 'finish_mobile_push_retry';
    await expect(processMobilePushMaintenance(admin, {fetcher,now})).rejects.toThrow('Failed to finalize push retry.');
    expect(await state()).toMatchObject({attempt_count:3,receipt_status:'error'});
    expect((await db.query('select retry_outcome from public.mobile_push_deliveries where id=$1',[delivery])).rows[0].retry_outcome).toMatchObject({status:'refused',error_code:'DeviceNotRegistered'});
    failTable = null;
    expect(await processMobilePushMaintenance(admin, {fetcher,now})).toMatchObject({recoveredRetryCount:1,disabledTokenCount:1});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await state()).toMatchObject({attempt_count:3,receipt_status:'stale'});
    expect((await db.query('select is_active from public.mobile_push_tokens where id=$1',[token])).rows[0].is_active).toBe(false);
  });

  it('preserves the spent attempt when the real sender is killed', async () => {
    const child = fork('src/__tests__/mobile-push-claim-worker.cjs', [], {
      execArgv: ['--import', 'tsx'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tsconfig.mobile-push-worker.json', AUDIT_STORAGE_CONFIG: configPath },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child did not reach provider boundary')), 8000);
        child.once('message', message => { clearTimeout(timer); if ((message as {stage:string}).stage === 'provider-started') resolve(); else reject(new Error('Child failed')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited early')); });
      });
      expect(await state()).toMatchObject({ attempt_count: 2, send_status: 'error' });
      const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
      child.kill('SIGKILL'); expect(await exited).toBe('SIGKILL');
      const fetcher = provider();
      expect(await processMobilePushMaintenance(admin, { fetcher, now })).toMatchObject({ resentCount: 0 });
      expect(fetcher).not.toHaveBeenCalled();
      // Lease expiry is advanced in this fixture; actual wall-clock expiry has
      // separate shared-lease evidence, not claimed by this test.
      await db.query("update public.mobile_push_deliveries set retry_claim_until=now()-interval '1 second' where id=$1", [delivery]);
      expect(await processMobilePushMaintenance(admin, { fetcher, now })).toMatchObject({ resentCount: 1 });
      expect(await state()).toMatchObject({ attempt_count: 3, send_status: 'sent' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      }
    }
  });
});
