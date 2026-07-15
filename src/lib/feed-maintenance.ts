import type { SupabaseClient } from '@supabase/supabase-js';

import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

const POST_STATS_REFRESH_LIMIT = 1000;
const USER_INTEREST_REFRESH_LIMIT = 1000;
const USER_INTEREST_LOOKBACK_DAYS = 90;
const USER_INTEREST_HALF_LIFE_DAYS = 30;
const FEED_EVENT_RETENTION_DAYS = 90;
const FEED_SESSION_RETENTION_DAYS = 2;
const FEED_RETENTION_PRUNE_LIMIT = 5000;

type FeedRetentionSummary = {
  skipped: boolean;
  reason?: string;
  events_deleted?: number;
  sessions_deleted?: number;
  assignments_deleted?: number;
  interests_deleted?: number;
  post_feedback_deleted?: number;
  creator_feedback_deleted?: number;
};

export type FeedMaintenanceSummary = {
  asOf: string;
  postStatsRefreshed: number;
  userInterestProfilesRefreshed: number;
  retention: FeedRetentionSummary;
};

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
 */
export async function maintainFeedPersonalization(
  client: SupabaseClient,
  options: {
    now?: Date;
    invalidateFeedCache?: typeof invalidateShowcaseFeedCache;
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
  (options.invalidateFeedCache ?? invalidateShowcaseFeedCache)();

  const interestsResult = await client.rpc('refresh_user_interest_weights', {
    p_as_of: asOf,
    p_lookback_days: USER_INTEREST_LOOKBACK_DAYS,
    p_half_life_days: USER_INTEREST_HALF_LIFE_DAYS,
    p_limit: USER_INTEREST_REFRESH_LIMIT,
  });
  if (interestsResult.error) {
    throw rpcError('refresh_user_interest_weights', interestsResult.error);
  }

  const pruneResult = await client.rpc('prune_feed_personalization_data', {
    p_as_of: asOf,
    p_event_retention_days: FEED_EVENT_RETENTION_DAYS,
    p_session_retention_days: FEED_SESSION_RETENTION_DAYS,
    p_limit: FEED_RETENTION_PRUNE_LIMIT,
  });
  if (pruneResult.error) {
    throw rpcError('prune_feed_personalization_data', pruneResult.error);
  }

  return {
    asOf,
    postStatsRefreshed,
    userInterestProfilesRefreshed: nonNegativeInteger(
      interestsResult.data,
      'refresh_user_interest_weights',
    ),
    retention: retentionSummary(pruneResult.data),
  };
}
