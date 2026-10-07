import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_SESSION_COOKIE, createAdminSessionToken, deriveAdminCredentialVersion } from '@/lib/admin-session-token';
import { insertAdminSession } from '@/lib/admin-session-store';
import { postAdminPostReportDecision, postAdminPostModeration } from '@/lib/admin-moderation-route-adapter-service';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

vi.mock('@/lib/showcase-feed-cache', () => ({ invalidateShowcaseFeedCache: vi.fn() }));
const configPath = process.env.AUDIT_STORAGE_CONFIG, connectionString = process.env.SUPABASE_TEST_DB_URL;


describe.skipIf(!configPath || !connectionString)('moderation take-down through actual sessions, SQL and Storage', () => {
  let db: Client, admin: SupabaseClient;
  let reviewerId: string, sessionId: string, token: string;
  let secret: string, passwordHash: string;
  let fixtureUsers: string[], postIds: string[], generationIds: string[], contactIds: string[], postReportIds: string[], subjectReportIds: string[];
  let expectedActions: { posts: number; generations: number; sanctions: number };
  let originalFetch: typeof fetch;
  let intercept: ((url: URL, method: string, target: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response | null>) | null = null;
  let objects: {bucket:'showcase_media'|'post_media';path:string}[];
  const imageBytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64'));
  const flows = [
    {name:'proactive',path:'/api/admin/moderation/posts',handler:postAdminPostModeration},
    {name:'report',path:'/api/admin/moderation/post-reports',handler:postAdminPostReportDecision},
  ];
  const request = (path: string, raw: string, signed = true) => new Request('http://127.0.0.1' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(signed ? { Cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}` } : {}) }, body: raw,
  });
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname); expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY);
    secret = randomUUID()+randomUUID(); passwordHash = `scrypt.16384.8.1.c2FsdHNhbHRzYWx0c2E.${'A'.repeat(86)}`;
    vi.stubEnv('ADMIN_USERNAME', 'local-audit'); vi.stubEnv('ADMIN_PASSWORD_HASH', passwordHash); vi.stubEnv('ADMIN_SESSION_SECRET', secret);
    originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== new URL(config.API_URL).origin) throw new Error('External network forbidden in local admin moderation controls');
      const method = init?.method ?? (target instanceof Request ? target.method : 'GET');
      const fault = await intercept?.(url, method, target, init);
      return fault ?? originalFetch(target, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    intercept = null; objects = []; vi.mocked(invalidateShowcaseFeedCache).mockClear();
    fixtureUsers = []; postIds = []; generationIds = []; contactIds = []; postReportIds = []; subjectReportIds = [];
    expectedActions = {posts:0,generations:0,sanctions:0};
    const made = await admin.auth.admin.createUser({ email: `admin-moderation-audit-${randomUUID()}@example.invalid`, password: randomUUID()+'aZ7!', email_confirm: true });
    expect(made.error).toBeNull(); reviewerId = made.data.user!.id; fixtureUsers.push(reviewerId);
    await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1', [reviewerId]);
    vi.stubEnv('ADMIN_REVIEWER_USER_ID', reviewerId);
    sessionId = randomUUID(); const now = new Date();
    const credentialVersion = await deriveAdminCredentialVersion({ secret, passwordHash });
    await insertAdminSession(admin, { sessionId, subject: 'master', credentialVersion, createdAt: now, expiresAt: new Date(now.getTime()+3600000) });
    token = await createAdminSessionToken({ secret, sessionId, credentialVersion, issuedAt: now, ttlSeconds: 3600 });
  });
  afterEach(async () => {
    try {
      expect((await db.query('select credits,promotional_credits from public.profiles where id=any($1::uuid[])', [fixtureUsers])).rows).toEqual(fixtureUsers.map(() => ({ credits:500,promotional_credits:0 })));
      expect((await db.query('select id from public.ai_usage_events where user_id=any($1::uuid[])', [fixtureUsers])).rows).toEqual([]);
      expect((await db.query(`select
      (select count(*) from public.admin_post_moderation_actions where reviewer_id=$1)::int as posts,
      (select count(*) from public.admin_generation_moderation_actions where reviewer_id=$1)::int as generations,
      (select count(*) from public.admin_user_sanctions where reviewer_id=$1)::int as sanctions`, [reviewerId])).rows[0]).toEqual(expectedActions);
    } finally {
      intercept = null;
      for (const bucket of ['showcase_media','post_media'] as const) {
        const paths=objects.filter(item=>item.bucket===bucket).map(item=>item.path);
        if(paths.length) expect((await admin.storage.from(bucket).remove(paths)).error).toBeNull();
      }
      await db.query('delete from public.post_reports where id=any($1::uuid[])', [postReportIds]);
      await db.query('delete from public.moderation_reports where id=any($1::uuid[])', [subjectReportIds]);
      for (const table of ['admin_post_moderation_actions','admin_generation_moderation_actions','admin_user_sanctions']) await db.query(`delete from public.${table} where reviewer_id=$1`, [reviewerId]);
      await db.query('delete from public.contact_messages where id=any($1::uuid[])', [contactIds]);
      await db.query('delete from public.posts where id=any($1::uuid[])', [postIds]);
      await db.query('delete from public.showcase_media_revocations where generation_id=any($1::uuid[])', [generationIds]);
      await db.query('delete from public.generations where id=any($1::uuid[])', [generationIds]);
      await db.query('delete from public.admin_sessions where session_id=$1', [sessionId]);
      await db.query('delete from auth.users where id=any($1::uuid[])', [fixtureUsers]);
      await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [fixtureUsers]);
    }
    expect((await db.query('select bucket_id,name from storage.objects where name=any($1::text[])',[objects.map(item=>item.path)])).rows).toEqual([]);
    expect((await db.query(`select
      (select count(*) from auth.users where id=any($1::uuid[]))::int as users,
      (select count(*) from public.profiles where id=any($1::uuid[]))::int as profiles,
      (select count(*) from public.admin_sessions where session_id=$2)::int as sessions,
      (select count(*) from public.backend_rate_limits where subject_key=any($1::text[]))::int as rates,
      (select count(*) from public.posts where id=any($3::uuid[]))::int as posts,
      (select count(*) from public.post_media where post_id=any($3::uuid[]))::int as post_media,
      (select count(*) from public.showcase_media_revocations where generation_id=any($4::uuid[]))::int as revocations,
      (select count(*) from public.generations where id=any($4::uuid[]))::int as generations,
      (select count(*) from public.contact_messages where id=any($5::uuid[]))::int as contacts,
      (select count(*) from public.post_reports where id=any($6::uuid[]))::int as post_reports,
      (select count(*) from public.moderation_reports where id=any($7::uuid[]))::int as subject_reports,
      (select count(*) from public.admin_post_moderation_actions where reviewer_id=$8)::int as post_actions,
      (select count(*) from public.admin_generation_moderation_actions where reviewer_id=$8)::int as generation_actions,
      (select count(*) from public.admin_user_sanctions where reviewer_id=$8)::int as sanctions,
      (select count(*) from public.ai_usage_events where user_id=any($1::uuid[]))::int as usage`, [fixtureUsers,sessionId,postIds,generationIds,contactIds,postReportIds,subjectReportIds,reviewerId])).rows[0])
      .toEqual({users:0,profiles:0,sessions:0,rates:0,posts:0,post_media:0,revocations:0,generations:0,contacts:0,post_reports:0,subject_reports:0,post_actions:0,generation_actions:0,sanctions:0,usage:0});
  });
  const upload = async (bucket: 'showcase_media'|'post_media', path: string) => {
    objects.push({bucket,path});
    expect((await admin.storage.from(bucket).upload(path,new Blob([imageBytes],{type:'image/png'}),{contentType:'image/png'})).error).toBeNull();
    return path;
  };
  const makePost = async (flow: typeof flows[number], withMedia = true) => {
    const id=randomUUID(); postIds.push(id);
    await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,review_status,post_format,title,body) values($1,$2,'public','text','external','visible','text','Fixture','Fixture body long enough for public text.')",[id,reviewerId]);
    let reportId: string | undefined;
    if(flow.name==='report') {
      reportId=randomUUID(); postReportIds.push(reportId);
      await db.query("insert into public.post_reports(id,post_id,reporter_user_id,reason) values($1,$2,$3,'spam')",[reportId,id,reviewerId]);
    } else expectedActions.posts=1;
    const body=flow.name==='report'?{reportId,action:'take_down',note:'Fixture confirmed violation'}:{postId:id,action:'take_down',reason:'Fixture confirmed violation',idempotencyKey:randomUUID()};
    if(withMedia) {
      const path=await upload('showcase_media',`posts/${id}/source.png`);
      await db.query('update public.posts set showcase_asset_path=$2 where id=$1',[id,path]);
    }
    return {id,body,invoke:()=>flow.handler(request(flow.path,JSON.stringify(body)))};
  };
  const stableDecision = async (id: string) => (await db.query('select review_status,reviewed_at,reviewed_by from public.posts where id=$1',[id])).rows[0];
  const assertRemoved = async () => {
    for(const {bucket,path} of objects) {
      const result=await admin.storage.from(bucket).download(path);
      expect(result.data).toBeNull(); expect(result.error).not.toBeNull();
    }
  };

  it.each(flows)('removes all public/private media variants and stable replay: $name',async flow=>{
    const fixture=await makePost(flow);
    const variants=await Promise.all(['original','preview','rendition','display','teaser'].map(name=>upload('post_media',`private-posts/${fixture.id}/${name}.png`)));
    await db.query("insert into public.post_media(post_id,media_kind,storage_path,preview_storage_path,rendition_storage_path,display_storage_path,teaser_storage_path,teaser_generated_at) values($1,'image',$2,$3,$4,$5,$6,now())",[fixture.id,...variants]);
    const signed=await admin.storage.from('post_media').createSignedUrl(variants[0],3600); expect(signed.error).toBeNull();
    const before=await fetch(signed.data!.signedUrl); expect(before.status).toBe(200); expect(new Uint8Array(await before.arrayBuffer())).toEqual(imageBytes);
    const first=await fixture.invoke(); expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({revokedMediaCount:6,mediaRevocationVerified:true,externalMediaRevocationRequired:false});
    const decision=await stableDecision(fixture.id); expect(decision).toMatchObject({review_status:'hidden',reviewed_by:reviewerId});
    await assertRemoved(); expect((await fetch(signed.data!.signedUrl)).ok).toBe(false);
    const duplicate=await fixture.invoke(); expect(duplicate.status).toBe(200); expect(await duplicate.json()).toMatchObject({mediaRevocationVerified:true});
    expect(await stableDecision(fixture.id)).toEqual(decision); expect(invalidateShowcaseFeedCache).toHaveBeenCalledTimes(2);
    const restore=await postAdminPostModeration(request('/api/admin/moderation/posts',JSON.stringify({postId:fixture.id,action:'restore',reason:'Fixture restore probe',idempotencyKey:randomUUID()})));
    expect(restore.status).toBe(409); expect(await stableDecision(fixture.id)).toEqual(decision);
  });

  it.each(flows.flatMap(flow=>['delete-error','delete-noop','head-error','committed-reply-loss'].map(fault=>({...flow,fault}))))('retries $fault after durable decision without a second mutation: $name',async flow=>{
    const fixture=await makePost(flow); let injected=0;
    intercept=async(url,method,target,init)=>{
      if(injected) return null;
      if(flow.fault==='committed-reply-loss'&&url.pathname.endsWith('/rpc/'+(flow.name==='report'?'resolve_post_report_for_ops':'apply_admin_post_moderation'))) {
        const actual=await originalFetch(target,init); expect(actual.ok).toBe(true); injected++;
        return Response.json({message:'Controlled reply loss after real SQL commit'},{status:504});
      }
      if(method==='DELETE'&&url.pathname==='/storage/v1/object/showcase_media'&&flow.fault.startsWith('delete')) {
        injected++; return flow.fault==='delete-noop'?Response.json([]):Response.json({message:'Controlled deletion failure'},{status:503});
      }
      if(flow.fault==='head-error'&&method==='HEAD'&&url.pathname.startsWith('/storage/v1/object/showcase_media/posts/'+fixture.id+'/')) {
        injected++; return new Response(null,{status:503});
      }
      return null;
    };
    const first=await fixture.invoke(); expect(first.status).toBe(400); expect(injected).toBe(1);
    expect(await first.json()).not.toHaveProperty('mediaRevocationVerified',true);
    const decision=await stableDecision(fixture.id); expect(decision).toMatchObject({review_status:'hidden',reviewed_by:reviewerId});
    if(flow.fault==='head-error') await assertRemoved();
    else expect((await admin.storage.from(objects[0].bucket).download(objects[0].path)).error).toBeNull();
    intercept=null;
    const retry=await fixture.invoke(); expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({mediaRevocationVerified:true});
    await assertRemoved(); expect(await stableDecision(fixture.id)).toEqual(decision);
  });

  it.each(flows)('rejects a foreign path before deleting any owned object, then recovers: $name',async flow=>{
    const fixture=await makePost(flow); const foreign=await upload('showcase_media',`posts/${randomUUID()}/unrelated.png`);
    await db.query("insert into public.post_media(post_id,media_kind,storage_path,preview_storage_path) values($1,'image',$2,$3)",[fixture.id,objects[0].path,foreign]);
    const response=await fixture.invoke(); expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('outside the reported post scope');
    for(const item of objects) expect((await admin.storage.from(item.bucket).download(item.path)).error).toBeNull();
    const decision=await stableDecision(fixture.id);
    await db.query('update public.post_media set preview_storage_path=null where post_id=$1',[fixture.id]);
    expect((await fixture.invoke()).status).toBe(200);
    expect((await admin.storage.from('showcase_media').download(objects[0].path)).data).toBeNull();
    expect((await admin.storage.from('showcase_media').download(foreign)).error).toBeNull();
    expect(await stableDecision(fixture.id)).toEqual(decision);
  });

  it.each(flows)('discloses external-only media instead of requesting its provider: $name',async flow=>{
    const fixture=await makePost(flow,false);
    await db.query('update public.posts set output_url=$2 where id=$1',[fixture.id,'https://provider.example.invalid/media.png']);
    const response=await fixture.invoke(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({revokedMediaCount:0,mediaRevocationVerified:true,externalMediaRevocationRequired:true});
  });

  it('preserves media for provisional hide/restore and permits later escalation',async()=>{
    const fixture=await makePost(flows[0]); expectedActions.posts=3;
    const invoke=async(action:string)=>postAdminPostModeration(request(flows[0].path,JSON.stringify({...fixture.body,action,idempotencyKey:randomUUID()})));
    expect((await invoke('hide')).status).toBe(200);
    expect((await admin.storage.from(objects[0].bucket).download(objects[0].path)).error).toBeNull();
    expect((await invoke('restore')).status).toBe(200);
    expect((await stableDecision(fixture.id)).review_status).toBe('visible');
    expect((await admin.storage.from(objects[0].bucket).download(objects[0].path)).error).toBeNull();
    expect((await invoke('take_down')).status).toBe(200); await assertRemoved();
  });

  it('checks generation ownership before revoking a showcase generation path',async()=>{
    const fixture=await makePost(flows[0],false);
    const made=await admin.auth.admin.createUser({email:`admin-moderation-audit-${randomUUID()}@example.invalid`,password:randomUUID()+'aZ7!',email_confirm:true}); expect(made.error).toBeNull();
    const other=made.data.user!.id; fixtureUsers.push(other); await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1',[other]);
    const generationId=randomUUID(); generationIds.push(generationId);
    await db.query("insert into public.generations(id,user_id,status,model,category,cost,is_public) values($1,$2,'succeeded','audit-inert','image',0,true)",[generationId,other]);
    const foreign=await upload('showcase_media',`showcase/${generationId}/source.png`);
    await db.query('update public.posts set generation_id=$2,showcase_asset_path=$3 where id=$1',[fixture.id,generationId,foreign]);
    const response=await fixture.invoke(); expect(response.status).toBe(400); expect((await response.json()).error).toContain('outside the reported post scope');
    expect((await admin.storage.from('showcase_media').download(foreign)).error).toBeNull();
    const decision=await stableDecision(fixture.id);
    await db.query('update public.generations set user_id=$2 where id=$1',[generationId,reviewerId]);
    expect((await fixture.invoke()).status).toBe(200); await assertRemoved();
    expect(await stableDecision(fixture.id)).toEqual(decision);
  });
});
