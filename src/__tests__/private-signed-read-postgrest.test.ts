import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createClient} from '@supabase/supabase-js';
import {it,expect} from 'vitest';
it.skipIf(!process.env.AUDIT_STORAGE_CONFIG || !process.env.SUPABASE_TEST_DB_URL)('enforces actual private signed-read ownership, integrity, expiry and deletion',async()=>{
 const cfg=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG!,'utf8'));
 const connectionString=process.env.SUPABASE_TEST_DB_URL!;
 expect(['localhost','127.0.0.1']).toContain(new URL(cfg.API_URL).hostname);expect(['localhost','127.0.0.1']).toContain(new URL(connectionString).hostname);
 const localFetch=async(input:RequestInfo|URL,init?:RequestInit)=>{const u=new URL(input instanceof Request?input.url:String(input));if(u.origin!==new URL(cfg.API_URL).origin)throw Error('External calls forbidden');return fetch(input,init);};
 const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:localFetch}};
 const admin=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,options);
 const db=new Client({connectionString,statement_timeout:10000});await db.connect();
 const users:string[]=[],paths:string[]=[];
 try{
  expect((await db.query("select public from storage.buckets where id='generation_inputs'")).rows).toEqual([{public:false}]);
  const clients=[];
  for(let n=0;n<2;n++){
   const email=randomUUID()+'@private-read.invalid',password=randomUUID()+randomUUID();
   const made=await admin.auth.admin.createUser({email,password,email_confirm:true});expect(made.error).toBeNull();if(!made.data.user)throw Error('No fixture user');users.push(made.data.user.id);
   const client=createClient(cfg.API_URL,cfg.ANON_KEY,options);expect((await client.auth.signInWithPassword({email,password})).error).toBeNull();clients.push(client);
   const path=made.data.user.id+'/private.png';paths.push(path);expect((await admin.storage.from('generation_inputs').upload(path,new Blob(['fixture-'+n],{type:'image/png'}))).error).toBeNull();
  }
  const [owner,other]=clients;
  const anon=createClient(cfg.API_URL,cfg.ANON_KEY,options);
  const own=await owner.storage.from('generation_inputs').createSignedUrl(paths[0],60);expect(own.error).toBeNull();if(!own.data)throw Error('No signed URL');
  const first=await localFetch(own.data.signedUrl);expect(first.status).toBe(200);expect(await first.text()).toBe('fixture-0');
  const cross=await other.storage.from('generation_inputs').createSignedUrl(paths[0],60);expect(cross.error).not.toBeNull();expect(cross.data).toBeNull();
  const unauth=await anon.storage.from('generation_inputs').createSignedUrl(paths[0],60);expect(unauth.error).not.toBeNull();expect(unauth.data).toBeNull();
  const publicUrl=admin.storage.from('generation_inputs').getPublicUrl(paths[0]).data.publicUrl;
  const unsigned=await localFetch(publicUrl);expect(unsigned.ok).toBe(false);
  const tampered=new URL(own.data.signedUrl);const token=tampered.searchParams.get('token')!;const parts=token.split('.');parts[2]=(parts[2][0]==='a'?'b':'a')+parts[2].slice(1);tampered.searchParams.set('token',parts.join('.'));
  const invalid=await localFetch(tampered);expect(invalid.ok).toBe(false);
  const changed=new URL(own.data.signedUrl);changed.pathname=changed.pathname.replace(users[0],users[1]);const rebound=await localFetch(changed);expect(rebound.ok).toBe(false);
  const short=await owner.storage.from('generation_inputs').createSignedUrl(paths[0],2);expect(short.error).toBeNull();if(!short.data)throw Error('No short-lived URL');expect((await localFetch(short.data.signedUrl)).ok).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,4000));const expired=await localFetch(short.data.signedUrl);expect(expired.ok).toBe(false);
  expect((await admin.storage.from('generation_inputs').remove([paths[0]])).error).toBeNull();const removed=await localFetch(own.data.signedUrl);expect(removed.ok).toBe(false);
  expect((await admin.storage.from('generation_inputs').download(paths[1])).error).toBeNull();
 }finally{
  if(paths.length)expect((await admin.storage.from('generation_inputs').remove(paths)).error).toBeNull();
  for(const user of users)expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
  const cleanup=(await db.query("select(select count(*)from auth.users where id=any($1::uuid[]))::int users,(select count(*)from storage.objects where bucket_id='generation_inputs' and name=any($2::text[]))::int objects",[users,paths])).rows;
  expect(cleanup).toEqual([{users:0,objects:0}]);await db.end();
 }
},40000);
