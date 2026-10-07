import { randomUUID } from 'node:crypto';
import { Client, type QueryResult } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)('legacy mobile product binding concurrency', () => {
  let admin: Client;
  let buyer: string;
  let intent: string;
  let receipt: string;
  let external: string;
  let products: string[];
  let before: Record<string, unknown>;
  const clients: Client[] = [];

  async function connect() {
    const client = new Client({ connectionString });
    await client.connect();
    clients.push(client);
    await client.query("set statement_timeout='8s'");
    return client;
  }

  async function snapshot() {
    return (await admin.query(`select to_jsonb(t)-'product_id'-'updated_at' as receipt,
      to_jsonb(i)-'product_id'-'updated_at' as intent
      from public.mobile_store_transactions t join public.mobile_purchase_intents i on i.id=t.purchase_intent_id
      where t.id=$1`, [receipt])).rows[0] as Record<string, unknown>;
  }

  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    buyer = randomUUID(); intent = randomUUID(); receipt = randomUUID();
    external = `mobile_app_store_audit_binding_${receipt}`;
    products = [`audit.binding.${receipt}.one`, `audit.binding.${receipt}.two`];
    admin = await connect();
    await admin.query(`insert into auth.users(id,email,created_at,is_anonymous)
      values($1,$2,now(),false)`, [buyer, `${buyer}@audit.invalid`]);
    await admin.query(`insert into public.mobile_store_products(product_id,entitlement_type,amount_subunits,currency,active)
      select unnest($1::text[]),'marketplace_unlock',87313,'USD',false`, [products]);
    await admin.query(`insert into public.mobile_purchase_intents(id,user_id,product_id,entitlement_type,resource_id,amount_subunits,currency,status,consumed_at)
      values($1,$2,'legacy.audit.binding','marketplace_unlock',$3,87313,'USD','consumed',now())`, [intent, buyer, randomUUID()]);
    await admin.query(`insert into public.mobile_store_transactions(id,provider,store_transaction_id,external_order_id,user_id,product_id,purchase_intent_id,entitlement_type,resource_id,amount_subunits,currency,source_record_id)
      select $1,'app_store',$2,$3,user_id,product_id,id,entitlement_type,resource_id,amount_subunits,currency,$4
      from public.mobile_purchase_intents where id=$5`, [receipt, `audit_binding_${receipt}`, external, randomUUID(), intent]);
    before = await snapshot();
  });

  afterEach(async () => {
    try {
      if (admin) {
        await admin.query('delete from public.mobile_store_transactions where id=$1', [receipt]);
        await admin.query('delete from public.mobile_purchase_intents where id=$1', [intent]);
        await admin.query('delete from public.mobile_store_products where product_id=any($1::text[])', [products]);
        await admin.query('delete from auth.users where id=$1', [buyer]);
        const remaining = (await admin.query(`select
          (select count(*) from auth.users where id=$1) +
          (select count(*) from public.profiles where id=$1) +
          (select count(*) from public.mobile_purchase_intents where id=$2) +
          (select count(*) from public.mobile_store_transactions where id=$3) +
          (select count(*) from public.mobile_store_products where product_id=any($4::text[])) as fixtures`,
        [buyer, intent, receipt, products])).rows[0];
        expect(Number(remaining.fixtures)).toBe(0);
      }
    } finally {
      await Promise.all(clients.splice(0).map(client => client.end()));
    }
  });

  it.each(['duplicate', 'competing product', 'aborted first binding'] as const)('%s serializes on the original receipt', async (mode) => {
    const first = await connect();
    const second = await connect();
    const pid = (await second.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await first.query('begin');
    await first.query('set local role service_role');
    await second.query('set role service_role');
    let pending: Promise<QueryResult> | undefined;
    try {
      const initial = await first.query('select public.bind_legacy_mobile_store_transaction_product($1,$2) as result', [external, products[0]]);
      expect(initial.rows[0].result.status).toBe('bound');
      const contenderProduct = mode === 'duplicate' ? products[0] : products[1];
      pending = second.query('select public.bind_legacy_mobile_store_transaction_product($1,$2) as result', [external, contenderProduct]);
      const deadline = Date.now() + 4000;
      let blocked = false;
      while (Date.now() < deadline) {
        const activity = (await admin.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0];
        if (activity?.wait_event_type === 'Lock') { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await first.query(mode === 'aborted first binding' ? 'rollback' : 'commit');
      const result = await pending;
      const expectedStatus = mode === 'duplicate' ? 'already_bound' : mode === 'competing product' ? 'identity_conflict' : 'bound';
      expect(result.rows[0].result.status).toBe(expectedStatus);
      const expectedProduct = mode === 'aborted first binding' ? products[1] : products[0];
      const persisted = (await admin.query(`select t.product_id as receipt_product,i.product_id as intent_product
        from public.mobile_store_transactions t join public.mobile_purchase_intents i on i.id=t.purchase_intent_id where t.id=$1`, [receipt])).rows[0];
      expect(persisted).toEqual({ receipt_product: expectedProduct, intent_product: expectedProduct });
      expect(await snapshot()).toEqual(before);
      const balance = (await admin.query('select credits,promotional_credits from public.profiles where id=$1', [buyer])).rows[0];
      expect(balance).toEqual({ credits: 0, promotional_credits: 0 });
      expect((await admin.query('select count(*)::int as purchases from public.transactions where user_id=$1', [buyer])).rows[0].purchases).toBe(0);
    } finally {
      await first.query('rollback');
      if (pending) await pending.catch(() => undefined);
    }
  });
});
