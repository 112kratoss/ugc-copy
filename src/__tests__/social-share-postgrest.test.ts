import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shareShowcasePostForRoute } from '@/lib/showcase-share-service';
import { shareCreatorProfileForRoute } from '@/lib/profile-share-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('share boundaries through actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let owner: string;
  let viewer: string;
  let post: string;
  let username: string;
  const notify = vi.fn(async () => null);
  const sharePost = (actorUserId: string | null = viewer) => shareShowcasePostForRoute({
    actorUserId, referenceId: post, channel: 'copy-link', sourceSurface: 'feed', serviceClient: admin,
    dependencies: { notifyPostSocialActivity: notify },
  });
  const shareProfile = (actorUserId: string | null = viewer) => shareCreatorProfileForRoute({
    actorUserId, username, channel: 'copy-link', sourceSurface: 'creator-profile', serviceClient: admin,
  });
  const counts = async () => (await db.query(`select
    (select share_count from public.posts where id=$1) post_count,
    (select count(*)::int from public.post_share_events where post_id=$1) post_events,
    (select share_count from public.profiles where id=$2) profile_count,
    (select count(*)::int from public.profile_share_events where profile_user_id=$2) profile_events`, [post, owner])).rows[0];

  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    anon = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false } });
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [owner, viewer, post] = Array.from({ length: 3 }, () => randomUUID());
    username = 'audit-' + owner.slice(0, 8);
    notify.mockClear();
    for (const id of [owner, viewer]) await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [id, `${id}@example.invalid`]);
    await db.query('update public.profiles set username=$1 where id=$2', [username, owner]);
    await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,review_status,post_format,body) values($1,$2,'public','text','manual','visible','text','Share audit fixture')", [post, owner]);
  });
  afterEach(async () => {
    await db.query('delete from public.posts where id=$1', [post]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[owner, viewer]]);
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [[owner, viewer]])).rows).toHaveLength(0);
  });

  it.each(['signed-in', 'anonymous'] as const)('records %s post and profile shares against their actual targets', async (identity) => {
    const actor = identity === 'anonymous' ? null : viewer;
    expect(await sharePost(actor)).toMatchObject({ ok: true });
    expect(await shareProfile(actor)).toMatchObject({ ok: true });
    expect(await counts()).toEqual({ post_count: 1, post_events: 1, profile_count: 1, profile_events: 1 });
    expect((await db.query('select actor_user_id from public.post_share_events where post_id=$1', [post])).rows[0].actor_user_id).toBe(actor);
    expect((await db.query('select actor_user_id from public.profile_share_events where profile_user_id=$1', [owner])).rows[0].actor_user_id).toBe(actor);
    expect(notify).toHaveBeenCalledTimes(actor ? 1 : 0);
  });

  it.each(['private', 'archived', 'hidden'] as const)('denies a %s post without recording or notifying', async (state) => {
    if (state === 'private') await db.query("update public.posts set visibility='private' where id=$1", [post]);
    if (state === 'archived') await db.query('update public.posts set archived_at=now() where id=$1', [post]);
    if (state === 'hidden') await db.query("update public.posts set review_status='hidden' where id=$1", [post]);
    expect(await sharePost()).toMatchObject({ ok: false, status: 404 });
    expect(await counts()).toMatchObject({ post_count: 0, post_events: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'creator'] as const)('denies both shares when the %s blocks the other identity', async (direction) => {
    const pair = direction === 'viewer' ? [viewer, owner] : [owner, viewer];
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', pair);
    expect(await sharePost()).toMatchObject({ ok: false, status: 404 });
    expect(await shareProfile()).toMatchObject({ ok: false, status: 404 });
    expect(await counts()).toEqual({ post_count: 0, post_events: 0, profile_count: 0, profile_events: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('denies a removed username without recording a profile share', async () => {
    await db.query('update public.profiles set username=null where id=$1', [owner]);
    expect(await shareProfile()).toMatchObject({ ok: false, status: 404 });
    expect(await counts()).toMatchObject({ profile_count: 0, profile_events: 0 });
  });

  it('atomically counts concurrent shares as separate events', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, async () => [await sharePost(null), await shareProfile(null)]));
    expect(results.flat().every(result => result.ok)).toBe(true);
    expect(await counts()).toEqual({ post_count: 8, post_events: 8, profile_count: 8, profile_events: 8 });
  });

  it('rejects invalid RPC events without partial counter updates', async () => {
    const a = await admin.rpc('record_post_share_event', { p_post_id: post, p_event_type: 'share_click', p_source_surface: 'invalid', p_channel: 'copy-link', p_actor_user_id: viewer });
    const b = await admin.rpc('record_profile_share_event', { p_profile_user_id: owner, p_event_type: 'share_click', p_source_surface: 'invalid', p_channel: 'copy-link', p_actor_user_id: viewer });
    expect(a.error?.code).toBe('23514');
    expect(b.error?.code).toBe('23514');
    expect(await counts()).toEqual({ post_count: 0, post_events: 0, profile_count: 0, profile_events: 0 });
  });

  it('preserves aggregate reach and anonymizes events when the actor is deleted', async () => {
    expect(await sharePost()).toMatchObject({ ok: true });
    expect(await shareProfile()).toMatchObject({ ok: true });
    await db.query('delete from auth.users where id=$1', [viewer]);
    expect(await counts()).toEqual({ post_count: 1, post_events: 1, profile_count: 1, profile_events: 1 });
    expect((await db.query('select actor_user_id from public.post_share_events where post_id=$1', [post])).rows[0].actor_user_id).toBeNull();
    expect((await db.query('select actor_user_id from public.profile_share_events where profile_user_id=$1', [owner])).rows[0].actor_user_id).toBeNull();
  });

  it('removes both target event ledgers when the creator is deleted', async () => {
    expect(await sharePost()).toMatchObject({ ok: true });
    expect(await shareProfile()).toMatchObject({ ok: true });
    await db.query('delete from auth.users where id=$1', [owner]);
    expect(await counts()).toEqual({ post_count: null, post_events: 0, profile_count: null, profile_events: 0 });
  });

  it('denies anonymous direct RPC calls even with valid forged actor IDs', async () => {
    const a = await anon.rpc('record_post_share_event', { p_post_id: post, p_event_type: 'share_click', p_source_surface: 'feed', p_channel: 'copy-link', p_actor_user_id: viewer });
    const b = await anon.rpc('record_profile_share_event', { p_profile_user_id: owner, p_event_type: 'share_click', p_source_surface: 'creator-profile', p_channel: 'copy-link', p_actor_user_id: viewer });
    expect(a.error?.code).toBe('42501');
    expect(b.error?.code).toBe('42501');
    expect(await counts()).toEqual({ post_count: 0, post_events: 0, profile_count: 0, profile_events: 0 });
  });
});
