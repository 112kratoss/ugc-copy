import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as overviewRoute } from '@/app/api/referrals/me/route';
import { POST as linkRoute } from '@/app/api/referrals/link/route';
import { POST as visitRoute } from '@/app/api/referrals/visit/route';
import { POST as claimRoute } from '@/app/api/referrals/claim/route';
import { recordDeletedAccountIdentityFingerprints } from '@/lib/account-identity-fingerprint';
import { collectAdminActivity } from '@/lib/admin-activity-service';
import { applyReferralReviewAction, getAdminReferralOverview } from '@/lib/admin-referrals-service';
import { settleCreditPurchaseReferralRewards } from '@/lib/credit-referral-integration';
import { getReferralRiskContext } from '@/lib/referral';
import {
  hasUnsettledReferralPurchaseTransactions,
  reconcileReferralPurchaseRewards,
} from '@/lib/referral-reward-reconciliation';
import { guardUserFacingRouteIdentity } from '@/lib/route-identity-admission';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
// The production proxy's shared admission boundary in front of the actual route
// exports, as in the intake suite. Not simulated: Next's HTTP server and CORS.
const admitted = (handler: (request: Request) => Promise<Response>) => async (request: Request) =>
  await guardUserFacingRouteIdentity(new NextRequest(request.url, { method: request.method, headers: request.headers })) ?? await handler(request);
const overview = admitted(overviewRoute), link = admitted(linkRoute), visit = admitted(visitRoute), claim = admitted(claimRoute);
type Actor = { id: string; token: string; email: string };
const installation = () => `fid_${randomBytes(32).toString('hex')}`;

