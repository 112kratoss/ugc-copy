import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fork, type ChildProcess} from 'node:child_process';
import {Client} from 'pg';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {it,expect,vi} from 'vitest';
import {finalizeUploadForConsumption} from '@/lib/upload-finalization';
import {completeUploadByteConsumption} from '@/lib/upload-byte-admission';
import {reclaimAbandonedMediaUploads} from '@/lib/media-upload-reclaim-service';
it.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL).each(['active', 'late-reader', 'claim-error', 'remove-error', 'lost-ack', 'unknown', 'worker-death'] as const)('fences upload reclaim against consumption: %s',async(mode)=>{
 const cfg=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!,'utf8'));
 const connectionString=process.env.SUPABASE_TEST_DB_URL!;
 expect(['localhost','127.0.0.1']).toContain(new URL(cfg.API_URL).hostname); expect(['localhost','127.0.0.1']).toContain(new URL(connectionString).hostname);
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',cfg.API_URL);
 const db=new Client({connectionString,statement_timeout:10000});await db.connect();
 let armed=false,injected=false;
 let worker: ChildProcess | undefined;
 const admin: SupabaseClient = createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:async(input,init)=>{
  const u=new URL(input instanceof Request?input.url:String(input));
  if(u.origin!==new URL(cfg.API_URL).origin)throw Error('External calls forbidden');
  const claim=u.pathname==='/rest/v1/rpc/claim_media_upload_intents_for_reclaim';
  const removal=init?.method==='DELETE' && u.pathname==='/storage/v1/object/uploads';
  if(armed && !injected && ((claim && mode==='claim-error') || (removal && ['remove-error','lost-ack'].includes(mode)))){
   injected=true;
   if(mode==='lost-ack')expect((await fetch(input,init)).ok).toBe(true);
   return new Response(JSON.stringify({message:'Injected reclaim failure',error:'injected',statusCode:503,code:'XX000'}),{status:503,headers:{'Content-Type':'application/json'}});
  }
  const response=await fetch(input,init);
  if(armed && !injected && claim && response.ok && mode==='late-reader'){
   injected=true;
   const late=await finalizeUploadForConsumption(admin,{bucket:'uploads',storagePath:path,userId:owner,disposition:'draft'});
   expect(late.ok).toBe(false);
  }
  return response;
 }}});
 const owner=randomUUID(),upload=randomUUID(),intent=randomUUID(),path=owner+'/lease.png';
 try{
  expect((await db.query("select id from public.media_upload_intents where consumed_by is not null and storage_cleared_at is null and created_at<now()-interval '48 hours'")).rows).toEqual([]);
  await db.query("insert into auth.users(id,email,aud,role,created_at)values($1,$2,'authenticated','authenticated',now())",[owner,owner+'@reclaim-lease.invalid']);
  const reserved=await db.query("select public.reserve_upload_bytes_v2($1,$2,'uploads',$3,22,262144000,'image/png',1073741824,107374182400,7200) result",[upload,owner,path]);
  expect(reserved.rows[0].result.reason).toBe('reserved');
  expect((await db.query('select public.mark_upload_byte_reservation_issued($1,$2,7200) issued',[upload,owner])).rows[0].issued).toBe(true);
  expect((await admin.storage.from('uploads').upload(path,new Blob(['local disposable bytes'],{type:'image/png'}))).error).toBeNull();
  const first=await finalizeUploadForConsumption(admin,{bucket:'uploads',storagePath:path,userId:owner,disposition:'draft'});
  expect(first.ok).toBe(true);if(!first.ok||!first.consumptionClaim)throw Error('Missing first claim');
  expect((await completeUploadByteConsumption(admin,{claim:first.consumptionClaim,disposition:'draft'})).ok).toBe(true);
  await db.query("insert into public.media_upload_intents(id,user_id,storage_path,kind,created_at,consumed_at,consumed_by)values($1,$2,$3,'image',now()-interval '72 hours',now()-interval '71 hours','generation_input')",[intent,owner,path]);
  const reuse=await finalizeUploadForConsumption(admin,{bucket:'uploads',storagePath:path,userId:owner,disposition:'draft'});
  expect(reuse.ok).toBe(true);if(!reuse.ok||!reuse.consumptionClaim)throw Error('Missing reuse claim');
  const before=(await db.query('select finalization_status,consumption_lease_id is not null leased,consumption_lease_expires_at>now() active from public.upload_byte_reservations where id=$1',[upload])).rows;
  expect(before).toEqual([{finalization_status:'consuming',leased:true,active:true}]);
  expect((await admin.storage.from('uploads').download(path)).error).toBeNull();
  if(mode!=='active')expect((await completeUploadByteConsumption(admin,{claim:reuse.consumptionClaim,disposition:'draft'})).ok).toBe(true);
  if(mode==='unknown')await db.query('update public.upload_byte_reservations set consumption_outcome_unknown_at=now() where id=$1',[upload]);
  armed=true;
  if(mode==='worker-death'){
   worker=fork('src/__tests__/media-upload-reclaim-worker.cjs',[],{execArgv:['--import','tsx'],silent:true,env:{NODE_ENV:'test',PATH:process.env.PATH,TSX_TSCONFIG_PATH:'tsconfig.mobile-push-worker.json',AUDIT_STORAGE_CONFIG:process.env.AUDIT_STORAGE_CONFIG,AUDIT_RECLAIM_PHASE:'after-claim'}});
   worker.stdout?.resume();worker.stderr?.resume();
   const closed=new Promise<NodeJS.Signals|null>(resolve=>worker!.once('close',(_code,signal)=>resolve(signal)));
   await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Reclaim worker checkpoint timed out')),20000);
    worker!.once('error',error=>{clearTimeout(timer);reject(error);});
    worker!.once('exit',()=>{clearTimeout(timer);reject(Error('Reclaim worker exited before checkpoint'));});
    worker!.once('message',message=>{clearTimeout(timer);if((message as {stage:string}).stage==='after-claim')resolve();else reject(Error('Unexpected reclaim checkpoint'));});
   });
   worker.kill('SIGKILL');expect(await closed).toBe('SIGKILL');
  }
  else if(mode==='claim-error')await expect(reclaimAbandonedMediaUploads(admin)).rejects.toThrow('Injected reclaim failure');
  else await reclaimAbandonedMediaUploads(admin);
  armed=false;
  if(['claim-error','remove-error','lost-ack','late-reader'].includes(mode))expect(injected).toBe(true);
  const state=(await db.query("select r.finalization_status,r.released_at is null charged,i.storage_cleared_at is not null cleared,exists(select 1 from storage.objects where bucket_id='uploads' and name=$2) object_exists from public.upload_byte_reservations r cross join public.media_upload_intents i where r.id=$1 and i.id=$3",[upload,path,intent])).rows[0];
  expect(state).toEqual({finalization_status:mode==='active'?'consuming':['unknown','claim-error'].includes(mode)?'consumed':'deleted',charged:true,cleared:mode==='late-reader',object_exists:!['late-reader','lost-ack'].includes(mode)});
  expect((await db.query('select outstanding_bytes::text bytes from public.upload_byte_user_counters where user_id=$1',[owner])).rows).toEqual([{bytes:['active','unknown','claim-error'].includes(mode)?'22':'262144000'}]);
  expect((await admin.storage.from('uploads').download(path)).error===null).toBe(state.object_exists);
  if(mode==='unknown'){
   expect((await reclaimAbandonedMediaUploads(admin)).kept).toBe(1);
   expect((await admin.storage.from('uploads').download(path)).error).toBeNull();
   return;
  }
  if(mode==='active')expect((await completeUploadByteConsumption(admin,{claim:reuse.consumptionClaim,disposition:'draft'})).ok).toBe(true);
  await reclaimAbandonedMediaUploads(admin);
  expect((await admin.storage.from('uploads').download(path)).error).not.toBeNull();
  expect((await db.query('select finalization_status,released_at is null charged from public.upload_byte_reservations where id=$1',[upload])).rows).toEqual([{finalization_status:'deleted',charged:true}]);
  expect((await reclaimAbandonedMediaUploads(admin)).scanned).toBe(0);
 }finally{
  armed=false;
  if(worker && worker.exitCode===null && worker.signalCode===null){
   const closed=new Promise<void>(resolve=>worker!.once('close',()=>resolve()));
   worker.kill('SIGKILL');await closed;
  }
  expect((await admin.storage.from('uploads').remove([path])).error).toBeNull();
  // Isolated fixture teardown only: bypass the delete guard inside a local DDL
  // transaction, retaining the ordinary DELETE counter trigger and exact IDs.
  await db.query('begin');
  try{
   await db.query('alter table public.upload_byte_reservations disable trigger upload_byte_reservations_guard_delete');
   await db.query('delete from public.upload_byte_reservations where id=$1 and user_id=$2',[upload,owner]);
   await db.query('alter table public.upload_byte_reservations enable trigger upload_byte_reservations_guard_delete');
   await db.query("delete from public.upload_path_tombstones where bucket_id='uploads' and storage_path=$1 and owner_user_id=$2",[path,owner]);
   await db.query('delete from public.upload_byte_user_counters where user_id=$1 and outstanding_bytes=0',[owner]);
   await db.query('delete from auth.users where id=$1',[owner]);
   await db.query('commit');
  }catch(e){await db.query('rollback');throw e;}
  const cleanup=(await db.query("select(select count(*)from auth.users where id=$1)::int users,(select count(*)from public.upload_byte_reservations where id=$2)::int reservations,(select count(*)from public.media_upload_intents where id=$3)::int intents,(select count(*)from storage.objects where bucket_id='uploads' and name=$4)::int objects",[owner,upload,intent,path])).rows;
  expect(cleanup).toEqual([{users:0,reservations:0,intents:0,objects:0}]);
  expect((await db.query('select public.reconcile_upload_byte_admission_counters(false) result')).rows[0].result.status).toBe('ok');
  await db.end();vi.unstubAllEnvs();
 }
});
