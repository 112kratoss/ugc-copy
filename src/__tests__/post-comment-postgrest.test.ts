import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostCommentForRoute, listPostCommentsForRoute, removePostCommentForRoute } from '@/lib/post-comments-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('comment services with actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let owner: string;
  let author: string;
  let viewer: string;
  let post: string;
  const create = (userId = author, body = 'Audit comment', parentId?: string) => createPostCommentForRoute({
    postId: post, authorUserId: userId, readBody: async () => ({ body, parentId }), createAdminSupabase: () => admin,
  });
  const list = (userId: string | null = viewer, parentId?: string) => listPostCommentsForRoute({
    postId: post, viewerUserId: userId, parentId, createAdminSupabase: () => admin,
  });
  const remove = (commentId: string, actorUserId = author) => removePostCommentForRoute({
    postId: post, commentId, actorUserId, createAdminSupabase: () => admin,
  });

  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8')) as { API_URL: string; SERVICE_ROLE_KEY: string };
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [owner, author, viewer, post] = Array.from({ length: 4 }, () => randomUUID());
    for (const id of [owner, author, viewer]) {
      await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [id, `${id}@example.invalid`]);
    }
    await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,review_status,post_format,body) values($1,$2,'public','text','manual','visible','text','Audit fixture')", [post, owner]);
  });
  afterEach(async () => {
    await db.query('delete from public.posts where id=$1', [post]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[owner, author, viewer]]);
    await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [[owner, author, viewer]]);
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [[owner, author, viewer]])).rows).toHaveLength(0);
  });

  it('creates, reads, denies foreign removal, and removes an authored comment', async () => {
    const created = await create();
    expect(created).toMatchObject({ ok: true, status: 201, body: { commentCount: 1 } });
    if (!created.ok) throw new Error('Fixture comment failed');
    expect(await list(null)).toMatchObject({ ok: true, body: { comments: [{ id: created.body.comment.id, body: 'Audit comment' }] } });
    expect(await remove(created.body.comment.id, viewer)).toMatchObject({ ok: false, status: 403 });
    expect(await remove(created.body.comment.id)).toMatchObject({ ok: true, body: { commentCount: 0 } });
    expect(await list()).toMatchObject({ ok: true, body: { comments: [] } });
  });

  it('preserves a removed parent placeholder while its reply remains readable', async () => {
    const parent = await create();
    if (!parent.ok) throw new Error('Fixture comment failed');
    expect(await create(viewer, 'Reply', parent.body.comment.id)).toMatchObject({ ok: true });
    await remove(parent.body.comment.id);
    expect(await list()).toMatchObject({ ok: true, body: { comments: [{ status: 'removed_by_author', body: '' }] } });
    expect(await list(viewer, parent.body.comment.id)).toMatchObject({ ok: true, body: { comments: [{ body: 'Reply' }] } });
  });

  it('hides blocked comment authors and denies new comments across a creator block', async () => {
    await create();
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', [viewer, author]);
    expect(await list()).toMatchObject({ ok: true, body: { comments: [] } });
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', [owner, viewer]);
    expect(await create(viewer)).toMatchObject({ ok: false, status: 403 });
  });

  it.each(['viewer-blocks-owner', 'owner-blocks-viewer'])('does not expose a blocked creator thread when %s', async direction => {
    await create();
    const pair = direction === 'viewer-blocks-owner' ? [viewer, owner] : [owner, viewer];
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', pair);
    expect(await list()).toMatchObject({ ok: false, status: 404 });
  });

  it.each(['private', 'archived', 'hidden'])('denies comment reads and creates after a post becomes %s', async mode => {
    await create();
    if (mode === 'private') await db.query("update public.posts set visibility='private' where id=$1", [post]);
    if (mode === 'archived') await db.query('update public.posts set archived_at=now() where id=$1', [post]);
    if (mode === 'hidden') await db.query("update public.posts set review_status='hidden' where id=$1", [post]);
    expect(await list()).toMatchObject({ ok: false, status: 404 });
    expect(await create()).toMatchObject({ ok: false, status: 404 });
  });
});
