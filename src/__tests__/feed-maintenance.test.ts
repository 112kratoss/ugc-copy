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

const LABELS_SUMMARY = { nsfwAccounts: 1, negativeFeedbackAccounts: 2, labelsUpserted: 3, expiredDeleted: 4 };

/** The v4 label pass as the chain sees it; its own reads and RPCs are tested in feed-safety-labels.test.ts. */
function labelPass(result: Promise<typeof LABELS_SUMMARY> | (() => Promise<typeof LABELS_SUMMARY>) = async () => LABELS_SUMMARY) {
  return vi.fn(typeof result === 'function' ? result : () => result);
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
      refresh_feed_viewer_daily: { data: 41, error: null },
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
    const refreshAccountLabels = labelPass();

    await expect(maintainFeedPersonalization(db.client as never, {
      now,
      invalidateFeedCache,
      refreshAccountLabels,
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
      accountLabels: LABELS_SUMMARY,
      viewerDaily: { rowsRefreshed: 41, lookbackDays: 3 },
      retention: {
        skipped: false,
        events_deleted: 8,
        sessions_deleted: 3,
        assignments_deleted: 1,
        interests_deleted: 2,
        post_feedback_deleted: 0,
        creator_feedback_deleted: 0,
        facts_deleted: 5,
        // No table filled its batch of 5,000, so one call was the whole prune.
        batches: 1,
        batch_limit_reached: false,
        time_budget_reached: false,
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
      // v4: the viewer-grain rollup, also before the prune.
      ['refresh_feed_viewer_daily', {
        p_as_of: '2026-07-11T07:20:00.000Z',
        p_days: 3,
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
    expect(refreshAccountLabels).toHaveBeenCalledOnce();
    expect(refreshAccountLabels).toHaveBeenCalledWith(db.client, { now });
  });

  it('renews account labels after creator stats and before the interest refresh', async () => {
    const calls: string[] = [];
    const db = createRpcClient({
      refresh_post_feed_stats: { data: 0, error: null },
      refresh_post_feed_engagement_stats: { data: 0, error: null },
      refresh_creator_feed_stats: { data: 0, error: null },
      refresh_user_interest_weights: { data: 0, error: null },
      refresh_feed_delivery_fact_daily: { data: {}, error: null },
      refresh_feed_viewer_daily: { data: { rows_refreshed: 7 }, error: null },
      prune_feed_personalization_data: { data: { skipped: false }, error: null },
    });
    db.rpc.mockImplementation(async (name: string) => {
      calls.push(name);
      return {
        refresh_feed_viewer_daily: { data: { rows_refreshed: 7 }, error: null },
        refresh_feed_delivery_fact_daily: { data: {}, error: null },
        prune_feed_personalization_data: { data: { skipped: false }, error: null },
      }[name] ?? { data: 0, error: null };
    });

    const summary = await maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-07-11T07:20:00.000Z'),
      invalidateFeedCache: () => calls.push('invalidate-feed-cache'),
      refreshAccountLabels: labelPass(async () => {
        calls.push('account-labels');
        return LABELS_SUMMARY;
      }),
    });

    expect(calls).toEqual([
      'refresh_post_feed_stats',
      'refresh_post_feed_engagement_stats',
      'refresh_creator_feed_stats',
      'invalidate-feed-cache',
      'account-labels',
      'refresh_user_interest_weights',
      'refresh_feed_delivery_fact_daily',
      'refresh_feed_viewer_daily',
      'prune_feed_personalization_data',
    ]);
    expect(summary.viewerDaily).toEqual({ rowsRefreshed: 7, lookbackDays: 3 });
  });

  it.each([
    ['the account label pass', 'labels'],
    ['the viewer-grain rollup', 'viewer-daily'],
  ])('lets every other phase and the prune run when %s fails, then fails the run', async (_label, failing) => {
    const db = createRpcClient({
      refresh_post_feed_stats: { data: 0, error: null },
      refresh_post_feed_engagement_stats: { data: 0, error: null },
      refresh_creator_feed_stats: { data: 0, error: null },
      refresh_user_interest_weights: { data: 0, error: null },
      refresh_feed_delivery_fact_daily: { data: {}, error: null },
      refresh_feed_viewer_daily: failing === 'viewer-daily'
        ? { data: null, error: { message: 'relation "feed_viewer_daily" does not exist' } }
        : { data: 3, error: null },
      prune_feed_personalization_data: { data: { skipped: false }, error: null },
    });
    const refreshAccountLabels = failing === 'labels'
      ? labelPass(async () => { throw new Error('Feed maintenance RPC upsert_account_labels failed: boom'); })
      : labelPass();

    await expect(maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-07-11T07:20:00.000Z'),
      invalidateFeedCache: vi.fn(),
      refreshAccountLabels,
    })).rejects.toThrow(failing === 'labels'
      ? 'Feed maintenance RPC upsert_account_labels failed: boom'
      : 'Feed maintenance RPC refresh_feed_viewer_daily failed: relation "feed_viewer_daily" does not exist');
    expect(db.rpc.mock.calls.map(([name]) => name)).toEqual([
      'refresh_post_feed_stats',
      'refresh_post_feed_engagement_stats',
      'refresh_creator_feed_stats',
      'refresh_user_interest_weights',
      'refresh_feed_delivery_fact_daily',
      'refresh_feed_viewer_daily',
      'prune_feed_personalization_data',
    ]);
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
      refreshAccountLabels: labelPass(),
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
      refresh_feed_viewer_daily: { data: 0, error: null },
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
      refreshAccountLabels: labelPass(),
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
      refresh_feed_viewer_daily: { data: 0, error: null },
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
      refreshAccountLabels: labelPass(),
    });

    expect(logBackendWarning).not.toHaveBeenCalled();
  });
});

