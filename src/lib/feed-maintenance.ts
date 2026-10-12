import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
import {
  refreshAccountSafetyLabels,
  type AccountSafetyLabelSummary,
} from '@/lib/feed-safety-labels';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

const POST_STATS_REFRESH_LIMIT = 1000;
const CREATOR_STATS_REFRESH_LIMIT = 1000;
const USER_INTEREST_REFRESH_LIMIT = 1000;
const USER_INTEREST_LOOKBACK_DAYS = 90;
const USER_INTEREST_HALF_LIFE_DAYS = 30;
import {
  FEED_EVENT_RETENTION_DAYS,
  FEED_FACT_DAILY_LOOKBACK_DAYS,
  FEED_FACT_DAILY_RETENTION_DAYS,
  FEED_FACT_RETENTION_DAYS,
  FEED_RETENTION_PRUNE_LIMIT,
  FEED_SESSION_RETENTION_DAYS,
} from '@/lib/feed-retention-policy';

/**
 * Days of `feed_viewer_daily` recomputed per run: the same tail as the daily
 * fact rollup, for the same reason — facts gain outcomes after the day ends.
 */
const FEED_VIEWER_DAILY_LOOKBACK_DAYS = FEED_FACT_DAILY_LOOKBACK_DAYS;

type FeedRetentionSummary = {
  skipped: boolean;
  reason?: string;
  events_deleted?: number;
  sessions_deleted?: number;
  assignments_deleted?: number;
  interests_deleted?: number;
  post_feedback_deleted?: number;
  creator_feedback_deleted?: number;
  facts_deleted?: number;
  fact_retention_days_requested?: number;
  fact_retention_days_applied?: number;
  fact_retention_clamped?: boolean;
};

export type FeedDailyRollupSummary = {
  bucketsRefreshed: number;
  bucketsPruned: number;
  fromDate: string | null;
  retentionDays: number | null;
};

export type FeedViewerDailySummary = {
  /** What `refresh_feed_viewer_daily` reported refreshing; null when it reports no count. */
  rowsRefreshed: number | null;
  lookbackDays: number;
};

export type FeedMaintenanceSummary = {
  asOf: string;
  postStatsRefreshed: number;
  postEngagementStatsRefreshed: number;
  creatorStatsRefreshed: number;
  userInterestProfilesRefreshed: number;
  dailyRollup: FeedDailyRollupSummary;
  /** v4: account labels renewed from content and creator stats. */
  accountLabels: AccountSafetyLabelSummary;
  /** v4: the viewer-grain daily rollup behind the scorecard. */
  viewerDaily: FeedViewerDailySummary;
  retention: FeedRetentionSummary;
};

function viewerDailySummary(value: unknown): FeedViewerDailySummary {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const raw = typeof value === 'number' ? value : record?.rows_refreshed;
  return {
    rowsRefreshed: typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null,
    lookbackDays: FEED_VIEWER_DAILY_LOOKBACK_DAYS,
  };
}

