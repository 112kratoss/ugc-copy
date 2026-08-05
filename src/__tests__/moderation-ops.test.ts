import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  listOpenModerationReports,
  resolvePostReport,
  resolveSubjectReport,
} from '@/lib/moderation-ops';

const REPORT_ID = '10000000-0000-4000-8000-000000000001';
const POST_ID = '20000000-0000-4000-8000-000000000002';
const REVIEWER_ID = '30000000-0000-4000-8000-000000000003';
const COMMENT_ID = '40000000-0000-4000-8000-000000000004';

function queryResult(data: unknown, error: unknown = null) {
  const result = Promise.resolve({ data, error });
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    update: vi.fn(() => query),
    maybeSingle: vi.fn(() => query),
    then: result.then.bind(result),
  };
  return query;
}

describe('moderation operations', () => {
  it('lists oldest open post and subject reports with reported-post context', async () => {
    const postReports = queryResult([{
      id: REPORT_ID,
      post_id: POST_ID,
      bundle_id: null,
      reporter_user_id: '40000000-0000-4000-8000-000000000004',
      reason: 'unsafe_content',
      details: 'Unsafe upload',
      status: 'open',
      created_at: '2026-07-21T01:00:00.000Z',
      updated_at: '2026-07-21T01:00:00.000Z',
    }]);
    const subjectReports = queryResult([{
      id: '50000000-0000-4000-8000-000000000005',
      reporter_user_id: '40000000-0000-4000-8000-000000000004',
      target_type: 'user',
      reported_user_id: '60000000-0000-4000-8000-000000000006',
      generation_id: null,
      reason: 'harassment',
      details: null,
      source_surface: 'creator-profile',
      status: 'reviewing',
      created_at: '2026-07-21T02:00:00.000Z',
      updated_at: '2026-07-21T02:30:00.000Z',
      reviewed_at: '2026-07-21T02:30:00.000Z',
      reviewed_by: REVIEWER_ID,
    }]);
    const posts = queryResult([{
      id: POST_ID,
      user_id: '70000000-0000-4000-8000-000000000007',
      title: 'Reported post',
      visibility: 'public',
      review_status: 'flagged',
      report_count: 1,
      created_at: '2026-07-20T01:00:00.000Z',
    }]);
    const from = vi.fn((table: string) => {
      if (table === 'post_reports') return postReports;
      if (table === 'moderation_reports') return subjectReports;
      if (table === 'posts') return posts;
      throw new Error(`Unexpected table ${table}`);
    });

    const snapshot = await listOpenModerationReports({ from } as unknown as SupabaseClient, { limit: 25 });

    expect(postReports.eq).toHaveBeenCalledWith('status', 'open');
    expect(postReports.limit).toHaveBeenCalledWith(25);
    expect(subjectReports.in).toHaveBeenCalledWith('status', ['open', 'reviewing']);
    expect(posts.in).toHaveBeenCalledWith('id', [POST_ID]);
    expect(snapshot.postReports[0]).toMatchObject({
      id: REPORT_ID,
      postId: POST_ID,
      reason: 'unsafe_content',
      post: {
        id: POST_ID,
        reviewStatus: 'flagged',
        reportCount: 1,
      },
    });
    expect(snapshot.subjectReports[0]).toMatchObject({
      targetType: 'user',
      status: 'reviewing',
      reviewedBy: REVIEWER_ID,
    });
  });

  it('uses the service-role RPC for an atomic, auditable post takedown', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        status: 'taken_down',
        report_id: REPORT_ID,
        post_id: POST_ID,
        report_status: 'reviewed',
        post_review_status: 'hidden',
        resolved_report_count: 2,
        reviewed_at: '2026-07-21T03:00:00.000Z',
        reviewed_by: REVIEWER_ID,
      },
      error: null,
    }));
    const post = queryResult({
      id: POST_ID,
      generation_id: '80000000-0000-4000-8000-000000000008',
      showcase_asset_path: `showcase/80000000-0000-4000-8000-000000000008/output.webp`,
      output_url: 'https://provider.example/original-output',
    });
    const postMedia = queryResult([{
      storage_path: `posts/${POST_ID}/0/proof.webp`,
      preview_storage_path: `posts/${POST_ID}/0/proof.preview.webp`,
      rendition_storage_path: `posts/${POST_ID}/0/proof.feed.mp4`,
      external_url: null,
    }]);
    const from = vi.fn((table: string) => {
      if (table === 'posts') return post;
      if (table === 'post_media') return postMedia;
      throw new Error(`Unexpected table ${table}`);
    });
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const exists = vi.fn(async () => ({ data: false, error: { status: 404 } }));
    const storageFrom = vi.fn(() => ({ remove, exists }));

    const result = await resolvePostReport({
      rpc,
      from,
      storage: { from: storageFrom },
    } as unknown as SupabaseClient, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'take_down',
      resolutionNote: 'Confirmed policy violation.',
    });

    expect(rpc).toHaveBeenCalledWith('resolve_post_report_for_ops', {
      p_report_id: REPORT_ID,
      p_reviewer_id: REVIEWER_ID,
      p_action: 'take_down',
      p_resolution_note: 'Confirmed policy violation.',
    });
    expect(result).toMatchObject({
      status: 'taken_down',
      postId: POST_ID,
      postReviewStatus: 'hidden',
      resolvedReportCount: 2,
      reviewedBy: REVIEWER_ID,
      revokedMediaCount: 4,
      mediaRevocationVerified: true,
      externalMediaRevocationRequired: true,
    });
    // The feed rendition is its own public object: a takedown that skips it
    // leaves the exact URL the feed was serving alive.
    expect(remove).toHaveBeenCalledWith([
      'showcase/80000000-0000-4000-8000-000000000008/output.webp',
      `posts/${POST_ID}/0/proof.webp`,
      `posts/${POST_ID}/0/proof.preview.webp`,
      `posts/${POST_ID}/0/proof.feed.mp4`,
    ]);
    expect(exists).toHaveBeenCalledTimes(4);
  });

  it('hydrates reported comments with enough context for an operator decision', async () => {
    const postReports = queryResult([]);
    const subjectReports = queryResult([{
      id: REPORT_ID,
      reporter_user_id: '50000000-0000-4000-8000-000000000005',
      target_type: 'comment',
      reported_user_id: null,
      generation_id: null,
      comment_id: COMMENT_ID,
      reason: 'harassment',
      details: 'Targeted abuse',
      source_surface: 'comments',
      status: 'open',
      created_at: '2026-07-21T02:00:00.000Z',
      updated_at: '2026-07-21T02:00:00.000Z',
      reviewed_at: null,
      reviewed_by: null,
    }]);
    const comments = queryResult([{
      id: COMMENT_ID,
      post_id: POST_ID,
      parent_comment_id: null,
      user_id: '60000000-0000-4000-8000-000000000006',
      body: 'Reported body',
      status: 'active',
    }]);
    const from = vi.fn((table: string) => {
      if (table === 'post_reports') return postReports;
      if (table === 'moderation_reports') return subjectReports;
      if (table === 'post_comments') return comments;
      throw new Error(`Unexpected table ${table}`);
    });

    const snapshot = await listOpenModerationReports({ from } as unknown as SupabaseClient);

    expect(comments.in).toHaveBeenCalledWith('id', [COMMENT_ID]);
    expect(snapshot.subjectReports[0]).toMatchObject({
      targetType: 'comment',
      commentId: COMMENT_ID,
      comment: {
        id: COMMENT_ID,
        postId: POST_ID,
        body: 'Reported body',
        status: 'active',
      },
    });
  });

  it('fails closed when Storage still exposes a taken-down post object', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        status: 'taken_down',
        report_id: REPORT_ID,
        post_id: POST_ID,
        report_status: 'reviewed',
        post_review_status: 'hidden',
        reviewed_at: '2026-07-21T03:00:00.000Z',
        reviewed_by: REVIEWER_ID,
      },
      error: null,
    }));
    const from = vi.fn((table: string) => table === 'posts'
      ? queryResult({
          id: POST_ID,
          generation_id: null,
          showcase_asset_path: `posts/${POST_ID}/0/proof.webp`,
          output_url: null,
        })
      : queryResult([]));
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const exists = vi.fn(async () => ({ data: true, error: null }));

    await expect(resolvePostReport({
      rpc,
      from,
      storage: { from: vi.fn(() => ({ remove, exists })) },
    } as unknown as SupabaseClient, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'take_down',
    })).rejects.toThrow('still exists after Storage revocation');
  });

  it('rejects malformed identifiers before touching the privileged client', async () => {
    const rpc = vi.fn();

    await expect(resolvePostReport({ rpc } as unknown as SupabaseClient, {
      reportId: 'not-a-uuid',
      reviewerId: REVIEWER_ID,
      action: 'dismiss',
    })).rejects.toThrow('Report id must be a UUID.');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses a subject decision that would leave no rationale', async () => {
    // A status change alone cannot answer an appeal, so the resolver rejects
    // an empty rationale before it reaches the database.
    const rpc = vi.fn();

    for (const note of ['', '   ', 'ab', 'x'.repeat(1001)]) {
      await expect(resolveSubjectReport({ rpc } as unknown as SupabaseClient, {
        reportId: REPORT_ID,
        reviewerId: REVIEWER_ID,
        action: 'resolve',
        resolutionNote: note,
      })).rejects.toThrow(/resolution note/i);
    }

    expect(rpc).not.toHaveBeenCalled();
  });

  it('uses the atomic subject resolver and reports comment enforcement details', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        status: 'resolved',
        report_id: REPORT_ID,
        target_type: 'comment',
        comment_id: COMMENT_ID,
        comment_status: 'removed_by_moderation',
        comment_removed: true,
        resolved_report_count: 2,
        reviewed_at: '2026-07-21T04:00:00.000Z',
        reviewed_by: REVIEWER_ID,
      },
      error: null,
    }));

    const result = await resolveSubjectReport({ rpc } as unknown as SupabaseClient, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'resolve',
      resolutionNote: '  Confirmed policy 4.2 violation.  ',
    });

    expect(rpc).toHaveBeenCalledWith('resolve_subject_report_for_ops', {
      p_report_id: REPORT_ID,
      p_reviewer_id: REVIEWER_ID,
      p_action: 'resolve',
      p_resolution_note: 'Confirmed policy 4.2 violation.',
    });
    expect(result).toEqual({
      status: 'resolved',
      reportId: REPORT_ID,
      targetType: 'comment',
      commentId: COMMENT_ID,
      commentStatus: 'removed_by_moderation',
      commentRemoved: true,
      resolvedReportCount: 2,
      reviewedAt: '2026-07-21T04:00:00.000Z',
      reviewedBy: REVIEWER_ID,
    });
  });
});
