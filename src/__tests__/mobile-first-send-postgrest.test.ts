import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/backend-logger', () => ({ logBackendError: vi.fn(), logBackendWarning: vi.fn() }));
vi.mock('@/lib/provider-dependency-telemetry', () => ({ recordProviderDependencyEvent: vi.fn() }));
import { createMobileNotification, processMobilePushMaintenance } from '@/lib/mobile-notifications';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('first-send persistence with actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let owner: string;
  let token: string;
  let ticket: string;
  let failTable: string | null;
  let config: { API_URL: string; SERVICE_ROLE_KEY: string };
  const realFetch = globalThis.fetch;
  const now = new Date();
  const provider = (unregistered = false) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data:
    [unregistered ? { status: 'error', message: 'Gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: ticket }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [owner, token, ticket] = Array.from({ length: 3 }, () => randomUUID());
    failTable = null;
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/rest/v1/rpc/prune_mobile_notification_retention') return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      if ((['PATCH','POST'].includes(init?.method ?? '') && url.pathname === '/rest/v1/' + failTable) || (init?.method === 'POST' && url.pathname === '/rest/v1/rpc/' + failTable)) {
        return new Response(JSON.stringify({ code: 'XX000', message: 'Injected receipt write failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(input, init);
    } } });
    await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [owner, owner + '@example.invalid']);
    await db.query("insert into public.mobile_push_tokens(id,user_id,expo_push_token,platform,is_active) values($1,$2,$3,'ios',true)", [token, owner, 'ExponentPushToken[audit-' + token + ']']);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.query('delete from auth.users where id=$1', [owner]);
    expect((await db.query('select id from public.mobile_push_deliveries where user_id=$1', [owner])).rows).toEqual([]);
    expect((await db.query('select id from public.mobile_push_tokens where user_id=$1', [owner])).rows).toEqual([]);
  });

  const create = () => createMobileNotification({adminSupabase:admin,userId:owner,type:'post_saved',category:'social',title:'Fixture',body:'Local only',dedupeKey:'first-send-'+owner});
  const rows = async () => (await db.query('select * from public.mobile_push_deliveries where user_id=$1',[owner])).rows;

  it('reserves durable delivery intent before the initial batch reaches the provider', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      expect(await rows()).toEqual([expect.objectContaining({attempt_count:3,initial_attempt_reservation:true,receipt_error_code:'PushRetryOutcomeUnknown'})]);
      return new Response(JSON.stringify({data:[{status:'ok',id:ticket}]}),{headers:{'Content-Type':'application/json'}});
    });
    vi.stubGlobal('fetch',fetcher);
    const notification = await create(); expect(notification?.id).toEqual(expect.any(String));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([expect.objectContaining({push_ticket_id:ticket,send_status:'sent',attempt_count:1,initial_attempt_reservation:false})]);
  });

  it('does not contact the provider if reserving the first-send record fails', async () => {
    const fetcher = provider(); vi.stubGlobal('fetch',fetcher);failTable='mobile_push_deliveries';
    expect((await create())?.id).toEqual(expect.any(String));
    expect(fetcher).not.toHaveBeenCalled();expect(await rows()).toEqual([]);
  });

  it('keeps an unrecorded accepted outcome within its reserved budget', async () => {
    const fetcher = provider();vi.stubGlobal('fetch',fetcher);failTable='record_initial_mobile_push_outcomes';
    await create();
    expect(await rows()).toEqual([expect.objectContaining({attempt_count:3,send_status:'error',retry_outcome:null})]);
    failTable=null;
    expect(await processMobilePushMaintenance(admin,{fetcher,now})).toMatchObject({retriedCount:0});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recovers first-send token retirement failure from its saved refusal without resending', async () => {
    const fetcher=provider(true);vi.stubGlobal('fetch',fetcher);failTable='finish_initial_mobile_push_outcomes';
    await create();
    expect(await rows()).toEqual([expect.objectContaining({attempt_count:3,retry_outcome:expect.objectContaining({status:'refused',error_code:'DeviceNotRegistered'})})]);
    expect((await db.query('select is_active from public.mobile_push_tokens where id=$1',[token])).rows[0].is_active).toBe(true);
    failTable=null;
    expect(await processMobilePushMaintenance(admin,{fetcher,now})).toMatchObject({recoveredRetryCount:1,disabledTokenCount:1});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([expect.objectContaining({receipt_status:'stale',attempt_count:1,initial_attempt_reservation:false})]);
    expect((await db.query('select is_active from public.mobile_push_tokens where id=$1',[token])).rows[0].is_active).toBe(false);
  });
  it('reserves all 101 devices before sending and preserves mixed results in two provider batches', async () => {
    await db.query("insert into public.mobile_push_tokens(user_id,expo_push_token,platform,is_active) select $1,'ExponentPushToken['||gen_random_uuid()::text||']','ios',true from generate_series(1,100)",[owner]);
    const sizes: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_input,init) => {
      const messages = JSON.parse(String(init?.body)) as Array<{to:string}>;
      sizes.push(messages.length);
      expect(await rows()).toHaveLength(101);
      return new Response(JSON.stringify({data:messages.map(message => message.to === 'ExponentPushToken[audit-'+token+']'
        ? {status:'error',message:'Gone',details:{error:'DeviceNotRegistered'}}
        : {status:'ok',id:'ticket-'+message.to})}),{headers:{'Content-Type':'application/json'}});
    });
    vi.stubGlobal('fetch',fetcher);await create();
    expect(sizes).toEqual([100,1]);
    const deliveries=await rows();
    expect(deliveries.filter(row=>row.send_status==='sent')).toHaveLength(100);
    expect(deliveries.filter(row=>row.receipt_status==='stale')).toHaveLength(1);
    expect(deliveries.every(row=>row.attempt_count===1 && row.retry_outcome===null && !row.initial_attempt_reservation)).toBe(true);
    expect((await db.query('select is_active from public.mobile_push_tokens where id=$1',[token])).rows[0].is_active).toBe(false);
  });

  it('continues a transient first refusal through the existing durable retry worker', async () => {
    const initial=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({data:[{status:'error',message:'Slow down',details:{error:'MessageRateExceeded'}}]}),{headers:{'Content-Type':'application/json'}}));
    vi.stubGlobal('fetch',initial);await create();
    expect(await rows()).toEqual([expect.objectContaining({attempt_count:1,receipt_status:'error',initial_attempt_reservation:false})]);
    const retry=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({data:{status:'ok',id:ticket}}),{headers:{'Content-Type':'application/json'}}));
    expect(await processMobilePushMaintenance(admin,{fetcher:retry,now})).toMatchObject({resentCount:1});
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([expect.objectContaining({attempt_count:2,send_status:'sent',push_ticket_id:ticket})]);
  });
  it.each(['provider-started', 'outcome-saved'])('recovers safely after SIGKILL at %s', async stage => {
    const child = fork('src/__tests__/mobile-first-send-worker.cjs', [], {
      execArgv: ['--import', 'tsx'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tsconfig.mobile-push-worker.json', AUDIT_STORAGE_CONFIG: configPath, AUDIT_OWNER: owner, AUDIT_STOP_STAGE: stage },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child did not reach boundary')), 8000);
        child.once('message', message => { clearTimeout(timer); if ((message as {stage:string}).stage === stage) resolve(); else reject(new Error('Child failed')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited early')); });
      });
      expect(await rows()).toEqual([expect.objectContaining({attempt_count:3,initial_attempt_reservation:true})]);
      const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
      child.kill('SIGKILL'); expect(await exited).toBe('SIGKILL');
      const fetcher = provider();
      expect(await processMobilePushMaintenance(admin,{fetcher,now})).toMatchObject({recoveredRetryCount:stage === 'outcome-saved' ? 1 : 0,resentCount:0});
      expect(fetcher).not.toHaveBeenCalled();
      expect(await rows()).toEqual([expect.objectContaining(stage === 'outcome-saved'
        ? {attempt_count:1,send_status:'sent',push_ticket_id:'audit-child-ticket',initial_attempt_reservation:false}
        : {attempt_count:3,send_status:'error',retry_outcome:null,initial_attempt_reservation:true})]);
      vi.stubGlobal('fetch',fetcher);await create();
      expect(fetcher).not.toHaveBeenCalled();
      expect(await rows()).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      }
    }
  });

  it('does not replay an already finalized batch when a later batch outcome cannot be saved', async () => {
    await db.query("insert into public.mobile_push_tokens(user_id,expo_push_token,platform,is_active) select $1,'ExponentPushToken['||gen_random_uuid()::text||']','ios',true from generate_series(1,100)",[owner]);
    const fetcher=vi.fn<typeof fetch>(async(_input,init)=>{
      const messages=JSON.parse(String(init?.body)) as unknown[];
      if(messages.length === 1) failTable='record_initial_mobile_push_outcomes';
      return new Response(JSON.stringify({data:messages.map(()=>({status:'ok',id:randomUUID()}))}),{headers:{'Content-Type':'application/json'}});
    });
    vi.stubGlobal('fetch',fetcher);await create();failTable=null;
    const deliveries=await rows();
    expect(deliveries.filter(row=>row.send_status==='sent' && row.attempt_count===1)).toHaveLength(100);
    expect(deliveries.filter(row=>row.initial_attempt_reservation && row.attempt_count===3)).toHaveLength(1);
    await create();
    expect(await processMobilePushMaintenance(admin,{fetcher,now})).toMatchObject({resentCount:0});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

});
