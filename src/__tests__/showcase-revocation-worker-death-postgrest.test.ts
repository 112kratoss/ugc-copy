import { readFileSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const configPath=process.env.AUDIT_STORAGE_CONFIG, connectionString=process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath||!connectionString)('background showcase revocation after real owned worker death',()=>{
  let db:Client,admin:SupabaseClient,originalFetch:typeof fetch;
  let owner:string,generationId:string,postId:string,paths:string[];
  let intercept:((url:URL,method:string,target:Parameters<typeof fetch>[0],init?:RequestInit)=>Promise<Response|null>)|null=null;
  const children=new Set<ChildProcess>();
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
    expect((await db.query('select reason from public.showcase_media_revocations where generation_id=$1',[generationId])).rows).toEqual([{reason:'post_unexposed'}]);
  });
  afterEach(async()=>{
    for(const child of children){
      if(child.exitCode===null&&child.signalCode===null){const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));child.kill('SIGKILL');await closed;}
    }
    children.clear();
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

  const startWorker=(phase:string)=>{
    const child=fork('src/__tests__/showcase-revocation-worker.cjs',[],{
      execArgv:['--import','tsx'],silent:true,
      env:{NODE_ENV:'test',PATH:process.env.PATH,TSX_TSCONFIG_PATH:'tsconfig.mobile-push-worker.json',AUDIT_STORAGE_CONFIG:configPath,AUDIT_REVOCATION_PHASE:phase},
    });
    children.add(child);
    const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>{children.delete(child);resolve({code,signal});}));
    let diagnostic='';child.stderr?.on('data',data=>{diagnostic=(diagnostic+String(data)).slice(-2000);});child.stdout?.resume();
    const checkpoint=new Promise<{stage:string;summary?:Record<string,number>}>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Owned worker checkpoint timed out: '+diagnostic)),20000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('Owned worker exited before its checkpoint: '+diagnostic));});
      child.on('message',message=>{
        const result=message as {stage:string;summary?:Record<string,number>};
        if(result.stage===phase||result.stage==='completed'){clearTimeout(timer);resolve(result);}
        else if(result.stage==='failed'){clearTimeout(timer);reject(Error('Owned worker failed: '+diagnostic));}
      });
    });
    return {child,closed,checkpoint};
  };

  it.each(['before-removal','after-removal','after-gallery-commit'])('recovers all media after actual SIGKILL %s',async phase=>{
    const worker=startWorker(phase);expect((await worker.checkpoint).stage).toBe(phase);
    expect((await db.query('select count(*)::int as count from public.showcase_media_revocations where generation_id=$1',[generationId])).rows[0].count).toBe(1);
    expect((await db.query('select count(*)::int as count from public.post_media where post_id=$1',[postId])).rows[0].count).toBe(phase==='after-gallery-commit'?0:1);
    expect((await db.query('select count(*)::int as count from storage.objects where name=any($1::text[])',[paths])).rows[0].count).toBe(phase==='before-removal'?6:0);
    worker.child.kill('SIGKILL');expect((await worker.closed).signal).toBe('SIGKILL');
    const replacement=startWorker('complete');expect(await replacement.checkpoint).toMatchObject({stage:'completed',summary:{due:1,removed:1,rescheduled:0}});expect((await replacement.closed).code).toBe(0);
    await assertRemoved();
    const duplicate=startWorker('complete');expect(await duplicate.checkpoint).toMatchObject({stage:'completed',summary:{due:0,removed:0}});expect((await duplicate.closed).code).toBe(0);
    await assertRemoved();
  },40000);
});
