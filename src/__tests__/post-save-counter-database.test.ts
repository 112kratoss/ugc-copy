import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!connectionString)('post save counters with real PostgreSQL', () => {
  let db: Client;
  let owner: string;
  let actor: string;
  let other: string;
  let post: string;

  const connect = async () => {
    const client = new Client({ connectionString, statement_timeout: 10000 });
    await client.connect();
    return client;
  };
  const save = (userId: string, shouldSave = true, client = db) => client.query(
    'select * from public.set_post_save_state($1,$2,$3)', [post, userId, shouldSave],
  );
  const state = async () => (await db.query(
    'select save_count, (select count(*)::int from public.post_saves where post_id=$1) actual from public.posts where id=$1',
    [post],
  )).rows[0];

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = await connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [owner, actor, other, post] = Array.from({ length: 4 }, () => randomUUID());
    for (const id of [owner, actor, other]) {
      await db.query(
        "insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",
        [id, `${id}@example.invalid`],
      );
    }
    await db.query(
      "insert into public.posts(id,user_id,visibility,category,source_kind,review_status,post_format,body) values($1,$2,'public','text','manual','visible','text','Audit fixture')",
      [post, owner],
    );
  });
  afterEach(async () => {
    await db.query('rollback');
    await db.query('delete from public.posts where id=$1', [post]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[owner, actor, other]]);
    const { rows } = await db.query('select id from auth.users where id=any($1::uuid[])', [[owner, actor, other]]);
    expect(rows).toHaveLength(0);
  });

  it.each(['public', 'private', 'archived'])('removes only the deleted account contribution on a %s post', async visibility => {
    await save(actor);
    await save(other);
    if (visibility === 'private') await db.query("update public.posts set visibility='private' where id=$1", [post]);
    if (visibility === 'archived') await db.query('update public.posts set archived_at=now() where id=$1', [post]);
    await db.query('delete from auth.users where id=$1', [actor]);
    expect(await state()).toEqual({ save_count: 1, actual: 1 });
  });

  it('keeps explicit save/unsave retries idempotent', async () => {
    await save(actor);
    await save(actor);
    expect(await state()).toEqual({ save_count: 1, actual: 1 });
    await save(actor, false);
    await save(actor, false);
    expect(await state()).toEqual({ save_count: 0, actual: 0 });
  });

  it('rolls back deletion and its counter change together', async () => {
    await save(actor);
    await db.query('begin');
    await db.query('delete from auth.users where id=$1', [actor]);
    expect(await state()).toEqual({ save_count: 0, actual: 0 });
    await db.query('rollback');
    expect(await state()).toEqual({ save_count: 1, actual: 1 });
  });

  it('allows deletion of the post owner with saves by other accounts', async () => {
    await save(actor);
    await db.query('delete from auth.users where id=$1', [owner]);
    expect(await state()).toBeUndefined();
    expect((await db.query('select id from public.post_saves where post_id=$1', [post])).rows).toHaveLength(0);
  });

  it.each(['explicit', 'legacy'])('counts a save removal once when account deletion races %s unsave', async method => {
    await save(actor);
    await save(other);
    const clients = await Promise.all([connect(), connect()]);
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const pids = await Promise.all(clients.map(async client => (await client.query('select pg_backend_pid() pid')).rows[0].pid));
      await db.query('begin');
      await db.query('select id from public.post_saves where user_id=$1 and post_id=$2 for update', [actor, post]);
      pending = Promise.allSettled([
        clients[0].query('delete from auth.users where id=$1', [actor]),
        method === 'legacy'
          ? clients[1].query('select public.toggle_post_save($1,$2)', [post, actor])
          : save(actor, false, clients[1]),
      ]);
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < deadline) {
        waiting = (await db.query("select pid from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'", [pids])).rows.length;
        if (waiting === 2) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      await db.query('commit');
      expect((await pending).every(result => result.status === 'fulfilled')).toBe(true);
      expect(await state()).toEqual({ save_count: 1, actual: 1 });
    } finally {
      await db.query('rollback');
      await pending;
      await Promise.all(clients.map(client => client.end()));
    }
  });

  it.each(['anon', 'authenticated'])('denies direct save mutation RPCs to %s', async role => {
    await db.query('begin');
    await db.query('set local role ' + role);
    await expect(save(actor)).rejects.toMatchObject({ code: '42501' });
    await db.query('rollback');
    await db.query('begin');
    await db.query('set local role ' + role);
    await expect(db.query('select public.toggle_post_save($1,$2)', [post, actor])).rejects.toMatchObject({ code: '42501' });
    await db.query('rollback');
    expect(await state()).toEqual({ save_count: 0, actual: 0 });
  });

  it('serializes concurrent legacy toggles when the save is initially absent', async () => {
    const clients = await Promise.all([connect(), connect()]);
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const pids = await Promise.all(clients.map(async client => (await client.query('select pg_backend_pid() pid')).rows[0].pid));
      await db.query('begin');
      await db.query('lock table public.post_saves in share mode');
      pending = Promise.allSettled(clients.map(client => client.query('select public.toggle_post_save($1,$2)', [post, actor])));
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < deadline) {
        waiting = (await db.query("select pid from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'", [pids])).rows.length;
        if (waiting === 2) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      await db.query('commit');
      expect((await pending).every(result => result.status === 'fulfilled')).toBe(true);
      expect(await state()).toEqual({ save_count: 0, actual: 0 });
    } finally {
      await db.query('rollback');
      await pending;
      await Promise.all(clients.map(client => client.end()));
    }
  });

  it('does not subtract another saver when concurrent legacy toggles remove the same row', async () => {
    await save(actor);
    await save(other);
    const clients = await Promise.all([connect(), connect()]);
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const pids = await Promise.all(clients.map(async client => (await client.query('select pg_backend_pid() pid')).rows[0].pid));
      await db.query('begin');
      await db.query('select id from public.post_saves where user_id=$1 and post_id=$2 for update', [actor, post]);
      pending = Promise.allSettled(clients.map(client => client.query('select public.toggle_post_save($1,$2)', [post, actor])));
      // Hold the saved row until both calls wait: without serialization both
      // reach DELETE; with it the second waits for the first intent to finish.
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < deadline) {
        waiting = (await db.query("select pid from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'", [pids])).rows.length;
        if (waiting === 2) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      await db.query('commit');
      expect((await pending).every(result => result.status === 'fulfilled')).toBe(true);
      // Two serialized toggles remove then recreate the actor's save.
      expect(await state()).toEqual({ save_count: 2, actual: 2 });
    } finally {
      await db.query('rollback');
      await pending;
      await Promise.all(clients.map(client => client.end()));
    }
  });
});
