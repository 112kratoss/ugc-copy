import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_SESSION_COOKIE, createAdminSessionToken, deriveAdminCredentialVersion } from '@/lib/admin-session-token';
import { insertAdminSession } from '@/lib/admin-session-store';
import { postAdminPostReportDecision, postAdminSubjectReportDecision, postAdminPostModeration } from '@/lib/admin-moderation-route-adapter-service';
import { postAdminGenerationModeration, postAdminContactTriage } from '@/lib/admin-content-moderation-route-adapter-service';
import { postAdminUserSanction } from '@/lib/admin-user-sanction-route-adapter-service';

vi.mock('@/lib/showcase-feed-cache', () => ({ invalidateShowcaseFeedCache: vi.fn() }));
const configPath = process.env.AUDIT_STORAGE_CONFIG, connectionString = process.env.SUPABASE_TEST_DB_URL;
const routes = [
  { path: '/api/admin/moderation/post-reports', handler: postAdminPostReportDecision },
  { path: '/api/admin/moderation/subject-reports', handler: postAdminSubjectReportDecision },
  { path: '/api/admin/moderation/posts', handler: postAdminPostModeration },
  { path: '/api/admin/moderation/generations', handler: postAdminGenerationModeration },
  { path: '/api/admin/contact', handler: postAdminContactTriage },
  { path: '/api/admin/users/sanctions', handler: postAdminUserSanction },
];

