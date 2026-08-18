import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { collectAdminActivity } from '@/lib/admin-activity-service';

function client(rows: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const result = { data: rows[table] ?? [], error: null };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        not: chain,
        order: chain,
        limit: () => Promise.resolve(result),
      });
      return builder;
    },
  } as unknown as SupabaseClient;
}

const SOURCES = {
  admin_credit_adjustments: [{
    id: 'c1', user_id: 'u1', reviewer_id: 'r1',
    credits_delta: 0, promotional_credits_delta: 500,
    reason: 'Goodwill.', created_at: '2026-08-18T10:00:00.000Z',
  }],
  admin_user_sanctions: [{
    id: 's1', user_id: 'u2', reviewer_id: 'r1', action: 'suspend',
    reason: 'Spam ring.', suspended_until: '2026-08-25T00:00:00.000Z',
    created_at: '2026-08-18T12:00:00.000Z',
  }],
  post_reports: [{
    id: 'p1', post_id: 'post-abc', reviewed_by: 'r1',
    reviewed_at: '2026-08-18T11:00:00.000Z',
    resolution_action: 'take_down', resolution_note: 'Policy 2.1.',
  }],
  moderation_reports: [{
    id: 'm1', reported_user_id: 'u2', reviewed_by: 'r1',
    reviewed_at: '2026-08-18T09:00:00.000Z', status: 'dismissed', resolution_note: null,
  }],
  creator_payout_requests: [{
    id: 'y1', user_id: 'u1', resolved_by: 'r1',
    resolved_at: '2026-08-18T08:00:00.000Z', status: 'paid',
    resolution_note: 'NEFT.', amount_token_subunits: 1200000,
  }],
};

describe('collectAdminActivity', () => {
  it('merges every action type into one newest-first feed', async () => {
    const feed = await collectAdminActivity(client(SOURCES));

    expect(feed.total).toBe(5);
    expect(feed.entries.map((entry) => entry.kind)).toEqual([
      'user-sanction',
      'post-moderation',
      'credit-adjustment',
      'subject-moderation',
      'payout',
    ]);
  });

  it('times each entry by when the operator acted, not when the record was created', async () => {
    const feed = await collectAdminActivity(client(SOURCES));

    // The payout row was requested long before it was resolved; the feed uses
    // resolved_at, which is when a human made a decision.
    const payout = feed.entries.find((entry) => entry.kind === 'payout');
    expect(payout?.at).toBe('2026-08-18T08:00:00.000Z');
    const postDecision = feed.entries.find((entry) => entry.kind === 'post-moderation');
    expect(postDecision?.at).toBe('2026-08-18T11:00:00.000Z');
  });

  it('keeps a suspension expiry raw so the page can format it', async () => {
    const feed = await collectAdminActivity(client(SOURCES));
    const sanction = feed.entries.find((entry) => entry.kind === 'user-sanction');

    expect(sanction?.summary).toBe('Sign-in blocked until');
    expect(sanction?.summaryUntil).toBe('2026-08-25T00:00:00.000Z');
    // A reinstatement has nothing to expire.
    expect(feed.entries.find((entry) => entry.kind === 'payout')?.summaryUntil).toBeNull();
  });

  it('carries the rationale, and marks its absence rather than dropping the row', async () => {
    const feed = await collectAdminActivity(client(SOURCES));

    expect(feed.entries.find((entry) => entry.kind === 'credit-adjustment')?.rationale).toBe('Goodwill.');
    const noNote = feed.entries.find((entry) => entry.kind === 'subject-moderation');
    expect(noNote).toBeDefined();
    expect(noNote?.rationale).toBeNull();
  });

  it('describes a balance change by its direction and column', async () => {
    const feed = await collectAdminActivity(client(SOURCES));

    expect(feed.entries.find((entry) => entry.kind === 'credit-adjustment')?.summary)
      .toBe('+500 promotional');
  });

  it('pages the merged list and falls back to page one past the end', async () => {
    const page = await collectAdminActivity(client(SOURCES), { pageSize: 2, offset: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.offset).toBe(2);

    const beyond = await collectAdminActivity(client(SOURCES), { pageSize: 2, offset: 500 });
    expect(beyond.offset).toBe(0);
    expect(beyond.entries).toHaveLength(2);
  });

  it('reports nothing truncated when every source is under its cap', async () => {
    const feed = await collectAdminActivity(client(SOURCES));
    expect(feed.truncated).toBe(false);
  });

  /** A silently capped audit log reads as "this is everything" when it is not. */
  it('flags truncation when a source fills its fetch cap', async () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      id: `c${index}`, user_id: 'u1', reviewer_id: 'r1',
      credits_delta: 1, promotional_credits_delta: 0,
      reason: 'bulk', created_at: '2026-08-18T10:00:00.000Z',
    }));

    const feed = await collectAdminActivity(client({ ...SOURCES, admin_credit_adjustments: many }));

    expect(feed.truncated).toBe(true);
  });

  it('surfaces a query failure instead of reporting a partial log as complete', async () => {
    const failing = {
      from: () => {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        Object.assign(builder, {
          select: chain, not: chain, order: chain,
          limit: () => Promise.resolve({ data: null, error: new Error('permission denied') }),
        });
        return builder;
      },
    } as unknown as SupabaseClient;

    await expect(collectAdminActivity(failing)).rejects.toThrow(/permission denied/);
  });
});
