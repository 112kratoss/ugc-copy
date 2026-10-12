import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ACCOUNT_LABEL_SOURCES,
  decideAccountLabels,
  decideNegativeFeedbackAccounts,
  decideNsfwAccounts,
  refreshAccountSafetyLabels,
  type AccountLabelPost,
} from '@/lib/feed-safety-labels';

const NOW = new Date('2026-10-12T00:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function posts(userId: string, flags: boolean[], { startDaysAgo = 1 } = {}): AccountLabelPost[] {
  // Newest first: flags[0] is the newest post.
  return flags.map((isNsfw, index) => ({ userId, isNsfw, createdAt: daysAgo(startDaysAgo + index) }));
}

describe('decideNsfwAccounts', () => {
  it('labels an author with an NSFW post among their newest ten public posts', () => {
    expect(decideNsfwAccounts([
      ...posts('newest-is-nsfw', [true, false, false]),
      ...posts('tenth-is-nsfw', [false, false, false, false, false, false, false, false, false, true]),
      ...posts('clean', [false, false]),
    ], NOW)).toEqual(['newest-is-nsfw', 'tenth-is-nsfw']);
  });

  it('forgets an NSFW post pushed out by ten newer ones', () => {
    expect(decideNsfwAccounts(posts('moved-on', [...new Array(10).fill(false), true]), NOW)).toEqual([]);
  });

  it('counts only the last 60 days, so an old NSFW post lapses', () => {
    expect(decideNsfwAccounts(posts('old', [true], { startDaysAgo: 61 }), NOW)).toEqual([]);
    expect(decideNsfwAccounts(posts('recent', [true], { startDaysAgo: 59 }), NOW)).toEqual(['recent']);
    // Order of the input does not matter: the newest ten are found by date.
    const shuffled = posts('shuffled', [...new Array(10).fill(false), true]).reverse();
    expect(decideNsfwAccounts(shuffled, NOW)).toEqual([]);
  });

  it('ignores posts dated after now or with no readable date', () => {
    expect(decideNsfwAccounts([
      { userId: 'future', isNsfw: true, createdAt: new Date(NOW.getTime() + 60_000).toISOString() },
      { userId: 'undated', isNsfw: true, createdAt: 'yesterday' },
    ], NOW)).toEqual([]);
  });
});

describe('decideNegativeFeedbackAccounts', () => {
  it('labels a creator above a 0.08 negative rate once they have 60 rendered deliveries', () => {
    expect(decideNegativeFeedbackAccounts([
      { creatorUserId: 'labelled', negativeFeedbackRate: 0.081, renderedCount: 60 },
      { creatorUserId: 'at-threshold', negativeFeedbackRate: 0.08, renderedCount: 500 },
      { creatorUserId: 'too-new', negativeFeedbackRate: 0.5, renderedCount: 59 },
      { creatorUserId: 'unreadable', negativeFeedbackRate: Number.NaN, renderedCount: 500 },
      { creatorUserId: 'labelled', negativeFeedbackRate: 0.2, renderedCount: 900 },
    ])).toEqual(['labelled']);
  });
});

describe('decideAccountLabels', () => {
  it('writes each label with its source and a seven-day expiry', () => {
    expect(decideAccountLabels({
      now: NOW,
      posts: posts('nsfw-author', [true]),
      creatorStats: [{ creatorUserId: 'disliked', negativeFeedbackRate: 0.3, renderedCount: 120 }],
    })).toEqual([
      {
        userId: 'nsfw-author',
        label: 'nsfw_account',
        source: ACCOUNT_LABEL_SOURCES.nsfw_account,
        expiresAt: '2026-10-19T00:00:00.000Z',
      },
      {
        userId: 'disliked',
        label: 'negative_feedback_account',
        source: ACCOUNT_LABEL_SOURCES.negative_feedback_account,
        expiresAt: '2026-10-19T00:00:00.000Z',
      },
    ]);
  });

  it('can give one account both labels', () => {
    const labels = decideAccountLabels({
      now: NOW,
      posts: posts('both', [true]),
      creatorStats: [{ creatorUserId: 'both', negativeFeedbackRate: 0.3, renderedCount: 120 }],
    });
    expect(labels.map((label) => label.label)).toEqual(['nsfw_account', 'negative_feedback_account']);
  });
});

