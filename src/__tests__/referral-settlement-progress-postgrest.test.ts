import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createClient} from '@supabase/supabase-js';
import {it,expect,vi} from 'vitest';
import {reconcileReferralPurchaseRewards,ReferralRewardReconciliationError} from '@/lib/referral-reward-reconciliation';
it.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL)('makes bounded progress past a full batch of persistent settlement failures',async()=>{
 const config=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!,'utf8'));
 const connectionString=process.env.SUPABASE_TEST_DB_URL!;
 expect(['localhost','127.0.0.1']).toContain(new URL(config.API_URL).hostname);
 expect(['localhost','127.0.0.1']).toContain(new URL(connectionString).hostname);
 const nativeFetch=globalThis.fetch;
 vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
  if(new URL(input instanceof Request?input.url:String(input)).origin!==new URL(config.API_URL).origin)throw Error('External calls forbidden');
  return nativeFetch(input,init);
 });
 const db=new Client({connectionString,statement_timeout:10000});await db.connect();
 const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 const users=Array.from({length:4},()=>randomUUID()), program=randomUUID(), codes=[randomUUID(),randomUUID()], visits=[randomUUID(),randomUUID()], attrs=[randomUUID(),randomUUID()];
 const bad=Array.from({length:100},()=>randomUUID()),good=randomUUID(),transactions=[...bad,good];
 try{
  const initial=await admin.rpc('list_unsettled_referral_purchase_transactions',{p_limit:100});expect(initial.error).toBeNull();expect(initial.data).toEqual([]);
  await db.query("insert into auth.users(id,email,aud,role,created_at) select id,id::text||'@referral-progress.invalid','authenticated','authenticated',now() from unnest($1::uuid[]) id",[users]);
  await db.query('update public.profiles set credits=0,promotional_credits=0 where id=any($1::uuid[])',[users]);
  await db.query('update public.profiles set credits=2147483647 where id=$1',[users[0]]);
  await db.query("insert into public.referral_programs(id,version,name,status,inviter_reward_bps,invitee_reward_bps) values($1,(select max(version)+1 from public.referral_programs),'Local progress audit','paused',500,500)",[program]);
  for(let i=0;i<2;i++){
   await db.query('insert into public.referral_codes(id,user_id,code) values($1,$2,$3)',[codes[i],users[i*2],randomUUID().replaceAll('-','').slice(0,16)]);
   await db.query("insert into public.referral_visits(id,referral_code_id,program_id,inviter_user_id,channel,expires_at) values($1,$2,$3,$4,'web',now()+interval '1 day')",[visits[i],codes[i],program,users[i*2]]);
   await db.query('insert into public.referral_attributions(id,program_id,referral_visit_id,inviter_user_id,invitee_user_id) values($1,$2,$3,$4,$5)',[attrs[i],program,visits[i],users[i*2],users[i*2+1]]);
  }
  await db.query("insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,credit_purchase_succeeded_at,updated_at) select id,$2,'audit-progress-'||id::text,41500,500,'success',now()-interval '1 day',now()-interval '1 day' from unnest($1::uuid[]) id",[bad,users[1]]);
  await db.query("insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,credit_purchase_succeeded_at) values($1,$2,$3,41500,500,'success',now())",[good,users[3],'audit-progress-'+good]);
  const passes=[];
  for(let pass=0;pass<2;pass++){
   try{passes.push(await reconcileReferralPurchaseRewards(admin));}
   catch(error){expect(error).toBeInstanceOf(ReferralRewardReconciliationError);passes.push((error as ReferralRewardReconciliationError).summary);}
  }
  const rows=(await db.query('select transaction_id from public.referral_purchase_events where transaction_id=$1',[good])).rows;
  expect(rows).toHaveLength(1);
  expect(passes.map(p=>({processed:p.processed,failed:p.failed,settled:p.settled}))).toEqual([
   {processed:100,failed:100,settled:0},{processed:1,failed:0,settled:1}
  ]);
  expect((await db.query('select count(*)::int n from public.referral_purchase_reconciliation_retries where transaction_id=any($1::uuid[]) and attempts=1 and next_attempt_at>now()',[bad])).rows).toEqual([{n:100}]);
  const deferredAgain=await admin.rpc('defer_referral_purchase_reconciliation',{p_transaction_id:bad[0]});
  expect(deferredAgain.error).toBeNull();expect(deferredAgain.data).toMatchObject({status:'deferred',attempts:2});
  expect((await db.query("select next_attempt_at>now()+interval '110 seconds' as backed_off from public.referral_purchase_reconciliation_retries where transaction_id=$1",[bad[0]])).rows).toEqual([{backed_off:true}]);
  await db.query('update public.referral_purchase_reconciliation_retries set attempts=2147483647 where transaction_id=$1',[bad[0]]);
  const capped=await admin.rpc('defer_referral_purchase_reconciliation',{p_transaction_id:bad[0]});expect(capped.error).toBeNull();expect(capped.data).toMatchObject({attempts:2147483647});
  expect((await db.query("select next_attempt_at<=now()+interval '1 hour' and next_attempt_at>now()+interval '59 minutes' as capped from public.referral_purchase_reconciliation_retries where transaction_id=$1",[bad[0]])).rows).toEqual([{capped:true}]);
  // The failed rows remain recoverable after the underlying cause is removed.
  await db.query('update public.profiles set credits=0 where id=$1',[users[0]]);
  await db.query("update public.referral_purchase_reconciliation_retries set next_attempt_at=now()-interval '1 second' where transaction_id=any($1::uuid[])",[bad]);
  // Independent direct foreground settlement also clears durable retry state.
  const foreground=await admin.rpc('settle_referral_purchase_rewards',{p_transaction_id:bad[0]});expect(foreground.error).toBeNull();
  expect((await db.query('select transaction_id from public.referral_purchase_reconciliation_retries where transaction_id=$1',[bad[0]])).rows).toEqual([]);
  expect(await reconcileReferralPurchaseRewards(admin)).toMatchObject({processed:99,failed:0,settled:99});
  expect((await db.query('select count(*)::int n from public.referral_purchase_events where transaction_id=any($1::uuid[])',[transactions])).rows).toEqual([{n:101}]);
  expect((await db.query('select transaction_id from public.referral_purchase_reconciliation_retries where transaction_id=any($1::uuid[])',[transactions])).rows).toEqual([]);
  expect((await db.query('select credits,promotional_credits from public.profiles where id=$1',[users[0]])).rows).toEqual([{credits:2500,promotional_credits:2500}]);
  // A stale/lost response cannot recreate retry work after a committed grant.
  expect((await admin.rpc('defer_referral_purchase_reconciliation',{p_transaction_id:good})).data).toMatchObject({status:'already_settled'});

 }finally{
  await db.query('begin');
  try{
   await db.query('set local session_replication_role=replica');
   await db.query('delete from public.referral_reward_notification_outbox where ledger_id in(select id from public.referral_credit_ledger where transaction_id=any($1::uuid[]))',[transactions]);
   for(const table of ['referral_purchase_reconciliation_retries','referral_credit_ledger','referral_reward_adjustments','referral_rewards','referral_purchase_events'])await db.query(`delete from public.${table} where transaction_id=any($1::uuid[])`,[transactions]);
   await db.query('delete from public.transactions where id=any($1::uuid[])',[transactions]);
   await db.query('delete from public.referral_attributions where id=any($1::uuid[])',[attrs]);
   await db.query('delete from public.referral_visits where id=any($1::uuid[])',[visits]);
   await db.query('delete from public.referral_codes where id=any($1::uuid[])',[codes]);
   await db.query('delete from public.referral_programs where id=$1',[program]);
   await db.query('set local session_replication_role=origin');
   await db.query('delete from auth.users where id=any($1::uuid[])',[users]);
   await db.query('commit');
  }catch(error){await db.query('rollback');throw error;}
  const cleanup=(await db.query('select (select count(*) from auth.users where id=any($1::uuid[]))::int users,(select count(*) from public.transactions where id=any($2::uuid[]))::int transactions,(select count(*) from public.referral_programs where id=$3)::int programs',[users,transactions,program])).rows;
  expect(cleanup).toEqual([{users:0,transactions:0,programs:0}]);await db.end();vi.restoreAllMocks();
 }
},30000);
