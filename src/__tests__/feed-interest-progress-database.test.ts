import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)('interest refresh progress with actual SQL', () => {
  let db: Client;
  const empty = (index: number) => `${(0x01a00000 + index).toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;
  const healthy = '02a00000-0000-4000-8000-000000000001';
  const ids = [...Array.from({ length: 1000 }, (_, index) => empty(index)), healthy];
  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 15000 }); await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('reaches a healthy user behind a complete 1000-user empty batch even with a fixed as-of', async () => {
    await db.query('begin');
    try {
      await db.query("insert into auth.users(id,email,aud,role,created_at) select id,id::text||'@example.invalid','authenticated','authenticated','1800-01-01' from unnest($1::uuid[]) ids(id)", [ids]);
      await db.query("insert into public.generations(user_id,status,category,model,completed_at,created_at) select id,'completed',case when id=$2 then 'image' else 'audio' end,'audit-local','1801-01-01','1801-01-01' from unnest($1::uuid[]) ids(id)", [ids, healthy]);
      await db.query('set local role service_role');
      const refresh = async () => (await db.query("select public.refresh_user_interest_weights('1801-01-01 00:01:00Z',90,30,1000) as count")).rows[0].count;
      expect(await refresh()).toBe(1000);
      expect((await db.query('select user_id from public.user_interest_weights where user_id=$1', [healthy])).rows).toHaveLength(0);
      expect(await refresh()).toBe(1000);
      expect((await db.query('select user_id from public.user_interest_weights where user_id=$1', [healthy])).rows).toHaveLength(2);
      expect((await db.query('select count(*)::int n from public.user_interest_refresh_state where user_id=any($1::uuid[])', [ids])).rows[0].n).toBe(1001);
      expect((await db.query('select user_id from public.user_interest_weights where user_id=any($1::uuid[]) and user_id<>$2', [ids, healthy])).rows).toHaveLength(0);
    } finally { await db.query('rollback'); }
    expect((await db.query('select id from auth.users where id=any($1::uuid[])', [ids])).rows).toEqual([]);
  });
  it('returns promptly without changing progress when another refresh holds the advisory lock', async () => {
    const holder = new Client({ connectionString, statement_timeout: 10000 }); await holder.connect();
    try {
      await holder.query('begin');
      await holder.query("select pg_advisory_xact_lock(hashtextextended('refresh_user_interest_weights',0))");
      const before = (await db.query('select count(*)::int n from public.user_interest_refresh_state')).rows;
      const result = await db.query("select public.refresh_user_interest_weights('1801-01-01',90,30,1) as count");
      expect(result.rows[0].count).toBe(0);
      expect((await db.query('select count(*)::int n from public.user_interest_refresh_state')).rows).toEqual(before);
    } finally { await holder.query('rollback'); await holder.end(); }
  });
});
