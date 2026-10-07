import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeInitialAccountDeletion } from '@/lib/account-deletion-service';
import { deliverReferralRewardNotifications } from '@/lib/referral-reward-notifications';
import { settleReferralPurchaseRewards } from '@/lib/referral-reward-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('referral account deletion through actual Auth and SQL', () => {
  let db: Client, admin: SupabaseClient;
  let inviter: string, invitee: string, program: string, code: string, visit: string, attribution: string, transaction: string;
  const notifications = async () => (await db.query('select user_id,dedupe_key from public.mobile_notifications where user_id=any($1::uuid[]) order by user_id', [[inviter, invitee]])).rows;
  const balances = async () => (await db.query('select credits,promotional_credits from public.profiles where id=any($1::uuid[])', [[inviter, invitee]])).rows;
  const queue = async () => (await db.query('select q.completed_at,q.attempts,q.last_error_code from public.referral_reward_notification_outbox q join public.referral_credit_ledger l on l.id=q.ledger_id where l.transaction_id=$1', [transaction])).rows;
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY);
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
      if (origin !== new URL(config.API_URL).origin) throw Error('External provider calls forbidden');
      return nativeFetch(input, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    [inviter, invitee, program, code, visit, attribution, transaction] = Array.from({ length: 7 }, () => randomUUID());
    const users = [];
    for (let index = 0; index < 2; index++) {
      const created = await admin.auth.admin.createUser({ email: randomUUID() + '@referral-audit.invalid', password: randomUUID() + 'aZ!7', email_confirm: true });
      expect(created.error).toBeNull(); users.push(created.data.user!.id);
    }
    [inviter, invitee] = users;
    await db.query('update public.profiles set credits=500,promotional_credits=0 where id=any($1::uuid[])', [[inviter, invitee]]);
    await db.query("insert into public.referral_programs(id,version,name,status,inviter_reward_bps,invitee_reward_bps) values($1,(select max(version)+1 from public.referral_programs),'Local referral audit','paused',500,500)", [program]);
    await db.query('insert into public.referral_codes(id,user_id,code) values($1,$2,$3)', [code, inviter, randomUUID().replaceAll('-', '').slice(0, 16)]);
    await db.query("insert into public.referral_visits(id,referral_code_id,program_id,inviter_user_id,channel,expires_at) values($1,$2,$3,$4,'web',now()+interval '1 day')", [visit, code, program, inviter]);
    await db.query('insert into public.referral_attributions(id,program_id,referral_visit_id,inviter_user_id,invitee_user_id) values($1,$2,$3,$4,$5)', [attribution, program, visit, inviter, invitee]);
    await db.query("insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,credit_purchase_succeeded_at) values($1,$2,$3,41500,500,'success',now())", [transaction, invitee, 'audit-referral-' + transaction]);
  });
  afterEach(async () => {
    // Only these disposable IDs; append-only financial fixtures require an
    // isolated privileged cleanup transaction, never production mutation.
    await db.query('begin');
    try {
      await db.query('set local session_replication_role=replica');
      await db.query('delete from public.referral_reward_notification_outbox where ledger_id in (select id from public.referral_credit_ledger where transaction_id=$1)', [transaction]);
      for (const table of ['credit_purchase_adjustments', 'referral_credit_ledger', 'referral_reward_adjustments', 'referral_rewards', 'referral_purchase_events']) {
        await db.query(`delete from public.${table} where transaction_id=$1`, [transaction]);
      }
      await db.query('delete from public.transactions where id=$1', [transaction]);
      await db.query('delete from public.referral_attributions where id=$1', [attribution]);
      await db.query('delete from public.referral_visits where id=$1', [visit]);
      await db.query('delete from public.referral_codes where id=$1', [code]);
      await db.query('delete from public.referral_programs where id=$1', [program]);
      await db.query('set local session_replication_role=origin');
      await db.query('delete from auth.users where id=any($1::uuid[])', [[inviter, invitee]]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    await db.query('delete from public.account_deletion_jobs where user_id=any($1::uuid[])', [[inviter, invitee]]);
    expect(await notifications()).toEqual([]);
    expect(await balances()).toEqual([]);
    expect((await db.query('select id from public.transactions where id=$1', [transaction])).rows).toEqual([]);
    expect((await db.query('select id from public.referral_credit_ledger where transaction_id=$1', [transaction])).rows).toEqual([]);
    expect(await queue()).toEqual([]);
  });
  it.each([
    { role: 'inviter', settled: true }, { role: 'invitee', settled: true },
    { role: 'inviter', settled: false }, { role: 'invitee', settled: false },
  ])('deletes $role with settled=$settled while retaining financial history', async ({ role, settled }) => {
    const target = role === 'inviter' ? inviter : invitee;
    if (settled) expect(await settleReferralPurchaseRewards(admin, transaction)).toMatchObject({ status: 'settled' });
    const result = await executeInitialAccountDeletion({ admin, userId: target });
    expect(result).toMatchObject({ cleanupPending: true, authUserAlreadyMissing: false });
    expect((await db.query('select id from auth.users where id=$1', [target])).rows).toEqual([]);
    expect((await db.query('select id from public.referral_credit_ledger where transaction_id=$1', [transaction])).rows).toHaveLength(settled ? 2 : 0);
  });
  it('deletes an account without a referral relationship through the same Auth service', async () => {
    await db.query('delete from public.referral_attributions where id=$1', [attribution]);
    await db.query('delete from public.referral_visits where id=$1', [visit]);
    await db.query('delete from public.referral_codes where id=$1', [code]);
    expect(await executeInitialAccountDeletion({ admin, userId: inviter })).toMatchObject({ cleanupPending: true, authUserAlreadyMissing: false });
    expect((await db.query('select id from auth.users where id=$1', [inviter])).rows).toEqual([]);
  });
  it.each(['inviter', 'invitee'] as const)('reconciles late refund/restore after %s deletion without losing the surviving reward', async role => {
    await db.query('update public.transactions set credit_effect_applied=true where id=$1', [transaction]);
    await settleReferralPurchaseRewards(admin, transaction);
    const target = role === 'inviter' ? inviter : invitee;
    const survivor = role === 'inviter' ? invitee : inviter;
    await executeInitialAccountDeletion({ admin, userId: target });
    expect((await db.query('select user_id,detached_user_id from public.referral_credit_ledger where transaction_id=$1 and detached_user_id=$2', [transaction, target])).rows).toEqual([{ user_id: null, detached_user_id: target }]);
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect((await notifications()).map(row => row.user_id)).toEqual([survivor]);
    const adjust = async (action: string, amount: number, key: string) => {
      const result = await admin.rpc('reconcile_credit_purchase_adjustment', { p_transaction_id: transaction, p_provider: 'razorpay', p_provider_event_id: key, p_cumulative_reversed_subunits: amount, p_action: action, p_reason: 'Local deletion audit' });
      expect(result.error).toBeNull(); return result.data;
    };
    expect(await adjust('reverse', 41500, 'audit-refund-' + transaction)).toMatchObject({ status: 'reversed', remaining_credits: role === 'inviter' ? 0 : null, rewards: [expect.objectContaining({ user_id: survivor, credits: 25 })] });
    expect((await db.query('select credits,promotional_credits from public.profiles where id=$1', [survivor])).rows).toEqual([{ credits: role === 'inviter' ? 0 : 500, promotional_credits: 0 }]);
    expect(await adjust('reverse', 41500, 'audit-refund-' + transaction)).toMatchObject({ status: 'duplicate_event' });
    expect(await adjust('restore', 0, 'audit-restore-' + transaction)).toMatchObject({ status: 'restored', remaining_credits: role === 'inviter' ? 525 : null, rewards: [expect.objectContaining({ user_id: survivor, credits: 25 })] });
    expect((await db.query('select credits,promotional_credits from public.profiles where id=$1', [survivor])).rows).toEqual([{ credits: 525, promotional_credits: 25 }]);
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 2, delivered: 2, failed: 0 });
    expect((await notifications()).every(row => row.user_id === survivor)).toBe(true);
  });
  it('settles the surviving invitee after the inviter deletes before settlement and disables the code', async () => {
    const referralCode = (await db.query('select code from public.referral_codes where id=$1', [code])).rows[0].code;
    await executeInitialAccountDeletion({ admin, userId: inviter });
    expect((await admin.rpc('create_referral_visit', { p_code: referralCode, p_channel: 'web' })).data).toMatchObject({ status: 'invalid_code' });
    expect(await settleReferralPurchaseRewards(admin, transaction)).toMatchObject({ status: 'settled', rewards: [expect.objectContaining({ userId: invitee, credits: 25 })] });
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }]);
  });
  it('preserves append-only values and prevents invented detachment or reassignment', async () => {
    await settleReferralPurchaseRewards(admin, transaction);
    await expect(db.query('update public.referral_credit_ledger set credit_delta=credit_delta+1,promotional_delta=promotional_delta+1 where transaction_id=$1', [transaction])).rejects.toThrow('append-only');
    await expect(db.query('update public.referral_credit_ledger set user_id=null where user_id=$1', [inviter])).rejects.toThrow('only detach');
    await expect(db.query('update public.referral_credit_ledger set user_id=$2 where user_id=$1', [inviter, invitee])).rejects.toThrow('only detach');
    await expect(db.query('update public.transactions set detached_credit_grant_applied=true where id=$1', [transaction])).rejects.toThrow('immutable');
    await executeInitialAccountDeletion({ admin, userId: inviter });
    await expect(db.query('update public.referral_credit_ledger set detached_user_id=$2 where transaction_id=$1 and user_id is null', [transaction, invitee])).rejects.toThrow('immutable');
    await expect(db.query('delete from public.referral_credit_ledger where transaction_id=$1', [transaction])).rejects.toThrow('append-only');
  });
  it('cancels all outstanding notifications when both beneficiaries delete', async () => {
    await settleReferralPurchaseRewards(admin, transaction);
    await executeInitialAccountDeletion({ admin, userId: inviter });
    await executeInitialAccountDeletion({ admin, userId: invitee });
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 0, delivered: 0, failed: 0 });
    expect(await notifications()).toEqual([]);
    expect((await queue()).every(row => row.completed_at !== null)).toBe(true);
    expect((await db.query('select user_id,detached_user_id from public.referral_credit_ledger where transaction_id=$1', [transaction])).rows).toEqual(expect.arrayContaining([{ user_id: null, detached_user_id: inviter }, { user_id: null, detached_user_id: invitee }]));
  });

  it('retains zero-grant evidence and never manufactures credits after a deleted ungranted buyer is restored', async () => {
    await db.query("update public.transactions set status='created',credit_effect_applied=false,credit_purchase_succeeded_at=null where id=$1", [transaction]);
    await executeInitialAccountDeletion({ admin, userId: invitee });
    for (const [action, amount] of [['reverse', 41500], ['restore', 0]] as const) {
      const result = await admin.rpc('reconcile_credit_purchase_adjustment', { p_transaction_id: transaction, p_provider: 'razorpay', p_provider_event_id: action + transaction, p_cumulative_reversed_subunits: amount, p_action: action, p_reason: 'Local ungranted audit' });
      expect(result.error).toBeNull(); expect(result.data).toMatchObject({ base_credit_delta: 0, rewards: [] });
    }
    expect(await balances()).toEqual([{ credits: 500, promotional_credits: 0 }]);
    expect((await db.query('select detached_credit_grant_applied,credit_effect_applied from public.transactions where id=$1', [transaction])).rows).toEqual([{ detached_credit_grant_applied: false, credit_effect_applied: false }]);
    expect(await queue()).toEqual([]);
  });
  it.each(['settlement', 'notification'] as const)('retries concurrent deletion versus %s without orphaning history or delivery work', async phase => {
    if (phase === 'notification') await settleReferralPurchaseRewards(admin, transaction);
    // Real independent HTTP transactions. A deadlock victim is retryable; the
    // completed deletion and money effect must converge without replayed grants.
    await Promise.allSettled([
      executeInitialAccountDeletion({ admin, userId: inviter }),
      phase === 'settlement' ? settleReferralPurchaseRewards(admin, transaction) : deliverReferralRewardNotifications(admin),
    ]);
    await executeInitialAccountDeletion({ admin, userId: inviter });
    await settleReferralPurchaseRewards(admin, transaction);
    await deliverReferralRewardNotifications(admin);
    expect((await db.query('select id from auth.users where id=$1', [inviter])).rows).toEqual([]);
    expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }]);
    expect((await notifications()).map(row => row.user_id)).toEqual([invitee]);
    expect((await queue()).every(row => row.completed_at !== null)).toBe(true);
    expect((await db.query('select count(*)::int n from public.referral_rewards where transaction_id=$1 and beneficiary_user_id=$2', [transaction, invitee])).rows).toEqual([{ n: 1 }]);
  });

  it('recovers an unsettled purchase for the surviving inviter after the buyer deletes', async () => {
    await db.query('update public.transactions set credit_effect_applied=true where id=$1', [transaction]);
    await executeInitialAccountDeletion({ admin, userId: invitee });
    const work = await admin.rpc('list_unsettled_referral_purchase_transactions', { p_limit: 100 });
    expect(work.error).toBeNull();
    expect(JSON.stringify(work.data)).toContain(transaction);
    expect(await settleReferralPurchaseRewards(admin, transaction)).toMatchObject({ status: 'settled', rewards: [expect.objectContaining({ userId: inviter, credits: 25 })] });
    expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }]);
  });

});
