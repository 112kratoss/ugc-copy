import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!connectionString)('post comment lifecycle with actual PostgreSQL', () => {
  let db: Client;
  let owner: string;
  let author: string;
  let stranger: string;
  let post: string;
  let otherPost: string;
  const connect = async () => {
    const client = new Client({ connectionString, statement_timeout: 10000 });
    await client.connect();
    return client;
  };
  const create = async (userId = author, parent: string | null = null, target = post, client = db) => (
    await client.query('select * from public.create_post_comment($1,$2,$3,$4)', [target, userId, parent, 'Audit comment'])
  ).rows[0];
  const remove = (commentId: string, actor = author, status = 'removed_by_author', client = db) => client.query(
    'select * from public.set_post_comment_status($1,$2,$3)', [commentId, actor, status],
  );
  const counts = async () => (await db.query(
    "select comment_count, (select count(*)::int from public.post_comments where post_id=$1 and status='active') actual from public.posts where id=$1", [post],
  )).rows[0];

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = await connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [owner, author, stranger, post, otherPost] = Array.from({ length: 5 }, () => randomUUID());
    for (const id of [owner, author, stranger]) {
      await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [id, `${id}@example.invalid`]);
    }
    for (const id of [post, otherPost]) {
      await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,review_status,post_format,body) values($1,$2,'public','text','manual','visible','text','Audit fixture')", [id, owner]);
    }
  });
  afterEach(async () => {
    await db.query('rollback');
    await db.query('delete from public.posts where id=any($1::uuid[])', [[post, otherPost]]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[owner, author, stranger]]);
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [[owner, author, stranger]])).rows).toHaveLength(0);
  });

  it('denies foreign removal and allows owner removal only once', async () => {
    const parent = await create();
    await expect(remove(parent.comment_id, stranger, 'removed_by_owner')).rejects.toMatchObject({ code: 'P0001' });
    expect((await remove(parent.comment_id, owner, 'removed_by_owner')).rows[0].changed).toBe(true);
    expect((await remove(parent.comment_id, owner, 'removed_by_owner')).rows[0].changed).toBe(false);
    expect(await counts()).toEqual({ comment_count: 0, actual: 0 });
  });

  it('rejects cross-post parents, nested replies and removed parents', async () => {
    const parent = await create();
    await expect(create(stranger, parent.comment_id, otherPost)).rejects.toMatchObject({ code: 'P0001' });
    const reply = await create(stranger, parent.comment_id);
    await expect(create(owner, reply.comment_id)).rejects.toMatchObject({ code: 'P0001' });
    await remove(parent.comment_id);
    await expect(create(stranger, parent.comment_id)).rejects.toMatchObject({ code: 'P0001' });
    expect(await counts()).toEqual({ comment_count: 1, actual: 1 });
  });

  it.each(['private', 'archived', 'hidden'])('rejects creation on a %s post', async mode => {
    if (mode === 'private') await db.query("update public.posts set visibility='private' where id=$1", [post]);
    if (mode === 'archived') await db.query('update public.posts set archived_at=now() where id=$1', [post]);
    if (mode === 'hidden') await db.query("update public.posts set review_status='hidden' where id=$1", [post]);
    await expect(create()).rejects.toMatchObject({ code: 'P0001' });
    expect(await counts()).toEqual({ comment_count: 0, actual: 0 });
  });

  it.each(['anon', 'authenticated'])('denies direct comment RPC access to %s', async role => {
    const parent = await create();
    await db.query('begin');
    await db.query('set local role ' + role);
    await expect(create()).rejects.toMatchObject({ code: '42501' });
    await db.query('rollback');
    await db.query('begin');
    await db.query('set local role ' + role);
    await expect(remove(parent.comment_id)).rejects.toMatchObject({ code: '42501' });
    await db.query('rollback');
    expect(await counts()).toEqual({ comment_count: 1, actual: 1 });
  });

  it('anonymizes a deleted author while preserving other replies and counters', async () => {
    const parent = await create();
    const reply = await create(stranger, parent.comment_id);
    await db.query('delete from auth.users where id=$1', [author]);
    expect((await db.query('select user_id,status,reply_count from public.post_comments where id=$1', [parent.comment_id])).rows[0])
      .toEqual({ user_id: null, status: 'removed_by_author', reply_count: 1 });
    expect((await db.query('select user_id,status from public.post_comments where id=$1', [reply.comment_id])).rows[0])
      .toEqual({ user_id: stranger, status: 'active' });
    expect(await counts()).toEqual({ comment_count: 1, actual: 1 });
  });

  it('rolls back author deletion with its comments and counters', async () => {
    const parent = await create();
    await db.query('begin');
    await db.query('delete from auth.users where id=$1', [author]);
    expect(await counts()).toEqual({ comment_count: 0, actual: 0 });
    await db.query('rollback');
    expect(await counts()).toEqual({ comment_count: 1, actual: 1 });
    expect((await db.query('select user_id,status from public.post_comments where id=$1', [parent.comment_id])).rows[0])
      .toEqual({ user_id: author, status: 'active' });
  });

  it('decrements only once for competing author and owner removals', async () => {
    const parent = await create();
    const clients = await Promise.all([connect(), connect()]);
    try {
      const results = await Promise.all([
        remove(parent.comment_id, author, 'removed_by_author', clients[0]),
        remove(parent.comment_id, owner, 'removed_by_owner', clients[1]),
      ]);
      expect(results.map(result => result.rows[0].changed).sort()).toEqual([false, true]);
      expect(await counts()).toEqual({ comment_count: 0, actual: 0 });
    } finally { await Promise.all(clients.map(client => client.end())); }
  });

  it('rechecks parent status after waiting for a removal transaction', async () => {
    const parent = await create();
    const client = await connect();
    let pending: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
      await db.query('begin');
      await remove(parent.comment_id);
      pending = create(stranger, parent.comment_id, post, client).then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await db.query("select pid from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid])).rows.length > 0;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await db.query('commit');
      expect(await pending).toMatchObject({ status: 'rejected', reason: { code: 'P0001' } });
      expect(await counts()).toEqual({ comment_count: 0, actual: 0 });
    } finally {
      await db.query('rollback');
      await pending;
      await client.end();
    }
  });
});