// What the unit tests fake, on the real thing: the digest the routes hand
// PostgREST is the one the SQL guard compares, the claim's identity digests
// reach `claim_referral_visit` as an array, and an operator's decision made
// through the admin service changes what the reconciliation pays.
describe.skipIf(!configPath || !connectionString)('referral abuse guard through actual Auth, PostgREST and SQL', () => {
  let db: Client, admin: SupabaseClient;
  let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  let users: string[], codes: string[], transactions: string[], rateKeys: string[];
  let inviter: Actor, network: string, startedAt: string;

  const makeActor = async (email = `referral-guard-${randomUUID()}@example.invalid`): Promise<Actor> => {
    const password = randomUUID() + 'aZ7!';
    const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(made.error).toBeNull();
    const id = made.data.user!.id; users.push(id);
    const client = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    expect(signed.error).toBeNull();
    return { id, token: signed.data.session!.access_token, email };
  };
  const request = (name: string, body: unknown, actor: Actor | null, extra: Record<string, string> = {}) => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'x-vercel-forwarded-for': network, ...extra });
    if (actor) headers.set('Authorization', `Bearer ${actor.token}`);
    rateKeys.push(getReferralRiskContext(headers).rateLimitKey);
    return new Request(`https://magicbooklet.local/api/referrals/${name}`, {
      method: name === 'me' ? 'GET' : 'POST',
      headers,
      ...(name === 'me' ? {} : { body: JSON.stringify(body) }),
    });
  };
  const makeCode = async (extra: Record<string, string> = {}, actor = inviter) => {
    const response = await link(request('link', {}, actor, extra));
    expect(response.status).toBe(200);
    const body = await response.json(); codes.push(body.code);
    return body.code as string;
  };
  const makeAppVisit = async (code: string, installationId: string) => {
    const response = await visit(request('visit', { code, source: 'mobile', installationId }, null));
    expect(response.status).toBe(200);
    return (await response.json()).visitToken as string;
  };
  const claimAs = async (actor: Actor, visitToken: string) => {
    const response = await claim(request('claim', { visitToken }, actor));
    expect(response.status).toBe(200);
    return await response.json() as { claimed: boolean; reason?: string };
  };
  const attributionOf = async (invitee: Actor) => (await db.query(
    'select id,reward_state,reward_state_reason,reward_state_source,risk_flags from public.referral_attributions where invitee_user_id=$1',
    [invitee.id],
  )).rows[0];
  const promotionalCredits = async (actor: Actor) => (await db.query(
    'select promotional_credits from public.profiles where id=$1', [actor.id],
  )).rows[0]?.promotional_credits;
  const buyStarterPack = async (buyer: Actor) => {
    const id = randomUUID(); transactions.push(id);
    await db.query(
      "insert into public.transactions(id,user_id,razorpay_order_id,amount,credits,status,credit_purchase_succeeded_at) values($1,$2,$3,41500,500,'success',now())",
      [id, buyer.id, 'audit-referral-guard-' + id],
    );
    return id;
  };

  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY);
    vi.stubEnv('REFERRAL_ATTRIBUTION_HASH_SECRET', randomUUID());
    vi.stubEnv('ACCOUNT_IDENTITY_FINGERPRINT_SECRET', randomUUID());
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== new URL(config.API_URL).origin) throw Error('External network forbidden in local referral guard controls');
      return originalFetch(target, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    expect((await db.query("select id from public.referral_programs where status='active'")).rows).toHaveLength(1);
  });
  beforeEach(async () => {
    users = []; codes = []; transactions = []; rateKeys = []; network = 'audit-' + randomUUID();
    startedAt = (await db.query('select now() as now')).rows[0].now.toISOString();
    inviter = await makeActor();
  });
  afterEach(async () => {
    // Only this test's disposable rows. The trails are append-only, so they go
    // in one privileged cleanup transaction with triggers off, as in the other
    // referral suites; never a production path.
    await db.query('begin');
    try {
      await db.query('set local session_replication_role=replica');
      await db.query('delete from public.referral_reward_notification_outbox where ledger_id in (select id from public.referral_credit_ledger where transaction_id=any($1::uuid[]))', [transactions]);
      for (const table of ['referral_credit_ledger', 'referral_reward_adjustments', 'referral_rewards', 'referral_purchase_events']) {
        await db.query(`delete from public.${table} where transaction_id=any($1::uuid[])`, [transactions]);
      }
      await db.query('delete from public.transactions where id=any($1::uuid[])', [transactions]);
      await db.query(`delete from public.referral_review_events where reviewer_id=any($1::uuid[])
        or attribution_id in (select id from public.referral_attributions where inviter_user_id=any($1::uuid[]) or invitee_user_id=any($1::uuid[]))
        or referral_code_id in (select id from public.referral_codes where user_id=any($1::uuid[]) or code=any($2::text[]))`, [users, codes]);
      await db.query('delete from public.referral_attributions where inviter_user_id=any($1::uuid[]) or invitee_user_id=any($1::uuid[])', [users]);
      await db.query('delete from public.referral_visits where inviter_user_id=any($1::uuid[]) or referral_code_id in (select id from public.referral_codes where code=any($2::text[]))', [users, codes]);
      await db.query('delete from public.referral_account_devices where user_id=any($1::uuid[])', [users]);
      await db.query('delete from public.referral_codes where user_id=any($1::uuid[]) or code=any($2::text[])', [users, codes]);
      await db.query('delete from public.deleted_account_identity_fingerprints where first_recorded_at>=$1', [startedAt]);
      await db.query('set local session_replication_role=origin');
      await db.query('delete from auth.users where id=any($1::uuid[])', [users]);
      await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [[...users, ...rateKeys]]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    expect((await db.query(`select
      (select count(*) from auth.users where id=any($1::uuid[]))::int users,
      (select count(*) from public.referral_attributions where inviter_user_id=any($1::uuid[]) or invitee_user_id=any($1::uuid[]))::int attributions,
      (select count(*) from public.referral_account_devices where user_id=any($1::uuid[]))::int devices,
      (select count(*) from public.referral_review_events where reviewer_id=any($1::uuid[]))::int reviews,
      (select count(*) from public.referral_codes where code=any($2::text[]))::int codes,
      (select count(*) from public.transactions where id=any($3::uuid[]))::int transactions`, [users, codes, transactions])).rows)
      .toEqual([{ users: 0, attributions: 0, devices: 0, reviews: 0, codes: 0, transactions: 0 }]);
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('blocks a friend who signs up on the app installation its inviter made the link from', async () => {
    const phone = installation();
    const code = await makeCode({ 'x-magicbooklet-installation-id': phone });
    const visitToken = await makeAppVisit(code, phone);
    const friend = await makeActor();

    // The claimant hears the invite is on hold, never why: the reason is the operator's to see.
    expect(await claimAs(friend, visitToken)).toEqual({ success: true, claimed: true, held: true });
    expect(await attributionOf(friend)).toMatchObject({
      reward_state: 'blocked', reward_state_reason: 'same_device_as_inviter', reward_state_source: 'system',
    });
    expect((await db.query(
      "select action,source,reviewer_id,reason from public.referral_review_events where attribution_id=$1",
      [(await attributionOf(friend)).id],
    )).rows).toEqual([{ action: 'block', source: 'system', reviewer_id: null, reason: 'same_device_as_inviter' }]);

    const blocked = await getAdminReferralOverview(admin, { filter: 'blocked' });
    expect(blocked.referrals.find((referral) => referral.invitee.userId === friend.id)).toMatchObject({
      rewardState: 'blocked',
      rewardStateReason: 'same_device_as_inviter',
      inviter: { userId: inviter.id },
      inviterCode: { enabled: true },
      settledPurchases: 0,
      activeRewardCredits: 0,
    });
  });

  it('keeps a friend on their own installation eligible, and blocks the next friend on it', async () => {
    const code = await makeCode({ 'x-magicbooklet-installation-id': installation() });
    // The friend is somewhere else: another network, another phone.
    network = 'audit-' + randomUUID();
    const friendsPhone = installation();
    const firstVisit = await makeAppVisit(code, friendsPhone);
    // An account must be newer than its visit: the visit first, then the account.
    const eligible = await makeActor();
    expect(await claimAs(eligible, firstVisit)).toMatchObject({ claimed: true });
    expect(await attributionOf(eligible)).toMatchObject({ reward_state: 'eligible', risk_flags: [] });
    expect((await db.query('select count(*)::int as devices from public.referral_account_devices where user_id=$1', [eligible.id])).rows)
      .toEqual([{ devices: 1 }]);

    const secondVisit = await makeAppVisit(code, friendsPhone);
    const second = await makeActor();
    expect(await claimAs(second, secondVisit)).toMatchObject({ claimed: true });
    expect(await attributionOf(second)).toMatchObject({ reward_state: 'blocked', reward_state_reason: 'device_reused_by_invitees' });
  });

  it('gives the inviter’s browser a device cookie and blocks a friend who signs up in that browser', async () => {
    const fromPage = { 'sec-fetch-site': 'same-origin' };
    const dashboard = await overview(request('me', undefined, inviter, fromPage));
    expect(dashboard.status).toBe(200);
    const browser = /__Host-magicbooklet-feed-id=(fid_[a-f0-9]{64})/.exec(dashboard.headers.get('set-cookie') ?? '')?.[1];
    expect(browser).toBeTruthy();
    const code = (await dashboard.json()).code as string; codes.push(code);

    const opened = await visit(request('visit', { code, source: 'web' }, null, {
      ...fromPage, Cookie: `__Host-magicbooklet-feed-id=${browser}`,
    }));
    expect(opened.status).toBe(200);
    // The browser already has its id: it is not given another.
    expect(opened.headers.get('set-cookie')).not.toContain('__Host-magicbooklet-feed-id');
    const visitToken = (await opened.json()).visitToken as string;

    const friend = await makeActor();
    expect(await claimAs(friend, visitToken)).toMatchObject({ claimed: true });
    expect(await attributionOf(friend)).toMatchObject({ reward_state: 'blocked', reward_state_reason: 'same_device_as_inviter' });
  });

  it('flags, and does not block, a friend on the inviter’s network', async () => {
    // Link and visit come from one address (`network`), on two installations.
    const code = await makeCode({ 'x-magicbooklet-installation-id': installation() });
    const visitToken = await makeAppVisit(code, installation());
    const friend = await makeActor();

    expect(await claimAs(friend, visitToken)).toMatchObject({ claimed: true });
    expect(await attributionOf(friend)).toMatchObject({ reward_state: 'eligible', risk_flags: ['same_network'] });
    const flagged = await getAdminReferralOverview(admin, { filter: 'flagged' });
    expect(flagged.referrals.map((referral) => referral.invitee.userId)).toContain(friend.id);
    expect(flagged.stats.flagged).toBeGreaterThanOrEqual(1);
  });

  it('refuses a visit posted from another site and writes nothing', async () => {
    const code = await makeCode();
    const response = await visit(request('visit', { code, source: 'web' }, null, { 'sec-fetch-site': 'cross-site' }));

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await db.query('select id from public.referral_visits where inviter_user_id=$1', [inviter.id])).rows).toEqual([]);
  });

  it('refuses a sign-in whose earlier account was deleted, by the record deletion leaves', async () => {
    const email = `referral-guard-returning-${randomUUID()}@example.invalid`;
    const earlier = await makeActor(email);
    // What the account-deletion flow does right before it deletes the Auth user.
    expect(await recordDeletedAccountIdentityFingerprints(admin, earlier.id)).toEqual({ fingerprintRows: 1 });
    expect((await admin.auth.admin.deleteUser(earlier.id)).error).toBeNull();

    const code = await makeCode();
    const visitToken = await makeAppVisit(code, installation());
    const returning = await makeActor(email);

    expect(await claimAs(returning, visitToken)).toEqual({ success: true, claimed: false, reason: 'existing_account' });
    expect(await attributionOf(returning)).toBeUndefined();
  });

  it('pays nothing for a blocked referral, then pays the top-up it skipped once an operator unblocks it', async () => {
    const phone = installation();
    const code = await makeCode({ 'x-magicbooklet-installation-id': phone });
    const visitToken = await makeAppVisit(code, phone);
    const friend = await makeActor(), reviewer = await makeActor();
    await claimAs(friend, visitToken);
    const attribution = await attributionOf(friend);
    const purchase = await buyStarterPack(friend);

    // The purchase itself is untouched; only the referral side stands still.
    expect(await settleCreditPurchaseReferralRewards({
      adminSupabase: admin, purchaserUserId: friend.id, transactionId: purchase, source: 'razorpay_verify',
    })).toEqual({ status: 'attribution_blocked', purchaserBonusCredits: 0, rewarded: false });
    expect((await db.query('select 1 from public.referral_purchase_events where transaction_id=$1', [purchase])).rows).toEqual([]);
    expect(await hasUnsettledReferralPurchaseTransactions(admin)).toBe(false);
    expect([await promotionalCredits(inviter), await promotionalCredits(friend)]).toEqual([0, 0]);

    expect(await applyReferralReviewAction(admin, {
      action: 'unblock', subjectId: attribution.id, reason: 'Two people, one family phone.', reviewerUserId: reviewer.id,
    })).toEqual({ ok: true, status: 'updated' });
    expect(await attributionOf(friend)).toMatchObject({ reward_state: 'eligible', reward_state_source: 'operator' });

    // The hourly job's own entry point finds the skipped top-up and pays it, once.
    expect(await reconcileReferralPurchaseRewards(admin)).toMatchObject({ processed: 1, settled: 1, failed: 0 });
    expect(await reconcileReferralPurchaseRewards(admin)).toMatchObject({ processed: 0, settled: 0 });
    expect([await promotionalCredits(inviter), await promotionalCredits(friend)]).toEqual([25, 25]);

    const activity = await collectAdminActivity(admin, { pageSize: 200 });
    expect(activity.entries.find((entry) => entry.kind === 'referral-review' && entry.reviewerId === reviewer.id)).toMatchObject({
      action: 'unblocked a referral',
      rationale: 'Two people, one family phone.',
    });
    // The guard's own block is on the trail and off the operators' feed.
    expect(activity.entries.filter((entry) => entry.kind === 'referral-review' && entry.reviewerId === null)).toEqual([]);
  });

  // Review of 2026-11-10: the visit's device is whatever the caller sends, so a
  // visit scripted with none was a way past the guard. The device that claims
  // is checked too, and a sign-up that names none anywhere is held.
  it('blocks a device-less visit claimed on the inviter\u2019s phone, and holds one with no device at all', async () => {
    const phone = installation();
    const code = await makeCode({ 'x-magicbooklet-installation-id': phone });
    const scripted = await visit(request('visit', { code, source: 'web' }, null));
    expect(scripted.status).toBe(200);
    const scriptedToken = (await scripted.json()).visitToken as string;
    expect((await db.query('select device_hash from public.referral_visits where public_token=$1', [scriptedToken])).rows[0].device_hash).toBeNull();

    const friend = await makeActor();
    const claimed = await claim(request('claim', { visitToken: scriptedToken }, friend, { 'x-magicbooklet-installation-id': phone }));
    expect(await claimed.json()).toEqual({ success: true, claimed: true, held: true });
    expect(await attributionOf(friend)).toMatchObject({ reward_state: 'blocked', reward_state_reason: 'same_device_as_inviter' });

    const second = await visit(request('visit', { code, source: 'web' }, null));
    const other = await makeActor();
    expect(await claimAs(other, (await second.json()).visitToken as string)).toEqual({ success: true, claimed: true, held: true });
    expect(await attributionOf(other)).toMatchObject({ reward_state: 'blocked', reward_state_reason: 'no_device' });
  });

  // A switched-off link used to stop new friends only, and every referral it
  // had made kept paying (review of 2026-11-10).
  it('holds the referrals of a switched-off link, tells its owner, and pays once it is back on', async () => {
    const code = await makeCode({ 'x-magicbooklet-installation-id': installation() });
    const visitToken = await makeAppVisit(code, installation());
    const friend = await makeActor(), reviewer = await makeActor();
    expect(await claimAs(friend, visitToken)).toEqual({ success: true, claimed: true });
    const linkId = (await db.query('select id from public.referral_codes where code=$1', [code])).rows[0].id as string;
    const decide = (action: 'disable_link' | 'enable_link') => applyReferralReviewAction(admin, {
      action, subjectId: linkId, reason: 'Repeated self-invites.', reviewerUserId: reviewer.id,
    });

    expect(await decide('disable_link')).toEqual({ ok: true, status: 'updated' });
    const answer = await link(request('link', {}, inviter));
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: 'REFERRAL_LINK_DISABLED' });

    const purchase = await buyStarterPack(friend);
    expect(await settleCreditPurchaseReferralRewards({
      adminSupabase: admin, purchaserUserId: friend.id, transactionId: purchase, source: 'razorpay_verify',
    })).toEqual({ status: 'link_disabled', purchaserBonusCredits: 0, rewarded: false });
    expect(await hasUnsettledReferralPurchaseTransactions(admin)).toBe(false);

    expect(await decide('enable_link')).toEqual({ ok: true, status: 'updated' });
    expect(await reconcileReferralPurchaseRewards(admin)).toMatchObject({ processed: 1, settled: 1, failed: 0 });
    expect([await promotionalCredits(inviter), await promotionalCredits(friend)]).toEqual([25, 25]);
  });

  // A shared post's visit gives way to an invite link opened after it in the
  // same browser; the answer names the invite actually kept.
  it('lets an invite link replace a shared link\u2019s visit, and never the other way round', async () => {
    const sharerCode = await makeCode();
    const friendInviter = await makeActor();
    const inviteCode = await makeCode({}, friendInviter);
    const shared = await visit(request('visit', { code: sharerCode, source: 'web', kind: 'shared_link' }, null));
    const sharedToken = (await shared.json()).visitToken as string;

    const invited = await visit(request('visit', { code: inviteCode, source: 'web' }, null, { cookie: `mb_referral_visit=${sharedToken}` }));
    const invitedBody = await invited.json();
    expect(invitedBody).toMatchObject({ code: inviteCode, preserved: false });
    expect(invitedBody.visitToken).not.toBe(sharedToken);

    const sharedAgain = await visit(request('visit', { code: sharerCode, source: 'web', kind: 'shared_link' }, null, {
      cookie: `mb_referral_visit=${invitedBody.visitToken}`,
    }));
    expect(await sharedAgain.json()).toMatchObject({ code: inviteCode, preserved: true, visitToken: invitedBody.visitToken });
  });

  it('switches an inviter’s link off for new visits, and on again', async () => {
    const code = await makeCode();
    const reviewer = await makeActor();
    const linkId = (await db.query('select id from public.referral_codes where code=$1', [code])).rows[0].id as string;
    const decide = (action: 'disable_link' | 'enable_link') => applyReferralReviewAction(admin, {
      action, subjectId: linkId, reason: 'Repeated self-invites.', reviewerUserId: reviewer.id,
    });

    expect(await decide('disable_link')).toEqual({ ok: true, status: 'updated' });
    expect((await visit(request('visit', { code, source: 'web' }, null))).status).toBe(404);
    // The inviter is shown no link while it is off.
    expect(await (await overview(request('me', undefined, inviter))).json()).toMatchObject({ code: null, shareUrl: null });

    expect(await decide('disable_link')).toEqual({ ok: true, status: 'unchanged' });
    expect(await decide('enable_link')).toEqual({ ok: true, status: 'updated' });
    expect((await visit(request('visit', { code, source: 'web' }, null))).status).toBe(200);
  });
});
