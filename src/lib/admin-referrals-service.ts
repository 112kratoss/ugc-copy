import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { runPagedQuery } from '@/lib/admin-paged-query';

/**
 * Read model for the admin Referrals page: who invited whom, whether the
 * referral may pay, what the abuse guard saw, and what it has paid so far.
 *
 * Runs on the service-role client, like every admin read; the boundary is
 * `admin-auth.ts`. The referral tables point at `auth.users`, not at profiles,
 * so names are read in a second query and joined here.
 */

export const ADMIN_REFERRALS_PAGE_SIZE = 25;

/** A page's purchase events and rewards are read whole, up to this many rows. */
const DETAIL_ROW_LIMIT = 2000;

export type AdminReferralFilter = 'all' | 'blocked' | 'flagged';

export type AdminReferralParty = {
  /** Null once the account is deleted. */
  userId: string | null;
  /** The account's id as it was, kept by the referral history. */
  detachedUserId: string | null;
  username: string | null;
  displayName: string | null;
};

export type AdminReferralRow = {
  id: string;
  attributedAt: string;
  rewardState: 'eligible' | 'blocked';
  rewardStateReason: string | null;
  rewardStateSource: 'system' | 'operator';
  rewardStateChangedAt: string | null;
  riskFlags: string[];
  inviter: AdminReferralParty;
  invitee: AdminReferralParty;
  /** Top-ups of the friend that settled a reward. */
  settledPurchases: number;
  /** Credits the referral has paid, both sides, net of reversals. */
  activeRewardCredits: number;
  /** The inviter's link, when the inviter still has an account. */
  inviterCode: { id: string; enabled: boolean; disabledReason: string | null } | null;
};

export type AdminReferralOverview = {
  stats: {
    inviteLinks: number;
    disabledLinks: number;
    referrals: number;
    blocked: number;
    flagged: number;
  };
  filter: AdminReferralFilter;
  referrals: AdminReferralRow[];
  total: number;
  offset: number;
  pageSize: number;
  /** A page's purchases or rewards hit the read limit, so its totals are a floor. */
  detailTruncated: boolean;
};

export function parseAdminReferralFilter(value: string | undefined): AdminReferralFilter {
  return value === 'blocked' || value === 'flagged' ? value : 'all';
}

function rows(result: { data: unknown; error: unknown }): Array<Record<string, unknown>> {
  if (result.error) throw result.error;
  return (result.data ?? []) as Array<Record<string, unknown>>;
}

