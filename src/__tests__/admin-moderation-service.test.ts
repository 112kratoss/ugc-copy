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
}));

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);
vi.mock('@/lib/moderation-ops', () => moderationOpsMocks);

import {
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
