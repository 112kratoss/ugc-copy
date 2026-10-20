import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { creatorFollowedWords } from '@/lib/mobile-notifications';

const connectionString = process.env.SUPABASE_TEST_DB_URL;

type AlertWords = { body: string; deep_link: string };

/** The words and link the server writes for a follow, as the row stores them. */
function serverFollowAlert(followerUsername: string | null): AlertWords {
  const { body, deepLink } = creatorFollowedWords(followerUsername);
  return { body, deep_link: deepLink };
}

/**
 * A follow's alert against real PostgreSQL (20261020072851): a block and an
 * alert written at the same moment cannot miss each other, either way round
 * and in either order, and the repair that follows it (20261020084422) takes
 * the name out of the alerts stored before it. The single-session checks are
 * in supabase/tests/database/follow_alert_names.test.sql.
 */
describe.skipIf(!connectionString)('follow alert names with actual PostgreSQL', () => {
  let db: Client;
  let creator: string;
  let follower: string;
  const named = serverFollowAlert('maya');
  const unnamed = serverFollowAlert(null);

  const connect = async () => {
    const client = new Client({ connectionString, statement_timeout: 10000 });
    await client.connect();
    return client;
  };
  // What the server writes for a follower with a handle, as the service role does.
  const writeAlert = async (client = db) => (await client.query(
    `insert into public.mobile_notifications
       (user_id,actor_user_id,type,category,title,body,deep_link,object_type,object_id,dedupe_key)
     values ($1,$2,'creator_followed','social','New follower',$3,$4,'profile',$5,$6)
     returning body, deep_link`,
    [creator, follower, named.body, named.deep_link, follower, `creator-follow:${follower}:${creator}`],
  )).rows[0] as AlertWords;
  const block = (client = db, reverse = false) => client.query(
    'insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)',
    reverse ? [follower, creator] : [creator, follower],
  );
  const stored = async () => (await db.query(
    'select body, deep_link from public.mobile_notifications where user_id=$1 and actor_user_id=$2', [creator, follower],
  )).rows;
  const createAccounts = async (...ids: string[]) => {
    for (const id of ids) {
      await db.query("insert into auth.users(id,email,aud,role,is_anonymous,created_at) values($1,$2,'authenticated','authenticated',false,now())", [id, `${id}@example.invalid`]);
    }
  };

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
    [creator, follower] = [randomUUID(), randomUUID()];
    await createAccounts(creator, follower);
  });
  afterEach(async () => {
    await db.query('delete from public.user_blocks where blocker_user_id=any($1::uuid[])', [[creator, follower]]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[creator, follower]]);
  });

  it('names the follower when there is no block between them', async () => {
    expect(await writeAlert()).toEqual(named);
    expect(await stored()).toEqual([named]);
  });

  for (const reverse of [false, true]) {
    const who = reverse ? 'the follower blocking the creator' : 'the creator blocking the follower';

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

  it('repairs the alerts stored before it, and leaves their retention where it was', async () => {
    const directory = path.resolve(process.cwd(), 'supabase/migrations');
    const file = fs.readdirSync(directory).find((name) => name.endsWith('_unname_follow_alerts_already_stored.sql'));
    expect(file).toBeDefined();
    const migration = fs.readFileSync(path.join(directory, file!), 'utf8');
    const start = migration.indexOf('DO $repair$');
    const repair = migration.slice(start, migration.indexOf('$repair$;', start + 'DO $repair$'.length) + '$repair$;'.length);
    expect(repair).toMatch(/^DO \$repair\$[\s\S]*\$repair\$;$/);

    const bystander = randomUUID();
    await createAccounts(bystander);
    const ago = '2026-10-01T00:00:00.000Z';
    const writeStored = (id: string, actor: string | null, words: AlertWords) => db.query(
      `insert into public.mobile_notifications
         (id,user_id,actor_user_id,type,category,title,body,deep_link,object_type,object_id,dedupe_key,updated_at)
       values ($1,$2,$3,'creator_followed','social','New follower',$4,$5,'profile',$6,$7,$8)`,
      [id, creator, actor, words.body, words.deep_link, id, `creator-follow:${id}:${creator}`, ago],
    );
    const [deleted, blocked, standing, noHandle] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    await db.query('begin');
    try {
      // As a deletion left it before this migration: the follower gone, the name kept.
      await writeStored(deleted, null, named);
      // Named while there was no block, then blocked as blocks did before
      // this migration, which left follow alerts as they were.
      await writeStored(blocked, follower, named);
      await db.query('alter table public.user_blocks disable trigger user_blocks_remove_follows');
      await block();
      await db.query('alter table public.user_blocks enable trigger user_blocks_remove_follows');
      await writeStored(standing, bystander, named);
      await writeStored(noHandle, null, unnamed);
      expect((await db.query(
        'select count(*)::int as count from public.mobile_notifications where id=any($1::uuid[]) and body=$2',
        [[deleted, blocked], named.body],
      )).rows[0].count, 'the named alerts the repair is for').toBe(2);

      await db.query(repair);

      const after = async (id: string) => (await db.query(
        'select body, deep_link, updated_at from public.mobile_notifications where id=$1', [id],
      )).rows[0] as AlertWords & { updated_at: Date };
      for (const id of [deleted, blocked]) {
        expect(await after(id)).toEqual({ ...unnamed, updated_at: new Date(ago) });
      }
      expect(await after(standing)).toEqual({ ...named, updated_at: new Date(ago) });
      expect(await after(noHandle)).toEqual({ ...unnamed, updated_at: new Date(ago) });
      // The trigger set aside for the repair is on again.
      expect((await db.query(
        "select tgenabled from pg_trigger where tgrelid='public.mobile_notifications'::regclass and tgname='mobile_notifications_set_updated_at'",
      )).rows).toEqual([{ tgenabled: 'O' }]);
    } finally {
      await db.query('rollback');
      await db.query('delete from auth.users where id=$1', [bystander]);
    }
  });
});
