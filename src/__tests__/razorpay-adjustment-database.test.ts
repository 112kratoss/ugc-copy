import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { processRazorpayWebhookForRoute } from '@/lib/razorpay-webhook-service';

// Explicit local-only integration run; ordinary web CI has no database.
// SQL state-machine coverage also runs in the mandatory migration replay job.
const enabled = Boolean(process.env.SUPABASE_TEST_DB_URL);
describe.skipIf(!enabled)('Razorpay handler against real local settlement SQL', () => {
  let db: Client;
  const user = 'e8600001-0000-4000-8000-000000000001';
  const transaction = 'e8600002-0000-4000-8000-000000000001';
  const payment = 'pay_audit_ordering';
  const order = 'order_audit_ordering';
  beforeEach(async () => {
    const connectionString = process.env.SUPABASE_TEST_DB_URL!;
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString).hostname);
    db = new Client({ connectionString });
    await db.connect();
    await db.query('begin');
    await db.query(`insert into auth.users(id,email,aud,role,is_anonymous,created_at) values($1,'ordering-audit@example.invalid','authenticated','authenticated',false,now())`, [user]);
    await db.query('update public.profiles set credits=0,promotional_credits=0 where id=$1', [user]);
    await db.query(`insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status) values($1,$2,$3,10000,100,'created')`, [transaction, user, order]);
    await db.query('set local role service_role');
    await db.query('select public.add_credits($1,100,$2,$3)', [user, transaction, payment]);
  });
  afterEach(async () => { await db?.query('rollback'); await db?.end(); });

  function client() {
    return {
      from(table: string) {
        if (table === 'provider_dependency_events') return { insert: async () => ({ error: null }) };
        if (table !== 'transactions') throw new Error(`Unexpected table ${table}`);
        return { select: () => ({ eq: (column: string, value: unknown) => ({ maybeSingle: async () => {
          if (!['id', 'razorpay_payment_id', 'razorpay_order_id'].includes(column)) throw new Error('Unexpected filter');
          return { data: (await db.query(`select * from public.transactions where ${column}=$1`, [value])).rows[0] ?? null, error: null };
        } }) }) };
      },
      async rpc(name: string, args: Record<string, unknown>) {
        if (!/^reconcile_razorpay_credit_/.test(name)) throw new Error(`Unexpected RPC ${name}`);
        const keys = Object.keys(args);
        if (!keys.every(key => /^p_[a-z_]+$/.test(key))) throw new Error('Unexpected argument');
        const result = await db.query(`select public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(',')}) as result`, Object.values(args));
        return { data: result.rows[0].result, error: null };
      },
    } as unknown as SupabaseClient;
  }
  async function event(kind: 'refund' | 'open' | 'won', id: string, refunded: number, amount = 3000) {
    const rawBody = JSON.stringify({
      event: kind === 'refund' ? 'refund.processed' : kind === 'open' ? 'payment.dispute.created' : 'payment.dispute.won',
      payload: {
        payment: { entity: { id: payment, order_id: order, amount: 10000, amount_refunded: refunded, currency: 'INR' } },
        ...(kind === 'refund' ? { refund: { entity: { id, payment_id: payment, amount: refunded, status: 'processed' } } }
          : { dispute: { entity: { id, payment_id: payment, amount, status: kind === 'open' ? 'open' : 'won' } } }),
      },
    });
    expect(await processRazorpayWebhookForRoute({ createAdminSupabase: client, rawBody })).toEqual({ status: 200, body: 'OK' });
  }
  async function balance() { return (await db.query('select credits from public.profiles where id=$1', [user])).rows[0].credits; }

  it('does not reopen a dispute when won is delivered before created', async () => {
    await event('won', 'disp_ordering', 0);
    await event('open', 'disp_ordering', 0);
    expect(await balance()).toBe(100);
  });
  it('keeps a later refund when an older won payment snapshot arrives', async () => {
    await event('open', 'disp_ordering', 0);
    await event('refund', 'rfnd_ordering', 5000);
    await event('won', 'disp_ordering', 0);
    expect(await balance()).toBe(50);
  });
  it('counts a refund and an active dispute regardless of delivery order', async () => {
    await event('open', 'disp_ordering', 0);
    await event('refund', 'rfnd_ordering', 2000);
    expect(await balance()).toBe(50);
  });
  it('does not lose a concurrent independent dispute amount', async () => {
    await Promise.all([event('open', 'disp_first', 0, 2000), event('open', 'disp_second', 0, 3000)]);
    expect(await balance()).toBe(50);
  });
});
