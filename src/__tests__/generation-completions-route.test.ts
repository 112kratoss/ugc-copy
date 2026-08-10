import { beforeEach, describe, expect, it, vi } from 'vitest';

type LockMockResult =
  | { acquired: true; value: unknown }
  | { acquired: false; reason: 'already_running' };

const stalledReapSummary = {
  providerSync: { eligible: 1, reconciled: 1, stillActive: 0, skipped: 0, failed: 0, deferred: 0 },
  startFailures: { eligible: 1, settled: 1, skipped: 0, failed: 0, deferred: 0 },
};

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  hasStalledGenerationWork: vi.fn(async (_client: unknown, _options?: unknown) => {
    void _client;
    void _options;
    return false;
  }),
  reapStalledGenerations: vi.fn(),
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
  hasDueGenerationCompletionJobs: vi.fn(async (_client: unknown, _options?: unknown) => {
    void _client;
    void _options;
    return true;
  }),
  processGenerationCompletionJobs: vi.fn(),
  processGenerationOutputImportJobs: vi.fn(),
  processTemplateRunJobs: vi.fn(),
  processWorkflowRunStepJobs: vi.fn(),
  hasDueGenerationOutputImportJobs: vi.fn(),
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

vi.mock('@/lib/stalled-generation-reaper', () => ({
  hasStalledGenerationWork: (client: unknown, options?: unknown) => (
    mocks.hasStalledGenerationWork(client, options)
  ),
  reapStalledGenerations: (...args: unknown[]) => mocks.reapStalledGenerations(...args),
}));

vi.mock('@/lib/generation-completion-jobs', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-completion-jobs')>(
    '@/lib/generation-completion-jobs',
  );
  return {
    ...actual,
    hasDueGenerationCompletionJobs: (client: unknown, options?: unknown) => (
      mocks.hasDueGenerationCompletionJobs(client, options)
    ),
    maybePruneGenerationCompletionJobs: (client: unknown, options?: unknown) => (
      mocks.maybePruneGenerationCompletionJobs(client, options)
    ),
    processGenerationCompletionJobs: (...args: unknown[]) => mocks.processGenerationCompletionJobs(...args),
    pruneGenerationCompletionJobs: (...args: unknown[]) => mocks.pruneGenerationCompletionJobs(...args),
  };
});

vi.mock('@/lib/workflow-run-jobs-processor', () => ({
  WORKFLOW_RUN_STEP_BATCH_LIMIT: 10,
  processWorkflowRunStepJobs: (...args: unknown[]) => mocks.processWorkflowRunStepJobs(...args),
}));

vi.mock('@/lib/template-run-jobs-processor', () => ({
  TEMPLATE_RUN_JOB_BATCH_LIMIT: 10,
  processTemplateRunJobs: (...args: unknown[]) => mocks.processTemplateRunJobs(...args),
}));

vi.mock('@/lib/generation-output-import-jobs', () => ({
  hasDueGenerationOutputImportJobs: (...args: unknown[]) => (
    mocks.hasDueGenerationOutputImportJobs(...args)
  ),
}));

vi.mock('@/lib/generation-output-import-jobs-processor', () => ({
  GENERATION_OUTPUT_IMPORT_BATCH_LIMIT: 4,
  processGenerationOutputImportJobs: (...args: unknown[]) => (
    mocks.processGenerationOutputImportJobs(...args)
  ),
}));