describe('refreshAccountSafetyLabels', () => {
  type Row = Record<string, unknown>;

  function client({
    postRows = [] as Row[],
    statsRows = [] as Row[],
    readError = null as { message: string } | null,
    upsertError = null as { message: string } | null,
  } = {}) {
    const reads: Array<{ table: string; filters: Array<[string, string, unknown]>; limit?: number }> = [];
    const from = vi.fn((table: string) => {
      const read: { table: string; filters: Array<[string, string, unknown]>; limit?: number } = { table, filters: [] };
      reads.push(read);
      const query: Record<string, unknown> = {};
      for (const operator of ['eq', 'is', 'gte', 'gt']) {
        query[operator] = vi.fn((column: string, value: unknown) => {
          read.filters.push([operator, column, value]);
          return query;
        });
      }
      query.select = vi.fn(() => query);
      query.order = vi.fn(() => query);
      query.limit = vi.fn((value: number) => {
        read.limit = value;
        return query;
      });
      query.then = (resolve: (value: unknown) => unknown) => {
        if (readError) return Promise.resolve({ data: null, error: readError }).then(resolve);
        if (table === 'creator_feed_stats') return Promise.resolve({ data: statsRows, error: null }).then(resolve);
        const userFilter = read.filters.find(([operator, column]) => operator === 'eq' && column === 'user_id');
        const nsfwFilter = read.filters.find(([operator, column]) => operator === 'eq' && column === 'is_nsfw');
        const rows = postRows
          .filter((row) => !userFilter || row.user_id === userFilter[2])
          .filter((row) => !nsfwFilter || row.is_nsfw === true)
          .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
          .slice(0, read.limit ?? Number.POSITIVE_INFINITY);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      };
      return query;
    });
    const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(
      async (name) => {
        if (name === 'upsert_account_labels') return { data: null, error: upsertError };
        if (name === 'delete_expired_account_labels') return { data: 5, error: null };
        throw new Error(`Unexpected RPC ${name}`);
      },
    );
    return { client: { from, rpc } as unknown as SupabaseClient, reads, rpc };
  }

  it('reads the evidence, renews every label for seven days, then drops the expired ones', async () => {
    const db = client({
      postRows: [
        { user_id: 'nsfw-author', is_nsfw: true, created_at: daysAgo(2) },
        { user_id: 'nsfw-author', is_nsfw: false, created_at: daysAgo(1) },
        { user_id: 'cleaned-up', is_nsfw: true, created_at: daysAgo(30) },
        ...Array.from({ length: 10 }, (_, index) => ({ user_id: 'cleaned-up', is_nsfw: false, created_at: daysAgo(1 + index * 0.1) })),
      ],
      statsRows: [{ creator_user_id: 'disliked', negative_feedback_rate: 0.12, rendered_count: 80 }],
    });

    await expect(refreshAccountSafetyLabels(db.client, { now: NOW })).resolves.toEqual({
      nsfwAccounts: 1,
      negativeFeedbackAccounts: 1,
      labelsUpserted: 2,
      expiredDeleted: 5,
    });
    expect(db.rpc.mock.calls).toEqual([
      ['upsert_account_labels', {
        p_labels: [
          { user_id: 'nsfw-author', label: 'nsfw_account', source: 'nsfw_posts_60d', expires_at: '2026-10-19T00:00:00.000Z' },
          {
            user_id: 'disliked',
            label: 'negative_feedback_account',
            source: 'creator_negative_feedback_30d',
            expires_at: '2026-10-19T00:00:00.000Z',
          },
        ],
      }],
      ['delete_expired_account_labels', { p_as_of: '2026-10-12T00:00:00.000Z' }],
    ]);
    // Public, unarchived posts of the last 60 days; each author's newest ten.
    const authorRead = db.reads.find((read) => read.filters.some(([, column, value]) => column === 'user_id' && value === 'nsfw-author'));
    expect(authorRead?.filters).toEqual(expect.arrayContaining([
      ['eq', 'visibility', 'public'],
      ['is', 'archived_at', null],
      ['gte', 'created_at', '2026-08-13T00:00:00.000Z'],
    ]));
    expect(authorRead?.limit).toBe(10);
    // The 30-day creator window, filtered to the label's own thresholds.
    expect(db.reads.find((read) => read.table === 'creator_feed_stats')?.filters).toEqual([
      ['eq', 'window_key', '30d'],
      ['gt', 'negative_feedback_rate', 0.08],
      ['gte', 'rendered_count', 60],
    ]);
  });

  it('still renews (with nothing) and sweeps expired labels when no account qualifies', async () => {
    const db = client();

    await expect(refreshAccountSafetyLabels(db.client, { now: NOW })).resolves.toEqual({
      nsfwAccounts: 0,
      negativeFeedbackAccounts: 0,
      labelsUpserted: 0,
      expiredDeleted: 5,
    });
    expect(db.rpc.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ['upsert_account_labels', { p_labels: [] }],
      ['delete_expired_account_labels', { p_as_of: '2026-10-12T00:00:00.000Z' }],
    ]);
  });

  it('fails without writing when the evidence cannot be read, and names a failed write', async () => {
    const unreadable = client({ readError: { message: 'timeout' } });
    await expect(refreshAccountSafetyLabels(unreadable.client, { now: NOW })).rejects.toThrow('timeout');
    expect(unreadable.rpc).not.toHaveBeenCalled();

    const unwritable = client({ upsertError: { message: 'permission denied' } });
    await expect(refreshAccountSafetyLabels(unwritable.client, { now: NOW }))
      .rejects.toThrow('Feed maintenance RPC upsert_account_labels failed: permission denied');
    expect(unwritable.rpc.mock.calls.map(([name]) => name)).toEqual(['upsert_account_labels']);
  });
});
