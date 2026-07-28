import { describe, expect, it, vi } from 'vitest';

import { maintainFeedPersonalization } from '@/lib/feed-maintenance';

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
      ['prune_feed_personalization_data', {
        p_as_of: '2026-07-11T07:20:00.000Z',
        p_event_retention_days: 90,
        p_session_retention_days: 2,
        p_limit: 5000,
        p_fact_retention_days: 400,
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
});
