import {fork} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('@/lib/backend-logger',()=>({logBackendError:vi.fn(),logBackendEvent:vi.fn()}));
vi.mock('@/lib/provider-dependency-telemetry',()=>({recordProviderDependencyEvent:vi.fn()}));
import {runMobilePushReceiptsBackendJob} from '@/lib/backend-job-executions';
import {processMobilePushMaintenance} from '@/lib/mobile-notifications';
const configPath=process.env.AUDIT_STORAGE_CONFIG;
const dbUrl=process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!configPath||!dbUrl)('push maintenance failure isolation',()=>{
 let db:Client,admin:SupabaseClient;let owner:string,token:string,notification:string,poison:string,healthy:string;let failurePath:string|null;let retentionCalls:number;let poisonIds:Set<string>;
 const now=new Date();const fetcher=vi.fn<typeof fetch>();
 const realFetch=globalThis.fetch;
 beforeAll(async()=>{expect(['127.0.0.1','localhost']).toContain(new URL(dbUrl!).hostname);db=new Client({connectionString:dbUrl,statement_timeout:10000});await db.connect();});
 afterAll(async()=>{await db.end();});
 beforeEach(async()=>{
  await db.query('delete from public.mobile_push_maintenance_scans');
  [owner,token,notification,poison,healthy]=Array.from({length:5},()=>randomUUID());failurePath=null;retentionCalls=0;poisonIds=new Set([poison]);fetcher.mockReset();fetcher.mockImplementation(async(input,init)=>{
   const payload=JSON.parse(String(init?.body));
   return new Response(JSON.stringify({data:String(input).includes('/getReceipts') ? Object.fromEntries(payload.ids.map((id:string)=>[id,{status:'ok'}])) : {status:'ok',id:'healthy-ticket'}}),{headers:{'Content-Type':'application/json'}});
  });
  const config=JSON.parse(readFileSync(configPath!,'utf8'));expect(['127.0.0.1','localhost']).toContain(new URL(config.API_URL).hostname);
  admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:async(input,init)=>{
   const url=new URL(String(input));
   if(url.pathname==='/rest/v1/rpc/prune_mobile_notification_retention'){retentionCalls++;return new Response('{}',{headers:{'Content-Type':'application/json'}});}
   if(url.pathname===failurePath && (url.searchParams.get('id')==='eq.'+poison || [...poisonIds].some(id=>String(init?.body).includes(id)))) return new Response(JSON.stringify({code:'XX000',message:'Injected per-record failure'}),{status:503,headers:{'Content-Type':'application/json'}});
   return realFetch(input,init);
  }}});
  await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",[owner,owner+'@example.invalid']);
  await db.query("insert into public.mobile_push_tokens(id,user_id,expo_push_token,platform,is_active) values($1,$2,$3,'ios',true)",[token,owner,'ExponentPushToken['+token+']']);
  await db.query("insert into public.mobile_notifications(id,user_id,type,category,title,body) values($1,$2,'post_saved','social','Local fixture','Local only')",[notification,owner]);
  for(const [index,id] of [poison,healthy].entries()) await db.query("insert into public.mobile_push_deliveries(id,notification_id,user_id,token_id,expo_push_token,platform,send_status,receipt_status,attempt_count,last_attempt_at,created_at) values($1,$2,$3,$4,$5,'ios','error','error',1,$6,$6)",[id,notification,owner,token,'ExponentPushToken['+token+']',new Date(now.getTime()-(2-index)*3600000)]);
 });
 afterEach(async()=>{vi.unstubAllGlobals();await db.query('delete from auth.users where id=$1',[owner]);expect((await db.query('select id from public.mobile_push_deliveries where user_id=$1',[owner])).rows).toEqual([]);});
 const repeat=async()=>{const results=[];for(let attempt=0;attempt<3;attempt++)results.push(await processMobilePushMaintenance(admin,{fetcher,now}).then(summary=>({summary}),error=>({error})));expect(retentionCalls).toBe(3);expect(results.some(result=>'error' in result && result.error.summary.maintenanceFailureCount>0)).toBe(true);return results;};
 it('continues healthy saved outcomes and later phases despite an oldest finalization failure',async()=>{
  await db.query("update public.mobile_push_deliveries set attempt_count=3,initial_attempt_reservation=true,retry_claim_id=gen_random_uuid(),retry_outcome=jsonb_build_object('status','sent','ticket_id',id::text,'attempt_count',1) where user_id=$1",[owner]);
  failurePath='/rest/v1/rpc/finish_mobile_push_retry';await repeat();
  expect((await db.query('select attempt_count,send_status,retry_outcome is not null as saved from public.mobile_push_deliveries where id=$1',[healthy])).rows[0]).toEqual({attempt_count:1,send_status:'sent',saved:false});
 });
 it('continues a healthy due receipt and retention after a failed stale receipt',async()=>{
  await db.query("update public.mobile_push_deliveries set send_status='sent',receipt_status='pending',push_ticket_id=id::text,sent_at=case when id=$2 then $3::timestamptz else $4::timestamptz end where user_id=$1",[owner,poison,new Date(now.getTime()-25*3600000),new Date(now.getTime()-3600000)]);
  failurePath='/rest/v1/mobile_push_deliveries';await repeat();
  expect((await db.query('select receipt_status from public.mobile_push_deliveries where id=$1',[healthy])).rows[0].receipt_status).toBe('ok');
 });
 it('continues another eligible retry after a failed oldest claim',async()=>{
  failurePath='/rest/v1/rpc/claim_mobile_push_retry';await repeat();
  expect((await db.query('select attempt_count,retry_claim_id from public.mobile_push_deliveries where id=$1',[healthy])).rows[0]).toEqual({attempt_count:2,retry_claim_id:null});
 });
 it('advances beyond 100 failing saved outcomes and returns to them on a later pass',async()=>{
  const ids=Array.from({length:99},()=>randomUUID());ids.forEach(id=>poisonIds.add(id));
  await db.query("insert into public.mobile_push_deliveries(id,notification_id,user_id,token_id,expo_push_token,platform,send_status,receipt_status,attempt_count,last_attempt_at,created_at) select id,$2,$3,$4,$5,'ios','error','error',1,$6,$6 from unnest($1::uuid[]) id",[ids,notification,owner,token,'ExponentPushToken['+token+']',new Date(now.getTime()-2*3600000)]);
  await db.query("update public.mobile_push_deliveries set attempt_count=3,initial_attempt_reservation=true,retry_claim_id=gen_random_uuid(),retry_outcome=jsonb_build_object('status','sent','ticket_id',id::text,'attempt_count',1) where user_id=$1",[owner]);
  failurePath='/rest/v1/rpc/finish_mobile_push_retry';await repeat();
  expect((await db.query("select id from public.mobile_push_deliveries where user_id=$1 and retry_outcome is not null",[owner])).rows).toHaveLength(100);
  expect((await db.query('select send_status from public.mobile_push_deliveries where id=$1',[healthy])).rows[0].send_status).toBe('sent');
 });

 it('persists partial progress and failure counts in an actual managed job run',async()=>{
  await db.query("update public.mobile_push_deliveries set attempt_count=3,initial_attempt_reservation=true,retry_claim_id=gen_random_uuid(),retry_outcome=jsonb_build_object('status','sent','ticket_id',id::text,'attempt_count',1) where user_id=$1",[owner]);
  const requestId='audit-push-progress-'+randomUUID();
  failurePath='/rest/v1/rpc/finish_mobile_push_retry';
  vi.stubGlobal('fetch',fetcher);
  try {
   expect(await runMobilePushReceiptsBackendJob({serviceClient:admin,requestId,startedAtMs:now.getTime()})).toMatchObject({success:false,status:'failed'});
   const runs=(await db.query('select status,summary from public.backend_job_runs where request_id=$1',[requestId])).rows;
   expect(runs).toEqual([expect.objectContaining({status:'failed',summary:expect.objectContaining({maintenanceFailureCount:1,failedPhases:['recorded'],recoveredRetryCount:1})})]);
   expect(retentionCalls).toBe(1);
   expect((await db.query('select name from public.backend_job_locks where locked_by like $1',['%'+requestId+'%'])).rows).toEqual([]);
  } finally {await db.query('delete from public.backend_job_runs where request_id=$1',[requestId]);}
 });

 it('serializes concurrent scan positions and revisits abandoned work after a full sweep',async()=>{
  await db.query("update public.mobile_push_deliveries set attempt_count=3,retry_claim_id=gen_random_uuid(),retry_outcome=jsonb_build_object('status','sent','ticket_id',id::text) where user_id=$1",[owner]);
  const scan=()=>admin.rpc('scan_mobile_push_maintenance',{p_phase:'recorded',p_limit:1,p_now:now.toISOString()});
  const result=await Promise.all([scan(),scan()]);
  expect(result.every(r=>!r.error)).toBe(true);
  expect(new Set(result.map(r=>r.data[0].id))).toEqual(new Set([poison,healthy]));
  expect((await scan()).data[0].id).toBe(poison);
 });
 it('reports a phase scan outage and still runs the other phases and retention',async()=>{
  failurePath='/rest/v1/rpc/scan_mobile_push_maintenance';
  const base=admin.rpc.bind(admin);
  vi.spyOn(admin,'rpc').mockImplementation(((name:string,args:Record<string,unknown>)=>name==='scan_mobile_push_maintenance' && args.p_phase==='recorded'
   ? Promise.resolve({data:null,error:{message:'Injected scan outage'}}) : base(name,args)) as typeof admin.rpc);
  const result=await processMobilePushMaintenance(admin,{fetcher,now}).catch(error=>error);
  expect(result.summary).toMatchObject({maintenanceFailureCount:1,failedPhases:['recorded'],resentCount:2});
  expect(retentionCalls).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
 });

 it('advances after SIGKILL following a saved scan and revisits its unprocessed records',async()=>{
  await db.query("insert into public.mobile_push_deliveries(notification_id,user_id,token_id,expo_push_token,platform,send_status,receipt_status,attempt_count,created_at) select $1,$2,$3,$4,'ios','error','error',3,$5 from generate_series(1,99)",[notification,owner,token,'ExponentPushToken['+token+']',new Date(now.getTime()-2*3600000)]);
  await db.query("update public.mobile_push_deliveries set attempt_count=3,initial_attempt_reservation=true,retry_claim_id=gen_random_uuid(),retry_outcome=jsonb_build_object('status','sent','ticket_id',id::text,'attempt_count',1) where user_id=$1",[owner]);
  const child=fork('src/__tests__/mobile-push-scan-worker.cjs',[],{execArgv:['--import','tsx'],env:{NODE_ENV:'test',PATH:process.env.PATH,TSX_TSCONFIG_PATH:'tsconfig.mobile-push-worker.json',AUDIT_STORAGE_CONFIG:configPath},stdio:['ignore','ignore','pipe','ipc']});
  try {
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Scan boundary not reached')),8000);child.once('message',message=>{clearTimeout(timer);if((message as {stage:string}).stage==='scan-saved')resolve();else reject(Error('Child failed'));});child.once('exit',()=>{clearTimeout(timer);reject(Error('Child exited early'));});});
   const exited=new Promise(resolve=>child.once('exit',(_code,signal)=>resolve(signal)));child.kill('SIGKILL');expect(await exited).toBe('SIGKILL');
   expect((await db.query('select id from public.mobile_push_deliveries where user_id=$1 and retry_outcome is not null',[owner])).rows).toHaveLength(101);
   expect(await processMobilePushMaintenance(admin,{fetcher,now})).toMatchObject({recoveredRetryCount:1});
   expect((await db.query('select send_status from public.mobile_push_deliveries where id=$1',[healthy])).rows[0].send_status).toBe('sent');
   expect(await processMobilePushMaintenance(admin,{fetcher,now})).toMatchObject({recoveredRetryCount:100});
   expect(fetcher).not.toHaveBeenCalled();
  } finally {if(child.exitCode===null && child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}}
 });

});
