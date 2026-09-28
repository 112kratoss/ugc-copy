import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)('mobile credit settlement concurrency', () => {
  let admin: Client;
  let buyers: string[];
  const clients: Client[] = [];
  async function connect() {
    const client = new Client({ connectionString });
    await client.connect(); clients.push(client);
    await client.query("set statement_timeout='8s'");
    return client;
  }
  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    admin = await connect(); buyers = [randomUUID(), randomUUID()];
    for (const buyer of buyers) await admin.query(`insert into auth.users(id,email,aud,role,created_at)
      values($1::uuid,$1::text||'@example.invalid','authenticated','authenticated',now())`, [buyer]);
  });
  afterEach(async () => {
    if (admin) await admin.query('delete from auth.users where id=any($1::uuid[])', [buyers]);
    await Promise.all(clients.splice(0).map(client => client.end()));
  });
  it.each(Array.from({ length: 24 }, (_, round): [number, boolean] => [round, round >= 12]))('grants once under parallel delivery (round %s, competing owner: %s)', async (_round, competingOwner) => {
    const callers = await Promise.all(Array.from({ length: 8 }, () => connect()));
    const storeId = `audit_mobile_${randomUUID()}`;
    const external = `mobile_app_store_${storeId}`;
    const results = await Promise.all(callers.map((client, index) => client.query(
      "select public.complete_mobile_purchase($1,null,'magicbooklet.credits.starter','app_store',$2,$3,$3) as result",
      [buyers[competingOwner ? index % 2 : 0], storeId, external],
    )));
    const statuses = results.map(result => result.rows[0].result.status);
    expect(statuses.filter(status => status === 'completed')).toHaveLength(1);
    expect(statuses.every(status => ['completed', 'already_processed', 'transaction_conflict'].includes(status))).toBe(true);
    if (!competingOwner) expect(statuses.filter(status => status === 'already_processed')).toHaveLength(7);
    expect((await admin.query('select sum(credits)::int as total from public.profiles where id=any($1::uuid[])', [buyers])).rows[0].total).toBe(500);
    expect((await admin.query('select count(*)::int as n from public.mobile_store_transactions where external_order_id=$1', [external])).rows[0].n).toBe(1);
    expect((await admin.query('select count(*)::int as n from public.mobile_purchase_intents where user_id=any($1::uuid[])', [buyers])).rows[0].n).toBe(1);
  });
});
