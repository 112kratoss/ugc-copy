import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveAccountIdentityFingerprints } from '@/lib/account-identity-fingerprint';
import { ADMIN_SESSION_COOKIE, createAdminSessionToken, deriveAdminCredentialVersion } from '@/lib/admin-session-token';
import { insertAdminSession } from '@/lib/admin-session-store';
import { postMarketplaceVerifyRouteResponse } from '@/lib/marketplace-verify-route-adapter-service';
import { postPostResourceBundleVerifyRouteResponse } from '@/lib/post-resource-bundle-verify-route-adapter-service';
import { postRazorpayCreditVerifyRouteResponse } from '@/lib/razorpay-credit-verify-route-adapter-service';
import { postMarketplaceOrderRouteResponse } from '@/lib/marketplace-order-route-adapter-service';
import { postPostResourceBundleOrderRouteResponse } from '@/lib/post-resource-bundle-order-route-adapter-service';
import { postRazorpayCreditOrderRouteResponse } from '@/lib/razorpay-credit-order-route-adapter-service';
import { postAdminCreditAdjustment } from '@/lib/admin-credit-route-adapter-service';
import { patchOnboardingStateRouteResponse, postWelcomeCreditsClaimRouteResponse, postOnboardingEventRouteResponse } from '@/lib/onboarding-route-adapter-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG, connectionString = process.env.SUPABASE_TEST_DB_URL;
const routes = [
  {path:'/api/admin/users/credits',method:'POST',mode:'admin',handler:postAdminCreditAdjustment},
  {path:'/api/onboarding/state',method:'PATCH',mode:'bearer',handler:(request:Request)=>patchOnboardingStateRouteResponse({request})},
  {path:'/api/credits/welcome/claim',method:'POST',mode:'bearer',handler:(request:Request)=>postWelcomeCreditsClaimRouteResponse({request})},
  {path:'/api/onboarding/events',method:'POST',mode:'public',handler:(request:Request)=>postOnboardingEventRouteResponse({request})},
];

