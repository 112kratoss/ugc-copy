import { beforeEach, describe, expect, it, vi } from 'vitest';

type LockMockResult =
  | { acquired: true; value: unknown }
  | { acquired: false; reason: 'already_running' };

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  finishBackendJobRun: vi.fn(async (_client: unknown, _run: unknown, _options: unknown) => {
    void _client;
    void _run;
    void _options;
  }),
  pruneBackendJobRuns: vi.fn(async (_client: unknown, _options?: unknown) => {
    void _client;
    void _options;
    return 0;
  }),
  maybePruneGenerationCompletionJobs: vi.fn(async (_client: unknown, _options?: unknown) => {
    void _client;
    void _options;
    return 3;
  }),
  processGenerationCompletionJobs: vi.fn(),
  pruneGenerationCompletionJobs: vi.fn(),
  startBackendJobRun: vi.fn(async (_client, options: {
    name: string;
    route: string;
    requestId: string;
    lockOwner: string;
    startedAtMs: number;
  }) => ({
    id: 'run-1',
    ...options,
  })),
  withBackendJobLock: vi.fn(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
    acquired: true,
    value: await task(),
  })),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: (...args: unknown[]) => mocks.createServiceClient(...args),
}));

vi.mock('@/lib/backend-job-lock', () => ({
  withBackendJobLock: (client: unknown, options: unknown, task: () => Promise<unknown>) => (
    mocks.withBackendJobLock(client, options, task)
  ),
}));

vi.mock('@/lib/backend-job-runs', () => ({
  finishBackendJobRun: (client: unknown, run: unknown, options: unknown) => (
    mocks.finishBackendJobRun(client, run, options)
  ),
  maybePruneBackendJobRuns: (client: unknown, options: unknown) => mocks.pruneBackendJobRuns(client, options),
  startBackendJobRun: (client: unknown, options: unknown) => mocks.startBackendJobRun(
    client,
    options as {
      name: string;
      route: string;
      requestId: string;
      lockOwner: string;
      startedAtMs: number;
    },
  ),
}));

vi.mock('@/lib/generation-completion-jobs', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-completion-jobs')>(
    '@/lib/generation-completion-jobs',
  );
  return {
    ...actual,
    maybePruneGenerationCompletionJobs: (client: unknown, options?: unknown) => (
      mocks.maybePruneGenerationCompletionJobs(client, options)
    ),
    processGenerationCompletionJobs: (...args: unknown[]) => mocks.processGenerationCompletionJobs(...args),
    pruneGenerationCompletionJobs: (...args: unknown[]) => mocks.pruneGenerationCompletionJobs(...args),
  };
});

describe('/api/cron/generation-completions route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createServiceClient.mockReset();
    mocks.finishBackendJobRun.mockClear();
    mocks.pruneBackendJobRuns.mockClear();
    mocks.maybePruneGenerationCompletionJobs.mockReset();
    mocks.processGenerationCompletionJobs.mockReset();
    mocks.pruneGenerationCompletionJobs.mockReset();
    mocks.startBackendJobRun.mockClear();
    mocks.withBackendJobLock.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
    mocks.processGenerationCompletionJobs.mockResolvedValue({
      claimed: 2,
      completed: 1,
      retried: 1,
      failed: 0,
    });
    mocks.maybePruneGenerationCompletionJobs.mockResolvedValue(3);
    mocks.pruneGenerationCompletionJobs.mockResolvedValue(3);
    mocks.withBackendJobLock.mockImplementation(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
      acquired: true,
      value: await task(),
    }));
    process.env.CRON_SECRET = 'secret-123';
  });

  it('runs the durable completion drain for authorized cron calls', async () => {
    const { GET } = await import('@/app/api/cron/generation-completions/route');
    const response = await GET(new Request('http://localhost/api/cron/generation-completions', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(200);
    expect(mocks.startBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({
        name: 'generation-completions',
        route: '/api/cron/generation-completions',
      }),
    );
    expect(mocks.withBackendJobLock).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({
        name: 'generation-completions',
        ttlSeconds: 840,
      }),
      expect.any(Function),
    );
    expect(mocks.processGenerationCompletionJobs).toHaveBeenCalledWith({
      supabase: { service: 'supabase' },
      creditSupabase: { service: 'supabase' },
      lockedBy: expect.stringMatching(/^generation-completions:/),
      limit: 25,
    });
    expect(mocks.maybePruneGenerationCompletionJobs).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    expect(mocks.pruneGenerationCompletionJobs).not.toHaveBeenCalled();
    expect(mocks.finishBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        status: 'succeeded',
        summary: {
          claimed: 2,
          completed: 1,
          retried: 1,
          failed: 0,
          pruned: 3,
        },
      }),
    );
    expect(mocks.pruneBackendJobRuns).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: {
        claimed: 2,
        pruned: 3,
      },
    });
  });
});
