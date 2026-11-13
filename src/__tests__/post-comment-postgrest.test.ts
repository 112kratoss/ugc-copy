import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPostCommentForRoute,
  listPostCommentsForRoute,
  removePostCommentForRoute,
  updatePostCommentForRoute,
} from '@/lib/post-comments-service';

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
  const update = (commentId: string, actorUserId: string, change: Record<string, unknown>) => updatePostCommentForRoute({
    postId: post, commentId, actorUserId, readBody: async () => change, createAdminSupabase: () => admin,
  });
  const created = async (userId = author, body = 'Audit comment', parentId?: string) => {
    const result = await create(userId, body, parentId);
    if (!result.ok) throw new Error('Fixture comment failed');
    return result.body.comment.id;
  };
  const listed = async (userId: string | null = viewer, sort: 'top' | 'newest' = 'top') => {
    const result = await listPostCommentsForRoute({
      postId: post, viewerUserId: userId, sort, createAdminSupabase: () => admin,
    });
    if (!result.ok) throw new Error('Fixture thread failed');
    return result.body.comments;
  };

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

  // 20261113191038: likes and dislikes, the creator's heart, the pin and edits,
  // through the service and the real functions, counters and constraints.
  it('counts a like once a reader, answers each reader their own reaction, and orders Top by likes', async () => {
    const first = await created(author, 'First');
    const second = await created(author, 'Second');
    expect(await update(second, viewer, { reaction: 'like' })).toMatchObject({
      ok: true, body: { comment: { id: second, likeCount: 1, viewerReaction: 'like' }, unpinnedCommentId: null },
    });
    // The same like again is the same like.
    expect(await update(second, viewer, { reaction: 'like' })).toMatchObject({ ok: true, body: { comment: { likeCount: 1 } } });
    expect(await update(second, owner, { reaction: 'like' })).toMatchObject({ ok: true, body: { comment: { likeCount: 2 } } });
    expect(await update(first, owner, { reaction: 'dislike' })).toMatchObject({
      ok: true, body: { comment: { likeCount: 0, viewerReaction: 'dislike' } },
    });

    // Top: the liked comment first, though it is not the newest... it is, so Newest agrees; a like on the older one flips Top only.
    expect((await listed(viewer)).map((item) => [item.id, item.likeCount, item.viewerReaction]))
      .toEqual([[second, 2, 'like'], [first, 0, null]]);
    expect((await listed(owner)).map((item) => item.viewerReaction)).toEqual(['like', 'dislike']);
    expect((await listed(null)).map((item) => item.viewerReaction)).toEqual([null, null]);
    await update(second, viewer, { reaction: null });
    await update(second, owner, { reaction: null });
    await update(first, viewer, { reaction: 'like' });
    expect((await listed(null, 'top')).map((item) => item.id)).toEqual([first, second]);
    expect((await listed(null, 'newest')).map((item) => item.id)).toEqual([second, first]);
    // No answer anywhere carries how many disliked.
    expect(JSON.stringify(await listed(owner))).not.toMatch(/dislike_?count/i);
    const counts = await db.query('select like_count, dislike_count from public.post_comments where id=$1', [first]);
    expect(counts.rows[0]).toEqual({ like_count: 1, dislike_count: 1 });
  });

  it('refuses a reaction across a block and on a removed comment', async () => {
    const comment = await created();
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', [author, viewer]);
    expect(await update(comment, viewer, { reaction: 'like' })).toMatchObject({ ok: false, status: 403 });
    await db.query('delete from public.user_blocks where blocker_user_id=$1', [author]);
    expect(await update(comment, viewer, { reaction: 'like' })).toMatchObject({ ok: true });
    await remove(comment);
    expect(await update(comment, viewer, { reaction: 'dislike' })).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses an edit across a block with the post owner or the comment replied to, and saves nothing', async () => {
    const parent = await created(author, 'Parent');
    const reply = await created(viewer, 'A reply', parent);
    const words = async (id: string) => (await db.query('select body, edited_at from public.post_comments where id=$1', [id])).rows[0];

    // The post's owner blocked the commenter after the comment was written.
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', [owner, author]);
    expect(await update(parent, author, { body: 'New words on their post' })).toMatchObject({ ok: false, status: 403 });
    expect(await words(parent)).toMatchObject({ body: 'Parent', edited_at: null });
    await db.query('delete from public.user_blocks where blocker_user_id=$1', [owner]);

    // The author of the comment a reply answers blocked the replier.
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', [author, viewer]);
    expect(await update(reply, viewer, { body: 'New words under their comment' })).toMatchObject({ ok: false, status: 403 });
    expect(await words(reply)).toMatchObject({ body: 'A reply', edited_at: null });
    expect((await db.query('select count(*)::int as n from public.post_comment_edits where comment_id = any($1)', [[parent, reply]])).rows[0].n).toBe(0);

    await db.query('delete from public.user_blocks where blocker_user_id=$1', [author]);
    expect(await update(reply, viewer, { body: 'Reworded' })).toMatchObject({ ok: true, body: { comment: { body: 'Reworded' } } });
  });

  it('keeps the heart and the pin for the post owner, moves the one pin, and leads the thread with it', async () => {
    const first = await created(author, 'First');
    const second = await created(viewer, 'Second');
    const reply = await created(viewer, 'Reply', first);
    const own = await created(owner, 'From the owner');

    expect(await update(first, author, { hearted: true })).toMatchObject({ ok: false, status: 403 });
    expect(await update(first, viewer, { pinned: true })).toMatchObject({ ok: false, status: 403 });
    expect(await update(own, owner, { hearted: true })).toMatchObject({ ok: false, status: 400 });
    expect(await update(reply, owner, { pinned: true })).toMatchObject({ ok: false, status: 400 });

    expect(await update(reply, owner, { hearted: true })).toMatchObject({ ok: true, body: { comment: { hearted: true } } });
    expect(await update(first, owner, { pinned: true })).toMatchObject({
      ok: true, body: { comment: { pinned: true }, unpinnedCommentId: null },
    });
    // The oldest comment, pinned, leads both orders.
    expect((await listed(null, 'newest')).map((item) => [item.id, item.pinned]))
      .toEqual([[first, true], [own, false], [second, false]]);
    expect((await listed(null, 'top'))[0]).toMatchObject({ id: first, pinned: true });

    expect(await update(own, owner, { pinned: true })).toMatchObject({
      ok: true, body: { comment: { id: own, pinned: true }, unpinnedCommentId: first },
    });
    expect((await listed(null, 'newest')).map((item) => [item.id, item.pinned]))
      .toEqual([[own, true], [second, false], [first, false]]);

    // A reader who blocked the pinned comment's author does not get it.
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', [author, owner]);
    await update(own, owner, { pinned: false });
    await update(first, owner, { pinned: true });
    await db.query('delete from public.user_blocks where blocker_user_id=$1', [author]);
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', [viewer, author]);
    expect((await listed(viewer, 'newest')).map((item) => item.id)).toEqual([own, second]);

    // Removed, a comment keeps neither mark, and the post can pin again.
    await remove(first);
    const marks = await db.query('select pinned_at, hearted_at from public.post_comments where id=$1', [first]);
    expect(marks.rows[0]).toEqual({ pinned_at: null, hearted_at: null });
    expect(await update(second, owner, { pinned: true })).toMatchObject({ ok: true, body: { unpinnedCommentId: null } });
  });

  it('lets only its author edit a comment, keeps the words replaced, and takes the heart off', async () => {
    const comment = await created(author, 'First words');
    await update(comment, owner, { hearted: true });

    expect(await update(comment, owner, { body: 'The owner rewrites it' })).toMatchObject({ ok: false, status: 403 });
    // The same words: not an edit, and the heart stays.
    expect(await update(comment, author, { body: '  First words ' })).toMatchObject({
      ok: true, body: { comment: { body: 'First words', editedAt: null, hearted: true } },
    });
    const edited = await update(comment, author, { body: 'Better words' });
    expect(edited).toMatchObject({ ok: true, body: { comment: { body: 'Better words', hearted: false } } });
    if (!edited.ok) throw new Error('Fixture edit failed');
    expect(edited.body.comment.editedAt).toEqual(expect.any(String));
    expect((await listed(null))[0]).toMatchObject({ body: 'Better words', editedAt: edited.body.comment.editedAt });

    const history = await db.query('select previous_body from public.post_comment_edits where comment_id=$1', [comment]);
    expect(history.rows).toEqual([{ previous_body: 'First words' }]);
  });
});