describe('/api/cron/generation-completions route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createServiceClient.mockReset();
    mocks.finishBackendJobRun.mockClear();
    mocks.hasDueGenerationCompletionJobs.mockReset();
    mocks.pruneBackendJobRuns.mockClear();
    mocks.maybePruneGenerationCompletionJobs.mockReset();
    mocks.processGenerationCompletionJobs.mockReset();
    mocks.processGenerationOutputImportJobs.mockReset();
    mocks.processTemplateRunJobs.mockReset();
    mocks.hasDueGenerationOutputImportJobs.mockReset();
    mocks.processWorkflowRunStepJobs.mockReset();
    mocks.pruneGenerationCompletionJobs.mockReset();
    mocks.startBackendJobRun.mockClear();
    mocks.withBackendJobLock.mockReset();
    mocks.hasStalledGenerationWork.mockReset();
    mocks.reapStalledGenerations.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
    mocks.processGenerationCompletionJobs.mockResolvedValue({
      claimed: 2,
      completed: 1,
      retried: 1,
      failed: 0,
    });
    mocks.hasDueGenerationOutputImportJobs.mockResolvedValue(false);
    mocks.processGenerationOutputImportJobs.mockResolvedValue({
      claimed: 1,
      completed: 1,
      retried: 0,
      exhausted: 0,
    });
    mocks.processWorkflowRunStepJobs.mockResolvedValue({
      claimed: 1,
      advanced: 1,
      deferred: 0,
      retried: 0,
      exhausted: 0,
      failed: 0,
      adopted: 0,
    });
    mocks.processTemplateRunJobs.mockResolvedValue({
      claimed: 1,
      completed: 1,
      deferred: 0,
      retried: 0,
      exhausted: 0,
      leaseLost: 0,
    });
    mocks.hasStalledGenerationWork.mockResolvedValue(false);
    mocks.reapStalledGenerations.mockResolvedValue(stalledReapSummary);
    mocks.hasDueGenerationCompletionJobs.mockResolvedValue(true);
    mocks.maybePruneGenerationCompletionJobs.mockResolvedValue(3);
    mocks.pruneGenerationCompletionJobs.mockResolvedValue(3);
    mocks.withBackendJobLock.mockImplementation(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
      acquired: true,
      value: await task(),
    }));
    process.env.CRON_SECRET = 'secret-123';
  });

  it('rejects requests without the cron secret before touching Supabase', async () => {
    const { GET } = await import('@/app/api/cron/generation-completions/route');
    const response = await GET(new Request('http://localhost/api/cron/generation-completions', {
      headers: { 'x-request-id': 'completion-reject-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('completion-reject-1');
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.startBackendJobRun).not.toHaveBeenCalled();
    expect(mocks.withBackendJobLock).not.toHaveBeenCalled();
    expect(mocks.processGenerationCompletionJobs).not.toHaveBeenCalled();
  });

  it('fails closed when the cron secret is missing', async () => {
    delete process.env.CRON_SECRET;

    const { GET } = await import('@/app/api/cron/generation-completions/route');
    const response = await GET(new Request('http://localhost/api/cron/generation-completions', {
      headers: { authorization: 'Bearer undefined' },
    }));

    expect(response.status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.startBackendJobRun).not.toHaveBeenCalled();
    expect(mocks.withBackendJobLock).not.toHaveBeenCalled();
    expect(mocks.processGenerationCompletionJobs).not.toHaveBeenCalled();
  });

  it('runs the durable completion drain for authorized cron calls', async () => {
    const { GET } = await import('@/app/api/cron/generation-completions/route');
    const response = await GET(new Request('http://localhost/api/cron/generation-completions', {
      headers: {
        authorization: 'Bearer secret-123',
        'x-request-id': 'completion-run-1',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('completion-run-1');
    expect(mocks.startBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({
        name: 'generation-completions',
        route: '/api/cron/generation-completions',
        requestId: 'completion-run-1',
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
    expect(mocks.reapStalledGenerations).toHaveBeenCalledWith({
      supabase: { service: 'supabase' },
      creditSupabase: { service: 'supabase' },
      nowMs: expect.any(Number),
    });
    expect(mocks.processWorkflowRunStepJobs).toHaveBeenCalledWith({
      supabase: { service: 'supabase' },
      lockedBy: expect.stringMatching(/^generation-completions:.*:workflow$/),
      limit: 4,
      nowMs: expect.any(Number),
    });
    expect(mocks.processTemplateRunJobs).toHaveBeenCalledWith({
      client: { service: 'supabase' },
      lockedBy: expect.stringMatching(/^generation-completions:.*:template$/),
      limit: 4,
    });
    expect(mocks.processGenerationOutputImportJobs).toHaveBeenCalledWith({
      client: { service: 'supabase' },
      lockedBy: expect.stringMatching(/^generation-completions:.*:output-import$/),
      limit: 4,
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
          stalled: stalledReapSummary,
          outputImports: expect.objectContaining({ claimed: 1, completed: 1 }),
          workflowWake: expect.objectContaining({ claimed: 1, advanced: 1 }),
          templateWake: expect.objectContaining({ claimed: 1, completed: 1 }),
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
        stalled: stalledReapSummary,
        pruned: 3,
      },
    });
  });

  it('runs the drain and reaper when only stalled generations need reconciliation', async () => {
    mocks.hasDueGenerationCompletionJobs.mockResolvedValueOnce(false);
    mocks.hasStalledGenerationWork.mockResolvedValueOnce(true);

    const { GET } = await import('@/app/api/cron/generation-completions/route');
    const response = await GET(new Request('http://localhost/api/cron/generation-completions', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(200);
    expect(mocks.hasStalledGenerationWork).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    expect(mocks.withBackendJobLock).toHaveBeenCalled();
    expect(mocks.processGenerationCompletionJobs).toHaveBeenCalled();
    expect(mocks.reapStalledGenerations).toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: { stalled: stalledReapSummary },
    });
  });

  it('records a skipped job-run without taking the lock when no completion or stalled work exists', async () => {
    mocks.hasDueGenerationCompletionJobs.mockResolvedValueOnce(false);
    mocks.hasStalledGenerationWork.mockResolvedValueOnce(false);

    const { GET } = await import('@/app/api/cron/generation-completions/route');
    const response = await GET(new Request('http://localhost/api/cron/generation-completions', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(202);
    expect(mocks.hasDueGenerationCompletionJobs).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    expect(mocks.hasStalledGenerationWork).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    expect(mocks.reapStalledGenerations).not.toHaveBeenCalled();
    expect(mocks.startBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({
        name: 'generation-completions',
        route: '/api/cron/generation-completions',
      }),
    );
    expect(mocks.withBackendJobLock).not.toHaveBeenCalled();
    expect(mocks.processGenerationCompletionJobs).not.toHaveBeenCalled();
    expect(mocks.finishBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        status: 'skipped',
        skipReason: 'no_due_jobs',
        summary: { pruned: 3 },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: 'no_due_jobs',
    });
  });
});
