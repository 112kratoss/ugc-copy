import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  applyReferralReviewAction,
  getAdminReferralOverview,
  parseAdminReferralFilter,
} from '@/lib/admin-referrals-service';

type Row = Record<string, unknown>;

const INVITER = '10000000-0000-4000-8000-000000000001';
const FRIEND = '10000000-0000-4000-8000-000000000002';
const SECOND_FRIEND = '10000000-0000-4000-8000-000000000003';
const GONE_INVITER = '10000000-0000-4000-8000-000000000009';
const REVIEWER = '10000000-0000-4000-8000-0000000000aa';

const TABLES: Record<string, Row[]> = {
  referral_codes: [
    { id: 'code-1', user_id: INVITER, is_enabled: true, disabled_reason: null },
    { id: 'code-2', user_id: null, is_enabled: false, disabled_reason: 'account_deleted' },
  ],
  // Newest first, as the service orders them.
  referral_attributions: [
    {
      id: 'attribution-3', inviter_user_id: null, invitee_user_id: SECOND_FRIEND,
      detached_inviter_user_id: GONE_INVITER, detached_invitee_user_id: null,
      attributed_at: '2026-11-03T10:00:00.000Z', reward_state: 'eligible', reward_state_reason: null,
      reward_state_source: 'system', reward_state_changed_at: null, risk_flags: [],
    },
    {
      id: 'attribution-2', inviter_user_id: INVITER, invitee_user_id: SECOND_FRIEND,
      detached_inviter_user_id: null, detached_invitee_user_id: null,
      attributed_at: '2026-11-02T10:00:00.000Z', reward_state: 'blocked', reward_state_reason: 'same_device_as_inviter',
      reward_state_source: 'system', reward_state_changed_at: '2026-11-02T10:00:00.000Z', risk_flags: [],
    },
    {
      id: 'attribution-1', inviter_user_id: INVITER, invitee_user_id: FRIEND,
      detached_inviter_user_id: null, detached_invitee_user_id: null,
      attributed_at: '2026-11-01T10:00:00.000Z', reward_state: 'eligible', reward_state_reason: null,
      reward_state_source: 'system', reward_state_changed_at: null, risk_flags: ['same_network'],
    },
  ],
  profiles: [
    { id: INVITER, username: 'inviter', display_name: 'The Inviter' },
    { id: FRIEND, username: 'friend', display_name: null },
    { id: SECOND_FRIEND, username: null, display_name: null },
  ],
  referral_purchase_events: [
    { attribution_id: 'attribution-1' },
    { attribution_id: 'attribution-1' },
  ],
  referral_rewards: [
    { attribution_id: 'attribution-1', active_credits: 25 },
    { attribution_id: 'attribution-1', active_credits: 25 },
    { attribution_id: 'attribution-1', active_credits: 100 },
  ],
};

/** An in-memory PostgREST: enough of the builder for the service's reads. */
function client(tables: Record<string, Row[]> = TABLES, failing: string | null = null) {
  const reads: string[] = [];
  const from = (table: string) => {
    let selected = (tables[table] ?? []).slice();
    let head = false;
    let counted = false;
    let window: [number, number] | null = null;
    let cap: number | null = null;
    const builder = {
      select(_columns: string, options?: { count?: string; head?: boolean }) {
        head = options?.head === true;
        counted = options?.count === 'exact';
        reads.push(`${table}${head ? ':count' : ''}`);
        return builder;
      },
      eq(column: string, value: unknown) {
        reads.push(`${table}.${column}=${String(value)}`);
        selected = selected.filter((row) => row[column] === value);
        return builder;
      },
      neq(column: string, value: unknown) {
        reads.push(`${table}.${column}!=${String(value)}`);
        // The one use: `risk_flags` is not the empty array.
        selected = selected.filter((row) => (Array.isArray(row[column]) ? row[column].length > 0 : row[column] !== value));
        return builder;
      },
      in(column: string, values: unknown[]) {
        selected = selected.filter((row) => values.includes(row[column]));
        return builder;
      },
      order() { return builder; },
      range(start: number, end: number) { window = [start, end]; return builder; },
      limit(count: number) { cap = count; return builder; },
      then<T>(resolve: (value: unknown) => T) {
        if (failing === table) {
          return Promise.resolve({ data: null, error: new Error(`${table} unavailable`), count: null, status: 500 }).then(resolve);
        }
        const total = selected.length;
        let data = window ? selected.slice(window[0], window[1] + 1) : selected;
        if (cap !== null) data = data.slice(0, cap);
        return Promise.resolve({
          data: head ? null : data,
          error: null,
          count: counted ? total : null,
          status: 200,
        }).then(resolve);
      },
    };
    return builder;
  };
  return { reads, supabase: { from } as unknown as SupabaseClient };
}

