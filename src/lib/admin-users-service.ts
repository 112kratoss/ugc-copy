import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

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
  counts: {
    generations: number;
    posts: number;
    followers: number;
    following: number;
    openReportsAgainst: number;
  };
  spend: {
    lifetimeCreditsSpent: number;
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
  }>;
};

function normalizeSearchLimit(limit: number | undefined) {
  if (!limit || !Number.isInteger(limit) || limit < 1) return 25;
  return Math.min(limit, MAX_SEARCH_LIMIT);
}

/**
 * PostgREST `or=` takes a comma-separated filter list, so a raw comma, parenthesis
 * or wildcard in the search term would change the filter's shape. Stripping the
 * structural characters keeps the term a value rather than syntax.
 */
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()*\\]/g, '').trim().slice(0, 64);
}

export async function searchAdminUsers(
  client: SupabaseClient,
  options: { term?: string; limit?: number } = {},
): Promise<AdminUserSummary[]> {
  const limit = normalizeSearchLimit(options.limit);
  const term = sanitizeSearchTerm(options.term ?? '');

  let query = client
    .from('profiles')
    .select('id, username, display_name, avatar_url, credits, promotional_credits, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (term) {
    query = UUID_PATTERN.test(term)
      ? query.eq('id', term)
      : query.or(`username.ilike.%${term}%,display_name.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id as string,
    username: (row.username as string | null) ?? null,
    displayName: (row.display_name as string | null) ?? null,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    credits: (row.credits as number | null) ?? 0,
    promotionalCredits: (row.promotional_credits as number | null) ?? 0,
    createdAt: (row.created_at as string | null) ?? null,
  }));
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
    .select('id, username, display_name, avatar_url, credits, promotional_credits, created_at, bio, location, website_url')
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
    spendResult,
    transactionsResult,
    mobileTransactionsResult,
    grantsResult,
    walletResult,
    recentGenerationsResult,
  ] = await Promise.all([
    client.auth.admin.getUserById(userId).catch(() => null),
    countRows(client, 'generations', 'user_id', userId),
    countRows(client, 'posts', 'user_id', userId),
    countRows(client, 'follows', 'following_id', userId).catch(() => 0),
    countRows(client, 'follows', 'follower_id', userId).catch(() => 0),
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
    client
      .from('ai_usage_events')
      .select('cost')
      .eq('user_id', userId)
      .eq('refunded', false)
      .limit(10000),
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
      .select('id, status, model, cost, created_at, error_message')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(15),
  ]);

  const lifetimeCreditsSpent = ((spendResult.data ?? []) as Array<{ cost: number | null }>)
    .reduce((total, row) => total + (row.cost ?? 0), 0);

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
    counts: {
      generations: generationsCount,
      posts: postsCount,
      followers: followersCount,
      following: followingCount,
      openReportsAgainst: openReportsCount.count ?? 0,
    },
    spend: {
      lifetimeCreditsSpent,
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
    })),
  };
}