// Usage audit (2026-11-04): the prune deletes at most 5,000 rows per table per
// call, so the hourly run calls it again while a table fills its batch, until
// the backlog is gone or three minutes of the run have passed.
describe('maintainFeedPersonalization prune batches', () => {
  function batchedClient(prunes: Array<{ data: unknown; error: unknown }>) {
    const queue = [...prunes];
    const rpc = vi.fn(async (name: string) => {
      if (name === 'prune_feed_personalization_data') {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (!next) throw new Error('no prune answer');
        return next;
      }
      if (name === 'refresh_feed_delivery_fact_daily') return { data: {}, error: null };
      if (name === 'refresh_feed_viewer_daily') return { data: 0, error: null };
      return { data: 0, error: null };
    });
    return { client: { rpc }, rpc };
  }

  const full = { data: { skipped: false, events_deleted: 5000, facts_deleted: 1200, sessions_deleted: 3 }, error: null };
  const short = { data: { skipped: false, events_deleted: 900, facts_deleted: 0, sessions_deleted: 0 }, error: null };
  const pruneCalls = (rpc: ReturnType<typeof vi.fn>) => rpc.mock.calls.filter(([name]) => name === 'prune_feed_personalization_data');

  it('calls the prune again while a table fills its batch and sums the counts', async () => {
    const db = batchedClient([full, full, short]);

    const summary = await maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-11-04T07:20:00.000Z'),
      invalidateFeedCache: vi.fn(),
      refreshAccountLabels: labelPass(),
    });

    expect(pruneCalls(db.rpc)).toHaveLength(3);
    expect(summary.retention).toEqual({
      skipped: false,
      events_deleted: 10_900,
      facts_deleted: 2400,
      sessions_deleted: 6,
      batches: 3,
      batch_limit_reached: false,
      time_budget_reached: false,
    });
  });

  it('asks every batch with the same arguments, so they all prune to the same instant', async () => {
    const db = batchedClient([full, short]);

    await maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-11-04T07:20:00.000Z'),
      invalidateFeedCache: vi.fn(),
      refreshAccountLabels: labelPass(),
    });

    const [first, second] = pruneCalls(db.rpc).map(([, args]) => args);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ p_as_of: '2026-11-04T07:20:00.000Z', p_limit: 5000 });
  });

  it('starts no batch after three minutes of the run and says a backlog remains', async () => {
    let clockMs = 0;
    const db = batchedClient([full]);
    const answer = db.rpc.getMockImplementation()!;
    db.rpc.mockImplementation(async (name: string) => {
      if (name === 'prune_feed_personalization_data') clockMs += 70_000;
      return answer(name);
    });

    const summary = await maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-11-04T07:20:00.000Z'),
      invalidateFeedCache: vi.fn(),
      refreshAccountLabels: labelPass(),
      clock: () => clockMs,
    });

    // Batches start at 0, 70 and 140 s; the third ends at 210 s, past the mark.
    expect(pruneCalls(db.rpc)).toHaveLength(3);
    expect(summary.retention).toMatchObject({ batches: 3, batch_limit_reached: true, time_budget_reached: true });
  });

  it('stops when another run holds the prune, keeping what its earlier batches did', async () => {
    const db = batchedClient([full, { data: { skipped: true, reason: 'already_running' }, error: null }]);

    const summary = await maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-11-04T07:20:00.000Z'),
      invalidateFeedCache: vi.fn(),
      refreshAccountLabels: labelPass(),
    });

    expect(pruneCalls(db.rpc)).toHaveLength(2);
    expect(summary.retention).toMatchObject({ skipped: false, events_deleted: 5000, batches: 1, batch_limit_reached: true });
  });

  it('answers a first call that found the prune running exactly as the RPC did', async () => {
    const db = batchedClient([{ data: { skipped: true, reason: 'already_running' }, error: null }]);

    const summary = await maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-11-04T07:20:00.000Z'),
      invalidateFeedCache: vi.fn(),
      refreshAccountLabels: labelPass(),
    });

    expect(pruneCalls(db.rpc)).toHaveLength(1);
    expect(summary.retention).toEqual({ skipped: true, reason: 'already_running' });
  });

  it('fails the run when a later batch fails', async () => {
    const db = batchedClient([full, { data: null, error: { message: 'canceling statement due to lock timeout' } }]);

    await expect(maintainFeedPersonalization(db.client as never, {
      now: new Date('2026-11-04T07:20:00.000Z'),
      invalidateFeedCache: vi.fn(),
      refreshAccountLabels: labelPass(),
    })).rejects.toThrow('prune_feed_personalization_data failed: canceling statement due to lock timeout');
  });
});
