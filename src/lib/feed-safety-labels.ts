import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Account-level safety labels (feed v4): a label propagated from an account's
 * content or its audience's reaction to it, kept for seven days and renewed by
 * every maintenance run while the evidence holds. The v4 candidate RPC keeps a
 * labelled account out of every pool but `following`, and the visibility
 * stage's `labelled_account` rule does the same for recommendations.
 *
 * The decisions are pure and tested here; `refreshAccountSafetyLabels` reads
 * the evidence and writes what they decide.
 */

export type AccountLabel = 'nsfw_account' | 'negative_feedback_account' | 'spam_account';

export const ACCOUNT_LABEL_TTL_DAYS = 7;
/** An account is `nsfw_account` when any of its newest public posts here is NSFW… */
export const NSFW_ACCOUNT_RECENT_POSTS = 10;
/** …counting only posts this recent. */
export const NSFW_ACCOUNT_LOOKBACK_DAYS = 60;
/** `negative_feedback_account` above this 30-day creator negative-feedback rate… */
export const NEGATIVE_FEEDBACK_ACCOUNT_RATE = 0.08;
/** …once the creator has this much rendered exposure, so one report cannot label a newcomer. */
export const NEGATIVE_FEEDBACK_ACCOUNT_MIN_RENDERED = 60;

export const ACCOUNT_LABEL_SOURCES: Record<Exclude<AccountLabel, 'spam_account'>, string> = {
  nsfw_account: 'nsfw_posts_60d',
  negative_feedback_account: 'creator_negative_feedback_30d',
};

/** NSFW authors examined per run; the newest NSFW posts' authors first. */
const NSFW_ACCOUNT_CANDIDATE_LIMIT = 500;
const NSFW_ACCOUNT_READ_CONCURRENCY = 8;
const NEGATIVE_FEEDBACK_ACCOUNT_LIMIT = 1_000;
const ACCOUNT_LABEL_WRITE_CHUNK = 1_000;

export type AccountLabelPost = { userId: string; isNsfw: boolean; createdAt: string };

export type AccountLabelCreatorStats = {
  creatorUserId: string;
  negativeFeedbackRate: number;
  renderedCount: number;
};

export type AccountLabelDecision = {
  userId: string;
  label: Exclude<AccountLabel, 'spam_account'>;
  source: string;
  expiresAt: string;
};

export type AccountSafetyLabelSummary = {
  nsfwAccounts: number;
  negativeFeedbackAccounts: number;
  labelsUpserted: number;
  expiredDeleted: number;
};

/**
 * Authors with an NSFW post among their newest ten public posts of the last 60
 * days. A post in the future of `now`, or with no readable date, is not
 * counted.
 */
export function decideNsfwAccounts(posts: readonly AccountLabelPost[], now: Date): string[] {
  const nowMs = now.getTime();
  const earliestMs = nowMs - NSFW_ACCOUNT_LOOKBACK_DAYS * 86_400_000;
  const byAuthor = new Map<string, Array<{ isNsfw: boolean; createdAtMs: number }>>();
  for (const post of posts) {
    const createdAtMs = Date.parse(post.createdAt);
    if (!post.userId || !Number.isFinite(createdAtMs) || createdAtMs < earliestMs || createdAtMs > nowMs) continue;
    byAuthor.set(post.userId, [...(byAuthor.get(post.userId) ?? []), { isNsfw: post.isNsfw === true, createdAtMs }]);
  }
  const labelled: string[] = [];
  for (const [userId, authored] of byAuthor) {
    const newest = [...authored]
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .slice(0, NSFW_ACCOUNT_RECENT_POSTS);
    if (newest.some((post) => post.isNsfw)) labelled.push(userId);
  }
  return labelled.sort();
}

/** Creators whose 30-day negative-feedback rate is above 0.08 with at least 60 rendered deliveries. */
export function decideNegativeFeedbackAccounts(stats: readonly AccountLabelCreatorStats[]): string[] {
  return Array.from(new Set(stats
    .filter((row) => (
      Boolean(row.creatorUserId)
      && Number.isFinite(row.negativeFeedbackRate)
      && row.negativeFeedbackRate > NEGATIVE_FEEDBACK_ACCOUNT_RATE
      && Number.isFinite(row.renderedCount)
      && row.renderedCount >= NEGATIVE_FEEDBACK_ACCOUNT_MIN_RENDERED
    ))
    .map((row) => row.creatorUserId))).sort();
}

