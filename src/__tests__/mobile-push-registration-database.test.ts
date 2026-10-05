import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!connectionString)('push registration with concurrent SQL transactions', () => {
  let db: Client;
  let owners: string[];
  const token = () => `ExponentPushToken[audit_${randomUUID()}]`;
  const register = async (owner: string, value: string, device = 'same-device') => {
    const client = new Client({ connectionString, statement_timeout: 10000 });
    await client.connect();
    try {
      await client.query('set role service_role');
      return await client.query('select public.register_mobile_push_token($1,$2,$3,$4)', [owner, value, 'ios', device]);
    } finally {
      await client.end();
    }
  };
  const active = async () => (await db.query(
    'select user_id,expo_push_token,device_id from public.mobile_push_tokens where user_id=any($1::uuid[]) and is_active', [owners],
  )).rows;

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    owners = [randomUUID(), randomUUID()];
    for (const owner of owners) await db.query(
      "insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",
      [owner, `${owner}@example.invalid`],
    );
  });
  afterEach(async () => {
    await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
    expect((await db.query('select id from public.mobile_push_tokens where user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
  });

  it('leaves one active same-device token and preserves another device after eight rotations', async () => {
    const other = token();
    await register(owners[0], other, 'other-device');
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => register(owners[0], token())));
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    const rows = await active();
    expect(rows.filter(row => row.device_id === 'same-device')).toHaveLength(1);
    expect(rows.filter(row => row.expo_push_token === other)).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it('leaves one active owner after eight same-token account handoffs', async () => {
    const value = token();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => register(owners[index % 2], value)));
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(await active()).toHaveLength(1);
  });

  it('completes opposite token transfers without a deadlock', async () => {
    const values = [token(), token()];
    await register(owners[0], values[0], 'original');
    await register(owners[1], values[1], 'original');
    const results = await Promise.allSettled([
      register(owners[0], values[1], 'incoming'), register(owners[1], values[0], 'incoming'),
    ]);
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(await active()).toEqual(expect.arrayContaining([
      { user_id: owners[0], expo_push_token: values[1], device_id: 'incoming' },
      { user_id: owners[1], expo_push_token: values[0], device_id: 'incoming' },
    ]));
    expect(await active()).toHaveLength(2);
  });
});