describe('the admin referrals overview', () => {
  it('counts links and referrals, blocked and flagged', async () => {
    const overview = await getAdminReferralOverview(client().supabase);

    expect(overview.stats).toEqual({ inviteLinks: 2, disabledLinks: 1, referrals: 3, blocked: 1, flagged: 1 });
    expect(overview).toMatchObject({ filter: 'all', total: 3, offset: 0, pageSize: 25, detailTruncated: false });
  });

  it('joins each referral to its two accounts, its inviter’s link and what it has paid', async () => {
    const overview = await getAdminReferralOverview(client().supabase);

    expect(overview.referrals.map((referral) => referral.id)).toEqual(['attribution-3', 'attribution-2', 'attribution-1']);
    expect(overview.referrals[2]).toEqual({
      id: 'attribution-1',
      attributedAt: '2026-11-01T10:00:00.000Z',
      rewardState: 'eligible',
      rewardStateReason: null,
      rewardStateSource: 'system',
      rewardStateChangedAt: null,
      riskFlags: ['same_network'],
      inviter: { userId: INVITER, detachedUserId: null, username: 'inviter', displayName: 'The Inviter' },
      invitee: { userId: FRIEND, detachedUserId: null, username: 'friend', displayName: null },
      settledPurchases: 2,
      activeRewardCredits: 150,
      inviterCode: { id: 'code-1', enabled: true, disabledReason: null },
    });
  });

  it('shows a blocked referral with the guard’s reason and nothing paid', async () => {
    const overview = await getAdminReferralOverview(client().supabase);

    expect(overview.referrals[1]).toMatchObject({
      rewardState: 'blocked',
      rewardStateReason: 'same_device_as_inviter',
      rewardStateSource: 'system',
      rewardStateChangedAt: '2026-11-02T10:00:00.000Z',
      settledPurchases: 0,
      activeRewardCredits: 0,
    });
  });

  it('keeps the id a deleted inviter had, and offers no link to switch', async () => {
    const overview = await getAdminReferralOverview(client().supabase);

    expect(overview.referrals[0]).toMatchObject({
      inviter: { userId: null, detachedUserId: GONE_INVITER, username: null, displayName: null },
      inviterCode: null,
    });
  });

  it.each([
    ['blocked', ['attribution-2'], 'referral_attributions.reward_state=blocked'],
    ['flagged', ['attribution-1'], 'referral_attributions.risk_flags!={}'],
  ] as const)('narrows to the %s referrals', async (filter, ids, read) => {
    const { supabase, reads } = client();
    const overview = await getAdminReferralOverview(supabase, { filter });

    expect(overview.referrals.map((referral) => referral.id)).toEqual(ids);
    expect(overview.total).toBe(1);
    // The filter is asked of the database, twice: once for its stat, once for the page.
    expect(reads.filter((entry) => entry === read)).toHaveLength(2);
    // The stats stay whole whatever the page shows.
    expect(overview.stats.referrals).toBe(3);
  });

  it('reads no accounts, links, purchases or rewards for an empty page', async () => {
    const { supabase, reads } = client({ ...TABLES, referral_attributions: [] });
    const overview = await getAdminReferralOverview(supabase);

    expect(overview.referrals).toEqual([]);
    expect(reads.filter((entry) => ['profiles', 'referral_purchase_events', 'referral_rewards'].includes(entry))).toEqual([]);
  });

  it.each(['profiles', 'referral_codes', 'referral_purchase_events', 'referral_rewards', 'referral_attributions'])(
    'throws when %s cannot be read, rather than showing a partial page as whole',
    async (table) => {
      await expect(getAdminReferralOverview(client(TABLES, table).supabase)).rejects.toThrow(`${table} unavailable`);
    },
  );

  it('reads any filter it does not know as all', () => {
    expect(parseAdminReferralFilter('blocked')).toBe('blocked');
    expect(parseAdminReferralFilter('flagged')).toBe('flagged');
    expect(parseAdminReferralFilter('eligible')).toBe('all');
    expect(parseAdminReferralFilter(undefined)).toBe('all');
  });
});

