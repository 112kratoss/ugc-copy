import {beforeEach,describe,expect,it,vi} from 'vitest';
import {registerMobilePushTokenForRoute} from '@/lib/mobile-push-registration-service';

function fixture({user=null,allowed=true,error=null}: {user?: {id:string;is_anonymous?:boolean}|null;allowed?:boolean;error?:{message:string}|null}={}) {
 const register=vi.fn(async(_args:unknown)=>{void _args;return {data:error?null:'token-row',error};});
 const rpc=vi.fn((name:string,args:unknown)=>{
  if(name==='register_mobile_push_token')return register(args);
  expect(name).toBe('check_backend_rate_limit');
  return Promise.resolve({data:{allowed,limit:20,remaining:allowed?19:0,retryAfterSeconds:35,resetAt:'2026-10-05T13:00:00Z'},error:null});
 });
 const admin={rpc};
 const userClient={auth:{getUser:vi.fn(async()=>({data:{user},error:null}))},from:vi.fn(()=>{throw Error('Unexpected non-atomic write');})};
 const getAdminSupabase=vi.fn(()=>admin);
 return {register,rpc,userClient,getAdminSupabase};
}
const payload={expoPushToken:'ExponentPushToken[new123]',platform:'android',deviceId:'device-1',appVersion:'1.0.0'};
describe('mobile push registration service',()=>{
 beforeEach(()=>{vi.restoreAllMocks();});
 it.each([null,{id:'guest',is_anonymous:true}])('rejects missing/guest identity before parsing and privileged calls',async user=>{
  const f=fixture({user});const readRequestBody=vi.fn(async()=>payload);
  expect(await registerMobilePushTokenForRoute({userSupabase:f.userClient,getAdminSupabase:f.getAdminSupabase,readRequestBody})).toEqual({ok:false,body:{error:'Unauthorized'},status:401});
  expect(f.getAdminSupabase).not.toHaveBeenCalled();expect(readRequestBody).not.toHaveBeenCalled();
 });
 it('passes the verified owner and normalized payload to one atomic RPC after the rate limit',async()=>{
  const f=fixture({user:{id:'owner'}});
  expect(await registerMobilePushTokenForRoute({userSupabase:f.userClient,getAdminSupabase:f.getAdminSupabase,requestBody:{...payload,userId:'foreign'}})).toEqual({ok:true,body:{success:true}});
  expect(f.rpc.mock.calls).toEqual([
   ['check_backend_rate_limit',{p_scope:'mobile-push-token:register',p_subject_key:'owner',p_limit:20,p_window_seconds:600}],
   ['register_mobile_push_token',{p_user_id:'owner',p_expo_push_token:payload.expoPushToken,p_platform:'android',p_device_id:'device-1',p_app_version:'1.0.0'}],
  ]);
  expect(f.userClient.from).not.toHaveBeenCalled();
 });
 it('stops before registration when the backend rate limit refuses the request',async()=>{
  const f=fixture({user:{id:'owner'},allowed:false});
  expect(await registerMobilePushTokenForRoute({userSupabase:f.userClient,getAdminSupabase:f.getAdminSupabase,requestBody:payload})).toMatchObject({ok:false,status:429,rateLimitError:expect.any(Error)});
  expect(f.register).not.toHaveBeenCalled();
 });
 it('surfaces an atomic transaction failure without returning registration success',async()=>{
  const f=fixture({user:{id:'owner'},error:{message:'Database failure'}});
  expect(await registerMobilePushTokenForRoute({userSupabase:f.userClient,getAdminSupabase:f.getAdminSupabase,requestBody:payload})).toEqual({ok:false,status:500,body:{error:'Failed to register mobile push token.'}});
 });
 it('validates the token before privileged work',async()=>{
  const f=fixture({user:{id:'owner'}});
  expect(await registerMobilePushTokenForRoute({userSupabase:f.userClient,getAdminSupabase:f.getAdminSupabase,requestBody:{...payload,expoPushToken:'bad'}})).toMatchObject({ok:false,status:400});
  expect(f.getAdminSupabase).not.toHaveBeenCalled();
 });
});
