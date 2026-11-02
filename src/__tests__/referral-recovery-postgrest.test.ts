import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileReferralPurchaseRewards } from '@/lib/referral-reward-reconciliation';
import { hasUnsettledReferralPurchaseTransactions } from '@/lib/referral-reward-reconciliation';
import { reconcileReferralPurchaseRewardAdjustment, settleReferralPurchaseRewards } from '@/lib/referral-reward-service';
import { deliverReferralRewardNotifications } from '@/lib/referral-reward-notifications';
import { notifyReferralReward, processMobilePushMaintenance } from '@/lib/mobile-notifications';
import { runReferralRewardReconciliationBackendJob } from '@/lib/backend-job-executions';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('referral notification recovery through actual PostgREST and SQL', () => {
  let db: Client, admin: SupabaseClient;
  let inviter: string, invitee: string, program: string, code: string, visit: string, attribution: string, transaction: string;
  let fault: 'settlement-reply' | 'notification-insert' | 'notification-reply' | null;
  let providerOrigin: string | null = null;
  const notifications = async () => (await db.query('select user_id,dedupe_key from public.mobile_notifications where user_id=any($1::uuid[]) order by user_id', [[inviter, invitee]])).rows;
  const balances = async () => (await db.query('select credits,promotional_credits from public.profiles where id=any($1::uuid[])', [[inviter, invitee]])).rows;
  const queue = async () => (await db.query('select q.completed_at,q.attempts,q.last_error_code from public.referral_reward_notification_outbox q join public.referral_credit_ledger l on l.id=q.ledger_id where l.transaction_id=$1', [transaction])).rows;
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
      if (origin !== new URL(config.API_URL).origin && origin !== providerOrigin) throw Error('External provider calls forbidden');
      return nativeFetch(input, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (fault && path.endsWith('/rpc/deliver_referral_reward_notifications')) {
        if (fault === 'notification-reply') expect((await fetch(input, init)).ok).toBe(true);
        return new Response(JSON.stringify({ code: 'XX000', message: 'Injected recovery transport failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      const failSettlement = fault === 'settlement-reply' && path.endsWith('/rpc/settle_referral_purchase_rewards');
      if (failSettlement) {
        expect((await fetch(input, init)).ok).toBe(true);
        return new Response(JSON.stringify({ code: 'XX000', message: 'Injected local referral transport failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(input, init);
    } } });
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    [inviter, invitee, program, code, visit, attribution, transaction] = Array.from({ length: 7 }, () => randomUUID()); fault = null;
    await db.query("insert into auth.users(id,email,aud,role,created_at) select id,id::text||'@referral-audit.invalid','authenticated','authenticated',now() from unnest($1::uuid[]) id", [[inviter, invitee]]);
    await db.query('update public.profiles set credits=500,promotional_credits=0 where id=any($1::uuid[])', [[inviter, invitee]]);
    await db.query("insert into public.referral_programs(id,version,name,status,inviter_reward_bps,invitee_reward_bps) values($1,(select max(version)+1 from public.referral_programs),'Local referral audit','paused',500,500)", [program]);
    await db.query('insert into public.referral_codes(id,user_id,code) values($1,$2,$3)', [code, inviter, randomUUID().replaceAll('-', '').slice(0, 16)]);
    await db.query("insert into public.referral_visits(id,referral_code_id,program_id,inviter_user_id,channel,expires_at) values($1,$2,$3,$4,'web',now()+interval '1 day')", [visit, code, program, inviter]);
    await db.query('insert into public.referral_attributions(id,program_id,referral_visit_id,inviter_user_id,invitee_user_id) values($1,$2,$3,$4,$5)', [attribution, program, visit, inviter, invitee]);
    await db.query("insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,credit_purchase_succeeded_at) values($1,$2,$3,41500,500,'success',now())", [transaction, invitee, 'audit-referral-' + transaction]);
  });
  afterEach(async () => {
    fault = null;
    // Only these disposable IDs; append-only financial fixtures require an
    // isolated privileged cleanup transaction, never production mutation.
    await db.query('begin');
    try {
      await db.query('set local session_replication_role=replica');
      await db.query('delete from public.referral_reward_notification_outbox where ledger_id in (select id from public.referral_credit_ledger where transaction_id=$1)', [transaction]);
      for (const table of ['referral_credit_ledger', 'referral_reward_adjustments', 'referral_rewards', 'referral_purchase_events']) {
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
    expect(await notifications()).toEqual([]);
    expect(await balances()).toEqual([]);
    expect((await db.query('select id from public.transactions where id=$1', [transaction])).rows).toEqual([]);
    expect((await db.query('select id from public.referral_credit_ledger where transaction_id=$1', [transaction])).rows).toEqual([]);
    expect(await queue()).toEqual([]);
  });
  it('settles both rewards once and creates one notification per beneficiary', async () => {
    expect(await reconcileReferralPurchaseRewards(admin)).toMatchObject({ processed: 1, settled: 1, failed: 0 });
    expect(await notifications()).toHaveLength(2);
    await reconcileReferralPurchaseRewards(admin);
    expect(await notifications()).toHaveLength(2);
    expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }, { credits: 525, promotional_credits: 25 }]);
  });
  it.each(['settlement-reply', 'notification-insert'] as const)('recovers missing notifications after %s without granting twice', async injected => {
    fault = injected; await expect(reconcileReferralPurchaseRewards(admin)).rejects.toBeDefined();
    expect(await notifications()).toHaveLength(0);
    expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }, { credits: 525, promotional_credits: 25 }]);
    fault = null; await reconcileReferralPurchaseRewards(admin);
    expect(await notifications()).toHaveLength(2);
    await reconcileReferralPurchaseRewards(admin);
    expect(await notifications()).toHaveLength(2);
    expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }, { credits: 525, promotional_credits: 25 }]);
  });
  it('does not duplicate a notification whose insert acknowledgement was lost', async () => {
    fault = 'notification-reply'; await expect(reconcileReferralPurchaseRewards(admin)).rejects.toBeDefined();
    expect(await notifications()).toHaveLength(2);
    fault = null; await reconcileReferralPurchaseRewards(admin);
    expect(await notifications()).toHaveLength(2);
    expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }, { credits: 525, promotional_credits: 25 }]);
  });
  it('keeps the job eligible after settlement has committed without notification delivery', async () => {
    await settleReferralPurchaseRewards(admin, transaction);
    expect((await admin.rpc('list_unsettled_referral_purchase_transactions', { p_limit: 1 })).data).toEqual([]);
    expect(await hasUnsettledReferralPurchaseTransactions(admin)).toBe(true);
    expect(await reconcileReferralPurchaseRewards(admin)).toMatchObject({ processed: 0, notificationDelivery: { processed: 2, delivered: 2, failed: 0 } });
    expect(await hasUnsettledReferralPurchaseTransactions(admin)).toBe(false);
  });
  it('uses authoritative ledger content for a targeted foreground notification and never grants from caller fields', async () => {
    const settlement = await settleReferralPurchaseRewards(admin, transaction);
    const reward = settlement.rewards[0];
    const parameters = { userId: randomUUID(), credits: 999999, rewardId: randomUUID(), eventKey: reward.eventKey, reversed: true };
    expect(await notifyReferralReward(admin, parameters)).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect((await notifications())[0]).toEqual({ user_id: reward.userId, dedupe_key: `referral-reward:${reward.rewardId}:${reward.eventKey}` });
    expect(await notifyReferralReward(admin, parameters)).toEqual({ processed: 0, delivered: 0, failed: 0 });
    expect(await notifyReferralReward(admin, { ...parameters, eventKey: 'absent-' + randomUUID() })).toEqual({ processed: 0, delivered: 0, failed: 0 });
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect(await notifications()).toHaveLength(2);
    expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }, { credits: 525, promotional_credits: 25 }]);
  });
  it('enqueues nothing when a reward transaction rolls back', async () => {
    await db.query('begin');
    try {
      await db.query('select public.settle_referral_purchase_rewards($1)', [transaction]);
      expect(await queue()).toHaveLength(2);
    } finally { await db.query('rollback'); }
    expect(await queue()).toEqual([]); expect(await notifications()).toEqual([]);
    expect(await balances()).toEqual([{ credits: 500, promotional_credits: 0 }, { credits: 500, promotional_credits: 0 }]);
  });
  it('delivers reversal and restoration events once using their financial event keys', async () => {
    await reconcileReferralPurchaseRewards(admin);
    await reconcileReferralPurchaseRewardAdjustment(admin, { transactionId: transaction, action: 'reverse', purchaseCredits: 500, adjustmentKey: 'audit-reverse', reason: 'Local audit' });
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 2, delivered: 2, failed: 0 });
    expect(await balances()).toEqual([{ credits: 500, promotional_credits: 0 }, { credits: 500, promotional_credits: 0 }]);
    await reconcileReferralPurchaseRewardAdjustment(admin, { transactionId: transaction, action: 'restore', purchaseCredits: 500, adjustmentKey: 'audit-restore' });
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 2, delivered: 2, failed: 0 });
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 0, delivered: 0, failed: 0 });
    expect(await notifications()).toHaveLength(6);
    expect((await db.query('select type,count(*)::int n from public.mobile_notifications where user_id=any($1::uuid[]) group by type order by type', [[inviter, invitee]])).rows)
      .toEqual([{ type: 'referral_reward_earned', n: 4 }, { type: 'referral_reward_reversed', n: 2 }]);
    expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }, { credits: 525, promotional_credits: 25 }]);
  });
  it('serializes eight concurrent drains without duplicate history or credit changes', async () => {
    await settleReferralPurchaseRewards(admin, transaction);
    const results = await Promise.all(Array.from({ length: 8 }, () => deliverReferralRewardNotifications(admin)));
    expect(results.reduce((sum, row) => sum + row.delivered, 0)).toBe(2);
    expect(await notifications()).toHaveLength(2);
    expect((await queue()).every(row => row.completed_at !== null)).toBe(true);
  });
  it('respects the delivery bound and never replays completed history after notification retention', async () => {
    await settleReferralPurchaseRewards(admin, transaction);
    expect((await admin.rpc('deliver_referral_reward_notifications', { p_limit: 1 })).data).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect(await notifications()).toHaveLength(1);
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 1, delivered: 1, failed: 0 });
    await db.query('delete from public.mobile_notifications where user_id=any($1::uuid[])', [[inviter, invitee]]);
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 0, delivered: 0, failed: 0 });
    expect(await notifications()).toEqual([]);
    expect((await admin.rpc('deliver_referral_reward_notifications', { p_limit: 101 })).error?.code).toBe('22023');
  });
  it('isolates a poison notification, backs it off, and repairs it after the fault is removed', async () => {
    await settleReferralPurchaseRewards(admin, transaction);
    const hook = 'audit_referral_' + inviter.replaceAll('-', '');
    try {
      await db.query(`create function public.${hook}() returns trigger language plpgsql as $$ begin if NEW.user_id='${inviter}'::uuid then raise exception 'Owned audit notification fault' using errcode='23514'; end if; return NEW; end $$`);
      await db.query(`create trigger ${hook} before insert on public.mobile_notifications for each row execute function public.${hook}()`);
      const requestId = 'audit-referral-job-' + randomUUID();
      try {
        expect(await runReferralRewardReconciliationBackendJob({ serviceClient: admin, requestId })).toMatchObject({ success: false, status: 'failed' });
        expect((await db.query('select status,summary from public.backend_job_runs where request_id=$1', [requestId])).rows)
          .toEqual([{ status: 'failed', summary: expect.objectContaining({ notificationDelivery: { processed: 2, delivered: 1, failed: 1 } }) }]);
      } finally { await db.query('delete from public.backend_job_runs where request_id=$1', [requestId]); }
      expect(await notifications()).toHaveLength(1);
      expect((await queue()).filter(row => row.last_error_code === '23514')).toHaveLength(1);
      expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 0, delivered: 0, failed: 0 });
    } finally {
      await db.query(`drop trigger if exists ${hook} on public.mobile_notifications`);
      await db.query(`drop function if exists public.${hook}()`);
    }
    await db.query('update public.referral_reward_notification_outbox q set available_at=now()-interval \'1 second\' from public.referral_credit_ledger l where l.id=q.ledger_id and l.transaction_id=$1', [transaction]);
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect(await notifications()).toHaveLength(2);
  });
  it('rolls back notification history if its completion marker cannot commit', async () => {
    await settleReferralPurchaseRewards(admin, transaction);
    const ledgerIds = (await db.query('select id from public.referral_credit_ledger where transaction_id=$1', [transaction])).rows.map(row => row.id as string);
    const hook = 'audit_marker_' + inviter.replaceAll('-', '');
    try {
      await db.query(`create function public.${hook}() returns trigger language plpgsql as $$ begin if NEW.ledger_id=any(ARRAY['${ledgerIds.join("','")}']::uuid[]) and NEW.completed_at is not null then raise exception 'Owned audit marker fault' using errcode='23514'; end if; return NEW; end $$`);
      await db.query(`create trigger ${hook} before update on public.referral_reward_notification_outbox for each row execute function public.${hook}()`);
      expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 2, delivered: 0, failed: 2 });
      expect(await notifications()).toEqual([]);
      expect((await queue()).every(row => row.completed_at === null)).toBe(true);
    } finally {
      await db.query(`drop trigger if exists ${hook} on public.referral_reward_notification_outbox`);
      await db.query(`drop function if exists public.${hook}()`);
    }
    await db.query('update public.referral_reward_notification_outbox q set available_at=now()-interval \'1 second\' from public.referral_credit_ledger l where l.id=q.ledger_id and l.transaction_id=$1', [transaction]);
    expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 2, delivered: 2, failed: 0 });
  });
  it.each(['enabled', 'disabled-before-delivery'] as const)('recovers zero-attempt pushes and respects %s token state with a local HTTP provider', async mode => {
    const tokenId = randomUUID();
    await db.query("insert into public.mobile_push_tokens(id,user_id,expo_push_token,platform,is_active) values($1,$2,$3,'ios',true)", [tokenId, inviter, 'ExponentPushToken[' + tokenId + ']']);
    await db.query("insert into public.mobile_push_tokens(user_id,expo_push_token,platform,is_active) values($1,$2,'ios',true)", [invitee, 'ExponentPushToken[' + randomUUID() + ']']);
    await db.query('insert into public.mobile_notification_preferences(user_id,commerce_enabled) values($1,false)', [invitee]);
    await settleReferralPurchaseRewards(admin, transaction);
    await deliverReferralRewardNotifications(admin);
    const deliveries = () => db.query('select user_id,send_status,receipt_status,attempt_count from public.mobile_push_deliveries where user_id=any($1::uuid[])', [[inviter, invitee]]);
    expect((await deliveries()).rows).toEqual([{ user_id: inviter, send_status: 'error', receipt_status: 'error', attempt_count: 0 }]);
    if (mode === 'disabled-before-delivery') await db.query('update public.mobile_push_tokens set is_active=false where id=$1', [tokenId]);
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      calls++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: { status: 'ok', id: 'local-referral-ticket' } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Local provider address missing');
    providerOrigin = 'http://127.0.0.1:' + address.port;
    const fetcher: typeof fetch = (input, init) => {
      expect(String(input)).toContain('/push/send');
      return fetch(providerOrigin + '/send', init);
    };
    try {
      await processMobilePushMaintenance(admin, { fetcher });
      await deliverReferralRewardNotifications(admin);
      await processMobilePushMaintenance(admin, { fetcher });
      expect(calls).toBe(mode === 'enabled' ? 1 : 0);
      expect((await deliveries()).rows).toEqual([expect.objectContaining({ user_id: inviter, attempt_count: mode === 'enabled' ? 1 : 0, send_status: mode === 'enabled' ? 'sent' : 'error' })]);
    } finally {
      providerOrigin = null;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each(['anon', 'authenticated'])('denies %s queue reads, writes and delivery', async role => {
    expect((await db.query("select has_table_privilege($1,'public.referral_reward_notification_outbox','SELECT') r,has_table_privilege($1,'public.referral_reward_notification_outbox','INSERT,UPDATE,DELETE') w,has_function_privilege($1,'public.deliver_referral_reward_notifications(integer, text)','EXECUTE') x,has_function_privilege($1,'public.has_pending_referral_reward_notifications()','EXECUTE') h", [role])).rows)
      .toEqual([{ r: false, w: false, x: false, h: false }]);
    await db.query('begin');
    try {
      await db.query(`set local role ${role}`);
      await expect(db.query('select public.deliver_referral_reward_notifications(1)')).rejects.toMatchObject({ code: '42501' });
    } finally { await db.query('rollback'); }
  });
  it.each(['settlement-committed', 'delivery-uncommitted'])('recovers after actual worker SIGKILL at %s', async phase => {
    if (phase === 'delivery-uncommitted') await settleReferralPurchaseRewards(admin, transaction);
    const child = fork('src/__tests__/referral-notification-worker.cjs', [], { env: { NODE_ENV: 'test', PATH: process.env.PATH, SUPABASE_TEST_DB_URL: connectionString, AUDIT_REFERRAL_TRANSACTION: transaction, AUDIT_REFERRAL_PHASE: phase }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Worker checkpoint timed out')), 8000);
        child.once('message', message => { clearTimeout(timer); if ((message as { stage: string }).stage === phase) resolve(); else reject(Error('Worker checkpoint failed')); });
        child.once('exit', () => { clearTimeout(timer); reject(Error('Worker exited before checkpoint')); });
      });
      const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
      child.kill('SIGKILL'); expect(await exited).toBe('SIGKILL');
      await reconcileReferralPurchaseRewards(admin);
      expect(await notifications()).toHaveLength(2);
      expect(await deliverReferralRewardNotifications(admin)).toEqual({ processed: 0, delivered: 0, failed: 0 });
      expect(await balances()).toEqual([{ credits: 525, promotional_credits: 25 }, { credits: 525, promotional_credits: 25 }]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      }
    }
  }, 12000);
});
