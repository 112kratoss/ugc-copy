import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!connectionString)('follow/block serialization with actual PostgreSQL', () => {
  let db: Client;
  let actor: string;
  let creator: string;
  const connect = async () => {
    const client = new Client({ connectionString, statement_timeout: 10000 });
    await client.connect();
    return client;
  };
  const follow = (client = db, reverse = false) => client.query(
    'insert into public.follows(follower_id,following_id) values($1,$2)',
    reverse ? [creator, actor] : [actor, creator],
  );
  const block = (client = db) => client.query(
    'insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2) on conflict(blocker_user_id,blocked_user_id) do update set created_at=excluded.created_at',
    [creator, actor],
  );
  const readState = async () => (await db.query(
    'select (select count(*)::int from public.user_blocks where blocker_user_id=$1 and blocked_user_id=$2) blocks, (select count(*)::int from public.follows where (follower_id=$1 and following_id=$2) or (follower_id=$2 and following_id=$1)) follows',
    [creator, actor],
  )).rows[0];

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = await connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [actor, creator] = [randomUUID(), randomUUID()];
    for (const id of [actor, creator]) {
      await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [id, `${id}@example.invalid`]);
    }
  });
  afterEach(async () => {
    await db.query('delete from auth.users where id=any($1::uuid[])', [[actor, creator]]);
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [[actor, creator]])).rows).toHaveLength(0);
  });

  for (const reverse of [false, true]) {
    it(`removes an earlier uncommitted ${reverse ? 'reverse' : 'forward'} follow when block commits`, async () => {
      const first = await connect();
      const second = await connect();
      let pending: Promise<PromiseSettledResult<unknown>> | undefined;
      try {
        await first.query('begin');
        await follow(first, reverse);
        const pid = (await second.query('select pg_backend_pid() pid')).rows[0].pid;
        pending = block(second).then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
        let settled = false;
        void pending.then(() => { settled = true; });
        const deadline = Date.now() + 5000;
        while (!settled && Date.now() < deadline) {
          const { rows } = await db.query("select pid from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid]);
          if (rows.length) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        // On the old functions the block finishes before the follow commits;
        // on the fix it waits for this transaction, then deletes its row.
        await first.query('commit');
        expect((await pending).status).toBe('fulfilled');
        expect(await readState()).toEqual({ blocks: 1, follows: 0 });
      } finally {
        await first.query('rollback');
        await pending;
        await Promise.all([first.end(), second.end()]);
      }
    });

    it(`rejects a ${reverse ? 'reverse' : 'forward'} follow started while a block is uncommitted`, async () => {
      const first = await connect();
      const second = await connect();
      let pending: Promise<PromiseSettledResult<unknown>> | undefined;
      try {
        await first.query('begin');
        await block(first);
        const pid = (await second.query('select pg_backend_pid() pid')).rows[0].pid;
        pending = follow(second, reverse).then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
        let settled = false;
        void pending.then(() => { settled = true; });
        const deadline = Date.now() + 5000;
        while (!settled && Date.now() < deadline) {
          const { rows } = await db.query("select pid from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid]);
          if (rows.length) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        await first.query('commit');
        expect(await pending).toMatchObject({ status: 'rejected', reason: { code: '23514' } });
        expect(await readState()).toEqual({ blocks: 1, follows: 0 });
      } finally {
        await first.query('rollback');
        await pending;
        await Promise.all([first.end(), second.end()]);
      }
    });
  }

  it('removes both directions on a sequential block and repeated block', async () => {
    await follow();
    await follow(db, true);
    await block();
    await block();
    expect(await readState()).toEqual({ blocks: 1, follows: 0 });
  });

  it('allows a new follow after explicit unblock', async () => {
    await block();
    await db.query('delete from public.user_blocks where blocker_user_id=$1 and blocked_user_id=$2', [creator, actor]);
    await follow();
    expect(await readState()).toEqual({ blocks: 0, follows: 1 });
  });
});
