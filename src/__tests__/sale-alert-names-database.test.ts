import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sellerUnlockWords } from '@/lib/mobile-notifications';

const connectionString = process.env.SUPABASE_TEST_DB_URL;

/**
 * A sale's alert against real PostgreSQL (20261020053858): a block and an
 * alert written at the same moment cannot miss each other, either way round
 * and in either order (PR #499 review 2, finding 5). The single-session checks
 * are in supabase/tests/database/sale_alert_names.test.sql.
 */
describe.skipIf(!connectionString)('sale alert names with actual PostgreSQL', () => {
  let db: Client;
  let seller: string;
  let buyer: string;

  const named = sellerUnlockWords(false, 'maya');
  const unnamed = sellerUnlockWords(false, null);

  const connect = async () => {
    const client = new Client({ connectionString, statement_timeout: 10000 });
    await client.connect();
    return client;
  };
  // What the server writes for a buyer with a handle, as the service role does.
  const writeAlert = async (client = db) => (await client.query(
    `insert into public.mobile_notifications
       (user_id,actor_user_id,type,category,title,body,object_type,object_id,dedupe_key)
     values ($1,$2,'post_resource_unlocked','commerce',$3,$4,'post','post-1',$5)
     returning title, body`,
    [seller, buyer, named.title, named.body, `post-resource-sale:post-1:${buyer}`],
  )).rows[0] as { title: string; body: string };
  const block = (client = db, reverse = false) => client.query(
    'insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)',
    reverse ? [buyer, seller] : [seller, buyer],
  );
  const stored = async () => (await db.query(
    'select title, body from public.mobile_notifications where user_id=$1 and actor_user_id=$2', [seller, buyer],
  )).rows;

  /**
   * Starts `run` on `client` and resolves once that session is waiting on a
   * lock, with its outcome still to come (wrapped: an async function handed
   * the promise itself would wait for it).
   */
  async function waitingOnLock<T>(client: Client, run: () => Promise<T>) {
    const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
    const pending = run().then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    let settled = false;
    void pending.then(() => { settled = true; });
    const deadline = Date.now() + 5000;
    while (!settled && Date.now() < deadline) {
      const { rows } = await db.query("select pid from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid]);
      if (rows.length) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(settled, 'the second session should wait for the first').toBe(false);
    return { outcome: pending };
  }

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = await connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [seller, buyer] = [randomUUID(), randomUUID()];
    for (const id of [seller, buyer]) {
      await db.query("insert into auth.users(id,email,aud,role,is_anonymous,created_at) values($1,$2,'authenticated','authenticated',false,now())", [id, `${id}@example.invalid`]);
    }
  });
  afterEach(async () => {
    await db.query('delete from public.user_blocks where blocker_user_id=any($1::uuid[])', [[seller, buyer]]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[seller, buyer]]);
  });

  it('names the buyer when there is no block between them', async () => {
    expect(await writeAlert()).toEqual(named);
    expect(await stored()).toEqual([named]);
  });

  for (const reverse of [false, true]) {
    const who = reverse ? 'the buyer blocking the seller' : 'the seller blocking the buyer';

    it(`takes the name out of an alert written in a transaction still open when ${who} lands`, async () => {
      const writer = await connect();
      const blocker = await connect();
      try {
        await writer.query('begin');
        expect(await writeAlert(writer)).toEqual(named);
        // The alert holds the pair's lock: the block waits for it to commit.
        const { outcome: pending } = await waitingOnLock(blocker, () => block(blocker, reverse));
        await writer.query('commit');
        expect((await pending).status).toBe('fulfilled');
        expect(await stored()).toEqual([unnamed]);
      } finally {
        await writer.query('rollback');
        await Promise.all([writer.end(), blocker.end()]);
      }
    });

    it(`stores the alert unnamed when it is written while ${who} is still open`, async () => {
      const blocker = await connect();
      const writer = await connect();
      try {
        await blocker.query('begin');
        await block(blocker, reverse);
        // The block holds the pair's lock: the alert waits, then sees the block.
        const { outcome: pending } = await waitingOnLock(writer, () => writeAlert(writer));
        await blocker.query('commit');
        expect(await pending).toEqual({ status: 'fulfilled', value: unnamed });
        expect(await stored()).toEqual([unnamed]);
      } finally {
        await blocker.query('rollback');
        await Promise.all([blocker.end(), writer.end()]);
      }
    });
  }
});
