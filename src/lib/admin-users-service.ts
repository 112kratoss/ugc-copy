import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { readLinkedAccountIds } from '@/lib/account-identity';
import {
  CREDIT_HISTORY_MAX_LIMIT,
  decodeCreditHistoryCursor,
  listCreditHistory,
  type CreditHistoryCursor,
} from '@/lib/credit-history-service';

/**
 * Read models for the admin Users & credits area.
 *
 * Every query here runs on the service-role client and therefore bypasses RLS.
 * That is intentional — support work needs to see across users — but it means
 * the security boundary is `admin-auth.ts`, not Postgres. Keep these functions
 * free of caller-supplied SQL and scope every lookup to an explicit id.
 */

const MAX_SEARCH_LIMIT = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type AdminUserSummary = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  credits: number;
  promotionalCredits: number;
  createdAt: string | null;
};

export type AdminUserDetail = {
  profile: AdminUserSummary & {
    bio: string | null;
    location: string | null;
    websiteUrl: string | null;
  };
  email: string | null;
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
  /** `guest` is an anonymous identity (auth.users.is_anonymous), linked or not. */
  accountKind: 'registered' | 'guest';
  /** The account a linked guest now belongs to (`profiles.merged_into_user_id`). */
  linkedToUserId: string | null;
  counts: {
    generations: number;
    posts: number;
    followers: number;
    following: number;
    openReportsAgainst: number;
  };
  spend: {
    /**
     * Credits spent, net of refunds, over everything the person's own Credit
     * history lists as spending: generations (deleted ones too), the prompt
     * enhancer, reservations and credit unlocks, across the guests linked to
     * the account.
     */
    lifetimeCreditsSpent: number;
    /** False when the history was longer than the pages read: the figure is then a lower bound. */
    lifetimeCreditsSpentComplete: boolean;
    generationsLast30Days: number;
  };
  purchases: Array<{
    id: string;
    kind: 'razorpay' | 'mobile-iap';
    status: string;
    amountSubunits: number | null;
    /**
     * Carried per row rather than assumed. Mobile store transactions record
     * their own currency, so rendering every amount as INR misstates any
     * non-INR purchase.
     */
    currency: string;
    credits: number | null;
    createdAt: string;
    reference: string | null;
  }>;
  creditGrants: Array<{
    id: string;
    programKey: string;
    amount: number;
    promotionalAmount: number;
    sourceSurface: string;
    claimedAt: string;
  }>;
  wallet: {
    availableTokenSubunits: number;
    lifetimeEarnedTokenSubunits: number;
    lifetimeRefundedTokenSubunits: number;
  } | null;
  recentGenerations: Array<{
    id: string;
    status: string;
    model: string | null;
    cost: number | null;
    createdAt: string;
    errorMessage: string | null;
    /** Set when an operator removed it; the creator cannot undo that. */
    moderationRemovedAt: string | null;
  }>;
};

function normalizeSearchLimit(limit: number | undefined) {
  if (!limit || !Number.isInteger(limit) || limit < 1) return 25;
  return Math.min(limit, MAX_SEARCH_LIMIT);
}

