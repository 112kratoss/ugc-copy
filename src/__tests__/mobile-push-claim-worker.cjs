/* eslint-disable @typescript-eslint/no-require-imports -- forked CommonJS fixture loads the TS service through tsx. */
const {readFileSync}=require('node:fs');
const {createClient}=require('@supabase/supabase-js');
const {processMobilePushMaintenance}=require('../lib/mobile-notifications.ts');
const config=JSON.parse(readFileSync(process.env.AUDIT_STORAGE_CONFIG,'utf8'));
if(!['localhost','127.0.0.1'].includes(new URL(config.API_URL).hostname)) throw new Error('Local API required');
const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
processMobilePushMaintenance(admin,{fetcher:async()=>{
  process.send({stage:'provider-started'});
  await new Promise(()=>{});
}}).catch(()=>{process.send({stage:'unexpected-failure'});process.exitCode=1;});
