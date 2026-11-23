import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  POST_VIEW_ROLLUP_LIMIT,
  POST_VIEW_ROLLUP_MAX_BATCHES,
  POST_VIEW_ROLLUP_TIME_BUDGET_MS,
  rollupPostViews,
} from '@/lib/post-view-counts';

function batch(overrides: Record<string, unknown> = {}) {
  return {
    skipped: false,
    views_counted: 0,
    posts_counted: 0,
    posts_failed: 0,
    marks_pruned: 0,
    days_pruned: 0,
    more: false,
    ...overrides,
  };
}

function clientAnswering(...answers: Array<{ data: unknown; error?: unknown }>) {
  const rpc = vi.fn();
  for (const answer of answers) rpc.mockResolvedValueOnce({ data: answer.data, error: answer.error ?? null });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const NOW = new Date('2026-11-23T08:00:00.000Z');

describe('rollupPostViews', () => {
  it('calls the rollup once when its batch is not full, with the run\'s time and the batch size', async () => {
    const { client, rpc } = clientAnswering({ data: batch({ views_counted: 7, posts_counted: 2, marks_pruned: 1 }) });

    const summary = await rollupPostViews(client, { now: NOW });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('rollup_post_views', {
      p_as_of: NOW.toISOString(),
      p_limit: POST_VIEW_ROLLUP_LIMIT,
    });
    expect(summary).toEqual({
      skipped: false,
      views_counted: 7,
      posts_counted: 2,
      posts_failed: 0,
      marks_pruned: 1,
      days_pruned: 0,
      batches: 1,
      batch_limit_reached: false,
      time_budget_reached: false,
    });
  });

  it('calls again while a batch comes back full, and adds the batches up', async () => {
    const { client, rpc } = clientAnswering(
      { data: batch({ views_counted: 5000, posts_counted: 40, more: true }) },
      { data: batch({ views_counted: 5000, posts_counted: 30, posts_failed: 1, more: true }) },
      { data: batch({ views_counted: 12, posts_counted: 3, days_pruned: 4 }) },
    );

    const summary = await rollupPostViews(client, { now: NOW });

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      views_counted: 10_012,
      posts_counted: 73,
      posts_failed: 1,
      days_pruned: 4,
      batches: 3,
      batch_limit_reached: false,
    });
  });

  it('stops at the batch cap with the backlog left for the next run', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: batch({ views_counted: 1, more: true }), error: null });

    const summary = await rollupPostViews({ rpc } as unknown as SupabaseClient, { now: NOW });

    expect(rpc).toHaveBeenCalledTimes(POST_VIEW_ROLLUP_MAX_BATCHES);
    expect(summary).toMatchObject({ batches: POST_VIEW_ROLLUP_MAX_BATCHES, batch_limit_reached: true });
  });

  it('starts no call past the time budget', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: batch({ views_counted: 1, more: true }), error: null });
    let time = 0;
    const clock = () => {
      const now = time;
      time += POST_VIEW_ROLLUP_TIME_BUDGET_MS;
      return now;
    };

    const summary = await rollupPostViews({ rpc } as unknown as SupabaseClient, { now: NOW, clock });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ batches: 1, batch_limit_reached: true, time_budget_reached: true });
  });

  it('stops when another run holds the rollup, saying so only if it counted nothing itself', async () => {
    const first = clientAnswering({ data: { skipped: true, reason: 'already_running' } });
    expect(await rollupPostViews(first.client, { now: NOW })).toMatchObject({ skipped: true, batches: 0 });

    const later = clientAnswering(
      { data: batch({ views_counted: 5000, more: true }) },
      { data: { skipped: true, reason: 'already_running' } },
    );
    expect(await rollupPostViews(later.client, { now: NOW })).toMatchObject({
      skipped: false,
      views_counted: 5000,
      batches: 1,
      batch_limit_reached: true,
    });
  });

  it('fails the run on a database error, and on an answer it cannot read', async () => {
    const failing = clientAnswering({ data: null, error: { message: 'connection reset' } });
    await expect(rollupPostViews(failing.client, { now: NOW }))
      .rejects.toThrow('Post view rollup RPC rollup_post_views failed: connection reset');

    const garbled = clientAnswering({ data: batch({ views_counted: -1 }) });
    await expect(rollupPostViews(garbled.client, { now: NOW }))
      .rejects.toThrow('Post view rollup returned an invalid views_counted');

    const empty = clientAnswering({ data: null });
    await expect(rollupPostViews(empty.client, { now: NOW })).rejects.toThrow('Post view rollup returned no summary');
  });

  it('refuses an invalid run time', async () => {
    const { client, rpc } = clientAnswering();
    await expect(rollupPostViews(client, { now: new Date(Number.NaN) })).rejects.toThrow('valid date');
    expect(rpc).not.toHaveBeenCalled();
  });
});
