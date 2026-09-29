import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)('mobile marketplace lifecycle concurrency', () => {
  let admin: Client;
  let buyer: string;
  let seller: string;
  let asset: string;
  let receipt: string;
  let productId: string;
  let eventPrefix: string;
  const clients: Client[] = [];
  async function connect() {
    const db = new Client({ connectionString });
    await db.connect(); clients.push(db);
    await db.query("set statement_timeout='10s'");
    return db;
  }
  async function adjust(db: Client, action: string, timestamp: number, suffix = action) {
    return (await db.query(`select public.reconcile_mobile_purchase_adjustment($1,$2,$3,$4,$5,$6) as result`,
      [receipt, buyer, productId, `${eventPrefix}:${suffix}`, timestamp, action])).rows[0].result.status;
  }
  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    admin = await connect(); buyer = randomUUID(); seller = randomUUID(); asset = randomUUID();
    receipt = `mobile_app_store_${randomUUID()}`; eventPrefix = randomUUID();
    for (const id of [buyer, seller]) await admin.query(`insert into auth.users(id,email,aud,role,created_at)
      values($1::uuid,$1::text||'@example.invalid','authenticated','authenticated',now())`, [id]);
    productId = (await admin.query(`select product_id from public.mobile_store_products
      where entitlement_type='marketplace_unlock' and amount_subunits=373 and currency='USD' and active`)).rows[0]?.product_id;
    if (!productId) {
      productId = `audit.lifecycle.${randomUUID()}`;
      await admin.query("select public.provision_mobile_store_product($1,'marketplace_unlock',373,'USD')", [productId]);
    }
    await admin.query(`insert into public.marketplace_assets(id,seller_user_id,type,title,price_usd_cents,status)
      values($1,$2,'prompt_pack','Lifecycle race fixture',373,'active')`, [asset, seller]);
    const intent = (await admin.query("select public.create_mobile_purchase_intent($1,'marketplace_unlock',$2) as result", [buyer, asset])).rows[0].result;
    const purchase = (await admin.query(`select public.complete_mobile_purchase($1,$2,$3,'app_store',$4,$5,$5) as result`,
      [buyer, intent.purchase_intent_id, productId, receipt.slice('mobile_app_store_'.length), receipt])).rows[0].result;
    expect(purchase.status).toBe('completed');
  });
  afterEach(async () => {
    if (admin) {
      await admin.query('rollback');
      await admin.query('select pg_advisory_unlock_all()');
      await admin.query('delete from public.mobile_purchase_adjustment_events where provider_event_id like $1', [`${eventPrefix}:%`]);
      await admin.query('delete from public.mobile_store_transactions where user_id=$1', [buyer]);
      await admin.query('delete from public.mobile_purchase_intents where user_id=$1', [buyer]);
      await admin.query('delete from auth.users where id=any($1::uuid[])', [[buyer, seller]]);
      await admin.query("delete from public.mobile_store_products where product_id=$1 and product_id like 'audit.lifecycle.%'", [productId]);
    }
    await Promise.all(clients.splice(0).map(db => db.end()));
  });
  async function race(actions: Array<(db: Client) => Promise<string>>) {
    const callers = await Promise.all(actions.map(() => connect()));
    const barrier = 859291919;
    await admin.query('select pg_advisory_lock($1)', [barrier]);
    const pids = await Promise.all(callers.map(async db => (await db.query('select pg_backend_pid() as pid')).rows[0].pid));
    const gates = callers.map(db => db.query('select pg_advisory_lock_shared($1)', [barrier]));
    const deadline = Date.now() + 4000;
    let waiting = 0;
    while (waiting < callers.length && Date.now() < deadline) {
      waiting = (await admin.query(`select count(*)::int as n from pg_locks where pid=any($1::int[])
        and locktype='advisory' and not granted`, [pids])).rows[0].n;
      if (waiting < callers.length) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(callers.length);
    await admin.query('select pg_advisory_unlock($1)', [barrier]);
    const settled = await Promise.allSettled(callers.map(async (db, i) => {
      await gates[i]; await db.query('set role service_role');
      return actions[i](db);
    }));
    return settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
  }
  // Queue both operations behind the asset row in each order. Before the fix,
  // restoration inserted the entitlement before waiting here, creating a cycle
  // when settlement got the asset first and waited on that entitlement's key.
  async function raceAssetQueue(actions: Array<(db: Client) => Promise<string>>, order: number[]) {
    const callers = await Promise.all(actions.map(() => connect()));
    const pids = await Promise.all(callers.map(async db => {
      await db.query('set role service_role');
      return (await db.query('select pg_backend_pid() as pid')).rows[0].pid;
    }));
    await admin.query('begin');
    await admin.query('select id from public.marketplace_assets where id=$1 for update', [asset]);
    const results: Array<Promise<PromiseSettledResult<string>>> = [];
    let queueError: unknown;
    try {
      for (const i of order) {
        results[i] = actions[i](callers[i]).then(value => ({ status: 'fulfilled' as const, value }),
          reason => ({ status: 'rejected' as const, reason }));
        const deadline = Date.now() + 4000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          blocked = (await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) as blocked", [pids[i]])).rows[0]?.blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
      }
    } catch (error) { queueError = error; } finally { await admin.query('rollback'); }
    const settled = await Promise.all(results.filter(Boolean));
    if (queueError) throw queueError;
    return settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
  }
  async function expectConsistentOwner() {
    const purchases = (await admin.query('select order_id from public.marketplace_purchases where buyer_user_id=$1', [buyer])).rows;
    expect(purchases).toHaveLength(1);
    const paid = (await admin.query("select id from public.marketplace_orders where buyer_user_id=$1 and status='paid'", [buyer])).rows;
    expect(paid).toEqual([{ id: purchases[0].order_id }]);
    const active = (await admin.query("select source_record_id from public.mobile_store_transactions where user_id=$1 and status='active'", [buyer])).rows;
    expect(active).toEqual([{ source_record_id: purchases[0].order_id }]);
    const counters = (await admin.query('select sales_count,earnings_usd_cents from public.marketplace_assets where id=$1', [asset])).rows[0];
    expect(counters).toEqual({ sales_count: 1, earnings_usd_cents: 373 });
    const wallet = (await admin.query('select available_token_subunits from public.creator_resource_wallets where user_id=$1', [seller])).rows[0];
    expect(Number(wallet.available_token_subunits)).toBe(31705);
  }

  it('keeps the newer restore when distinct refund and restore events arrive together', async () => {
    const results = await race([db => adjust(db, 'refund', 1000), db => adjust(db, 'restore', 2000)]);
    expect(['refunded', 'stale_event']).toContain(results[0]);
    expect(['restored', 'already_active']).toContain(results[1]);
    await expectConsistentOwner();
    expect((await admin.query('select provider_event_timestamp_ms from public.mobile_store_transactions where external_order_id=$1', [receipt])).rows[0].provider_event_timestamp_ms).toBe('2000');
  });

  it.each([[0, 1], [1, 0]])('keeps one owner with restore/repurchase lock order %s then %s', async (first, second) => {
    expect(await adjust(admin, 'refund', 1000)).toBe('refunded');
    const intent = (await admin.query("select public.create_mobile_purchase_intent($1,'marketplace_unlock',$2) as result", [buyer, asset])).rows[0].result;
    const storeId = randomUUID();
    const results = await raceAssetQueue([
      async db => {
        try { return await adjust(db, 'restore', 2000); }
        catch (error) {
          expect(error).toMatchObject({ code: 'P0001', message: 'Mobile restoration conflicts with another purchase' });
          return 'conflict';
        }
      },
      async db => (await db.query(`select public.complete_mobile_purchase($1,$2,$3,'app_store',$4,$5,$5) as result`,
        [buyer, intent.purchase_intent_id, productId, storeId, `mobile_app_store_${storeId}`])).rows[0].result.status,
    ], [first, second]);
    expect([['restored', 'already_owned'], ['conflict', 'completed']]).toContainEqual(results);
    await expectConsistentOwner();
    expect((await admin.query('select count(*)::int as n from public.mobile_purchase_adjustment_events where provider_event_id=$1', [`${eventPrefix}:restore`])).rows[0].n).toBe(results[0] === 'restored' ? 1 : 0);
  });
});
