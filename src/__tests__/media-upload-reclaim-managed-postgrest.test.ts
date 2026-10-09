import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createClient} from '@supabase/supabase-js';
import {it,expect,vi} from 'vitest';
import {runMediaUploadReclaimBackendJob} from '@/lib/backend-job-executions';
it.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL).each(['empty','eligibility-error','intent-error','repair-error','claim-error','locked','normal'] as const)('persists staged cleanup job outcome: %s',async(mode)=>{
 const cfg=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!,'utf8'));
 const connectionString=process.env.SUPABASE_TEST_DB_URL!;
 expect(['localhost','127.0.0.1']).toContain(new URL(cfg.API_URL).hostname);expect(['localhost','127.0.0.1']).toContain(new URL(connectionString).hostname);
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',cfg.API_URL);
 const db=new Client({connectionString,statement_timeout:10000});await db.connect();
 let armed=false,injected=false;
 const admin=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:(input,init)=>{
  const u=new URL(input instanceof Request?input.url:String(input));if(u.origin!==new URL(cfg.API_URL).origin)throw Error('External calls forbidden');
  if(u.pathname==='/rest/v1/rpc/prune_backend_job_runs')throw Error('Unexpected global prune');
  const legacy=u.pathname==='/rest/v1/rpc/list_generations_missing_durable_input_media';
  const intent=u.pathname==='/rest/v1/media_upload_intents' && (!init?.method||init.method==='GET');
  const claim=u.pathname==='/rest/v1/rpc/claim_media_upload_intents_for_reclaim';
  if(armed && ((legacy&&['eligibility-error','repair-error'].includes(mode))||(intent&&mode==='intent-error')||(claim&&mode==='claim-error'))){injected=true;return Promise.resolve(new Response(JSON.stringify({code:'XX000',message:'Injected job lookup failure'}),{status:503,headers:{'Content-Type':'application/json'}}));}
  return fetch(input,init);
 }}});
 const requestIds=[randomUUID(),randomUUID(),randomUUID()].map(id=>'audit-reclaim-job-'+id);
 const owner=randomUUID(),intent=randomUUID(),path=owner+'/job.png',lockOwner='audit-reclaim-lock-'+randomUUID();
 const hasObject=['repair-error','claim-error','locked','normal'].includes(mode);
 // Avoid the unrelated global run-history prune window; use the current hour.
 const now=new Date();now.setUTCMinutes(10,0,0);
 const run=(index:number)=>runMediaUploadReclaimBackendJob({serviceClient:admin,requestId:requestIds[index],startedAtMs:now.getTime()});
 try{
  expect((await db.query("select name from public.backend_job_locks where name='media-upload-reclaim'")).rows).toEqual([]);
  expect((await db.query("select id from public.media_upload_intents where consumed_by is not null and storage_cleared_at is null and created_at<now()-interval '48 hours'")).rows).toEqual([]);
  const legacy=await admin.rpc('list_generations_missing_durable_input_media',{p_limit:1,p_max_attempts:3,p_created_before:new Date(Date.now()-3600000).toISOString()});
  expect(legacy.error).toBeNull();expect(legacy.data).toEqual([]);
  if(hasObject){
   await db.query("insert into auth.users(id,email,aud,role,created_at)values($1,$2,'authenticated','authenticated',now())",[owner,owner+'@reclaim-job.invalid']);
   expect((await admin.storage.from('uploads').upload(path,new Blob(['owned cleanup fixture'],{type:'image/png'}))).error).toBeNull();
   await db.query("insert into public.media_upload_intents(id,user_id,storage_path,kind,created_at,consumed_at,consumed_by)values($1,$2,$3,'image',now()-interval '72 hours',now(),'generation_input')",[intent,owner,path]);
  }
  if(mode==='locked')expect(await admin.rpc('try_acquire_backend_job_lock',{p_name:'media-upload-reclaim',p_ttl_seconds:60,p_locked_by:lockOwner})).toMatchObject({data:true,error:null});
  armed=true;
  const first=await run(0);armed=false;
  const failed=['eligibility-error','intent-error','repair-error','claim-error'].includes(mode);
  const expectedStatus=failed?'failed':mode==='normal'?'succeeded':'skipped';
  expect(first).toMatchObject({success:!failed,status:expectedStatus});
  expect(injected).toBe(failed);
  const persisted=(await db.query('select status,skip_reason,error_message,summary from public.backend_job_runs where request_id=$1',[requestIds[0]])).rows;
  expect(persisted).toHaveLength(1);expect(persisted[0].status).toBe(expectedStatus);
  if(failed)expect(persisted[0].error_message).toBe('Injected job lookup failure');
  if(mode==='empty')expect(persisted[0]).toMatchObject({skip_reason:'no_reclaimable_media_uploads',summary:{abandonedReclaimEnabled:false}});
  if(mode==='locked'){
   expect(persisted[0].skip_reason).toBe('already_running');
   expect((await db.query("select locked_by from public.backend_job_locks where name='media-upload-reclaim'")).rows).toEqual([{locked_by:lockOwner}]);
   expect(await admin.rpc('release_backend_job_lock',{p_name:'media-upload-reclaim',p_locked_by:lockOwner})).toMatchObject({data:true,error:null});
  }else expect((await db.query("select name from public.backend_job_locks where name='media-upload-reclaim'")).rows).toEqual([]);
  if(hasObject)expect((await admin.storage.from('uploads').download(path)).error===null).toBe(mode!=='normal');
  const retry=await run(1);
  expect(retry).toMatchObject({success:true,status:hasObject&&mode!=='normal'?'succeeded':'skipped'});
  if(hasObject){expect((await admin.storage.from('uploads').download(path)).error).not.toBeNull();expect((await db.query('select storage_cleared_at is not null cleared from public.media_upload_intents where id=$1',[intent])).rows).toEqual([{cleared:true}]);}
  expect(await run(2)).toMatchObject({success:true,status:'skipped',reason:'no_reclaimable_media_uploads'});
  expect((await db.query('select status from public.backend_job_runs where request_id=any($1::text[])',[requestIds])).rows).toHaveLength(3);
 }finally{
  armed=false;
  await admin.rpc('release_backend_job_lock',{p_name:'media-upload-reclaim',p_locked_by:lockOwner});
  expect((await admin.storage.from('uploads').remove([path])).error).toBeNull();
  await db.query('delete from auth.users where id=$1',[owner]);
  await db.query('delete from public.backend_job_runs where request_id=any($1::text[])',[requestIds]);
  expect((await db.query("select(select count(*)from auth.users where id=$1)::int users,(select count(*)from public.media_upload_intents where id=$2)::int intents,(select count(*)from storage.objects where bucket_id='uploads' and name=$3)::int objects,(select count(*)from public.backend_job_runs where request_id=any($4::text[]))::int runs,(select count(*)from public.backend_job_locks where name='media-upload-reclaim')::int locks",[owner,intent,path,requestIds])).rows).toEqual([{users:0,intents:0,objects:0,runs:0,locks:0}]);
  await db.end();vi.unstubAllEnvs();
 }
},30000);
