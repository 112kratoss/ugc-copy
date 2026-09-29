import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)('mobile adjustment event concurrency', () => {
  let admin: Client;
  let buyer: string;
  let seller: string;
  let eventId: string;
  let receipts: string[];
  let productId: string;
  const clients: Client[] = [];
  async function connect() {
    const db = new Client({ connectionString });
    await db.connect(); clients.push(db);
    await db.query("set statement_timeout='10s'");
    return db;
  }
  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    admin = await connect(); buyer = randomUUID(); seller = randomUUID();
    eventId = `audit-mobile-event-${randomUUID()}`;
    receipts = [randomUUID(), randomUUID()].map(id => `mobile_app_store_${id}`);
    for (const id of [buyer, seller]) await admin.query(`insert into auth.users(id,email,aud,role,created_at)
      values($1::uuid,$1::text||'@example.invalid','authenticated','authenticated',now())`, [id]);
    productId = (await admin.query(`select product_id from public.mobile_store_products
      where entitlement_type='marketplace_unlock' and amount_subunits=300 and currency='USD' and active`)).rows[0]?.product_id;
    if (!productId) {
      productId = `audit.market.${randomUUID()}`;
      await admin.query("select public.provision_mobile_store_product($1,'marketplace_unlock',300,'USD')", [productId]);
    }
    for (const receipt of receipts) {
      const resource = randomUUID();
      await admin.query(`insert into public.marketplace_assets(id,seller_user_id,type,title,price_usd_cents,status)
        values($1,$2,'prompt_pack','Event race fixture',300,'active')`, [resource, seller]);
      const intent = (await admin.query("select public.create_mobile_purchase_intent($1,'marketplace_unlock',$2) as result", [buyer, resource])).rows[0].result;
      const purchase = (await admin.query(`select public.complete_mobile_purchase($1,$2,$3,'app_store',$4,$5,$5) as result`,
        [buyer, intent.purchase_intent_id, productId, receipt.slice('mobile_app_store_'.length), receipt])).rows[0].result;
      expect(purchase.status).toBe('completed');
    }
  });
  afterEach(async () => {
    if (admin) {
      await admin.query('select pg_advisory_unlock_all()');
      await admin.query('delete from public.mobile_purchase_adjustment_events where provider_event_id=$1', [eventId]);
      await admin.query('delete from public.mobile_store_transactions where user_id=$1', [buyer]);
      await admin.query('delete from public.mobile_purchase_intents where user_id=$1', [buyer]);
      await admin.query('delete from auth.users where id=any($1::uuid[])', [[buyer, seller]]);
      await admin.query("delete from public.mobile_store_products where product_id=$1 and product_id like 'audit.market.%'", [productId]);
    }
    await Promise.all(clients.splice(0).map(db => db.end()));
  });

  it.each(['same receipt', 'different receipts', 'different actions'] as const)('binds one event under simultaneous %s', async scenario => {
    const callers = await Promise.all([connect(), connect()]);
    const barrier = 859291632;
    await admin.query('select pg_advisory_lock($1)', [barrier]);
    const pids = await Promise.all(callers.map(async db => (await db.query('select pg_backend_pid() as pid')).rows[0].pid));
    const gates = callers.map(db => db.query('select pg_advisory_lock_shared($1)', [barrier]));
    const deadline = Date.now() + 4000;
    let waiting = 0;
    while (waiting < 2 && Date.now() < deadline) {
      waiting = (await admin.query(`select count(*)::int as n from pg_locks where pid=any($1::int[])
        and locktype='advisory' and not granted`, [pids])).rows[0].n;
      if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(2);
    await admin.query('select pg_advisory_unlock($1)', [barrier]);
    const results = await Promise.all(callers.map(async (db, index) => {
      await gates[index];
      await db.query('set role service_role');
      return (await db.query(`select public.reconcile_mobile_purchase_adjustment($1,$2,$3,$4,1000,$5) as result`,
        [receipts[scenario === 'different receipts' ? index : 0], buyer, productId, eventId,
          scenario === 'different actions' && index === 1 ? 'restore' : 'refund'])).rows[0].result.status;
    }));
    if (scenario === 'same receipt') expect(results.sort()).toEqual(['duplicate_event', 'refunded']);
    else {
      expect(results.filter(status => status === 'event_conflict')).toHaveLength(1);
      expect(results.filter(status => ['refunded', 'already_active'].includes(status))).toHaveLength(1);
    }
    expect((await admin.query('select count(*)::int as n from public.mobile_purchase_adjustment_events where provider_event_id=$1', [eventId])).rows[0].n).toBe(1);
    const active = (await admin.query('select count(*)::int as n from public.marketplace_purchases where buyer_user_id=$1', [buyer])).rows[0].n;
    const wallet = (await admin.query('select available_token_subunits from public.creator_resource_wallets where user_id=$1', [seller])).rows[0];
    expect(Number(wallet.available_token_subunits)).toBe(active * 25500);
    expect((await admin.query("select count(*)::int as n from public.mobile_store_transactions where user_id=$1 and status='active'", [buyer])).rows[0].n).toBe(active);
  });
});