/** Every label the evidence supports, each expiring seven days from `now`. */
export function decideAccountLabels({
  creatorStats,
  now,
  posts,
}: {
  creatorStats: readonly AccountLabelCreatorStats[];
  now: Date;
  posts: readonly AccountLabelPost[];
}): AccountLabelDecision[] {
  const expiresAt = new Date(now.getTime() + ACCOUNT_LABEL_TTL_DAYS * 86_400_000).toISOString();
  return [
    ...decideNsfwAccounts(posts, now).map((userId) => ({
      userId,
      label: 'nsfw_account' as const,
      source: ACCOUNT_LABEL_SOURCES.nsfw_account,
      expiresAt,
    })),
    ...decideNegativeFeedbackAccounts(creatorStats).map((userId) => ({
      userId,
      label: 'negative_feedback_account' as const,
      source: ACCOUNT_LABEL_SOURCES.negative_feedback_account,
      expiresAt,
    })),
  ];
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function count(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** The newest ten public posts of the last 60 days of every author with a recent NSFW post. */
async function loadNsfwEvidence(client: SupabaseClient, now: Date): Promise<AccountLabelPost[]> {
  const since = new Date(now.getTime() - NSFW_ACCOUNT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data, error } = await client
    .from('posts')
    .select('user_id')
    .eq('visibility', 'public')
    .is('archived_at', null)
    .eq('is_nsfw', true)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(NSFW_ACCOUNT_CANDIDATE_LIMIT);
  if (error) throw new Error(`Feed maintenance could not read NSFW posts: ${errorMessage(error)}`);
  const authors = Array.from(new Set(((data ?? []) as Array<{ user_id?: unknown }>)
    .flatMap((row) => (typeof row.user_id === 'string' ? [row.user_id] : []))));

  const evidence: AccountLabelPost[] = [];
  for (let offset = 0; offset < authors.length; offset += NSFW_ACCOUNT_READ_CONCURRENCY) {
    const batch = authors.slice(offset, offset + NSFW_ACCOUNT_READ_CONCURRENCY);
    const results = await Promise.all(batch.map(async (userId) => {
      const { data: rows, error: rowsError } = await client
        .from('posts')
        .select('user_id, is_nsfw, created_at')
        .eq('user_id', userId)
        .eq('visibility', 'public')
        .is('archived_at', null)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(NSFW_ACCOUNT_RECENT_POSTS);
      if (rowsError) throw new Error(`Feed maintenance could not read an author's posts: ${errorMessage(rowsError)}`);
      return ((rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
        userId,
        isNsfw: row.is_nsfw === true,
        createdAt: String(row.created_at),
      }));
    }));
    for (const rows of results) evidence.push(...rows);
  }
  return evidence;
}

async function loadNegativeFeedbackEvidence(client: SupabaseClient): Promise<AccountLabelCreatorStats[]> {
  const { data, error } = await client
    .from('creator_feed_stats')
    .select('creator_user_id, negative_feedback_rate, rendered_count')
    .eq('window_key', '30d')
    .gt('negative_feedback_rate', NEGATIVE_FEEDBACK_ACCOUNT_RATE)
    .gte('rendered_count', NEGATIVE_FEEDBACK_ACCOUNT_MIN_RENDERED)
    .limit(NEGATIVE_FEEDBACK_ACCOUNT_LIMIT);
  if (error) throw new Error(`Feed maintenance could not read creator stats: ${errorMessage(error)}`);
  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => (
    typeof row.creator_user_id === 'string'
      ? [{
        creatorUserId: row.creator_user_id,
        negativeFeedbackRate: Number(row.negative_feedback_rate),
        renderedCount: Number(row.rendered_count),
      }]
      : []
  ));
}

/**
 * The maintenance pass: decide every label from fresh evidence, renew them all
 * (`upsert_account_labels`, always called, with an empty list when nothing is
 * labelled), then drop what expired (`delete_expired_account_labels`). A label
 * whose evidence went away is not removed here: it lapses at its expiry.
 */
export async function refreshAccountSafetyLabels(
  client: SupabaseClient,
  { now = new Date() }: { now?: Date } = {},
): Promise<AccountSafetyLabelSummary> {
  const [posts, creatorStats] = await Promise.all([
    loadNsfwEvidence(client, now),
    loadNegativeFeedbackEvidence(client),
  ]);
  const decisions = decideAccountLabels({ creatorStats, now, posts });

  let labelsUpserted = 0;
  for (let offset = 0; offset === 0 || offset < decisions.length; offset += ACCOUNT_LABEL_WRITE_CHUNK) {
    const chunk = decisions.slice(offset, offset + ACCOUNT_LABEL_WRITE_CHUNK);
    const { data, error } = await client.rpc('upsert_account_labels', {
      p_labels: chunk.map((decision) => ({
        user_id: decision.userId,
        label: decision.label,
        source: decision.source,
        expires_at: decision.expiresAt,
      })),
    });
    if (error) throw new Error(`Feed maintenance RPC upsert_account_labels failed: ${errorMessage(error)}`);
    labelsUpserted += typeof data === 'number' ? count(data) : chunk.length;
  }

  const expired = await client.rpc('delete_expired_account_labels', { p_as_of: now.toISOString() });
  if (expired.error) {
    throw new Error(`Feed maintenance RPC delete_expired_account_labels failed: ${errorMessage(expired.error)}`);
  }

  return {
    nsfwAccounts: decisions.filter((decision) => decision.label === 'nsfw_account').length,
    negativeFeedbackAccounts: decisions.filter((decision) => decision.label === 'negative_feedback_account').length,
    labelsUpserted,
    expiredDeleted: count(expired.data),
  };
}
