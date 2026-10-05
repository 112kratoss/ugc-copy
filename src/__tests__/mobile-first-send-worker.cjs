/* eslint-disable @typescript-eslint/no-require-imports -- forked crash fixture loads the actual TS service. */
const {readFileSync}=require('node:fs');
const {createClient}=require('@supabase/supabase-js');
const {createMobileNotification}=require('../lib/mobile-notifications.ts');
const config=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG,'utf8'));
if(!['localhost','127.0.0.1'].includes(new URL(config.API_URL).hostname)) throw new Error('Local API required');
const realFetch=globalThis.fetch;
const stop=async(stage)=>{process.send({stage});await new Promise(()=>{});};
const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:async(input,init)=>{
  if(new URL(String(input)).pathname === '/rest/v1/rpc/finish_initial_mobile_push_outcomes') await stop('outcome-saved');
  return realFetch(input,init);
}}});
globalThis.fetch=async()=>{
  if(process.env.AUDIT_STOP_STAGE === 'provider-started') await stop('provider-started');
  return new Response(JSON.stringify({data:[{status:'ok',id:'audit-child-ticket'}]}),{headers:{'Content-Type':'application/json'}});
};
createMobileNotification({adminSupabase:admin,userId:process.env.AUDIT_OWNER,type:'post_saved',category:'social',title:'Fixture',body:'Local only',dedupeKey:'first-send-'+process.env.AUDIT_OWNER})
.then(()=>{process.send({stage:'unexpected-completion'});}).catch(()=>{process.send({stage:'unexpected-failure'});process.exitCode=1;});
