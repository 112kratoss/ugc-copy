import { describe, expect, it, vi } from 'vitest';

import { logBackendWarning } from '@/lib/backend-logger';
import { maintainFeedPersonalization } from '@/lib/feed-maintenance';

vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logBackendWarning: vi.fn(),
}));

function createRpcClient(results: Record<string, { data: unknown; error: unknown }>) {
  const rpc = vi.fn(async (name: string) => {
    const result = results[name];
    if (!result) throw new Error(`Unexpected RPC: ${name}`);
    return result;
  });

  return { client: { rpc }, rpc };
}

describe('maintainFeedPersonalization', () => {
  it('refreshes bounded stats and interests before pruning expired feed data', async () => {
    const db = createRpcClient({
      refresh_post_feed_stats: { data: 37, error: null },
      refresh_post_feed_engagement_stats: { data: 21, error: null },
      refresh_creator_feed_stats: { data: 9, error: null },
      refresh_user_interest_weights: { data: 12, error: null },
      refresh_feed_delivery_fact_daily: {
        data: {
          buckets_refreshed: 6,
          buckets_pruned: 1,
          from_date: '2026-07-08',
          retention_days: 400,
        },
        error: null,
      },
      prune_feed_personalization_data: {
        data: {
          skipped: false,
          events_deleted: 8,
          sessions_deleted: 3,
          assignments_deleted: 1,
          interests_deleted: 2,
          post_feedback_deleted: 0,
          creator_feedback_deleted: 0,
          facts_deleted: 5,
        },
        error: null,
      },
    });
    const now = new Date('2026-07-11T07:20:00.000Z');
    const invalidateFeedCache = vi.fn();

    await expect(maintainFeedPersonalization(db.client as never, {
      now,
      invalidateFeedCache,
    })).resolves.toEqual({
      asOf: '2026-07-11T07:20:00.000Z',
      postStatsRefreshed: 37,
      postEngagementStatsRefreshed: 21,
      creatorStatsRefreshed: 9,
      userInterestProfilesRefreshed: 12,
      dailyRollup: {
        bucketsRefreshed: 6,
        bucketsPruned: 1,
        fromDate: '2026-07-08',
        retentionDays: 400,
      },
      retention: {
        skipped: false,
        events_deleted: 8,
        sessions_deleted: 3,
        assignments_deleted: 1,
        interests_deleted: 2,
        post_feedback_deleted: 0,
        creator_feedback_deleted: 0,
        facts_deleted: 5,
      },
    });
    expect(db.rpc.mock.calls).toEqual([
      ['refresh_post_feed_stats', {
        p_as_of: '2026-07-11T07:20:00.000Z',
        p_limit: 1000,
      }],
      ['refresh_post_feed_engagement_stats', {
        p_as_of: '2026-07-11T07:20:00.000Z',
        p_limit: 1000,
      }],
      ['refresh_creator_feed_stats', {
        p_as_of: '2026-07-11T07:20:00.000Z',
        p_limit: 1000,
      }],
      ['refresh_user_interest_weights', {
        p_as_of: '2026-07-11T07:20:00.000Z',
        p_lookback_days: 90,
        p_half_life_days: 30,
        p_limit: 1000,
      }],
      // F7b: the rollup runs *before* the prune. Aggregating after deleting
      // would silently drop a day of experiment history rather than fail, so
      // the order is asserted, not left to chance.
      ['refresh_feed_delivery_fact_daily', {
        p_as_of: '2026-07-11T07:20:00.000Z',
        p_lookback_days: 3,
        p_retention_days: 400,
      }],
      ['prune_feed_personalization_data', {
        p_as_of: '2026-07-11T07:20:00.000Z',
        // Brought down from 90 with the facts. The prune RPC rejects fact
        // retention shorter than event retention, so decision #2's 30-day
        // facts require events at 30 too — leaving this at 90 aborted every
        // feed-maintenance run.
        p_event_retention_days: 30,
        p_session_retention_days: 2,
        p_limit: 5000,
        // F7b / decision #2: 30 days, down from 400. The old setting projected
        // ~24 GiB of raw facts at 5,000 MAU against an 8 GiB included quota.
        p_fact_retention_days: 30,
      }],
    ]);
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it('stops before pruning when an aggregate refresh fails', async () => {
    const db = createRpcClient({
      refresh_post_feed_stats: { data: 4, error: null },
      refresh_post_feed_engagement_stats: { data: 2, error: null },
      refresh_creator_feed_stats: { data: 1, error: null },
      refresh_user_interest_weights: {
        data: null,
        error: { message: 'statement timeout' },
      },
      prune_feed_personalization_data: { data: { skipped: false }, error: null },
    });
    const invalidateFeedCache = vi.fn();

    await expect(maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-07-11T07:20:00.000Z'),
      invalidateFeedCache,
    })).rejects.toThrow(
      'Feed maintenance RPC refresh_user_interest_weights failed: statement timeout',
    );
    expect(db.rpc).toHaveBeenCalledTimes(4);
    expect(db.rpc).not.toHaveBeenCalledWith('prune_feed_personalization_data', expect.anything());
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it('rejects invalid timestamps before querying Supabase', async () => {
    const db = createRpcClient({});

    await expect(maintainFeedPersonalization(db.client as never, {
      now: new Date(Number.NaN),
    })).rejects.toThrow('Feed maintenance time must be a valid date');
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('surfaces a clamped retention run as a structured warning, not a silent success', async () => {
    vi.mocked(logBackendWarning).mockClear();
    const db = createRpcClient({
      refresh_post_feed_stats: { data: 0, error: null },
      refresh_post_feed_engagement_stats: { data: 0, error: null },
      refresh_creator_feed_stats: { data: 0, error: null },
      refresh_user_interest_weights: { data: 0, error: null },
      refresh_feed_delivery_fact_daily: {
        data: { buckets_refreshed: 0, buckets_pruned: 0, from_date: null, retention_days: 400 },
        error: null,
      },
      prune_feed_personalization_data: {
        data: {
          skipped: false,
          events_deleted: 0,
          sessions_deleted: 0,
          assignments_deleted: 0,
          interests_deleted: 0,
          post_feedback_deleted: 0,
          creator_feedback_deleted: 0,
          facts_deleted: 0,
          fact_retention_days_requested: 30,
          fact_retention_days_applied: 90,
          fact_retention_clamped: true,
        },
        error: null,
      },
    });

    const summary = await maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-08-09T15:00:00.000Z'),
      invalidateFeedCache: vi.fn(),
    });

    expect(logBackendWarning).toHaveBeenCalledWith('feed_retention_clamped', {
      requestedDays: 30,
      appliedDays: 90,
    });
    expect(summary.retention.fact_retention_clamped).toBe(true);
    expect(summary.retention.fact_retention_days_applied).toBe(90);
  });

  it('does not warn when the retention run applied exactly what was requested', async () => {
    vi.mocked(logBackendWarning).mockClear();
    const db = createRpcClient({
      refresh_post_feed_stats: { data: 0, error: null },
      refresh_post_feed_engagement_stats: { data: 0, error: null },
      refresh_creator_feed_stats: { data: 0, error: null },
      refresh_user_interest_weights: { data: 0, error: null },
      refresh_feed_delivery_fact_daily: {
        data: { buckets_refreshed: 0, buckets_pruned: 0, from_date: null, retention_days: 400 },
        error: null,
      },
      prune_feed_personalization_data: {
        data: {
          skipped: false,
          events_deleted: 0,
          sessions_deleted: 0,
          assignments_deleted: 0,
          interests_deleted: 0,
          post_feedback_deleted: 0,
          creator_feedback_deleted: 0,
          facts_deleted: 0,
          fact_retention_days_requested: 30,
          fact_retention_days_applied: 30,
          fact_retention_clamped: false,
        },
        error: null,
      },
    });

    await maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-08-09T15:00:00.000Z'),
      invalidateFeedCache: vi.fn(),
    });

    expect(logBackendWarning).not.toHaveBeenCalled();
  });
});
