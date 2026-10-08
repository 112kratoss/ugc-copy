import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createClient} from '@supabase/supabase-js';
import {it,expect,vi} from 'vitest';
import {reclaimAbandonedMediaUploads} from '@/lib/media-upload-reclaim-service';
it.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL)('advances past a full batch of protected uploads',async()=>{
 const cfg=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!,'utf8')),url=process.env.SUPABASE_TEST_DB_URL!;
 expect(['localhost','127.0.0.1']).toContain(new URL(cfg.API_URL).hostname);expect(['localhost','127.0.0.1']).toContain(new URL(url).hostname);
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',cfg.API_URL);
 const originalFetch=globalThis.fetch;
 vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
  const target=new URL(input instanceof Request?input.url:String(input));if(target.origin!==new URL(cfg.API_URL).origin)throw Error('External calls forbidden');return originalFetch(input,init);
 });
 const db=new Client({connectionString:url,statement_timeout:10000});await db.connect();
 const admin=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 const user=randomUUID(),paths=Array.from({length:501},(_,i)=>user+'/'+String(i).padStart(3,'0')+'.png');
 try{
  expect((await db.query("select id from public.media_upload_intents where consumed_by is not null and storage_cleared_at is null and created_at<now()-interval '48 hours'")).rows).toEqual([]);
  await db.query("insert into auth.users(id,email,aud,role,created_at)values($1,$2,'authenticated','authenticated',now())",[user,user+'@reclaim-progress.invalid']);
  for(let start=0;start<paths.length;start+=10)await Promise.all(paths.slice(start,start+10).map(async path=>expect((await admin.storage.from('uploads').upload(path,new Blob(['inert'],{type:'image/png'}))).error).toBeNull()));
  await db.query("insert into public.media_upload_intents(user_id,storage_path,kind,declared_bytes,created_at,consumed_at,consumed_by) select $1::uuid,$1::uuid::text||'/'||lpad(n::text,3,'0')||'.png','image',5,now()-interval '72 hours'+make_interval(secs=>n),now()-interval '71 hours','generation_input' from generate_series(0,500) n",[user]);
  const protectedPaths=new Set(paths.slice(0,500));
  const first=await reclaimAbandonedMediaUploads(admin,{protectedPaths});const second=await reclaimAbandonedMediaUploads(admin,{protectedPaths});
  expect(first).toMatchObject({scanned:500,reclaimed:0,protectedLegacyReferences:500});
  expect(second).toMatchObject({scanned:500,reclaimed:1,protectedLegacyReferences:499});
  const result=(await db.query("select count(*) filter(where storage_cleared_at is not null)::int cleared,count(*) filter(where storage_cleared_at is null)::int uncleared from public.media_upload_intents where user_id=$1",[user])).rows;
  expect(result).toEqual([{cleared:1,uncleared:500}]);
  // All 500 become reclaimable once the owning references are gone. This also
  // exercises bounded URL filters for both scan markers and final bookkeeping.
  expect((await reclaimAbandonedMediaUploads(admin,{protectedPaths:new Set()})).reclaimed).toBe(500);
  expect((await db.query('select count(*)::int count from public.media_upload_intents where user_id=$1 and storage_cleared_at is null',[user])).rows).toEqual([{count:0}]);
  expect((await reclaimAbandonedMediaUploads(admin,{protectedPaths:new Set()})).scanned).toBe(0);
  expect((await db.query("select count(*)::int count from storage.objects where bucket_id='uploads' and name like $1",[user+'/%'])).rows).toEqual([{count:0}]);

 }finally{
  for(let start=0;start<paths.length;start+=100)expect((await admin.storage.from('uploads').remove(paths.slice(start,start+100))).error).toBeNull();
  await db.query('delete from auth.users where id=$1',[user]);
  const cleanup=(await db.query("select(select count(*)from auth.users where id=$1)::int users,(select count(*)from public.media_upload_intents where user_id=$1)::int intents,(select count(*)from storage.objects where bucket_id='uploads' and name like $2)::int objects",[user,user+'/%'])).rows;
  expect(cleanup).toEqual([{users:0,intents:0,objects:0}]);
  await db.end();vi.restoreAllMocks();vi.unstubAllEnvs();
 }
},30000);