describe.skipIf(!configPath || !connectionString)('admin moderation through actual authoritative sessions and PostgREST', () => {
  let db: Client, admin: SupabaseClient;
  let reviewerId: string, sessionId: string, token: string;
  let secret: string, passwordHash: string;
  let fixtureUsers: string[], postIds: string[], generationIds: string[], contactIds: string[], postReportIds: string[], subjectReportIds: string[];
  let expectedActions: { posts: number; generations: number; sanctions: number };
  const request = (path: string, raw: string, signed = true) => new Request('http://127.0.0.1' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(signed ? { Cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}` } : {}) }, body: raw,
  });
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname); expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY);
    secret = randomUUID()+randomUUID(); passwordHash = `scrypt.16384.8.1.c2FsdHNhbHRzYWx0c2E.${'A'.repeat(86)}`;
    vi.stubEnv('ADMIN_USERNAME', 'local-audit'); vi.stubEnv('ADMIN_PASSWORD_HASH', passwordHash); vi.stubEnv('ADMIN_SESSION_SECRET', secret);
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== new URL(config.API_URL).origin) throw new Error('External network forbidden in local admin moderation controls');
      return originalFetch(target, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
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
      await db.query('delete from public.post_reports where id=any($1::uuid[])', [postReportIds]);
      await db.query('delete from public.moderation_reports where id=any($1::uuid[])', [subjectReportIds]);
      for (const table of ['admin_post_moderation_actions','admin_generation_moderation_actions','admin_user_sanctions']) await db.query(`delete from public.${table} where reviewer_id=$1`, [reviewerId]);
      await db.query('delete from public.contact_messages where id=any($1::uuid[])', [contactIds]);
      await db.query('delete from public.posts where id=any($1::uuid[])', [postIds]);
      await db.query('delete from public.generations where id=any($1::uuid[])', [generationIds]);
      await db.query('delete from public.admin_sessions where session_id=$1', [sessionId]);
      await db.query('delete from auth.users where id=any($1::uuid[])', [fixtureUsers]);
      await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [fixtureUsers]);
    }
    expect((await db.query(`select
      (select count(*) from auth.users where id=any($1::uuid[]))::int as users,
      (select count(*) from public.profiles where id=any($1::uuid[]))::int as profiles,
      (select count(*) from public.admin_sessions where session_id=$2)::int as sessions,
      (select count(*) from public.backend_rate_limits where subject_key=any($1::text[]))::int as rates,
      (select count(*) from public.posts where id=any($3::uuid[]))::int as posts,
      (select count(*) from public.generations where id=any($4::uuid[]))::int as generations,
      (select count(*) from public.contact_messages where id=any($5::uuid[]))::int as contacts,
      (select count(*) from public.post_reports where id=any($6::uuid[]))::int as post_reports,
      (select count(*) from public.moderation_reports where id=any($7::uuid[]))::int as subject_reports,
      (select count(*) from public.admin_post_moderation_actions where reviewer_id=$8)::int as post_actions,
      (select count(*) from public.admin_generation_moderation_actions where reviewer_id=$8)::int as generation_actions,
      (select count(*) from public.admin_user_sanctions where reviewer_id=$8)::int as sanctions,
      (select count(*) from public.ai_usage_events where user_id=any($1::uuid[]))::int as usage`, [fixtureUsers,sessionId,postIds,generationIds,contactIds,postReportIds,subjectReportIds,reviewerId])).rows[0])
      .toEqual({users:0,profiles:0,sessions:0,rates:0,posts:0,generations:0,contacts:0,post_reports:0,subject_reports:0,post_actions:0,generation_actions:0,sanctions:0,usage:0});
  });

  it.each(routes)('rejects null safely after real session admission: $path', async ({path,handler}) => {
    const response = await handler(request(path, 'null')); expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json(); expect(body.error).not.toMatch(/Cannot read|TypeError|migration|undefined/i);
  });

  it.each(routes)('denies unsigned null before parsing or privileged mutation: $path', async ({path,handler}) => {
    const response = await handler(request(path, 'null', false)); expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it.each(routes.flatMap(route => ['[]', '42', '"invalid"', '{'].map(raw => ({ ...route, raw }))))('rejects invalid root $raw after real admission: $path', async ({path,handler,raw}) => {
    const response = await handler(request(path, raw)); expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await response.json()).error).not.toMatch(/Cannot read|TypeError|migration|undefined/i);
  });

  it.each(routes.flatMap(route => ['revoked', 'missing', 'expired'].map(state => ({ ...route, state }))))('denies $state authoritative session before null parsing: $path', async ({path,handler,state}) => {
    if (state === 'revoked') await db.query('update public.admin_sessions set revoked_at=greatest(created_at,now()) where session_id=$1', [sessionId]);
    else if (state === 'expired') await db.query("update public.admin_sessions set created_at=now()-interval '2 hours',expires_at=now()-interval '1 second' where session_id=$1", [sessionId]);
    else await db.query('delete from public.admin_sessions where session_id=$1', [sessionId]);
    const response = await handler(request(path, 'null')); expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it.each(routes)('preserves valid mutation, actor binding and duplicate behavior: $path', async ({path,handler}) => {
    const invoke = async (body: Record<string, unknown>) => {
      const response = await handler(request(path, JSON.stringify({ ...body, reviewerId: randomUUID() })));
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store'); return response.json();
    };
    if (path.endsWith('/contact')) {
      const id = randomUUID(); contactIds.push(id);
      await db.query("insert into public.contact_messages(id,name,email,subject,message) values($1,'Fixture','fixture@example.invalid','Fixture subject','Fixture body')", [id]);
      const row = async () => (await db.query('select handled_at,handled_by,handled_note from public.contact_messages where id=$1', [id])).rows[0];
      await invoke({ messageId:id,handled:true,note:'Fixture handled' }); const first = await row(); expect(first).toMatchObject({handled_by:reviewerId,handled_note:'Fixture handled'}); expect(first.handled_at).not.toBeNull();
      await invoke({ messageId:id,handled:true,note:'Duplicate note' }); expect(await row()).toEqual(first);
      await invoke({ messageId:id,handled:false }); expect(await row()).toEqual({handled_at:null,handled_by:null,handled_note:null});
    } else if (path.endsWith('/generations')) {
      const id = randomUUID(); generationIds.push(id); expectedActions.generations=2;
      await db.query("insert into public.generations(id,user_id,status,model,category,cost,is_public) values($1,$2,'succeeded','audit-inert','image',0,true)", [id,reviewerId]);
      const body = {generationId:id,action:'remove',reason:'Fixture moderation',idempotencyKey:randomUUID()};
      expect(await invoke(body)).toMatchObject({status:'applied'}); expect(await invoke(body)).toMatchObject({status:'already_applied'});
      const removed = (await db.query('select moderation_removed_by,is_public from public.generations where id=$1', [id])).rows[0]; expect(removed).toEqual({moderation_removed_by:reviewerId,is_public:false});
      await invoke({...body,action:'restore',idempotencyKey:randomUUID()});
      expect((await db.query('select moderation_removed_at,moderation_removed_by,is_public from public.generations where id=$1', [id])).rows[0]).toEqual({moderation_removed_at:null,moderation_removed_by:null,is_public:true});
    } else if (path.endsWith('/sanctions')) {
      const made = await admin.auth.admin.createUser({email:`admin-moderation-audit-${randomUUID()}@example.invalid`,password:randomUUID()+'aZ7!',email_confirm:true}); expect(made.error).toBeNull(); const id=made.data.user!.id; fixtureUsers.push(id);
      await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1', [id]); expectedActions.sanctions=2;
      const body = {userId:id,action:'suspend',reason:'Fixture sanction',durationHours:24,idempotencyKey:randomUUID()};
      expect(await invoke(body)).toMatchObject({status:'applied'}); expect(await invoke(body)).toMatchObject({status:'already_applied'});
      expect((await db.query('select banned_until>now() as banned from auth.users where id=$1', [id])).rows[0].banned).toBe(true);
      await invoke({...body,action:'reinstate',idempotencyKey:randomUUID()}); expect((await db.query('select banned_until from auth.users where id=$1', [id])).rows[0].banned_until).toBeNull();
      expect((await db.query('select distinct reviewer_id from public.admin_user_sanctions where user_id=$1', [id])).rows).toEqual([{reviewer_id:reviewerId}]);
    } else if (path.endsWith('/subject-reports')) {
      const id=randomUUID(); subjectReportIds.push(id);
      const made = await admin.auth.admin.createUser({email:`admin-moderation-audit-${randomUUID()}@example.invalid`,password:randomUUID()+'aZ7!',email_confirm:true}); expect(made.error).toBeNull(); const targetId=made.data.user!.id; fixtureUsers.push(targetId);
      await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1', [targetId]);
      await db.query("insert into public.moderation_reports(id,reporter_user_id,target_type,reported_user_id,reason,source_surface) values($1,$2,'user',$3,'spam','creator-profile')", [id,reviewerId,targetId]);
      const body = {reportId:id,action:'dismiss',note:'Fixture dismissal'}; expect(await invoke(body)).toMatchObject({status:'dismissed'});
      const row = async () => (await db.query('select status,reviewed_at,reviewed_by,resolution_note from public.moderation_reports where id=$1', [id])).rows[0];
      const first=await row(); expect(first).toMatchObject({status:'dismissed',reviewed_by:reviewerId,resolution_note:'Fixture dismissal'});
      expect(await invoke(body)).toMatchObject({status:'already_resolved'}); expect(await row()).toEqual(first);
    } else {
      const id=randomUUID(); postIds.push(id);
      await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,review_status,post_format,title,body) values($1,$2,'public','text','external','visible','text','Fixture','Fixture body long enough for public text.')", [id,reviewerId]);
      if (path.endsWith('/post-reports')) {
        const reportId=randomUUID(); postReportIds.push(reportId); await db.query("insert into public.post_reports(id,post_id,reporter_user_id,reason) values($1,$2,$3,'spam')", [reportId,id,reviewerId]);
        const body={reportId,action:'dismiss',note:'Fixture dismissal'}; expect(await invoke(body)).toMatchObject({status:'dismissed'});
        const row = async () => (await db.query('select status,reviewed_at,reviewed_by,resolution_note from public.post_reports where id=$1', [reportId])).rows[0];
        const first=await row(); expect(first).toMatchObject({status:'dismissed',reviewed_by:reviewerId,resolution_note:'Fixture dismissal'});
        expect(await invoke(body)).toMatchObject({status:'already_resolved'}); expect(await row()).toEqual(first);
      } else {
        expectedActions.posts=2; const body={postId:id,action:'hide',reason:'Fixture moderation',idempotencyKey:randomUUID()};
        await invoke(body); await invoke(body); expect((await db.query('select review_status,reviewed_by from public.posts where id=$1', [id])).rows[0]).toEqual({review_status:'hidden',reviewed_by:reviewerId});
        await invoke({...body,action:'restore',idempotencyKey:randomUUID()}); expect((await db.query('select review_status from public.posts where id=$1', [id])).rows[0].review_status).toBe('visible');
      }
    }
  });
});
