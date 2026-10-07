import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { processShowcaseMediaRevocations } from '@/lib/showcase-media-revocations';

const configPath=process.env.AUDIT_STORAGE_CONFIG, connectionString=process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath||!connectionString)('background showcase revocation through actual SQL and Storage',()=>{
  let db:Client,admin:SupabaseClient,originalFetch:typeof fetch;
  let owner:string,generationId:string,postId:string,paths:string[];
  let intercept:((url:URL,method:string,target:Parameters<typeof fetch>[0],init?:RequestInit)=>Promise<Response|null>)|null=null;
  const bytes=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64'));
  beforeAll(async()=>{
    const config=JSON.parse(readFileSync(configPath!,'utf8'));
    expect(['localhost','127.0.0.1']).toContain(new URL(config.API_URL).hostname);expect(['localhost','127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',config.API_URL);vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY',config.ANON_KEY);vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY',config.SERVICE_ROLE_KEY);
    originalFetch=globalThis.fetch;
    vi.spyOn(globalThis,'fetch').mockImplementation(async(target,init)=>{
      const url=new URL(target instanceof Request?target.url:String(target));
      if(url.origin!==new URL(config.API_URL).origin)throw Error('External network forbidden in local revocation controls');
      const method=init?.method??(target instanceof Request?target.method:'GET');
      return await intercept?.(url,method,target,init)??originalFetch(target,init);
    });
    admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    db=new Client({connectionString,statement_timeout:10000});await db.connect();
  });
  afterAll(async()=>{await db?.end();vi.restoreAllMocks();vi.unstubAllEnvs();});
  beforeEach(async()=>{
    intercept=null;paths=[];
    expect((await db.query('select count(*)::int as count from public.showcase_media_revocations')).rows[0].count).toBe(0);
    const made=await admin.auth.admin.createUser({email:`revocation-audit-${randomUUID()}@example.invalid`,password:randomUUID()+'aZ7!',email_confirm:true});expect(made.error).toBeNull();owner=made.data.user!.id;
    await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1',[owner]);
    generationId=randomUUID();postId=randomUUID();
    await db.query("insert into public.generations(id,user_id,status,model,category,cost,is_public) values($1,$2,'succeeded','audit-inert','image',0,false)",[generationId,owner]);
    for(const name of ['cover','source','preview','rendition','display','teaser']){
      const path=`showcase/${generationId}/${name}.png`;paths.push(path);
      expect((await admin.storage.from('showcase_media').upload(path,new Blob([bytes],{type:'image/png'}),{contentType:'image/png'})).error).toBeNull();
    }
    await db.query("insert into public.posts(id,user_id,generation_id,visibility,category,source_kind,review_status,post_format,title,body,showcase_asset_path) values($1,$2,$3,'public','text','external','visible','text','Fixture','Fixture body long enough for public text.',$4)",[postId,owner,generationId,paths[0]]);
    await db.query("insert into public.post_media(post_id,media_kind,storage_path,preview_storage_path,rendition_storage_path,display_storage_path,teaser_storage_path,teaser_generated_at) values($1,'image',$2,$3,$4,$5,$6,now())",[postId,...paths.slice(1)]);
    await db.query("update public.posts set visibility='private',showcase_asset_path=null where id=$1",[postId]);
    await db.query("update public.showcase_media_revocations set next_attempt_at=now()-interval '1 minute' where generation_id=$1",[generationId]);
    expect((await db.query('select reason from public.showcase_media_revocations where generation_id=$1',[generationId])).rows).toEqual([{reason:'post_unexposed'}]);
  });
  afterEach(async()=>{
    try{
      expect((await db.query('select credits,promotional_credits from public.profiles where id=$1',[owner])).rows[0]).toEqual({credits:500,promotional_credits:0});
      expect((await db.query('select id from public.ai_usage_events where user_id=$1',[owner])).rows).toEqual([]);
    }finally{
      intercept=null;
      if(paths.length)expect((await admin.storage.from('showcase_media').remove(paths)).error).toBeNull();
      await db.query('delete from public.posts where id=$1',[postId]);
      await db.query('delete from public.showcase_media_revocations where generation_id=$1',[generationId]);
      await db.query('delete from public.generations where id=$1',[generationId]);
      await db.query('delete from auth.users where id=$1',[owner]);
    }
    expect((await db.query(`select
      (select count(*) from auth.users where id=$1)::int as users,
      (select count(*) from public.profiles where id=$1)::int as profiles,
      (select count(*) from public.generations where id=$2)::int as generations,
      (select count(*) from public.posts where id=$3)::int as posts,
      (select count(*) from public.post_media where post_id=$3)::int as media,
      (select count(*) from public.showcase_media_revocations where generation_id=$2)::int as revocations,
      (select count(*) from storage.objects where name=any($4::text[]))::int as objects,
      (select count(*) from public.ai_usage_events where user_id=$1)::int as usage`,[owner,generationId,postId,paths])).rows[0])
      .toEqual({users:0,profiles:0,generations:0,posts:0,media:0,revocations:0,objects:0,usage:0});
  });
  const assertRemoved=async()=>{
    for(const path of paths){const result=await admin.storage.from('showcase_media').download(path);expect(result.data,`Still fetchable: ${path}`).toBeNull();expect(result.error).not.toBeNull();}
    expect((await db.query('select id from public.post_media where post_id=$1',[postId])).rows).toEqual([]);
    expect((await db.query('select id from public.showcase_media_revocations where generation_id=$1',[generationId])).rows).toEqual([]);
  };

  it('removes the cover and every legacy variant before settling the queue',async()=>{
    expect(await processShowcaseMediaRevocations(admin,{now:new Date()})).toMatchObject({due:1,removed:1,rescheduled:0});
    await assertRemoved();
  });
  it.each(['delete-error','delete-noop','committed-media-delete-reply-loss','head-error','media-delete-error'])('retains all removal paths across %s and a fresh retry',async fault=>{
    let injected=0;
    intercept=async(url,method,target,init)=>{
      if(injected)return null;
      if(method==='DELETE'&&url.pathname==='/storage/v1/object/showcase_media'&&fault.startsWith('delete')){
        injected++;return fault==='delete-noop'?Response.json([]):Response.json({message:'Controlled Storage deletion failure'},{status:503});
      }
      if(fault==='committed-media-delete-reply-loss'&&method==='DELETE'&&url.pathname==='/rest/v1/post_media'){
        const actual=await originalFetch(target,init);expect(actual.ok).toBe(true);injected++;return Response.json({message:'Controlled reply loss after real media-row commit'},{status:504});
      }
      if(fault==='media-delete-error'&&method==='DELETE'&&url.pathname==='/rest/v1/post_media'){
        injected++;return Response.json({message:'Controlled final gallery cleanup failure'},{status:503});
      }
      if(fault==='head-error'&&method==='HEAD'&&url.pathname.startsWith('/storage/v1/object/showcase_media/showcase/'+generationId+'/')){
        injected++;return new Response(null,{status:503});
      }
      return null;
    };
    const now=new Date();expect(await processShowcaseMediaRevocations(admin,{now})).toMatchObject({due:1,removed:0,rescheduled:1});expect(injected).toBe(1);
    const queued=(await db.query('select attempt_count,next_attempt_at,last_error from public.showcase_media_revocations where generation_id=$1',[generationId])).rows[0];
    expect(queued.attempt_count).toBe(1);expect(queued.next_attempt_at.getTime()).toBe(now.getTime()+600000);expect(queued.last_error).not.toBeNull();
    intercept=null;
    expect(await processShowcaseMediaRevocations(admin,{now:new Date(now.getTime()+660000)})).toMatchObject({due:1,removed:1,rescheduled:0});
    await assertRemoved();
  });

  it.each(['queue-delete-error','queue-delete-reply-loss'])('recovers %s after verified object removal',async fault=>{
    let injected=0;
    intercept=async(url,method,target,init)=>{
      if(!injected&&method==='DELETE'&&url.pathname==='/rest/v1/showcase_media_revocations'){
        if(fault==='queue-delete-reply-loss')expect((await originalFetch(target,init)).ok).toBe(true);
        injected++;return Response.json({message:'Controlled queue acknowledgement failure'},{status:504});
      }
      return null;
    };
    await expect(processShowcaseMediaRevocations(admin,{now:new Date()})).rejects.toMatchObject({message:'Controlled queue acknowledgement failure'});expect(injected).toBe(1);
    for(const path of paths)expect((await admin.storage.from('showcase_media').download(path)).data).toBeNull();
    intercept=null;
    expect(await processShowcaseMediaRevocations(admin,{now:new Date()})).toMatchObject({due:fault==='queue-delete-error'?1:0,removed:fault==='queue-delete-error'?1:0});
    await assertRemoved();
  });

  it('preserves a copy republished before the worker reads exposure',async()=>{
    await db.query("update public.posts set visibility='public',showcase_asset_path=$2 where id=$1",[postId,paths[0]]);
    expect(await processShowcaseMediaRevocations(admin,{now:new Date()})).toMatchObject({due:1,removed:0,stillServing:1});
    for(const path of paths)expect((await admin.storage.from('showcase_media').download(path)).error).toBeNull();
    expect((await db.query('select count(*)::int as count from public.post_media where post_id=$1',[postId])).rows[0].count).toBe(1);
    expect((await db.query('select id from public.showcase_media_revocations where generation_id=$1',[generationId])).rows).toEqual([]);
  });

  it('settles an invalid-prefix row without deleting its object or blocking healthy work',async()=>{
    const foreign=`showcase/${randomUUID()}/unrelated.png`;paths.push(foreign);
    expect((await admin.storage.from('showcase_media').upload(foreign,new Blob([bytes],{type:'image/png'}),{contentType:'image/png'})).error).toBeNull();
    await db.query("insert into public.showcase_media_revocations(generation_id,showcase_asset_path,reason,next_attempt_at) values($1,$2,'post_deleted',now()-interval '1 minute')",[generationId,foreign]);
    expect(await processShowcaseMediaRevocations(admin,{now:new Date()})).toMatchObject({due:2,removed:1,outsidePrefix:1});
    expect((await admin.storage.from('showcase_media').download(foreign)).error).toBeNull();
    for(const path of paths.slice(0,-1))expect((await admin.storage.from('showcase_media').download(path)).data).toBeNull();
    expect((await db.query('select id from public.showcase_media_revocations where generation_id=$1',[generationId])).rows).toEqual([]);
  });
});
