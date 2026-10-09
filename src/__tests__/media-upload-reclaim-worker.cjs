/* eslint-disable @typescript-eslint/no-require-imports -- owned process-death fixture. */
const {readFileSync}=require('node:fs');
const {createClient}=require('@supabase/supabase-js');
const {reclaimAbandonedMediaUploads}=require('../lib/media-upload-reclaim-service.ts');
const config=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG,'utf8'));
const origin=new URL(config.API_URL).origin;
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Local API required');
const phase=process.env.AUDIT_RECLAIM_PHASE;
const pause=async()=>{
 // A pending Promise alone does not keep Node alive once its HTTP sockets idle.
 // Keep the fixture process alive until the parent sends the asserted SIGKILL.
 setInterval(()=>{},1000);
 process.send?.({stage:phase});
 await new Promise(()=>{});
};
const client=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{
 auth:{persistSession:false,autoRefreshToken:false},
 global:{fetch:async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin!==origin)throw Error('External network forbidden for reclaim worker');
  const method=init?.method??(input instanceof Request?input.method:'GET');
  const response=await fetch(input,init);
  if(response.ok){
   const body=typeof init?.body==='string'?JSON.parse(init.body):{};
   const marker=method==='PATCH'&&url.pathname==='/rest/v1/media_upload_intents'&&'reclaim_checked_at' in body;
   const clear=method==='PATCH'&&url.pathname==='/rest/v1/media_upload_intents'&&'storage_cleared_at' in body;
   const removal=method==='DELETE'&&url.pathname==='/storage/v1/object/uploads';
   const claim=url.pathname==='/rest/v1/rpc/claim_media_upload_intents_for_reclaim';
   if((marker&&phase==='after-scan')||(claim&&phase==='after-claim')||(removal&&phase==='after-removal')||(clear&&phase==='after-clearing'))await pause();
  }
  return response;
 }},
});
reclaimAbandonedMediaUploads(client).then(summary=>{
 process.send?.({stage:'completed',summary},()=>process.disconnect());
}).catch(error=>{
 console.error(error.message);process.exitCode=1;process.send?.({stage:'failed'},()=>process.disconnect());
});
