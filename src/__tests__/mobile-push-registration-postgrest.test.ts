import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('@/lib/backend-rate-limit',async()=>{const actual=await vi.importActual<Record<string,unknown>>('@/lib/backend-rate-limit');return {...actual,enforceBackendRateLimit:vi.fn(async()=>({}))};});
import {registerMobilePushTokenForRoute} from '@/lib/mobile-push-registration-service';
const configPath=process.env.AUDIT_STORAGE_CONFIG,dbUrl=process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!configPath||!dbUrl)('atomic mobile push registration',()=>{
 it('keeps exactly one active token after concurrent same-device registrations',async()=>{
  const config=JSON.parse(readFileSync(configPath!,'utf8'));expect(['127.0.0.1','localhost']).toContain(new URL(config.API_URL).hostname);expect(['127.0.0.1','localhost']).toContain(new URL(dbUrl!).hostname);
  const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
  const email=randomUUID()+'@example.invalid',password=randomUUID()+'aZ!7';
  const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true});expect(error).toBeNull();const owner=data.user!.id;
  const db=new Client({connectionString:dbUrl,statement_timeout:10000});await db.connect();
  let arrivals=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  const registrationFetch:typeof fetch=async(input,init)=>{
   const response=await fetch(input,init);
   if(['/rest/v1/mobile_push_tokens','/rest/v1/rpc/register_mobile_push_token'].includes(new URL(String(input)).pathname) && init?.method==='POST' && response.ok){arrivals++;if(arrivals===2)release();await Promise.race([barrier,new Promise((_,reject)=>setTimeout(()=>reject(Error('Barrier timed out')),3000))]);}
   return response;
  };
  const registrationAdmin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:registrationFetch}});
  const clients=Array.from({length:2},()=>createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:registrationFetch}}));
  try{
   for(const client of clients){const result=await client.auth.signInWithPassword({email,password});expect(result.error).toBeNull();}
   const results=await Promise.all(clients.map((client,index)=>registerMobilePushTokenForRoute({userSupabase:client,getAdminSupabase:()=>registrationAdmin,requestBody:{expoPushToken:'ExponentPushToken[audit_'+index+'_'+randomUUID()+']',platform:'ios',deviceId:'audit-same-device'}})));
   expect(arrivals).toBe(2);expect(results).toEqual([{ok:true,body:{success:true}},{ok:true,body:{success:true}}]);
   const rows=(await db.query('select is_active from public.mobile_push_tokens where user_id=$1',[owner])).rows;
   expect(rows).toHaveLength(2);expect(rows.filter(row=>row.is_active)).toHaveLength(1);
   expect((await clients[0].rpc('register_mobile_push_token',{p_user_id:owner,p_expo_push_token:'ExponentPushToken[forbidden]',p_platform:'ios'})).error).not.toBeNull();
  }finally{
   release();await db.query('delete from auth.users where id=$1',[owner]);expect((await db.query('select id from public.mobile_push_tokens where user_id=$1',[owner])).rows).toEqual([]);await db.end();
  }
 });
});

