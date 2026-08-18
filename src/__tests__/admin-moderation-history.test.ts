import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { collectAdminModerationHistory } from '@/lib/admin-moderation-service';
import { listResolvedModerationReports } from '@/lib/moderation-ops';

const POST_REPORT_ID = '10000000-0000-4000-8000-000000000001';
const POST_ID = '20000000-0000-4000-8000-000000000002';
const REVIEWER_ID = '30000000-0000-4000-8000-000000000003';
const SUBJECT_REPORT_ID = '40000000-0000-4000-8000-000000000004';
const REPORTED_USER_ID = '50000000-0000-4000-8000-000000000005';
const UNKNOWN_REVIEWER_ID = '60000000-0000-4000-8000-000000000006';

type Call = { table: string; method: string; args: unknown[] };

/**
 * PostgREST stand-in that records every filter so the tests can assert which
 * statuses each table was queried for and which window each was paged to.
 */
function createClient(
  rows: Record<string, Array<Record<string, unknown>>>,
  counts: Record<string, number> = {},
  calls: Call[] = [],
) {
  return {
    from(table: string) {
      const result = {
        data: rows[table] ?? [],
        error: null,
        count: counts[table] ?? (rows[table]?.length ?? 0),
      };
      const builder: Record<string, unknown> = {};
      const record = (method: string) => (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
      Object.assign(builder, {
        select: record('select'),
        in: record('in'),
        order: record('order'),
        eq: record('eq'),
        range: (...args: unknown[]) => {
          calls.push({ table, method: 'range', args });
          return Promise.resolve(result);
        },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      });
      return builder;
    },
  } as unknown as SupabaseClient;
}

const RESOLVED_POST_REPORT = {
  id: POST_REPORT_ID,
  post_id: POST_ID,
  bundle_id: null,
  reporter_user_id: null,
  reason: 'nudity',
  details: 'Explicit thumbnail',
  status: 'reviewed',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
  reviewed_at: '2026-08-02T00:00:00.000Z',
  reviewed_by: REVIEWER_ID,
  resolution_action: 'take_down',
  resolution_note: 'Violates section 4.2.',
};

const RESOLVED_SUBJECT_REPORT = {
  id: SUBJECT_REPORT_ID,
  reporter_user_id: null,
  target_type: 'user',
  reported_user_id: REPORTED_USER_ID,
  generation_id: null,
  comment_id: null,
  reason: 'harassment',
  details: null,
  source_surface: 'profile',
  status: 'dismissed',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-03T00:00:00.000Z',
  reviewed_at: '2026-08-03T00:00:00.000Z',
  reviewed_by: UNKNOWN_REVIEWER_ID,
  resolution_note: null,
};

const POST_ROW = {
  id: POST_ID,
  user_id: REPORTED_USER_ID,
  title: 'A reported post',
  visibility: 'public',
  review_status: 'hidden',
  report_count: 2,
  created_at: '2026-07-30T00:00:00.000Z',
};

describe('listResolvedModerationReports', () => {
  it('queries only decided reports, using each table\'s own resolved vocabulary', async () => {
    const calls: Call[] = [];
    const client = createClient(
      {
        post_reports: [RESOLVED_POST_REPORT],
        moderation_reports: [RESOLVED_SUBJECT_REPORT],
        posts: [POST_ROW],
      },
      {},
      calls,
    );

    await listResolvedModerationReports(client, { limit: 25 });

    const statusFilters = calls.filter((call) => call.method === 'in' && call.args[0] === 'status');
    expect(statusFilters).toEqual([
      { table: 'post_reports', method: 'in', args: ['status', ['reviewed', 'dismissed']] },
      { table: 'moderation_reports', method: 'in', args: ['status', ['resolved', 'dismissed']] },
    ]);
  });

  // The two families live in separate tables with very different volumes. A
  // shared cursor paged the short list past its end as soon as the operator
  // advanced the long one.
  it('pages each report family with its own offset', async () => {
    const calls: Call[] = [];
    const client = createClient(
      { post_reports: [], moderation_reports: [] },
      {},
      calls,
    );

    await listResolvedModerationReports(client, { limit: 25, postOffset: 50, subjectOffset: 0 });

    const postRange = calls.find((call) => call.table === 'post_reports' && call.method === 'range');
    const subjectRange = calls.find((call) => call.table === 'moderation_reports' && call.method === 'range');

    expect(postRange?.args).toEqual([50, 74]);
    expect(subjectRange?.args).toEqual([0, 24]);
  });

  it('reports the full resolved count so a pager knows a next page exists', async () => {
    const client = createClient(
      { post_reports: [RESOLVED_POST_REPORT], moderation_reports: [], posts: [POST_ROW] },
      { post_reports: 312, moderation_reports: 7 },
    );

    const history = await listResolvedModerationReports(client, { limit: 25 });

    expect(history.totals).toEqual({ postReports: 312, subjectReports: 7 });
  });

  it('carries the reviewer, action and rationale that an appeal is answered from', async () => {
    const client = createClient({
      post_reports: [RESOLVED_POST_REPORT],
      moderation_reports: [],
      posts: [POST_ROW],
    });

    const history = await listResolvedModerationReports(client, { limit: 25 });

    expect(history.postReports[0]).toMatchObject({
      id: POST_REPORT_ID,
      reviewedBy: REVIEWER_ID,
      resolutionAction: 'take_down',
      resolutionNote: 'Violates section 4.2.',
      post: { title: 'A reported post', reviewStatus: 'hidden' },
    });
  });

  it('rejects a negative offset rather than letting PostgREST reinterpret it', async () => {
    const client = createClient({ post_reports: [], moderation_reports: [] });

    await expect(listResolvedModerationReports(client, { postOffset: -1 }))
      .rejects.toThrow(/non-negative integer/);
  });
});

describe('collectAdminModerationHistory', () => {
  it('resolves reviewer ids to names, and leaves an unknown reviewer as a bare id', async () => {
    const client = createClient({
      post_reports: [RESOLVED_POST_REPORT],
      moderation_reports: [RESOLVED_SUBJECT_REPORT],
      posts: [POST_ROW],
      profiles: [{ id: REVIEWER_ID, username: 'operator', display_name: 'Ops One' }],
    });

    const history = await collectAdminModerationHistory(client);

    expect(history.reviewers[REVIEWER_ID]).toEqual({ username: 'operator', displayName: 'Ops One' });
    // The decision must still be listed; only the name is missing.
    expect(history.reviewers[UNKNOWN_REVIEWER_ID]).toBeUndefined();
    expect(history.subjectReports[0].reviewedBy).toBe(UNKNOWN_REVIEWER_ID);
  });

  it('skips the profile lookup entirely when no page row has a reviewer', async () => {
    const calls: Call[] = [];
    const client = createClient({ post_reports: [], moderation_reports: [] }, {}, calls);

    await collectAdminModerationHistory(client);

    expect(calls.some((call) => call.table === 'profiles')).toBe(false);
  });

  it('echoes both offsets back so each pager renders its own window', async () => {
    const client = createClient({ post_reports: [], moderation_reports: [] });

    const history = await collectAdminModerationHistory(client, { postOffset: 25, subjectOffset: 50 });

    expect(history.postOffset).toBe(25);
    expect(history.subjectOffset).toBe(50);
  });
});
