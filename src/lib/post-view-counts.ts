import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Post view counts: the rollup the post-view-counts job runs every ten
 * minutes (migration 20261123070740, docs/plans/post-view-counts-2026-11-23.md).
 *
 * A view is a mark (one per post, viewer and UTC day) made by the feed's
 * qualified impressions or by POST /api/showcase/views. `rollup_post_views`
 * adds the uncounted marks to `posts.view_count` and `post_view_days`, then
 * prunes marks two days after their day and days older than 400 days. Each
 * call is one short transaction over at most `POST_VIEW_ROLLUP_LIMIT` marks;
 * the run calls again while a batch comes back full, until the backlog is
 * gone or the run's budget is spent, so the backfill's thirty days drain over
 * a few calls rather than one long transaction.
 */

/** Uncounted marks one call takes. */
export const POST_VIEW_ROLLUP_LIMIT = 5000;

/** No call starts later than this into the run. */
export const POST_VIEW_ROLLUP_TIME_BUDGET_MS = 30_000;

/** A backstop on calls per run; the time budget is the real bound. */
export const POST_VIEW_ROLLUP_MAX_BATCHES = 20;

const BATCH_COUNTS = [
  'views_counted',
  'posts_counted',
  'posts_failed',
  'marks_pruned',
  'days_pruned',
] as const;

type BatchCount = (typeof BATCH_COUNTS)[number];

export type PostViewRollupSummary = Record<BatchCount, number> & {
  /** Another run held the rollup's lock, so this one counted nothing more. */
  skipped: boolean;
  batches: number;
  /** The run stopped with a full batch behind it: the next run goes on. */
  batch_limit_reached: boolean;
  time_budget_reached: boolean;
};

type RollupBatch = Record<BatchCount, number> & { skipped: boolean; more: boolean };

function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

function readCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Post view rollup returned an invalid ${name}`);
  }
  return value;
}

function readRollupBatch(data: unknown): RollupBatch {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Post view rollup returned no summary');
  }
  const row = data as Record<string, unknown>;
  if (row.skipped === true) {
    return {
      skipped: true,
      more: false,
      views_counted: 0,
      posts_counted: 0,
      posts_failed: 0,
      marks_pruned: 0,
      days_pruned: 0,
    };
  }
  const counts = Object.fromEntries(
    BATCH_COUNTS.map((key) => [key, readCount(row[key], key)]),
  ) as Record<BatchCount, number>;
  return { ...counts, skipped: false, more: row.more === true };
}

function emptySummary(): PostViewRollupSummary {
  return {
    skipped: false,
    views_counted: 0,
    posts_counted: 0,
    posts_failed: 0,
    marks_pruned: 0,
    days_pruned: 0,
    batches: 0,
    batch_limit_reached: false,
    time_budget_reached: false,
  };
}

/**
 * Counts the uncounted views into the posts' totals. The first call always
 * runs; a failed call fails the run (the batches before it stand, each its
 * own transaction).
 */
export async function rollupPostViews(
  client: SupabaseClient,
  options: { now?: Date; clock?: () => number } = {},
): Promise<PostViewRollupSummary> {
  const clock = options.clock ?? Date.now;
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Post view rollup time must be a valid date');
  }
  const asOf = now.toISOString();
  const deadlineMs = clock() + POST_VIEW_ROLLUP_TIME_BUDGET_MS;
  const total = emptySummary();

  for (;;) {
    const { data, error } = await client.rpc('rollup_post_views', {
      p_as_of: asOf,
      p_limit: POST_VIEW_ROLLUP_LIMIT,
    });
    if (error) {
      throw new Error(`Post view rollup RPC rollup_post_views failed: ${errorMessage(error)}`);
    }
    const batch = readRollupBatch(data);

    // Another run holds the rollup's lock and is counting: this one stops.
    if (batch.skipped) {
      return total.batches === 0
        ? { ...total, skipped: true }
        : { ...total, batch_limit_reached: true };
    }

    total.batches += 1;
    for (const key of BATCH_COUNTS) total[key] += batch[key];

    if (!batch.more) return total;
    if (total.batches >= POST_VIEW_ROLLUP_MAX_BATCHES) {
      return { ...total, batch_limit_reached: true };
    }
    if (clock() >= deadlineMs) {
      return { ...total, batch_limit_reached: true, time_budget_reached: true };
    }
  }
}
