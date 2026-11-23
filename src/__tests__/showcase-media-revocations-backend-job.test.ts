// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink } from '@/lib/backend-logger';

import { createFakeBackendJobRunsDatabase } from './fixtures/fake-backend-job-runs-database';

const passes = vi.hoisted(() => ({
  order: [] as string[],
  stuckCreationCopy: false,
}));

vi.mock('@/lib/showcase-media-revocations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/showcase-media-revocations')>();
  return {
    ...actual,
    hasPendingShowcaseMediaRevocations: vi.fn(async () => true),
    processShowcaseMediaRevocations: vi.fn(async () => {
      passes.order.push('creation copies');
      const summary = { due: 1, removed: 0, stillServing: 0, outsidePrefix: 0, rescheduled: 1, stuck: passes.stuckCreationCopy ? 1 : 0 };
      if (passes.stuckCreationCopy) throw new actual.ShowcaseMediaRevocationsStuckError(summary);
      return summary;
    }),
  };
});

vi.mock('@/lib/uploaded-media-maintenance', () => ({
  hasPendingUploadedMediaMaintenance: vi.fn(async () => false),
  processUploadedMediaMaintenance: vi.fn(async () => {
    passes.order.push('uploaded media');
    return { revokedPublicCopies: 0, removedPrivateObjects: 0, retainedPrivateObjects: 0 };
  }),
}));

const POST = 'b9800000-0000-4000-8000-000000000001';
const OWNER = 'a9800000-0000-4000-8000-000000000001';

vi.mock('@/lib/post-media-public-copies', () => ({
  hasPendingPostMediaPublicCopyWork: vi.fn(async () => true),
  maintainPostMediaPublicCopies: vi.fn(async () => {
    passes.order.push('post media public copies');
    return {
      removal: { due: 2, held: 0, released: 0, removed: 2, served: 0, gone: 0, rescheduled: 0, stuck: 0 },
      synced: { posts: 1, committed: 1, refused: 0, failed: 0 },
      copiedPosts: [{ postId: POST, ownerUserId: OWNER }],
    };
  }),
}));

const cache = vi.hoisted(() => ({
  invalidateShowcaseFeedAndRefreshPostPages: vi.fn(async () => {}),
}));
vi.mock('@/lib/showcase-feed-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/showcase-feed-cache')>()),
  invalidateShowcaseFeedAndRefreshPostPages: cache.invalidateShowcaseFeedAndRefreshPostPages,
}));

const T0 = Date.parse('2026-11-23T12:30:00.000Z');

describe('the showcase-media-revocations backend job', () => {
  let clock: { nowMs: number };
  let db: ReturnType<typeof createFakeBackendJobRunsDatabase>;
  let restoreSink: () => void;

  beforeEach(() => {
    clock = { nowMs: T0 };
    db = createFakeBackendJobRunsDatabase(clock);
    restoreSink = setBackendLogSink(() => {});
    passes.order.length = 0;
    passes.stuckCreationCopy = false;
    cache.invalidateShowcaseFeedAndRefreshPostPages.mockClear();
  });

  afterEach(() => {
    restoreSink();
    vi.restoreAllMocks();
  });

  async function runJob() {
    const { runShowcaseMediaRevocationsBackendJob } = await import('@/lib/backend-job-executions');
    return runShowcaseMediaRevocationsBackendJob({
      serviceClient: db.client as never,
      requestId: 'scheduler-1:showcase-media-revocations',
      startedAtMs: T0,
      triggerRoute: '/api/cron/showcase-media-revocations',
    });
  }

  it('removes queued public copies of uploaded media and refreshes the pages of posts it copied', async () => {
    const result = await runJob();

    expect(result).toMatchObject({
      status: 'succeeded',
      summary: {
        postMediaPublicCopies: {
          removal: { removed: 2 },
          synced: { posts: 1, committed: 1 },
        },
      },
    });
    expect(passes.order).toEqual(['creation copies', 'uploaded media', 'post media public copies']);
    expect(cache.invalidateShowcaseFeedAndRefreshPostPages).toHaveBeenCalledWith(db.client, {
      postId: POST,
      creatorId: OWNER,
      arrived: false,
    });
  });

  it('never lets a stuck creation copy hold back the other removals, and still fails the run', async () => {
    passes.stuckCreationCopy = true;

    const result = await runJob();

    expect(passes.order).toEqual(['creation copies', 'uploaded media', 'post media public copies']);
    expect(result).toMatchObject({ status: 'failed' });
  });
});
