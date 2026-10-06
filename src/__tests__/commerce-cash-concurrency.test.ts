import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Dedicated local DB only: fixtures must be visible across real connections.
const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)('cash commerce concurrency against PostgreSQL', () => {
  let admin: Client;
  const clients: Client[] = [];
  let buyer: string;
  let seller: string;
  let bundle: string;
  let oldOrder: string;
  let newOrder: string;
  let oldPayment: string;
  let event: string;
  async function connect() {
    const client = new Client({ connectionString });
    await client.connect();
    clients.push(client);
    await client.query("set statement_timeout='8s'; set deadlock_timeout='100ms'");
    return client;
  }
  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    admin = await connect();
    buyer = randomUUID(); seller = randomUUID(); bundle = randomUUID();
    oldOrder = `order_old_${randomUUID()}`; newOrder = `order_new_${randomUUID()}`;
    oldPayment = `pay_old_${randomUUID()}`; event = `event_${randomUUID()}`;
    await admin.query(`insert into auth.users(id,email,aud,role,created_at) values
      ($1::uuid,$1::text||'@example.invalid','authenticated','authenticated',now()),
      ($2::uuid,$2::text||'@example.invalid','authenticated','authenticated',now())`, [buyer, seller]);
    const post = randomUUID();
    await admin.query(`insert into public.posts(id,user_id,visibility,category,source_kind,post_format,body)
      values($1,$2,'public','text','external','text','Concurrency fixture')`, [post, seller]);
    await admin.query(`insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,price_usd_cents,prompt_text)
      values($1,$2,$3,'paid','published','Concurrency fixture',200,'paid prompt')`, [bundle, post, seller]);
    for (const order of [oldOrder, newOrder]) {
      await admin.query(`insert into public.post_resource_bundle_orders(bundle_id,buyer_user_id,razorpay_order_id,
        amount_subunits,currency,status,quoted_price_usd_cents,quoted_revision_id,quoted_content_fingerprint,quoted_media)
        select $1,$2,$3,16600,'INR','created',200,id,content_fingerprint,'[]'::jsonb
        from public.post_resource_bundle_revisions where bundle_id=$1 order by revision_number desc limit 1`, [bundle, buyer, order]);
    }
    expect((await admin.query('select public.complete_post_resource_bundle_purchase($1,$2) as result', [oldOrder, oldPayment])).rows[0].result).toBe(true);
  });
  afterEach(async () => {
    for (const client of clients) await client.query('rollback').catch(() => {});
    if (admin) {
      await admin.query('delete from public.cash_purchase_adjustments where provider_event_id=$1', [event]);
      await admin.query('delete from auth.users where id=any($1::uuid[])', [[buyer, seller]]);
    }
    await Promise.all(clients.splice(0).map(client => client.end()));
  });
  it('finishes refund and a second checkout for the same buyer without a deadlock', async () => {
    const capture = await connect();
    const refund = await connect();
    await capture.query('begin');
    await refund.query('begin');
    // Pause capture at its real first lock: complete_* locks bundle before order.
    await capture.query('select id from public.post_resource_bundles where id=$1 for update', [bundle]);
    const pid = (await refund.query('select pg_backend_pid() as pid')).rows[0].pid;
    const refundResult = refund.query('select public.reconcile_post_resource_cash_adjustment($1,$2,\'refund\',\'local race\',$3) as result', [event, oldPayment, oldOrder])
      .then(async result => { await refund.query('commit'); return { result: result.rows[0].result }; })
      .catch(async (error: { code?: string }) => { await refund.query('rollback'); return { error: error.code }; });
    // Observe an actual database wait, not a sleep-based assumption.
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await admin.query("select wait_event_type from pg_stat_activity where pid=$1", [pid]);
      if (state.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    const captureResult = await capture.query('select public.complete_post_resource_bundle_purchase($1,$2) as result', [newOrder, `pay_new_${randomUUID()}`])
      .then(async result => { await capture.query('commit'); return { result: result.rows[0].result }; })
      .catch(async (error: { code?: string }) => { await capture.query('rollback'); return { error: error.code }; });
    const refunded = await refundResult;
    expect([captureResult, refunded]).toEqual([{ result: false }, { result: expect.objectContaining({ status: 'adjusted' }) }]);
    expect((await admin.query('select count(*)::int as n from public.post_resource_bundle_purchases where bundle_id=$1', [bundle])).rows[0].n).toBe(0);
    expect((await admin.query('select available_token_subunits from public.creator_resource_wallets where user_id=$1', [seller])).rows[0].available_token_subunits).toBe('0');
  });
  it('lets a checkout buy again when the refund acquires the bundle first', async () => {
    const capture = await connect();
    const refund = await connect();
    await refund.query('begin');
    await refund.query('select id from public.post_resource_bundles where id=$1 for update', [bundle]);
    const pid = (await capture.query('select pg_backend_pid() as pid')).rows[0].pid;
    const captured = capture.query('select public.complete_post_resource_bundle_purchase($1,$2) as result', [newOrder, `pay_new_${randomUUID()}`]);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await admin.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
      if (state.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    const refunded = await refund.query("select public.reconcile_post_resource_cash_adjustment($1,$2,'refund','local race',$3) as result", [event, oldPayment, oldOrder]);
    await refund.query('commit');
    expect(refunded.rows[0].result.status).toBe('adjusted');
    expect((await captured).rows[0].result).toBe(true);
    expect((await admin.query('select count(*)::int as n from public.post_resource_bundle_purchases where bundle_id=$1', [bundle])).rows[0].n).toBe(1);
    expect((await admin.query('select available_token_subunits from public.creator_resource_wallets where user_id=$1', [seller])).rows[0].available_token_subunits).toBe('17000');
    expect((await admin.query('select sales_count from public.post_resource_bundles where id=$1', [bundle])).rows[0].sales_count).toBe(1);
  });
  it('applies one refund across simultaneous duplicate deliveries', async () => {
    const callers = await Promise.all(Array.from({ length: 8 }, () => connect()));
    const results = await Promise.all(callers.map(client => client.query(
      "select public.reconcile_post_resource_cash_adjustment($1,$2,'refund','local duplicate',$3) as result", [event, oldPayment, oldOrder],
    )));
    expect(results.map(result => result.rows[0].result.status).sort()).toEqual(['adjusted', ...Array<string>(7).fill('already_adjusted')]);
    expect((await admin.query('select available_token_subunits from public.creator_resource_wallets where user_id=$1', [seller])).rows[0].available_token_subunits).toBe('0');
    expect((await admin.query("select count(*)::int as n from public.creator_resource_wallet_entries where user_id=$1 and entry_kind='refund'", [seller])).rows[0].n).toBe(1);
  });

  it('reconciles a refund waiting behind committed creator deletion', async () => {
    const deletion = await connect();
    const refund = await connect();
    await deletion.query('begin');
    await deletion.query('delete from auth.users where id=$1', [seller]);
    const pid = (await refund.query('select pg_backend_pid() as pid')).rows[0].pid;
    const result = refund.query("select public.reconcile_post_resource_cash_adjustment($1,$2,'refund','local deletion race',$3) as result", [event, oldPayment, oldOrder]);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await admin.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await deletion.query('commit');
    expect((await result).rows[0].result.status).toBe('adjusted');
    expect((await admin.query('select status,bundle_id from public.post_resource_bundle_orders where razorpay_order_id=$1', [oldOrder])).rows[0]).toMatchObject({ status: 'failed', bundle_id: null });
    expect((await admin.query('select id from public.post_resource_bundle_purchases where buyer_user_id=$1', [buyer])).rows).toEqual([]);
  });

  it('finishes refund before an overlapping creator deletion', async () => {
    const deletion = await connect();
    const refund = await connect();
    await refund.query('begin');
    // Pause at the first live-owner lock used by reconciliation.
    await refund.query('select id from auth.users where id=$1 for key share', [seller]);
    await refund.query('select id from public.post_resource_bundles where id=$1 for update', [bundle]);
    const pid = (await deletion.query('select pg_backend_pid() as pid')).rows[0].pid;
    const deleted = deletion.query('delete from auth.users where id=$1', [seller])
      .then(() => ({ ok: true }))
      .catch((error: { code?: string }) => ({ error: error.code }));
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await admin.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    const result = await refund.query("select public.reconcile_post_resource_cash_adjustment($1,$2,'refund','local deletion race',$3) as result", [event, oldPayment, oldOrder]);
    await refund.query('commit');
    expect(result.rows[0].result.status).toBe('adjusted');
    expect(await deleted).toEqual({ ok: true });
    expect((await admin.query('select status,bundle_id from public.post_resource_bundle_orders where razorpay_order_id=$1', [oldOrder])).rows[0]).toMatchObject({ status: 'failed', bundle_id: null });
  });

});
