import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createClient} from '@supabase/supabase-js';
import {it,expect,vi} from 'vitest';
import {repairPostMediaRenditions} from '@/lib/media-preview-repair';
it.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL).each(['normal','owner','attempt','terminal','release-error','lost-ack'] as const)('preserves unstarted rendition work and lease fencing: %s',async(mode)=>{
 const cfg=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!,'utf8')),url=process.env.SUPABASE_TEST_DB_URL!;
 expect(['localhost','127.0.0.1']).toContain(new URL(cfg.API_URL).hostname);expect(['localhost','127.0.0.1']).toContain(new URL(url).hostname);
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',cfg.API_URL);
 const originalFetch=globalThis.fetch,downloads:string[]=[];
 let injected=false;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const target=new URL(input instanceof Request?input.url:String(input));if(target.origin!==new URL(cfg.API_URL).origin)throw Error('External calls forbidden');
  if(target.pathname.includes('/storage/v1/object/'))downloads.push(target.pathname);
  const isRelease=init?.method==='PATCH'&&target.pathname.endsWith('/post_media')&&typeof init.body==='string'&&JSON.parse(init.body).rendition_status==='pending';
  if(isRelease&&mode!=='normal'&&!injected){
   injected=true;
   if(mode==='owner')await db.query('update public.post_media set rendition_locked_by=$2 where id=$1',[media[1],'new-owner']);
   if(mode==='attempt')await db.query('update public.post_media set rendition_attempt_count=2 where id=$1',[media[1]]);
   if(mode==='terminal')await db.query("update public.post_media set rendition_status='failed',rendition_locked_by=null,rendition_locked_at=null where id=$1",[media[1]]);
   if(mode==='release-error'||mode==='lost-ack'){
    if(mode==='lost-ack')expect((await originalFetch(input,init)).ok).toBe(true);
    return new Response(JSON.stringify({code:'XX000',message:'Injected local release transport failure'}),{status:503,headers:{'Content-Type':'application/json'}});
   }
  }
  return originalFetch(input,init);
 });
 const db=new Client({connectionString:url,statement_timeout:10000});await db.connect();
 const admin=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 const user=randomUUID(),post=randomUUID(),media=[randomUUID(),randomUUID()];
 try{
  expect((await db.query("select id from public.post_media where media_kind='video' and rendition_status in('pending','processing','failed') and rendition_attempt_count<3")).rows).toEqual([]);
  await db.query("insert into auth.users(id,email,aud,role,created_at)values($1,$2,'authenticated','authenticated',now())",[user,user+'@media-budget.invalid']);
  await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,post_format,showcase_asset_path)values($1,$2,'private','video','manual','media',$3)",[post,user,'posts/'+post+'/first.mp4']);
  for(let i=0;i<2;i++)await db.query("insert into public.post_media(id,post_id,storage_path,media_kind,content_type,sort_order,preview_status,rendition_status,rendition_attempt_count,created_at)values($1,$2,$3,'video','video/mp4',$4,'pending','pending',0,now()+make_interval(secs=>$4::integer))",[media[i],post,'posts/'+post+'/'+i+'.mp4',i]);
  // A missing source is a real Storage404. No fake encoder or synthetic clock.
  const operation=repairPostMediaRenditions(admin,{batchSize:2,timeBudgetMs:0,lockedBy:'budget-audit-'+post});
  if(mode==='release-error'||mode==='lost-ack'){
   await expect(operation).rejects.toMatchObject({message:'Injected local release transport failure'});
   expect(injected).toBe(true);expect(downloads).toHaveLength(1);
   const remaining=(await db.query('select rendition_status,rendition_attempt_count,rendition_locked_by from public.post_media where id=$1',[media[1]])).rows;
   expect(remaining).toEqual([mode==='lost-ack'?{rendition_status:'pending',rendition_attempt_count:0,rendition_locked_by:null}:{rendition_status:'processing',rendition_attempt_count:1,rendition_locked_by:'budget-audit-'+post}]);
   return;
  }
  const summary=await operation;
  expect(summary).toEqual({attempted:1,completed:0,failed:1});
  expect(downloads).toHaveLength(1);
  const rows=(await db.query('select id,rendition_status,rendition_attempt_count,rendition_locked_by from public.post_media where post_id=$1 order by sort_order',[post])).rows;
  if(mode!=='normal'){
   expect(injected).toBe(true);
   expect(rows[1]).toMatchObject({rendition_status:mode==='terminal'?'failed':'processing',rendition_attempt_count:mode==='attempt'?2:1,rendition_locked_by:mode==='terminal'?null:mode==='owner'?'new-owner':'budget-audit-'+post});
   return;
  }
  expect(rows[1]).toMatchObject({rendition_status:'pending',rendition_attempt_count:0,rendition_locked_by:null});
  for(let pass=0;pass<2;pass++)expect(await repairPostMediaRenditions(admin,{batchSize:2,timeBudgetMs:0,lockedBy:'budget-repeat-'+post+'-'+pass})).toEqual({attempted:1,completed:0,failed:1});
  expect(downloads).toHaveLength(3);
  expect((await db.query('select rendition_status,rendition_attempt_count,rendition_locked_by from public.post_media where id=$1',[media[1]])).rows).toEqual([{rendition_status:'pending',rendition_attempt_count:0,rendition_locked_by:null}]);
  // The untouched row remains eligible after the older failure exhausts its budget.
  expect(await repairPostMediaRenditions(admin,{batchSize:2,timeBudgetMs:0,lockedBy:'budget-last-'+post})).toEqual({attempted:1,completed:0,failed:1});
  expect(downloads).toHaveLength(4);expect(downloads[3]).toContain('/1.mp4');
  expect((await db.query('select rendition_attempt_count from public.post_media where post_id=$1 order by sort_order',[post])).rows).toEqual([{rendition_attempt_count:3},{rendition_attempt_count:1}]);
 }finally{
  await db.query('delete from public.post_media where post_id=$1',[post]);
  await db.query('delete from public.posts where id=$1',[post]);await db.query('delete from auth.users where id=$1',[user]);
  const cleanup=(await db.query('select(select count(*)from auth.users where id=$1)::int users,(select count(*)from public.posts where id=$2)::int posts,(select count(*)from public.post_media where post_id=$2)::int media',[user,post])).rows;
  expect(cleanup).toEqual([{users:0,posts:0,media:0}]);
  await db.end();vi.restoreAllMocks();vi.unstubAllEnvs();
 }
});