describe.skipIf(!configPath || !dbUrl)('registration transaction and ownership controls', () => {
 let db: Client;
 let admin: SupabaseClient;
 let anon: SupabaseClient;
 let owners: string[];
 const expo = () => 'ExponentPushToken[audit_' + randomUUID() + ']';
 const register = (user: string, token: string, device: string | null = 'device') => admin.rpc('register_mobile_push_token', {
  p_user_id: user, p_expo_push_token: token, p_platform: 'ios', p_device_id: device, p_app_version: 'audit',
 });
 beforeAll(async () => {
  const config = JSON.parse(readFileSync(configPath!, 'utf8'));
  expect(['127.0.0.1', 'localhost']).toContain(new URL(config.API_URL).hostname);
  expect(['127.0.0.1', 'localhost']).toContain(new URL(dbUrl!).hostname);
  admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  anon = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false } });
  db = new Client({ connectionString: dbUrl, statement_timeout: 10000 }); await db.connect();
 });
 afterAll(async () => { await db?.end(); });
 beforeEach(async () => {
  owners = [randomUUID(), randomUUID()];
  for (const owner of owners) await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [owner, owner+'@example.invalid']);
 });
 afterEach(async () => {
  await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
  expect((await db.query('select id from public.mobile_push_tokens where user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
 });
 it('serializes eight same-device rotations while preserving an independent device', async () => {
  const independent = expo(); expect((await register(owners[0], independent, 'other')).error).toBeNull();
  const tokens = Array.from({length: 8}, expo);
  const replies = await Promise.all(tokens.map(token => register(owners[0], token)));
  expect(replies.every(reply => !reply.error)).toBe(true);
  const rows = (await db.query('select expo_push_token,device_id,is_active from public.mobile_push_tokens where user_id=$1', [owners[0]])).rows;
  expect(rows.filter(row => row.device_id === 'device' && row.is_active)).toHaveLength(1);
  expect(rows.find(row => row.expo_push_token === independent)?.is_active).toBe(true);
 });
 it('serializes same-token account handoffs with one active owner', async () => {
  const token = expo();
  const replies = await Promise.all(Array.from({length: 8}, (_,index) => register(owners[index%2], token)));
  expect(replies.every(reply => !reply.error)).toBe(true);
  const rows = (await db.query('select user_id,is_active from public.mobile_push_tokens where expo_push_token=$1', [token])).rows;
  expect(rows).toHaveLength(2); expect(rows.filter(row => row.is_active)).toHaveLength(1);
  for (const owner of owners) expect((await db.query('select user_id from public.mobile_notification_preferences where user_id=$1', [owner])).rows).toHaveLength(1);
 });
 it('completes opposite account transfers without a lock-order deadlock', async () => {
  const tokens = [expo(), expo()];
  for (let i=0;i<2;i++) expect((await register(owners[i], tokens[i], 'original')).error).toBeNull();
  const replies = await Promise.all([register(owners[0],tokens[1],'incoming'), register(owners[1],tokens[0],'incoming')]);
  expect(replies.every(reply => !reply.error)).toBe(true);
  const rows = (await db.query('select user_id,expo_push_token from public.mobile_push_tokens where user_id=any($1::uuid[]) and is_active', [owners])).rows;
  expect(rows).toEqual(expect.arrayContaining([{user_id:owners[0],expo_push_token:tokens[1]},{user_id:owners[1],expo_push_token:tokens[0]}]));
  expect(rows).toHaveLength(2);
 });
 it('rolls back cleanup and the upsert when preference initialization fails', async () => {
  const old = expo(), incoming = expo();
  expect((await register(owners[0],old)).error).toBeNull();
  expect((await register(owners[1],incoming)).error).toBeNull();
  await db.query(`create function public.audit_registration_failure() returns trigger language plpgsql as $$ begin if new.user_id='${owners[0]}'::uuid then raise exception 'Injected preference write failure'; end if; return new; end $$`);
  await db.query('create trigger audit_registration_failure before insert on public.mobile_notification_preferences for each row execute function public.audit_registration_failure()');
  try {
   expect((await register(owners[0],incoming)).error).not.toBeNull();
   const rows=(await db.query('select user_id,expo_push_token,is_active from public.mobile_push_tokens where user_id=any($1::uuid[])',[owners])).rows;
   expect(rows).toEqual(expect.arrayContaining([{user_id:owners[0],expo_push_token:old,is_active:true},{user_id:owners[1],expo_push_token:incoming,is_active:true}]));expect(rows).toHaveLength(2);
  } finally {
   await db.query('drop trigger audit_registration_failure on public.mobile_notification_preferences');await db.query('drop function public.audit_registration_failure()');
  }
  expect((await register(owners[0],incoming)).error).toBeNull();
  const live=(await db.query('select user_id,expo_push_token from public.mobile_push_tokens where user_id=any($1::uuid[]) and is_active',[owners])).rows;
  expect(live).toEqual([{user_id:owners[0],expo_push_token:incoming}]);
 });
 it('keeps an existing paused preference and reuses the token row on idempotent registration',async()=>{
  const token=expo();const first=await register(owners[0],token);expect(first.error).toBeNull();
  await db.query('update public.mobile_notification_preferences set push_enabled=false,social_enabled=false where user_id=$1',[owners[0]]);
  const again=await register(owners[0],token);expect(again.error).toBeNull();expect(again.data).toBe(first.data);
  expect((await db.query('select push_enabled,social_enabled from public.mobile_notification_preferences where user_id=$1',[owners[0]])).rows).toEqual([{push_enabled:false,social_enabled:false}]);
 });
 it('refuses unauthenticated RPC access and invalid values without changing tokens',async()=>{
  expect((await anon.rpc('register_mobile_push_token',{p_user_id:owners[0],p_expo_push_token:expo(),p_platform:'ios'})).error).not.toBeNull();
  for(const args of [{p_expo_push_token:'bad'},{p_platform:'web'},{p_user_id:randomUUID()}]) {
   expect((await admin.rpc('register_mobile_push_token',{p_user_id:owners[0],p_expo_push_token:expo(),p_platform:'ios',...args})).error).not.toBeNull();
  }
  expect((await db.query('select id from public.mobile_push_tokens where user_id=any($1::uuid[])',[owners])).rows).toEqual([]);
 });
});
