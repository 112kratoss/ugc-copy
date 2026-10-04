import { readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createTemplateInputUploadIntent, finalizeTemplateRunInputs } from '@/lib/template-run-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
// Run via vitest.template-storage.config.ts: this suite requires Node's native
// multipart/Blob transport and an explicitly configured local Storage stack.
describe.skipIf(!configPath || !connectionString)('actual isolated template input Storage transport', () => {
  let db: Client;
  let admin: SupabaseClient;
  let anonymous: SupabaseClient;
  let userId: string;
  let runId: string;
  let templateId: string;
  let image: Buffer;
  let configuration: { API_URL: string; SERVICE_ROLE_KEY: string; ANON_KEY: string };
  const fixtureLog = process.env.AUDIT_STORAGE_FIXTURE_LOG
    ?? path.join(tmpdir(), `template-input-storage-${randomUUID()}.jsonl`);
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    configuration = config;
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    console.info('Local Storage fixture log:', fixtureLog);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    anonymous = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
    image = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#446688' } }).png().toBuffer();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    userId = randomUUID(); runId = randomUUID(); templateId = randomUUID();
    appendFileSync(fixtureLog, JSON.stringify({ userId, runId, templateId, createdAt: new Date().toISOString() })+'\n');
    await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [userId, `${userId}@example.invalid`]);
    await db.query("insert into public.templates(id,name,creator_user_id,status,is_active) values($1,'Storage input audit',$2,'draft',true)", [templateId,userId]);
    const graph={version:2,nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}};
    await db.query(`insert into public.template_runs(id,template_id,user_id,graph_snapshot,graph_hash,input_manifest,input_storage_paths,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits,is_test)
      values($1,$2,$3,$4,$5,$6,'{}','output','image','collecting_inputs',0,0,true)`,
      [runId,templateId,userId,JSON.stringify({graph,templateTitle:'Storage input audit',templateId}), 'a'.repeat(64),JSON.stringify([{key:'portrait',kind:'image',label:'Portrait',required:true}])]);
  });
  afterEach(async () => {
    await db.query('delete from public.template_runs where id=$1', [runId]);
    await db.query('delete from public.templates where id=$1', [templateId]);
    const objects=(await db.query("select name from storage.objects where bucket_id='template_inputs' and name like $1", [`${userId}/${runId}/%`])).rows;
    if(objects.length){const removal=await admin.storage.from('template_inputs').remove(objects.map(r=>r.name));expect(removal.error).toBeNull();}
    await db.query('delete from auth.users where id=$1', [userId]);
    expect((await db.query("select name from storage.objects where bucket_id='template_inputs' and name like $1", [`${userId}/${runId}/%`])).rows).toEqual([]);
    appendFileSync(fixtureLog, JSON.stringify({ userId, runId, cleanup:'run/template/objects/auth removed', at:new Date().toISOString() })+'\n');
  });
  const paths = async () => (await db.query('select input_storage_paths from public.template_runs where id=$1',[runId])).rows[0].input_storage_paths as Record<string,string>;
  const sign = () => createTemplateInputUploadIntent({ client:admin,runId,userId,body:{slotKey:'portrait',mimeType:'image/png',sizeBytes:image.length,fileName:'portrait.png'} });
  const upload = async (intent: Awaited<ReturnType<typeof sign>>, bytes: Buffer = image) => {
    const result=await anonymous.storage.from(intent.bucket).uploadToSignedUrl(intent.path,intent.token,new Blob([new Uint8Array(bytes)],{type:'image/png'}),{contentType:'image/png'});
    expect(result.error).toBeNull();
  };
  const finalize = (storagePath: string) => finalizeTemplateRunInputs({ client:admin,runId,userId,body:{inputs:[{slotKey:'portrait',storagePath}]} });
  it('uploads and finalizes real bytes, removes staging, and refuses the consumed token', async () => {
    const intent=await sign(); await upload(intent);
    expect(await finalize(intent.storagePath)).toMatchObject({status:'collecting_inputs',inputs:{portrait:'uploaded'}});
    const stored=await paths(); const finalPath=stored.portrait.slice('template_inputs/'.length);
    const downloaded=await admin.storage.from('template_inputs').download(finalPath);
    expect(downloaded.error).toBeNull();
    const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
    expect(digest(new Uint8Array(await downloaded.data!.arrayBuffer()))).toBe(digest(image));
    expect((await admin.storage.from('template_inputs').download(intent.path)).error).not.toBeNull();
    const replay=await anonymous.storage.from('template_inputs').uploadToSignedUrl(intent.path,intent.token,new Blob([new Uint8Array(image)],{type:'image/png'}),{contentType:'image/png'});
    expect(replay.error).not.toBeNull();
    expect((await anonymous.storage.from('template_inputs').download(finalPath)).error).not.toBeNull();
    expect((await fetch(admin.storage.from('template_inputs').getPublicUrl(finalPath).data.publicUrl)).ok).toBe(false);
  });
  it('rejects uploaded non-image bytes without committing an input path', async () => {
    const intent=await sign(); await upload(intent,Buffer.alloc(image.length,0x5a));
    await expect(finalize(intent.storagePath)).rejects.toMatchObject({code:'INVALID_INPUT_FILE'});
    expect(await paths()).toEqual({});
  });
  it('rejects metadata size mismatch before accepting the input', async () => {
    const intent=await sign(); await upload(intent,Buffer.from('not an image'));
    await expect(finalize(intent.storagePath)).rejects.toMatchObject({code:'UPLOAD_METADATA_MISMATCH'});
    expect(await paths()).toEqual({});
  });
  it('keeps committed final bytes after an HTTP acknowledgement loss and permits state recovery', async () => {
    const intent=await sign();await upload(intent);
    let lost=false;
    const ambiguous=createClient(configuration.API_URL,configuration.SERVICE_ROLE_KEY,{
      auth:{persistSession:false,autoRefreshToken:false},
      global:{fetch:async(input,init)=>{
        const response=await fetch(input,init);
        if(!lost && init?.method==='PATCH' && String(input).includes('/rest/v1/template_runs?') && response.ok){
          lost=true;
          expect((await paths()).portrait).toContain('/final/portrait/');
          return new Response(JSON.stringify({message:'audit upstream timeout'}),{status:504,headers:{'Content-Type':'application/json'}});
        }
        return response;
      }},
    });
    await expect(finalizeTemplateRunInputs({client:ambiguous,runId,userId,body:{inputs:[{slotKey:'portrait',storagePath:intent.storagePath}]}})).rejects.toBeDefined();
    expect(lost).toBe(true);
    const committed=(await paths()).portrait;
    expect((await admin.storage.from('template_inputs').download(committed.slice('template_inputs/'.length))).error).toBeNull();
    // Recovery uses the persisted input state, without re-consuming a still-leased token.
    expect(await finalizeTemplateRunInputs({client:admin,runId,userId,body:{inputs:[]}})).toMatchObject({inputs:{portrait:'uploaded'}});
    expect((await paths()).portrait).toBe(committed);
  });
  it('does not orphan a finalized object when two input requests commit from the same state', async () => {
    const first=await sign();await upload(first);
    const second=await sign();await upload(second);
    let arrivals=0;
    let release!:()=>void;
    const bothReady=new Promise<void>(resolve=>{release=resolve;});
    const concurrent=createClient(configuration.API_URL,configuration.SERVICE_ROLE_KEY,{
      auth:{persistSession:false,autoRefreshToken:false},
      global:{fetch:async(input,init)=>{
        if(init?.method==='PATCH' && String(input).includes('/rest/v1/template_runs?')){
          arrivals++;
          if(arrivals===2)release();
          await bothReady;
        }
        return fetch(input,init);
      }},
    });
    const results=await Promise.allSettled([first,second].map(intent=>finalizeTemplateRunInputs({client:concurrent,runId,userId,body:{inputs:[{slotKey:'portrait',storagePath:intent.storagePath}]}})));
    const finalObjects=(await db.query("select name from storage.objects where bucket_id='template_inputs' and name like $1",[`${userId}/${runId}/final/%`])).rows;
    // One durable slot must have exactly one final object; the losing request must clean up its copy.
    expect(finalObjects).toHaveLength(1);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    expect(`template_inputs/${finalObjects[0].name}`).toBe((await paths()).portrait);
    const rejectedIndex=results.findIndex(result=>result.status==='rejected');
    const rejected=results[rejectedIndex];
    expect(rejected.status==='rejected' ? rejected.reason : null).toMatchObject({status:409,code:'TEMPLATE_INPUT_CONFLICT'});
    expect(await finalize([first,second][rejectedIndex].storagePath)).toMatchObject({inputs:{portrait:'uploaded'}});
    expect((await db.query("select name from storage.objects where bucket_id='template_inputs' and name like $1",[`${userId}/${runId}/final/%`])).rows).toHaveLength(1);
  });
  it('preserves the current final input when the run starts before a replacement commits', async () => {
    const first=await sign();await upload(first);await finalize(first.storagePath);
    const original=(await paths()).portrait;
    const second=await sign();await upload(second);
    const racing=createClient(configuration.API_URL,configuration.SERVICE_ROLE_KEY,{
      auth:{persistSession:false,autoRefreshToken:false},
      global:{fetch:async(input,init)=>{
        if(init?.method==='PATCH' && String(input).includes('/rest/v1/template_runs?')){
          await db.query("update public.template_runs set status='queued' where id=$1",[runId]);
        }
        return fetch(input,init);
      }},
    });
    await expect(finalizeTemplateRunInputs({client:racing,runId,userId,body:{inputs:[{slotKey:'portrait',storagePath:second.storagePath}]}})).rejects.toMatchObject({status:409,code:'TEMPLATE_INPUT_CONFLICT'});
    expect((await paths()).portrait).toBe(original);
    expect((await admin.storage.from('template_inputs').download(original.slice('template_inputs/'.length))).error).toBeNull();
    expect((await db.query("select name from storage.objects where bucket_id='template_inputs' and name like $1",[`${userId}/${runId}/final/%`])).rows).toHaveLength(1);
  });
  it('replaces the final object only after recording the new owned input', async () => {
    const first=await sign();await upload(first);await finalize(first.storagePath);
    const old=(await paths()).portrait;
    const second=await sign();await upload(second);await finalize(second.storagePath);
    const current=(await paths()).portrait;expect(current).not.toBe(old);
    expect((await admin.storage.from('template_inputs').download(old.slice('template_inputs/'.length))).error).not.toBeNull();
    expect((await admin.storage.from('template_inputs').download(current.slice('template_inputs/'.length))).error).toBeNull();
  });
});