describe('an operator’s referral decision', () => {
  const rpcClient = (data: unknown, error: unknown = null) => {
    const rpc = vi.fn(async () => ({ data, error }));
    return { rpc, supabase: { rpc } as unknown as SupabaseClient };
  };
  const decision = (action: 'block' | 'unblock' | 'disable_link' | 'enable_link') => ({
    action,
    subjectId: 'subject-1',
    reason: 'Two accounts, one person.',
    reviewerUserId: REVIEWER,
  });

  it.each([
    ['block', 'blocked'],
    ['unblock', 'eligible'],
  ] as const)('sends a %s to the referral’s reward state, with reason and reviewer', async (action, state) => {
    const { rpc, supabase } = rpcClient({ status: 'updated', reward_state: state });

    await expect(applyReferralReviewAction(supabase, decision(action))).resolves.toEqual({ ok: true, status: 'updated' });
    expect(rpc).toHaveBeenCalledWith('set_referral_attribution_reward_state', {
      p_attribution_id: 'subject-1',
      p_reward_state: state,
      p_reason: 'Two accounts, one person.',
      p_reviewer_id: REVIEWER,
    });
  });

  it.each([
    ['disable_link', false],
    ['enable_link', true],
  ] as const)('sends a %s to the inviter’s link', async (action, enabled) => {
    const { rpc, supabase } = rpcClient({ status: 'updated', enabled });

    await expect(applyReferralReviewAction(supabase, decision(action))).resolves.toEqual({ ok: true, status: 'updated' });
    expect(rpc).toHaveBeenCalledWith('set_referral_code_enabled', {
      p_referral_code_id: 'subject-1',
      p_enabled: enabled,
      p_reason: 'Two accounts, one person.',
      p_reviewer_id: REVIEWER,
    });
  });

  it('answers a repeated decision as unchanged, not as an error', async () => {
    await expect(applyReferralReviewAction(rpcClient({ status: 'unchanged' }).supabase, decision('block')))
      .resolves.toEqual({ ok: true, status: 'unchanged' });
  });

  it.each([
    [{ status: 'not_found' }, 'not_found', 'That referral or invite link no longer exists.'],
    [{ status: 'account_deleted' }, 'account_deleted', 'The inviter deleted their account; the link stays off.'],
    [{ status: 'invalid', error: 'a reason of 3 to 1000 characters is required' }, 'invalid', 'a reason of 3 to 1000 characters is required'],
    [{ status: 'invalid' }, 'invalid', 'The decision was refused.'],
  ] as const)('explains a refusal: %j', async (data, code, error) => {
    await expect(applyReferralReviewAction(rpcClient(data).supabase, decision('disable_link')))
      .resolves.toEqual({ ok: false, code, error });
  });

  it('throws on a database error or an answer it does not know, so nothing reads as decided', async () => {
    await expect(applyReferralReviewAction(rpcClient(null, new Error('connection reset')).supabase, decision('block')))
      .rejects.toThrow('connection reset');
    await expect(applyReferralReviewAction(rpcClient({ status: 'maybe' }).supabase, decision('block')))
      .rejects.toThrow('unknown status: maybe');
    await expect(applyReferralReviewAction(rpcClient('ok').supabase, decision('block')))
      .rejects.toThrow('invalid response');
  });
});
