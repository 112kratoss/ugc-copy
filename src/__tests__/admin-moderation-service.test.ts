import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const cacheMocks = vi.hoisted(() => ({
  SHOWCASE_FEED_CACHE_TAG: 'showcase-feed:v2',
  invalidateShowcaseFeedCache: vi.fn(),
}));

const moderationOpsMocks = vi.hoisted(() => ({
  listOpenModerationReports: vi.fn(),
  resolvePostReport: vi.fn(),
  resolveSubjectReport: vi.fn(),
  applyPostModerationAction: vi.fn(),
}));

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);
vi.mock('@/lib/moderation-ops', () => moderationOpsMocks);

import {
  applyAdminPostModeration,
  applyAdminPostReportDecision,
  applyAdminSubjectReportDecision,
} from '@/lib/admin-moderation-service';

const REPORT_ID = '10000000-0000-4000-8000-000000000001';
const POST_ID = '20000000-0000-4000-8000-000000000002';
const REVIEWER_ID = '30000000-0000-4000-8000-000000000003';

// The service only forwards to moderation-ops; no Supabase call is made here.
const client = {} as unknown as SupabaseClient;

function postResolution(overrides: Record<string, unknown> = {}) {
  return {
    status: 'taken_down',
    reportId: REPORT_ID,
    postId: POST_ID,
    reportStatus: 'reviewed',
    reviewedAt: '2026-08-05T03:00:00.000Z',
    reviewedBy: REVIEWER_ID,
    resolutionAction: 'take_down',
    ...overrides,
  };
}

describe('applyAdminPostReportDecision', () => {
  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
    moderationOpsMocks.resolvePostReport.mockReset();
    moderationOpsMocks.resolveSubjectReport.mockReset();
  });

  it('invalidates the showcase feed after a take-down so cached pages stop serving it', async () => {
    moderationOpsMocks.resolvePostReport.mockResolvedValue(postResolution());

    const result = await applyAdminPostReportDecision(client, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'take_down',
      resolutionNote: '  Confirmed policy violation.  ',
    });

    expect(moderationOpsMocks.resolvePostReport).toHaveBeenCalledWith(client, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'take_down',
      resolutionNote: 'Confirmed policy violation.',
    });
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('taken_down');
  });

  // A retried take-down re-sweeps storage in moderation-ops, so it must
  // re-invalidate too -- the first attempt may have failed after the RPC.
  it('invalidates when an already-resolved report was itself a take-down', async () => {
    moderationOpsMocks.resolvePostReport.mockResolvedValue(postResolution({
      status: 'already_resolved',
      resolutionAction: 'take_down',
    }));

    await applyAdminPostReportDecision(client, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'take_down',
      resolutionNote: 'Retrying after a partial failure.',
    });

    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  it('leaves the feed cache alone when a report is dismissed', async () => {
    moderationOpsMocks.resolvePostReport.mockResolvedValue(postResolution({
      status: 'dismissed',
      resolutionAction: 'dismiss',
    }));

    await applyAdminPostReportDecision(client, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'dismiss',
      resolutionNote: 'Report was not actionable.',
    });

    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('does not invalidate when an already-resolved report was a dismissal', async () => {
    moderationOpsMocks.resolvePostReport.mockResolvedValue(postResolution({
      status: 'already_resolved',
      resolutionAction: 'dismiss',
    }));

    await applyAdminPostReportDecision(client, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'take_down',
      resolutionNote: 'Someone else already dismissed this.',
    });

    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('requires a resolution note before touching the moderation core', async () => {
    await expect(applyAdminPostReportDecision(client, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'take_down',
      resolutionNote: '   ',
    })).rejects.toThrow('A resolution note is required.');

    expect(moderationOpsMocks.resolvePostReport).not.toHaveBeenCalled();
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });
});

