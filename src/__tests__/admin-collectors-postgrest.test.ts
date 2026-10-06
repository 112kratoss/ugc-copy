// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectAdminOverview } from '@/lib/admin-overview-service';
import { collectAdminRevenueReport } from '@/lib/admin-revenue-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('admin collectors through real PostgREST and SQL', () => {
  let db: Client;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let owner: string;
  let transactionIds: string[];
  const now = new Date();
  const snapshot = () => collectAdminOverview(admin, { now });

  const insert = async (options: { mobile?: boolean; sandbox?: boolean; status?: string; old?: boolean } = {}) => {
    const id = randomUUID();
    transactionIds.push(id);
    const createdAt = new Date(now.getTime() - (options.old ? 31 : 1) * 86400_000);
    await db.query('insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,mobile_product_id,is_test,created_at) values($1,$2,$3,100,10,$4,$5,$6,$7)', [
      id, owner, 'audit-collector-' + id, options.status ?? 'success', options.mobile ? 'audit.credit.pack' : null, options.sandbox ?? false, createdAt,
    ]);
    return id;
  };
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['127.0.0.1', 'localhost']).toContain(new URL(config.API_URL).hostname);
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    const options = { auth: { persistSession: false, autoRefreshToken: false } };
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options);
    anon = createClient(config.API_URL, config.ANON_KEY, options);
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  beforeEach(async () => {
    transactionIds = [];
    const result = await admin.auth.admin.createUser({ email: 'collector-' + randomUUID() + '@audit.invalid', password: randomUUID(), email_confirm: true });
    expect(result.error).toBeNull();
    owner = result.data.user!.id;
  });
  afterEach(async () => {
    await db.query('delete from public.transactions where id=any($1::uuid[])', [transactionIds]);
    expect((await admin.auth.admin.deleteUser(owner)).error).toBeNull();
    expect((await db.query('select id from public.transactions where id=any($1::uuid[])', [transactionIds])).rows).toEqual([]);
    expect((await db.query('select id from auth.users where id=$1', [owner])).rows).toEqual([]);
    expect((await db.query('select id from public.profiles where id=$1', [owner])).rows).toEqual([]);
  });
  afterAll(async () => { await db.end(); });

  it('excludes a successful mobile credit mirror from the Razorpay paid-order counter', async () => {
    const before = await snapshot();
    const revenueBefore = await collectAdminRevenueReport(admin, { now });
    const id = await insert({ mobile: true });
    const after = await snapshot();
    expect(after.dashboardError).toBeNull();
    const revenueAfter = await collectAdminRevenueReport(admin, { now });
    expect(revenueAfter.recentOrders.some(row => row.id === id)).toBe(false);
    expect(revenueAfter.rails.find(row => row.key === 'razorpay-credits')!.succeededCount)
      .toBe(revenueBefore.rails.find(row => row.key === 'razorpay-credits')!.succeededCount);
    expect(after.counters.paidOrders30d).toBe(before.counters.paidOrders30d);
  });
  it('counts only the genuine web rail in a mixed recent fixture', async () => {
    const before = await snapshot();
    await insert();
    await insert({ mobile: true });
    await insert({ mobile: true, sandbox: true });
    await insert({ sandbox: true });
    await insert({ status: 'created' });
    await insert({ status: 'failed' });
    await insert({ old: true });
    expect((await snapshot()).counters.paidOrders30d).toBe(before.counters.paidOrders30d + 1);
  });
  it.each([{ sandbox: true }, { status: 'created' }, { status: 'failed' }, { old: true }])('retains the existing exclusion for $sandbox $status $old', async options => {
    const before = await snapshot();
    await insert(options);
    expect((await snapshot()).counters.paidOrders30d).toBe(before.counters.paidOrders30d);
  });
  it('denies the population collector RPC to an anonymous API client', async () => {
    const result = await anon.rpc('admin_user_population_counts', { p_since: now.toISOString() });
    expect(result.error).not.toBeNull();
  });
});
