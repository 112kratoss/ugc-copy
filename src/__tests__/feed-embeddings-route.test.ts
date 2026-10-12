import { afterEach, describe, expect, it, vi } from 'vitest';

type LockMockResult =
  | { acquired: true; value: unknown }
  | { acquired: false; reason: 'already_running' };

const embeddingState = vi.hoisted(() => ({
  hasWork: vi.fn(async () => true),
  run: vi.fn(async () => ({
    asOf: '2026-10-01T12:00:00.000Z',
    pending: 30,
    embedded: 28,
    skipped: 2,
    failed: 0,
    clustering: { status: 'reclustered', embeddings: 120, clusters: 15, assigned: 120 },
    nearDuplicates: { checked: 28, marked: 1, matchFailures: 0 },
  })),
}));

const lockState = vi.hoisted(() => ({
  withLock: vi.fn(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
    acquired: true,
    value: await task(),
  })),
}));

const jobRunState = vi.hoisted(() => ({
  finish: vi.fn(async () => undefined),
  prune: vi.fn(async () => 0),
  start: vi.fn(async (_client, options: { name: string; route: string; requestId: string }) => ({
    id: 'run-embeddings-1',
    ...options,
  })),
}));

vi.mock('@/lib/feed-embeddings', () => ({
  hasFeedEmbeddingWork: embeddingState.hasWork,
  runFeedEmbeddingJob: embeddingState.run,
}));

vi.mock('@/lib/backend-job-lock', () => ({
  withBackendJobLock: lockState.withLock,
}));

vi.mock('@/lib/backend-job-runs', () => ({
  finishBackendJobRun: jobRunState.finish,
  maybePruneBackendJobRuns: jobRunState.prune,
  startBackendJobRun: jobRunState.start,
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

describe('feed embeddings cron', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    jobRunState.finish.mockClear();
    jobRunState.start.mockClear();
    embeddingState.hasWork.mockClear();
    embeddingState.hasWork.mockResolvedValue(true);
    embeddingState.run.mockClear();
    lockState.withLock.mockClear();
  });

  it('declares the 120 s the registry gives the job', async () => {
    const route = await import('@/app/api/cron/feed-embeddings/route');
    expect(route.maxDuration).toBe(120);
    expect(route.runtime).toBe('nodejs');
  });

  it('rejects unauthorized requests before creating a job run', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const { GET } = await import('@/app/api/cron/feed-embeddings/route');

    const response = await GET(new Request('http://localhost/api/cron/feed-embeddings', {
      headers: { 'x-request-id': 'feed-embeddings-reject-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('x-request-id')).toBe('feed-embeddings-reject-1');
    expect(jobRunState.start).not.toHaveBeenCalled();
    expect(embeddingState.run).not.toHaveBeenCalled();
  });

  it('embeds, clusters and de-duplicates behind the job lock and reports the counts', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
    const { GET } = await import('@/app/api/cron/feed-embeddings/route');

    const response = await GET(new Request('http://localhost/api/cron/feed-embeddings', {
      headers: { authorization: 'Bearer secret', 'x-request-id': 'feed-embeddings-run-1' },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: { embedded: 28, skipped: 2, clustering: { clusters: 15 }, nearDuplicates: { marked: 1 } },
    });
    expect(jobRunState.start).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ name: 'feed-embeddings', route: '/api/cron/feed-embeddings', requestId: 'feed-embeddings-run-1' }),
    );
    expect(lockState.withLock).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ name: 'feed-embeddings', ttlSeconds: 600 }),
      expect.any(Function),
    );
    expect(embeddingState.run).toHaveBeenCalledWith({ service: true }, { now: new Date('2026-10-01T12:00:00.000Z') });
  });

  it('skips with its own reason when nothing waits for an embedding', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    embeddingState.hasWork.mockResolvedValue(false);
    const { GET } = await import('@/app/api/cron/feed-embeddings/route');

    const response = await GET(new Request('http://localhost/api/cron/feed-embeddings', {
      headers: { authorization: 'Bearer secret' },
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ skipped: true, reason: 'no_posts_pending_embedding' });
    expect(embeddingState.run).not.toHaveBeenCalled();
  });

  it('returns a retryable failure and records the failed run', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    embeddingState.run.mockRejectedValueOnce(new Error('Feed embeddings could not reach embed-post: all 2 request(s) failed'));
    const { GET } = await import('@/app/api/cron/feed-embeddings/route');

    const response = await GET(new Request('http://localhost/api/cron/feed-embeddings', {
      headers: { authorization: 'Bearer secret' },
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to embed feed posts.' });
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ id: 'run-embeddings-1' }),
      expect.objectContaining({ status: 'failed', errorMessage: expect.stringContaining('embed-post') }),
    );
  });
});