describe('applyAdminSubjectReportDecision', () => {
  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
    moderationOpsMocks.resolveSubjectReport.mockReset();
  });

  it('requires a resolution note', async () => {
    await expect(applyAdminSubjectReportDecision(client, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'resolve',
      resolutionNote: '',
    })).rejects.toThrow('A resolution note is required.');

    expect(moderationOpsMocks.resolveSubjectReport).not.toHaveBeenCalled();
  });

  it('forwards a trimmed note to the moderation core', async () => {
    moderationOpsMocks.resolveSubjectReport.mockResolvedValue({
      status: 'resolved',
      reportId: REPORT_ID,
      reviewedAt: '2026-08-05T03:00:00.000Z',
      reviewedBy: REVIEWER_ID,
      targetType: 'comment',
      commentId: null,
      commentStatus: 'removed',
      commentRemoved: true,
    });

    await applyAdminSubjectReportDecision(client, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'resolve',
      resolutionNote: '  Removed the comment.  ',
    });

    expect(moderationOpsMocks.resolveSubjectReport).toHaveBeenCalledWith(client, {
      reportId: REPORT_ID,
      reviewerId: REVIEWER_ID,
      action: 'resolve',
      resolutionNote: 'Removed the comment.',
    });
  });
});


describe('applyAdminPostModeration', () => {
  const moderationResult = (overrides: Record<string, unknown> = {}) => ({
    status: 'applied',
    actionId: '40000000-0000-4000-8000-000000000004',
    postId: POST_ID,
    action: 'hide',
    postReviewStatus: 'hidden',
    postReviewStatusBefore: 'visible',
    mediaRevocationRequired: false,
    resolvedReportCount: 0,
    affectedBundleCount: 0,
    affectedAssetCount: 0,
    error: null,
    ...overrides,
  });

  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
    moderationOpsMocks.applyPostModerationAction.mockReset();
  });

  it('refuses an action with no rationale before touching the database', async () => {
    await expect(applyAdminPostModeration(client, {
      postId: POST_ID,
      reviewerId: REVIEWER_ID,
      action: 'hide',
      reason: '   ',
      idempotencyKey: 'key-1',
    })).rejects.toThrow('A reason is required.');

    expect(moderationOpsMocks.applyPostModerationAction).not.toHaveBeenCalled();
  });

  it.each(['hide', 'take_down', 'restore'] as const)(
    'invalidates the showcase feed after a %s so cached pages stop disagreeing with the database',
    async (action) => {
      moderationOpsMocks.applyPostModerationAction.mockResolvedValue(moderationResult({ action }));

      await applyAdminPostModeration(client, {
        postId: POST_ID,
        reviewerId: REVIEWER_ID,
        action,
        reason: 'policy 4.2',
        idempotencyKey: `key-${action}`,
      });

      expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
    },
  );

  it('re-invalidates on a replayed action, matching the re-sweep moderation-ops performs', async () => {
    moderationOpsMocks.applyPostModerationAction.mockResolvedValue(
      moderationResult({ status: 'already_applied' }),
    );

    await applyAdminPostModeration(client, {
      postId: POST_ID,
      reviewerId: REVIEWER_ID,
      action: 'take_down',
      reason: 'policy 4.2',
      idempotencyKey: 'key-replay',
    });

    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  it.each(['not_found', 'invalid', 'not_restorable'] as const)(
    'does not invalidate the feed when the action was rejected (%s)',
    async (status) => {
      moderationOpsMocks.applyPostModerationAction.mockResolvedValue(moderationResult({ status }));

      await applyAdminPostModeration(client, {
        postId: POST_ID,
        reviewerId: REVIEWER_ID,
        action: 'restore',
        reason: 'policy 4.2',
        idempotencyKey: `key-${status}`,
      });

      expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
    },
  );

  it('forwards the trimmed reason and the caller\'s idempotency key unchanged', async () => {
    moderationOpsMocks.applyPostModerationAction.mockResolvedValue(moderationResult());

    await applyAdminPostModeration(client, {
      postId: POST_ID,
      reviewerId: REVIEWER_ID,
      action: 'hide',
      reason: '  policy 4.2  ',
      idempotencyKey: 'key-stable',
    });

    expect(moderationOpsMocks.applyPostModerationAction).toHaveBeenCalledWith(client, {
      postId: POST_ID,
      reviewerId: REVIEWER_ID,
      action: 'hide',
      reason: 'policy 4.2',
      idempotencyKey: 'key-stable',
    });
  });
});