/** A failed count is unknown, not zero. */
async function countOf(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

const NO_ROWS = { data: [], error: null };

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export async function getAdminReferralOverview(
  client: SupabaseClient,
  options: { filter?: AdminReferralFilter; offset?: number } = {},
): Promise<AdminReferralOverview> {
  const filter = options.filter ?? 'all';
  const requestedOffset = Number.isInteger(options.offset) && (options.offset ?? 0) > 0 ? options.offset! : 0;

  const head = { count: 'exact', head: true } as const;
  const [inviteLinks, disabledLinks, referrals, blocked, flagged, page] = await Promise.all([
    countOf(client.from('referral_codes').select('*', head)),
    countOf(client.from('referral_codes').select('*', head).eq('is_enabled', false)),
    countOf(client.from('referral_attributions').select('*', head)),
    countOf(client.from('referral_attributions').select('*', head).eq('reward_state', 'blocked')),
    countOf(client.from('referral_attributions').select('*', head).neq('risk_flags', '{}')),
    runPagedQuery<Record<string, unknown>>(
      (from, to) => {
        const query = client
          .from('referral_attributions')
          .select(
            'id, inviter_user_id, invitee_user_id, detached_inviter_user_id, detached_invitee_user_id, attributed_at, reward_state, reward_state_reason, reward_state_source, reward_state_changed_at, risk_flags',
            { count: 'exact' },
          )
          .order('attributed_at', { ascending: false })
          // `attributed_at` is not unique: without a tiebreaker a row can sit on
          // two pages, or on neither.
          .order('id', { ascending: false })
          .range(from, to);
        if (filter === 'blocked') return query.eq('reward_state', 'blocked');
        if (filter === 'flagged') return query.neq('risk_flags', '{}');
        return query;
      },
      { offset: requestedOffset, pageSize: ADMIN_REFERRALS_PAGE_SIZE },
    ),
  ]);

  const attributionIds = page.rows.map((row) => String(row.id));
  const userIds = [...new Set(page.rows.flatMap((row) => [
    stringOrNull(row.inviter_user_id),
    stringOrNull(row.invitee_user_id),
  ]).filter((id): id is string => id !== null))];
  const inviterIds = [...new Set(page.rows
    .map((row) => stringOrNull(row.inviter_user_id))
    .filter((id): id is string => id !== null))];

  const [profileResult, codeResult, purchaseResult, rewardResult] = await Promise.all([
    userIds.length === 0
      ? NO_ROWS
      : client.from('profiles').select('id, username, display_name').in('id', userIds),
    inviterIds.length === 0
      ? NO_ROWS
      : client.from('referral_codes').select('id, user_id, is_enabled, disabled_reason').in('user_id', inviterIds),
    attributionIds.length === 0
      ? NO_ROWS
      : client
          .from('referral_purchase_events')
          .select('attribution_id')
          .in('attribution_id', attributionIds)
          .limit(DETAIL_ROW_LIMIT),
    attributionIds.length === 0
      ? NO_ROWS
      : client
          .from('referral_rewards')
          .select('attribution_id, active_credits')
          .in('attribution_id', attributionIds)
          .limit(DETAIL_ROW_LIMIT),
  ]);
  // A failed read is unknown support data, not an empty history.
  const profileRows = rows(profileResult);
  const codeRows = rows(codeResult);
  const purchaseRows = rows(purchaseResult);
  const rewardRows = rows(rewardResult);

  const profiles = new Map(profileRows.map((row) => [String(row.id), row]));
  const codes = new Map(codeRows.map((row) => [String(row.user_id), row]));
  const purchases = new Map<string, number>();
  for (const row of purchaseRows) {
    const id = String(row.attribution_id);
    purchases.set(id, (purchases.get(id) ?? 0) + 1);
  }
  const rewardCredits = new Map<string, number>();
  for (const row of rewardRows) {
    const id = String(row.attribution_id);
    rewardCredits.set(id, (rewardCredits.get(id) ?? 0) + Number(row.active_credits ?? 0));
  }

  const party = (userId: string | null, detachedUserId: string | null): AdminReferralParty => {
    const profile = userId ? profiles.get(userId) : undefined;
    return {
      userId,
      detachedUserId,
      username: stringOrNull(profile?.username),
      displayName: stringOrNull(profile?.display_name),
    };
  };

  return {
    stats: { inviteLinks, disabledLinks, referrals, blocked, flagged },
    filter,
    referrals: page.rows.map((row) => {
      const id = String(row.id);
      const inviterUserId = stringOrNull(row.inviter_user_id);
      const code = inviterUserId ? codes.get(inviterUserId) : undefined;
      return {
        id,
        attributedAt: String(row.attributed_at ?? ''),
        rewardState: row.reward_state === 'blocked' ? 'blocked' : 'eligible',
        rewardStateReason: stringOrNull(row.reward_state_reason),
        rewardStateSource: row.reward_state_source === 'operator' ? 'operator' : 'system',
        rewardStateChangedAt: stringOrNull(row.reward_state_changed_at),
        riskFlags: Array.isArray(row.risk_flags)
          ? row.risk_flags.filter((flag): flag is string => typeof flag === 'string')
          : [],
        inviter: party(inviterUserId, stringOrNull(row.detached_inviter_user_id)),
        invitee: party(stringOrNull(row.invitee_user_id), stringOrNull(row.detached_invitee_user_id)),
        settledPurchases: purchases.get(id) ?? 0,
        activeRewardCredits: rewardCredits.get(id) ?? 0,
        inviterCode: code
          ? {
              id: String(code.id),
              enabled: code.is_enabled === true,
              disabledReason: stringOrNull(code.disabled_reason),
            }
          : null,
      };
    }),
    total: page.total,
    offset: page.offset,
    pageSize: ADMIN_REFERRALS_PAGE_SIZE,
    detailTruncated: purchaseRows.length >= DETAIL_ROW_LIMIT || rewardRows.length >= DETAIL_ROW_LIMIT,
  };
}

export type ReferralReviewAction = 'block' | 'unblock' | 'disable_link' | 'enable_link';

export type ReferralReviewResult =
  | { ok: true; status: 'updated' | 'unchanged' }
  | { ok: false; code: 'invalid' | 'not_found' | 'account_deleted'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * One operator decision: whether a referral may pay, or whether an inviter's
 * link takes new friends. Both go through a database function that writes the
 * `referral_review_events` trail in the same transaction, so there is no
 * decision without its reason and reviewer.
 *
 * Unblocking pays nothing by itself: the purchases a blocked referral skipped
 * have no purchase event, so the hourly `referral-reward-reconciliation` job
 * finds and settles them.
 */
export async function applyReferralReviewAction(
  client: SupabaseClient,
  input: {
    action: ReferralReviewAction;
    subjectId: string;
    reason: string;
    reviewerUserId: string;
  },
): Promise<ReferralReviewResult> {
  const { data, error } = input.action === 'block' || input.action === 'unblock'
    ? await client.rpc('set_referral_attribution_reward_state', {
        p_attribution_id: input.subjectId,
        p_reward_state: input.action === 'block' ? 'blocked' : 'eligible',
        p_reason: input.reason,
        p_reviewer_id: input.reviewerUserId,
      })
    : await client.rpc('set_referral_code_enabled', {
        p_referral_code_id: input.subjectId,
        p_enabled: input.action === 'enable_link',
        p_reason: input.reason,
        p_reviewer_id: input.reviewerUserId,
      });
  if (error) throw error;
  if (!isRecord(data) || typeof data.status !== 'string') {
    throw new Error('Referral review RPC returned an invalid response');
  }

  switch (data.status) {
    case 'updated':
    case 'unchanged':
      return { ok: true, status: data.status };
    case 'not_found':
      return { ok: false, code: 'not_found', error: 'That referral or invite link no longer exists.' };
    case 'account_deleted':
      return { ok: false, code: 'account_deleted', error: 'The inviter deleted their account; the link stays off.' };
    case 'invalid':
      return {
        ok: false,
        code: 'invalid',
        error: typeof data.error === 'string' ? data.error : 'The decision was refused.',
      };
    default:
      throw new Error(`Referral review RPC returned an unknown status: ${data.status}`);
  }
}