describe.skipIf(!configPath || !connectionString)('onboarding and admin credit inputs through actual sessions and Auth', () => {
  let db: Client, admin: SupabaseClient, userClient: SupabaseClient;
  let bearer: string;
  let reviewerId: string, sessionId: string, token: string;
  let secret: string, passwordHash: string;
  let fixtureUsers: string[], fingerprints: string[], eventIds: string[], installationIds: string[];
  let expectedRows: { states: number; events: number; adjustments: number };
  const request=(route:typeof routes[number],raw:string,signed=true)=>new Request('http://127.0.0.1'+route.path,{
    method:route.method,headers:{'Content-Type':'application/json',...(signed?(route.mode==='admin'?{Cookie:`${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`}:{Authorization:`Bearer ${bearer}`}):{})},body:raw,
  });
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname); expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY);
    secret = randomUUID()+randomUUID(); passwordHash = `scrypt.16384.8.1.c2FsdHNhbHRzYWx0c2E.${'A'.repeat(86)}`;
    vi.stubEnv('ACCOUNT_IDENTITY_FINGERPRINT_SECRET', randomUUID()+randomUUID());
    vi.stubEnv('ADMIN_USERNAME', 'local-audit'); vi.stubEnv('ADMIN_PASSWORD_HASH', passwordHash); vi.stubEnv('ADMIN_SESSION_SECRET', secret);
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== new URL(config.API_URL).origin) throw new Error('External network forbidden in local auth/credit controls');
      return originalFetch(target, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    userClient=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    fixtureUsers = []; eventIds = []; installationIds = [];
    expectedRows = {states:0,events:0,adjustments:0};
    const password=randomUUID()+'aZ7!';
    const made = await admin.auth.admin.createUser({ email: `auth-credit-input-audit-${randomUUID()}@example.invalid`, password, email_confirm: true });
    expect(made.error).toBeNull(); reviewerId = made.data.user!.id; fixtureUsers.push(reviewerId);
    fingerprints=deriveAccountIdentityFingerprints(made.data.user!);
    await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1', [reviewerId]);
    vi.stubEnv('ADMIN_REVIEWER_USER_ID', reviewerId);
    const signed=await userClient.auth.signInWithPassword({email:made.data.user!.email!,password});expect(signed.error).toBeNull();bearer=signed.data.session!.access_token;
    sessionId = randomUUID(); const now = new Date();
    const credentialVersion = await deriveAdminCredentialVersion({ secret, passwordHash });
    await insertAdminSession(admin, { sessionId, subject: 'master', credentialVersion, createdAt: now, expiresAt: new Date(now.getTime()+3600000) });
    token = await createAdminSessionToken({ secret, sessionId, credentialVersion, issuedAt: now, ttlSeconds: 3600 });
  });
  afterEach(async () => {
    try {
      expect((await db.query('select credits,promotional_credits from public.profiles where id=$1', [reviewerId])).rows)
        .toEqual([{ credits:500,promotional_credits:0 }]);
      expect((await db.query(`select
        (select count(*) from public.mobile_onboarding_states where user_id=$1)::int as states,
        (select count(*) from public.onboarding_events where client_event_id=any($2::uuid[]))::int as events,
        (select count(*) from public.admin_credit_adjustments where user_id=$1 or reviewer_id=$1)::int as adjustments,
        (select count(*) from public.credit_grants where user_id=$1)::int as grants,
        (select count(*) from public.credit_grant_identity_fingerprints where fingerprint=any($3::text[]))::int as fingerprints,
        (select count(*) from public.marketplace_orders where buyer_user_id=$1)::int as marketplace_orders,
      (select count(*) from public.post_resource_bundle_orders where buyer_user_id=$1)::int as resource_orders,
      (select count(*) from public.transactions where user_id=$1)::int as transactions,
      (select count(*) from public.razorpay_checkout_intents where user_id=$1)::int as checkout_intents,
      (select count(*) from public.ai_usage_events where user_id=$1)::int as usage`, [reviewerId,eventIds,fingerprints])).rows[0])
        .toEqual({...expectedRows,grants:0,fingerprints:0,transactions:0,checkout_intents:0,marketplace_orders:0,resource_orders:0,usage:0});
    } finally {
      await db.query('delete from public.onboarding_events where client_event_id=any($1::uuid[])', [eventIds]);
      await db.query('delete from public.admin_credit_adjustments where user_id=$1 or reviewer_id=$1', [reviewerId]);
      await db.query('delete from public.credit_grant_identity_fingerprints where fingerprint=any($1::text[])', [fingerprints]);
      await db.query('delete from public.admin_sessions where session_id=$1', [sessionId]);
      await db.query('delete from auth.users where id=any($1::uuid[])', [fixtureUsers]);
      await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [[reviewerId,...installationIds]]);
    }
    expect((await db.query(`select
      (select count(*) from auth.users where id=$1)::int as users,
      (select count(*) from public.profiles where id=$1)::int as profiles,
      (select count(*) from public.admin_sessions where session_id=$2)::int as sessions,
      (select count(*) from public.backend_rate_limits where subject_key=any($3::text[]))::int as rates,
      (select count(*) from public.mobile_onboarding_states where user_id=$1)::int as states,
      (select count(*) from public.onboarding_events where client_event_id=any($4::uuid[]))::int as events,
      (select count(*) from public.admin_credit_adjustments where user_id=$1 or reviewer_id=$1)::int as adjustments,
      (select count(*) from public.credit_grants where user_id=$1)::int as grants,
      (select count(*) from public.credit_grant_identity_fingerprints where fingerprint=any($5::text[]))::int as fingerprints,
      (select count(*) from public.marketplace_orders where buyer_user_id=$1)::int as marketplace_orders,
      (select count(*) from public.post_resource_bundle_orders where buyer_user_id=$1)::int as resource_orders,
      (select count(*) from public.transactions where user_id=$1)::int as transactions,
      (select count(*) from public.razorpay_checkout_intents where user_id=$1)::int as checkout_intents,
      (select count(*) from public.ai_usage_events where user_id=$1)::int as usage`, [reviewerId,sessionId,[reviewerId,...installationIds],eventIds,fingerprints])).rows[0])
      .toEqual({users:0,profiles:0,sessions:0,rates:0,states:0,events:0,adjustments:0,grants:0,fingerprints:0,transactions:0,checkout_intents:0,marketplace_orders:0,resource_orders:0,usage:0});
  });

  it.each(routes)('rejects null before a state, reward or credit mutation: $path',async route=>{
    const response=await route.handler(request(route,'null'));expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each(routes.filter(route=>route.mode!=='public'))('denies unsigned null before parsing: $path',async route=>{
    const response=await route.handler(request(route,'null',false));expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each(routes.flatMap(route => ['[]','5','true','"scalar"','{',''].map(raw=>({route,raw,path:route.path}))))('rejects nonobject/malformed root $raw: $path',async ({route,raw})=>{
    const response=await route.handler(request(route,raw));expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('keeps anonymous event intake public while rejecting an invalid root',async()=>{
    const response=await routes[3].handler(request(routes[3],'null',false));expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('rejects a revoked authoritative admin session before credit parsing',async()=>{
    await db.query('update public.admin_sessions set revoked_at=greatest(created_at,now()) where session_id=$1',[sessionId]);
    const response=await routes[0].handler(request(routes[0],'null'));expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('persists a valid state object and preserves completed state on later progress',async()=>{
    for(const status of ['in_progress','completed','in_progress']){
      const response=await routes[1].handler(request(routes[1],JSON.stringify({status,goal:null})));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');expectedRows.states=1;
    }
    const state=(await db.query('select status,goal,completed_at from public.mobile_onboarding_states where user_id=$1',[reviewerId])).rows[0];
    expect(state).toMatchObject({status:'completed',goal:null});expect(state.completed_at).not.toBeNull();
  });
  it.each([true,false])('accepts and deduplicates a valid onboarding event with signed=%s',async signed=>{
    const clientEventId=randomUUID(), installationId='fid_'+randomBytes(32).toString('hex');eventIds.push(clientEventId);installationIds.push(installationId);
    const body={clientEventId,installationId,eventName:'started',platform:'web'};
    const first=await routes[3].handler(request(routes[3],JSON.stringify(body),signed));expect(first.status).toBe(200);expect(first.headers.get('cache-control')).toContain('no-store');expectedRows.events=1;
    const replay=await routes[3].handler(request(routes[3],JSON.stringify({...body,platform:'ios'}),signed));expect(replay.status).toBe(200);
    expect((await db.query('select user_id,event_name,platform from public.onboarding_events where client_event_id=$1',[clientEventId])).rows)
      .toEqual([{user_id:signed?reviewerId:null,event_name:'started',platform:'web'}]);
  });
  it('applies and replays a real credit adjustment, binds its reviewer and reverses the fixture grant',async()=>{
    const adjustment={userId:reviewerId,reviewerId:randomUUID(),intent:'goodwill',amount:7,reason:'local audit fixture',idempotencyKey:randomUUID()};
    const first=await routes[0].handler(request(routes[0],JSON.stringify(adjustment)));expect(first.status).toBe(200);const result=await first.json();expect(result.status).toBe('applied');expectedRows.adjustments=1;
    const replay=await routes[0].handler(request(routes[0],JSON.stringify(adjustment)));expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({status:'already_applied',adjustmentId:result.adjustmentId});
    expect((await db.query('select reviewer_id,credits_delta,promotional_credits_delta from public.admin_credit_adjustments where id=$1',[result.adjustmentId])).rows)
      .toEqual([{reviewer_id:reviewerId,credits_delta:7,promotional_credits_delta:7}]);
    expect((await db.query('select credits,promotional_credits from public.profiles where id=$1',[reviewerId])).rows).toEqual([{credits:507,promotional_credits:7}]);
    const reversed=await routes[0].handler(request(routes[0],JSON.stringify({...adjustment,intent:'clawback',idempotencyKey:randomUUID()})));expect(reversed.status).toBe(200);expect(await reversed.json()).toMatchObject({status:'applied',credits:500,promotionalCredits:0});expectedRows.adjustments=2;
  });

  it.each([
    {intent:'goodwill',seedCredits:500,seedPromo:0,credits:507,promo:7},
    {intent:'clawback',seedCredits:507,seedPromo:7,credits:500,promo:0},
    {intent:'refund',seedCredits:500,seedPromo:0,credits:507,promo:0},
    {intent:'clawback',seedCredits:3,seedPromo:0,credits:-4,promo:-7},
  ])('moves total spendable value correctly for $intent from $seedCredits/$seedPromo',async control=>{
    await db.query('update public.profiles set credits=$2,promotional_credits=$3 where id=$1',[reviewerId,control.seedCredits,control.seedPromo]);
    const body={userId:reviewerId,intent:control.intent,amount:7,reason:'local balance audit',idempotencyKey:randomUUID()};
    const response=await routes[0].handler(request(routes[0],JSON.stringify(body)));expect(response.status).toBe(200);const result=await response.json();expectedRows.adjustments=1;
    const replay=await routes[0].handler(request(routes[0],JSON.stringify(body)));expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({status:'already_applied',adjustmentId:result.adjustmentId});
    const actual=(await db.query('select credits,promotional_credits from public.profiles where id=$1',[reviewerId])).rows[0];
    // Only this disposable fixture is reset; the independently queried result
    // above, not the cleanup write, is the behavioral evidence.
    await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1',[reviewerId]);
    expect(actual).toEqual({credits:control.credits,promotional_credits:control.promo});
  });

  it('conserves total and promotional balances across concurrent grants and reversals', async () => {
    for (const intent of ['goodwill', 'clawback']) {
      const responses = await Promise.all(Array.from({ length: 8 }, () => routes[0].handler(request(routes[0], JSON.stringify({
        userId: reviewerId, intent, amount: 1, reason: 'local concurrent balance audit', idempotencyKey: randomUUID(),
      })))));
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: 'applied' });
      }
      expectedRows.adjustments += 8;
      expect((await db.query('select credits,promotional_credits from public.profiles where id=$1', [reviewerId])).rows)
        .toEqual([{ credits: intent === 'goodwill' ? 508 : 500, promotional_credits: intent === 'goodwill' ? 8 : 0 }]);
    }
  });

  it.each([true,false].flatMap(signed=>['null','[]','5','true','"scalar"','{',''].map(raw=>({signed,raw}))))('rejects credit-order root $raw with signed=$signed before provider activity',async({signed,raw})=>{
    const response=await postRazorpayCreditOrderRouteResponse({request:new Request('http://127.0.0.1/api/razorpay/order',{
      method:'POST',headers:{'Content-Type':'application/json',...(signed?{Authorization:`Bearer ${bearer}`}:{})},body:raw,
    })});
    expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await db.query('select id from public.transactions where user_id=$1',[reviewerId])).rows).toEqual([]);
  });

  it.each(['null','[]','5','true','"scalar"','{',''])('rejects marketplace order root %s before provider activity',async raw=>{
    const response=await postMarketplaceOrderRouteResponse({request:new Request('http://127.0.0.1/api/marketplace/order',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${bearer}`},body:raw,
    })});
    expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each(['null','[]','5','true','"scalar"','{',''])('rejects resource order root %s before lookup/provider activity',async raw=>{
    const postId=randomUUID();
    const response=await postPostResourceBundleOrderRouteResponse({request:new Request(`http://127.0.0.1/api/posts/${postId}/resource-bundle/order`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${bearer}`},body:raw,
    }),context:{params:Promise.resolve({postId})}});
    expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it.each(['marketplace','resource'])('authenticates %s order requests before reading malformed JSON',async kind=>{
    const postId=randomUUID();
    const request=new Request(kind==='marketplace'?'http://127.0.0.1/api/marketplace/order':`http://127.0.0.1/api/posts/${postId}/resource-bundle/order`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});
    const response=kind==='marketplace'?await postMarketplaceOrderRouteResponse({request}):await postPostResourceBundleOrderRouteResponse({request,context:{params:Promise.resolve({postId})}});
    expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('preserves a valid object resource request and missing-resource response',async()=>{
    const postId=randomUUID();
    const response=await postPostResourceBundleOrderRouteResponse({request:new Request(`http://127.0.0.1/api/posts/${postId}/resource-bundle/order`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${bearer}`},body:'{}',
    }),context:{params:Promise.resolve({postId})}});
    expect(response.status).toBe(404);expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it.each([
    {path:'/api/marketplace/verify',handler:postMarketplaceVerifyRouteResponse},
    {path:'/api/posts/10000000-0000-4000-8000-000000000001/resource-bundle/verify',handler:postPostResourceBundleVerifyRouteResponse},
    {path:'/api/razorpay/verify',handler:postRazorpayCreditVerifyRouteResponse},
  ].flatMap(route=>['null','[]','5','true','"scalar"','{',''].map(raw=>({...route,raw}))))('rejects payment verification root $raw on $path before provider activity',async({path,handler,raw})=>{
    const response=await handler({request:new Request('http://127.0.0.1'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${bearer}`},body:raw})});
    expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it.each([
    {path:'/api/marketplace/verify',handler:postMarketplaceVerifyRouteResponse,status:401},
    {path:'/api/posts/10000000-0000-4000-8000-000000000001/resource-bundle/verify',handler:postPostResourceBundleVerifyRouteResponse,status:401},
    {path:'/api/razorpay/verify',handler:postRazorpayCreditVerifyRouteResponse,status:400},
  ])('preserves unsigned native validation ordering at $path',async({path,handler,status})=>{
    const response=await handler({request:new Request('http://127.0.0.1'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})});
    expect(response.status).toBe(status);expect(response.headers.get('cache-control')).toContain('no-store');
  });

});