function dailyRollupSummary(value: unknown): FeedDailyRollupSummary {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const count = (raw: unknown) => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0);
  return {
    bucketsRefreshed: count(record.buckets_refreshed),
    bucketsPruned: count(record.buckets_pruned),
    fromDate: typeof record.from_date === 'string' ? record.from_date : null,
    retentionDays: typeof record.retention_days === 'number' ? record.retention_days : null,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function rpcError(name: string, error: unknown): Error {
  return new Error(`Feed maintenance RPC ${name} failed: ${errorMessage(error)}`);
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Feed maintenance RPC ${name} returned an invalid count`);
  }
  return value;
}

function retentionSummary(value: unknown): FeedRetentionSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Feed maintenance RPC prune_feed_personalization_data returned an invalid summary');
  }

  const summary = value as Record<string, unknown>;
  if (typeof summary.skipped !== 'boolean') {
    throw new Error('Feed maintenance RPC prune_feed_personalization_data returned an invalid summary');
  }

  return summary as FeedRetentionSummary;
}

/**
 * Refreshes the bounded feed aggregates before deleting expired source telemetry.
 * The migration RPCs provide their own advisory locks; this service is additionally
 * wrapped by the shared backend-job lock at the scheduler boundary.
 *
 * v4 adds two phases, each isolated: the account safety labels (after creator
 * stats, which they read) and the viewer-grain daily rollup (before the prune,
 * like the fact rollup). A failure in either is held while every other phase
 * still runs — a new phase must never starve the stats and the prune v1–v3
 * depend on — and then fails the run with that phase's message, so job health
 * still shows it.
 */
export async function maintainFeedPersonalization(
  client: SupabaseClient,
  options: {
    now?: Date;
    invalidateFeedCache?: typeof invalidateShowcaseFeedCache;
    refreshAccountLabels?: typeof refreshAccountSafetyLabels;
  } = {},
): Promise<FeedMaintenanceSummary> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Feed maintenance time must be a valid date');
  }
  const asOf = now.toISOString();

  const statsResult = await client.rpc('refresh_post_feed_stats', {
    p_as_of: asOf,
    p_limit: POST_STATS_REFRESH_LIMIT,
  });
  if (statsResult.error) {
    throw rpcError('refresh_post_feed_stats', statsResult.error);
  }
  const postStatsRefreshed = nonNegativeInteger(
    statsResult.data,
    'refresh_post_feed_stats',
  );

  // Fact-derived aggregates are refreshed separately from the v1 event rollup
  // so a failure in the newer path cannot stall v1's inputs.
  const engagementStatsResult = await client.rpc('refresh_post_feed_engagement_stats', {
    p_as_of: asOf,
    p_limit: POST_STATS_REFRESH_LIMIT,
  });
  if (engagementStatsResult.error) {
    throw rpcError('refresh_post_feed_engagement_stats', engagementStatsResult.error);
  }

  const creatorStatsResult = await client.rpc('refresh_creator_feed_stats', {
    p_as_of: asOf,
    p_limit: CREATOR_STATS_REFRESH_LIMIT,
  });
  if (creatorStatsResult.error) {
    throw rpcError('refresh_creator_feed_stats', creatorStatsResult.error);
  }
  (options.invalidateFeedCache ?? invalidateShowcaseFeedCache)();

  const deferredFailures: string[] = [];
  let accountLabels: AccountSafetyLabelSummary = {
    nsfwAccounts: 0,
    negativeFeedbackAccounts: 0,
    labelsUpserted: 0,
    expiredDeleted: 0,
  };
  try {
    accountLabels = await (options.refreshAccountLabels ?? refreshAccountSafetyLabels)(client, { now });
  } catch (error) {
    deferredFailures.push(errorMessage(error));
  }

  const interestsResult = await client.rpc('refresh_user_interest_weights', {
    p_as_of: asOf,
    p_lookback_days: USER_INTEREST_LOOKBACK_DAYS,
    p_half_life_days: USER_INTEREST_HALF_LIFE_DAYS,
    p_limit: USER_INTEREST_REFRESH_LIMIT,
  });
  if (interestsResult.error) {
    throw rpcError('refresh_user_interest_weights', interestsResult.error);
  }

  // Deliberately before the prune. The rollup window (3 days) sits well inside
  // the raw retention window (30), so the order is not load-bearing today —
  // but aggregating before deleting is the invariant that stays correct if
  // either number ever changes, and getting it backwards would silently drop a
  // day of experiment history rather than fail.
  const dailyRollupResult = await client.rpc('refresh_feed_delivery_fact_daily', {
    p_as_of: asOf,
    p_lookback_days: FEED_FACT_DAILY_LOOKBACK_DAYS,
    p_retention_days: FEED_FACT_DAILY_RETENTION_DAYS,
  });
  if (dailyRollupResult.error) {
    throw rpcError('refresh_feed_delivery_fact_daily', dailyRollupResult.error);
  }

  // Before the prune, like the fact rollup: aggregate before deleting.
  let viewerDaily = viewerDailySummary(null);
  try {
    const viewerDailyResult = await client.rpc('refresh_feed_viewer_daily', {
      p_as_of: asOf,
      p_days: FEED_VIEWER_DAILY_LOOKBACK_DAYS,
    });
    if (viewerDailyResult.error) throw rpcError('refresh_feed_viewer_daily', viewerDailyResult.error);
    viewerDaily = viewerDailySummary(viewerDailyResult.data);
  } catch (error) {
    deferredFailures.push(errorMessage(error));
  }

  const pruneResult = await client.rpc('prune_feed_personalization_data', {
    p_as_of: asOf,
    p_event_retention_days: FEED_EVENT_RETENTION_DAYS,
    p_session_retention_days: FEED_SESSION_RETENTION_DAYS,
    p_limit: FEED_RETENTION_PRUNE_LIMIT,
    p_fact_retention_days: FEED_FACT_RETENTION_DAYS,
  });
  if (pruneResult.error) {
    throw rpcError('prune_feed_personalization_data', pruneResult.error);
  }

  const retention = retentionSummary(pruneResult.data);
  // The clamp is the right runtime behaviour — retaining longer than asked is
  // recoverable — but it must never pass unobserved: a clamped run means the
  // configured policy is not what production is actually retaining.
  if (retention.fact_retention_clamped === true) {
    logBackendWarning('feed_retention_clamped', {
      requestedDays: retention.fact_retention_days_requested ?? FEED_FACT_RETENTION_DAYS,
      appliedDays: retention.fact_retention_days_applied ?? null,
    });
  }

  if (deferredFailures.length > 0) {
    throw new Error(deferredFailures.join('; '));
  }

  return {
    asOf,
    postStatsRefreshed,
    postEngagementStatsRefreshed: nonNegativeInteger(
      engagementStatsResult.data,
      'refresh_post_feed_engagement_stats',
    ),
    creatorStatsRefreshed: nonNegativeInteger(
      creatorStatsResult.data,
      'refresh_creator_feed_stats',
    ),
    userInterestProfilesRefreshed: nonNegativeInteger(
      interestsResult.data,
      'refresh_user_interest_weights',
    ),
    dailyRollup: dailyRollupSummary(dailyRollupResult.data),
    accountLabels,
    viewerDaily,
    retention,
  };
}
