import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getCreatorFollowStateForRoute,
  updateCreatorFollowForRoute,
} from '@/lib/profile-follow-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('follow service with actual PostgREST and SQL', () => {
  let db: Client;
  let admin: SupabaseClient;
  let config: { API_URL: string; SERVICE_ROLE_KEY: string };
  let follower: string;
  let creator: string;
  // Capture notification scheduling; never execute sends to another person.
  const notifications: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });

  afterAll(async () => { await db?.end(); });

  beforeEach(async () => {
    notifications.length = 0;
    follower = randomUUID();
    creator = randomUUID();
    for (const id of [follower, creator]) {
      await db.query(
        "insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",
        [id, `${id}@example.invalid`],
      );
    }
  });

  afterEach(async () => {
    await db.query('delete from public.follows where follower_id=$1 or following_id=$1', [follower]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [[follower, creator]]);
    await db.query('delete from public.backend_rate_limits where subject_key=$1', [follower]);
    const remaining = await db.query(
      'select id from auth.users where id=any($1::uuid[])', [[follower, creator]],
    );
    expect(remaining.rows).toHaveLength(0);
  });

  const update = (following: boolean, client = admin) => updateCreatorFollowForRoute({
    adminSupabase: client,
    followerId: follower,
    body: { followingId: creator, following },
    runAfterResponse: task => { notifications.push(task); },
  });
  const saved = async () => (await db.query(
    'select follower_id,following_id from public.follows where follower_id=$1 and following_id=$2',
    [follower, creator],
  )).rows;

  it('makes repeated follow/unfollow idempotent without duplicate notification scheduling', async () => {
    expect(await update(true)).toMatchObject({ ok: true, body: { following: true } });
    expect(await update(true)).toMatchObject({ ok: true });
    expect(await saved()).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(await update(false)).toMatchObject({ ok: true, body: { following: false } });
    expect(await update(false)).toMatchObject({ ok: true });
    expect(await saved()).toHaveLength(0);
  });

  it('accepts concurrent retries as the same follow intent', async () => {
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const client = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: {
        fetch: async (input, init) => {
          if (init?.method === 'POST' && String(input).includes('/rest/v1/follows')) {
            if (++arrivals === 2) release();
            await barrier;
          }
          return fetch(input, init);
        },
      },
    });
    const result = await Promise.all([update(true, client), update(true, client)]);
    expect(await saved()).toHaveLength(1);
    expect(result).toEqual([
      { ok: true, body: { following: true } },
      { ok: true, body: { following: true } },
    ]);
    expect(notifications).toHaveLength(1);
  });

  it('returns unavailable when a block commits after the service check but before insertion', async () => {
    let injected = false;
    const client = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: {
        fetch: async (input, init) => {
          if (!injected && init?.method === 'POST' && String(input).includes('/rest/v1/follows')) {
            injected = true;
            await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', [creator, follower]);
          }
          return fetch(input, init);
        },
      },
    });
    expect(await update(true, client)).toMatchObject({ ok: false, status: 404 });
    expect(await saved()).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it('removes an existing follow on block and denies refollow', async () => {
    expect(await update(true)).toMatchObject({ ok: true });
    await db.query('insert into public.user_blocks(blocker_user_id,blocked_user_id) values($1,$2)', [creator, follower]);
    expect(await saved()).toHaveLength(0);
    expect(await update(true)).toMatchObject({ ok: false, status: 404 });
    expect(await getCreatorFollowStateForRoute({
      adminSupabase: admin, followerId: follower, followingId: creator,
    })).toMatchObject({ ok: true, body: { following: false } });
  });
});
