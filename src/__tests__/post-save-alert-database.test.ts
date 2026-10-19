import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;

/**
 * The named save alert against real PostgreSQL: it belongs to its save, goes
 * with it however the save goes, and a block or an unsave made at the same
 * moment as the write cannot miss it (review 4 finding #15). The fixtures'
 * single-session checks are in supabase/tests/database/post_save_alerts.test.sql.
 */
describe.skipIf(!connectionString)('named save alerts with actual PostgreSQL', () => {
  let db: Client;
  let creator: string;
  let saver: string;
  let post: string;

  const connect = async () => {
    const client = new Client({ connectionString, statement_timeout: 10000 });
    await client.connect();
    return client;
  };
  const saveState = (shouldSave: boolean, client = db) => client.query(
    'select * from public.set_post_save_state($1,$2,$3)', [post, saver, shouldSave],
  );
  const writeAlert = async (client = db) => (await client.query(
    "select public.create_post_save_alert($1,$2,'It is in their saved media now.',null) as result", [post, saver],
  )).rows[0].result as { nameable: boolean; wasCreated: boolean; notification: { title: string } | null };
  const block = (client = db, reverse = false) => client.query(
    'insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)',
    reverse ? [saver, creator] : [creator, saver],
  );
  const alerts = async () => Number((await db.query(
    'select count(*)::int as count from public.mobile_notifications where save_user_id=$1', [saver],
  )).rows[0].count);

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
    [creator, saver, post] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [creator, saver]) {
      await db.query("insert into auth.users(id,email,aud,role,is_anonymous,created_at) values($1,$2,'authenticated','authenticated',false,now())", [id, `${id}@example.invalid`]);
    }
    await db.query(
      "update public.profiles set username=$2, saver_notice_seen_at=now() where id=$1",
      [saver, `saver-${saver.slice(0, 8)}`],
    );
    await db.query(
      "insert into public.posts(id,user_id,visibility,category,source_kind,title,output_url) values($1,$2,'public','image','external','Saved',$3)",
      [post, creator, `generated_images/${post}.png`],
    );
    await saveState(true);
  });
  afterEach(async () => {
    await db.query('delete from public.user_blocks where blocker_user_id=any($1::uuid[])', [[creator, saver]]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[creator, saver]]);
  });

  it('writes the alert for a save that stands, to its owner, by the handle on record', async () => {
    const result = await writeAlert();
    expect(result).toMatchObject({ nameable: true, wasCreated: true });
    expect(result.notification?.title).toBe(`@saver-${saver.slice(0, 8)} saved your post`);
    const { rows } = await db.query('select user_id from public.mobile_notifications where save_user_id=$1', [saver]);
    expect(rows).toEqual([{ user_id: creator }]);
  });

  it.each([
    { how: 'an unsave', remove: () => saveState(false) },
    { how: 'the saver\'s account going', remove: () => db.query('delete from auth.users where id=$1', [saver]) },
    { how: 'the post going', remove: () => db.query('delete from public.posts where id=$1', [post]) },
    {
      how: 'the post tombstoned',
      remove: () => db.query(
        "update public.posts set tombstoned_at=now(), archived_at=now(), archived_by_user_id=$2, visibility='private' where id=$1",
        [post, creator],
      ),
    },
    {
      how: 'an unsave of the post made private',
      remove: async () => {
        await db.query("update public.posts set visibility='private' where id=$1", [post]);
        await saveState(false);
      },
    },
  ])('takes the alert with the save through $how', async ({ remove }) => {
    await writeAlert();
    expect(await alerts()).toBe(1);

    await remove();

    expect(await alerts()).toBe(0);
  });

  for (const reverse of [false, true]) {
    const who = reverse ? 'the saver blocking the creator' : 'the creator blocking the saver';

    it(`removes an alert written in a transaction still open when ${who} lands`, async () => {
      const writer = await connect();
      const blocker = await connect();
      try {
        await writer.query('begin');
        expect(await writeAlert(writer)).toMatchObject({ wasCreated: true });
        const { outcome: pending } = await waitingOnLock(blocker, () => block(blocker, reverse));
        await writer.query('commit');
        expect((await pending).status).toBe('fulfilled');
        expect(await alerts()).toBe(0);
      } finally {
        await writer.query('rollback');
        await Promise.all([writer.end(), blocker.end()]);
      }
    });

    it(`writes nothing for a save while ${who} is still open`, async () => {
      const blocker = await connect();
      const writer = await connect();
      try {
        await blocker.query('begin');
        await block(blocker, reverse);
        const { outcome: pending } = await waitingOnLock(writer, () => writeAlert(writer));
        await blocker.query('commit');
        const settled = await pending;
        expect(settled).toMatchObject({ status: 'fulfilled', value: { nameable: true, wasCreated: false } });
        expect(await alerts()).toBe(0);
      } finally {
        await blocker.query('rollback');
        await Promise.all([blocker.end(), writer.end()]);
      }
    });
  }

  it('takes an alert written in a transaction still open with the unsave that lands meanwhile', async () => {
    const writer = await connect();
    const unsaver = await connect();
    try {
      await writer.query('begin');
      expect(await writeAlert(writer)).toMatchObject({ wasCreated: true });
      // The alert's key holds the save: the unsave waits for the write.
      const { outcome: pending } = await waitingOnLock(unsaver, () => saveState(false, unsaver));
      await writer.query('commit');
      expect((await pending).status).toBe('fulfilled');
      expect(await alerts()).toBe(0);
    } finally {
      await writer.query('rollback');
      await Promise.all([writer.end(), unsaver.end()]);
    }
  });

  it('writes nothing for a save whose unsave is still open', async () => {
    const unsaver = await connect();
    const writer = await connect();
    try {
      await unsaver.query('begin');
      await saveState(false, unsaver);
      const { outcome: pending } = await waitingOnLock(writer, () => writeAlert(writer));
      await unsaver.query('commit');
      expect(await pending).toMatchObject({ status: 'fulfilled', value: { nameable: true, wasCreated: false } });
      expect(await alerts()).toBe(0);
    } finally {
      await unsaver.query('rollback');
      await Promise.all([unsaver.end(), writer.end()]);
    }
  });
});