function normalizeOffset(offset: number | undefined) {
  if (!offset || !Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}

/** At most this many credit-history pages (50 entries each) are read for the spend figure. */
export const LIFETIME_SPEND_MAX_HISTORY_PAGES = 20;

/**
 * Lifetime spend from `list_credit_history`, the ledger the person's own Credit
 * history page reads, so the two always agree. Spending and its refunds are
 * summed; purchases, grants, reversals and operator adjustments are not
 * spending. Reads newest first and stops after a bounded number of pages, so a
 * very long history gives a lower bound, said as such, rather than a slow page.
 */
async function readLifetimeCreditsSpent(
  client: SupabaseClient,
  userId: string,
): Promise<{ credits: number; complete: boolean }> {
  const userIds = await readLinkedAccountIds(client, userId);
  // "Only the account's own rows" would understate the figure, so an unreadable
  // identity set fails the page like every other read here.
  if (!userIds) throw new Error('Could not read the identities linked to this account.');

  let net = 0;
  let cursor: CreditHistoryCursor | null = null;
  for (let page = 0; page < LIFETIME_SPEND_MAX_HISTORY_PAGES; page += 1) {
    const result = await listCreditHistory({ client, userIds, cursor, limit: CREDIT_HISTORY_MAX_LIMIT });
    for (const entry of result.entries) {
      if (entry.kind === 'spend' || entry.kind === 'refund') net += entry.amount;
    }
    if (!result.nextCursor) return { credits: Math.max(0, -net), complete: true };
    cursor = decodeCreditHistoryCursor(result.nextCursor);
    if (!cursor) throw new Error('list_credit_history returned a cursor this build cannot read.');
  }
  return { credits: Math.max(0, -net), complete: false };
}

/**
 * Which identities the list shows. Most profiles are guests the app signs in on
 * a first launch, a reinstall or a sign-out, so the list opens on registered
 * accounts; `guests` covers linked and unlinked ones alike.
 */
export const ADMIN_USER_KINDS = ['registered', 'guests', 'all'] as const;
export type AdminUserKind = (typeof ADMIN_USER_KINDS)[number];

export type AdminUserListRow = AdminUserSummary & {
  /** An anonymous identity (auth.users.is_anonymous), not an account. */
  isGuest: boolean;
  /** The account a linked guest now belongs to (`profiles.merged_into_user_id`). */
  linkedToUserId: string | null;
};

export type AdminUserSearchResult = {
  users: AdminUserListRow[];
  /** Matches across every page, not just this one. */
  total: number;
  /** The window actually returned: the first page when the offset was past the end. */
  offset: number;
  /** The kind the list was read with, the default resolved. */
  kind: AdminUserKind;
};

/**
 * Lists identities through `admin_search_users`, which reads
 * auth.users.is_anonymous (PostgREST does not expose it) and escapes the term's
 * LIKE wildcards. Without a kind, a search covers every kind, so an id copied
 * from a report finds its guest; the bare list shows registered accounts.
 */
export async function searchAdminUsers(
  client: SupabaseClient,
  options: { term?: string; kind?: AdminUserKind; limit?: number; offset?: number } = {},
): Promise<AdminUserSearchResult> {
  const limit = normalizeSearchLimit(options.limit);
  const term = (options.term ?? '').trim().slice(0, 64);
  const kind = options.kind ?? (term ? 'all' : 'registered');

  const read = async (offset: number) => {
    const { data, error } = await client.rpc('admin_search_users', {
      p_term: term || null,
      p_kind: kind,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) throw error;
    return (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  };

  let offset = normalizeOffset(options.offset);
  let rows = await read(offset);
  // A page past the end comes back empty; show the first page and its total,
  // as every other paged admin list does (runPagedQuery).
  if (rows.length === 0 && offset > 0) {
    offset = 0;
    rows = await read(0);
  }

  const users = rows.map((row) => ({
    id: row.id as string,
    username: (row.username as string | null) ?? null,
    displayName: (row.display_name as string | null) ?? null,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    credits: (row.credits as number | null) ?? 0,
    promotionalCredits: (row.promotional_credits as number | null) ?? 0,
    createdAt: (row.created_at as string | null) ?? null,
    isGuest: row.is_guest === true,
    linkedToUserId: (row.merged_into_user_id as string | null) ?? null,
  }));

  return { users, total: rows.length > 0 ? Number(rows[0].total_count ?? rows.length) : 0, offset, kind };
}

async function countRows(
  client: SupabaseClient,
  table: string,
  column: string,
  userId: string,
): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(column, userId);
  if (error) throw error;
  return count ?? 0;
}

export async function getAdminUserDetail(
  client: SupabaseClient,
  userId: string,
): Promise<AdminUserDetail | null> {
  if (!UUID_PATTERN.test(userId)) {
    throw new Error('User id must be a UUID.');
  }

  const profileResult = await client
    .from('profiles')
    .select('id, username, display_name, avatar_url, credits, promotional_credits, created_at, bio, location, website_url, merged_into_user_id')
    .eq('id', userId)
    .maybeSingle();
  if (profileResult.error) throw profileResult.error;
  if (!profileResult.data) return null;

  const profile = profileResult.data;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    authUser,
    generationsCount,
    postsCount,
    followersCount,
    followingCount,
    openReportsCount,
    recentGenerationsCount,
    lifetimeSpend,
    transactionsResult,
    mobileTransactionsResult,
    grantsResult,
    walletResult,
    recentGenerationsResult,
  ] = await Promise.all([
    client.auth.admin.getUserById(userId),
    countRows(client, 'generations', 'user_id', userId),
    countRows(client, 'posts', 'user_id', userId),
    countRows(client, 'follows', 'following_id', userId),
    countRows(client, 'follows', 'follower_id', userId),
    client
      .from('moderation_reports')
      .select('id', { count: 'exact', head: true })
      .eq('reported_user_id', userId)
      .in('status', ['open', 'reviewing']),
    client
      .from('generations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', thirtyDaysAgo),
    // Not get_user_ai_usage_cost_total: that sums ai_usage_events alone, the
    // prompt enhancer's charges, and left every generation out of the figure.
    readLifetimeCreditsSpent(client, userId),
    client
      .from('transactions')
      .select('id, status, amount, credits, created_at, razorpay_payment_id')
      .eq('user_id', userId)
      // A mobile IAP writes BOTH a mobile_store_transactions row and a
      // mirrored transactions ledger row (linked by source_record_id). Without
      // this filter the same purchase appears twice in a user's history, and
      // the ledger copy is mislabelled as a web Razorpay payment.
      .is('mobile_product_id', null)
      .order('created_at', { ascending: false })
      .limit(25),
    client
      .from('mobile_store_transactions')
      .select('id, status, amount_subunits, currency, credits, created_at, product_id, provider')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(25),
    client
      .from('credit_grants')
      .select('id, program_key, amount, promotional_amount, source_surface, claimed_at')
      .eq('user_id', userId)
      .order('claimed_at', { ascending: false })
      .limit(25),
    client
      .from('creator_resource_wallets')
      .select('available_token_subunits, lifetime_earned_token_subunits, lifetime_refunded_token_subunits')
      .eq('user_id', userId)
      .maybeSingle(),
    client
      .from('generations')
      .select('id, status, model, cost, created_at, error_message, moderation_removed_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(15),
  ]);

  // A failed read is unknown support data, not an empty history or zero money.
  for (const result of [
    authUser, openReportsCount, recentGenerationsCount,
    transactionsResult, mobileTransactionsResult, grantsResult, walletResult,
    recentGenerationsResult,
  ]) {
    if (result.error) throw result.error;
  }

  const purchases: AdminUserDetail['purchases'] = [
    ...((transactionsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      kind: 'razorpay' as const,
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount === 'number' ? row.amount : null,
      // Web credit purchases are Razorpay, which this product bills in INR.
      currency: 'INR',
      credits: typeof row.credits === 'number' ? row.credits : null,
      createdAt: String(row.created_at ?? ''),
      reference: (row.razorpay_payment_id as string | null) ?? null,
    })),
    ...((mobileTransactionsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      kind: 'mobile-iap' as const,
      status: String(row.status ?? ''),
      amountSubunits: typeof row.amount_subunits === 'number' ? row.amount_subunits : null,
      currency: typeof row.currency === 'string' && row.currency ? row.currency : 'INR',
      credits: typeof row.credits === 'number' ? row.credits : null,
      createdAt: String(row.created_at ?? ''),
      reference: (row.product_id as string | null) ?? null,
    })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 30);

  const walletRow = walletResult.data as Record<string, unknown> | null;

  return {
    profile: {
      id: profile.id as string,
      username: (profile.username as string | null) ?? null,
      displayName: (profile.display_name as string | null) ?? null,
      avatarUrl: (profile.avatar_url as string | null) ?? null,
      credits: (profile.credits as number | null) ?? 0,
      promotionalCredits: (profile.promotional_credits as number | null) ?? 0,
      createdAt: (profile.created_at as string | null) ?? null,
      bio: (profile.bio as string | null) ?? null,
      location: (profile.location as string | null) ?? null,
      websiteUrl: (profile.website_url as string | null) ?? null,
    },
    email: authUser?.data?.user?.email ?? null,
    lastSignInAt: authUser?.data?.user?.last_sign_in_at ?? null,
    emailConfirmedAt: authUser?.data?.user?.email_confirmed_at ?? null,
    accountKind: authUser?.data?.user?.is_anonymous === true ? 'guest' : 'registered',
    linkedToUserId: (profile.merged_into_user_id as string | null) ?? null,
    counts: {
      generations: generationsCount,
      posts: postsCount,
      followers: followersCount,
      following: followingCount,
      openReportsAgainst: openReportsCount.count ?? 0,
    },
    spend: {
      lifetimeCreditsSpent: lifetimeSpend.credits,
      lifetimeCreditsSpentComplete: lifetimeSpend.complete,
      generationsLast30Days: recentGenerationsCount.count ?? 0,
    },
    purchases,
    creditGrants: ((grantsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      programKey: String(row.program_key ?? ''),
      amount: Number(row.amount ?? 0),
      promotionalAmount: Number(row.promotional_amount ?? 0),
      sourceSurface: String(row.source_surface ?? ''),
      claimedAt: String(row.claimed_at ?? ''),
    })),
    wallet: walletRow
      ? {
          availableTokenSubunits: Number(walletRow.available_token_subunits ?? 0),
          lifetimeEarnedTokenSubunits: Number(walletRow.lifetime_earned_token_subunits ?? 0),
          lifetimeRefundedTokenSubunits: Number(walletRow.lifetime_refunded_token_subunits ?? 0),
        }
      : null,
    recentGenerations: ((recentGenerationsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      status: String(row.status ?? ''),
      model: (row.model as string | null) ?? null,
      cost: typeof row.cost === 'number' ? row.cost : null,
      createdAt: String(row.created_at ?? ''),
      errorMessage: (row.error_message as string | null) ?? null,
      moderationRemovedAt: (row.moderation_removed_at as string | null) ?? null,
    })),
  };
}
