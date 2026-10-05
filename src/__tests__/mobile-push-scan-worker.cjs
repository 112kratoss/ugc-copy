/* eslint-disable @typescript-eslint/no-require-imports -- crash fixture executes the actual TS worker. */
const {readFileSync}=require('node:fs');
const {createClient}=require('@supabase/supabase-js');
const {processMobilePushMaintenance}=require('../lib/mobile-notifications.ts');
const config=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG,'utf8'));
if(!['localhost','127.0.0.1'].includes(new URL(config.API_URL).hostname)) throw new Error('Local API required');
const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:async(input,init)=>{
 const response=await fetch(input,init);
 if(new URL(String(input)).pathname==='/rest/v1/rpc/scan_mobile_push_maintenance' && JSON.parse(init.body).p_phase==='recorded') {
  if(!response.ok) throw new Error('Scan failed');
  process.send({stage:'scan-saved'});await new Promise(()=>{});
 }
 return response;
}}});
processMobilePushMaintenance(admin,{fetcher:async()=>{throw Error('Unexpected provider request');}}).catch(()=>{process.send({stage:'unexpected-failure'});process.exitCode=1;});
