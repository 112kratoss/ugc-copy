/* eslint-disable @typescript-eslint/no-require-imports -- actual owned process-death fixture. */
const {readFileSync}=require('node:fs');
const {createClient}=require('@supabase/supabase-js');
const {processShowcaseMediaRevocations}=require('../lib/showcase-media-revocations.ts');
const config=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG,'utf8'));
const origin=new URL(config.API_URL).origin;
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Local API required');
const phase=process.env.AUDIT_REVOCATION_PHASE;
const pause=async()=>{process.send?.({stage:phase});await new Promise(()=>{});};
const client=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{
 auth:{persistSession:false,autoRefreshToken:false},
 global:{fetch:async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin!==origin)throw Error('External network forbidden for the owned revocation worker');
  const method=init?.method??(input instanceof Request?input.method:'GET');
  const storageDelete=method==='DELETE'&&url.pathname==='/storage/v1/object/showcase_media';
  if(storageDelete&&phase==='before-removal')await pause();
  const response=await fetch(input,init);
  if(response.ok&&((storageDelete&&phase==='after-removal')||(method==='DELETE'&&url.pathname==='/rest/v1/post_media'&&phase==='after-gallery-commit')))await pause();
  return response;
 }},
});
processShowcaseMediaRevocations(client,{now:new Date()}).then(summary=>{
 process.send?.({stage:'completed',summary},()=>process.disconnect());
}).catch(()=>{
 process.exitCode=1;process.send?.({stage:'failed'},()=>process.disconnect());
});
