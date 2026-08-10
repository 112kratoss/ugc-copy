import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  finish: vi.fn(),
  persistOne: vi.fn(),
  persistList: vi.fn(),
}));

vi.mock('@/lib/generation-output-import-jobs', () => ({
  claimGenerationOutputImportJobs: (...args: unknown[]) => mocks.claim(...args),
  finishGenerationOutputImportJob: (...args: unknown[]) => mocks.finish(...args),
}));

vi.mock('@/lib/generation-services', () => ({
  persistGeneratedOutput: (...args: unknown[]) => mocks.persistOne(...args),
  persistGeneratedOutputList: (...args: unknown[]) => mocks.persistList(...args),
}));

function clientWithGeneration(status = 'processing') {
  const row = {
    id: 'generation-1',
    user_id: 'user-1',
    prediction_id: 'prediction-1',
    status,
    output_url: null,
    model: 'video-model',
    category: 'video',
    workflow_settings: null,
    created_at: '2026-08-10T00:00:00.000Z',
    completed_at: null,
  };
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(async () => ({ data: row, error: null })),
  };
  return { from: vi.fn(() => query), rpc: vi.fn() };
}

const job = {
  id: 'import-1',
  generation_id: 'generation-1',
  prediction_id: 'prediction-1',
  output_urls: ['https://provider.invalid/output.mp4'],
  provider_completed_at: '2026-08-10T00:01:00.000Z',
  status: 'processing',
  attempt_count: 0,
};

describe('generation output import processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue([{ ...job }]);
    mocks.finish.mockResolvedValue('succeeded');
    mocks.persistOne.mockResolvedValue('succeeded');
    mocks.persistList.mockResolvedValue({
      status: 'succeeded',
      outputs: [{ index: 0, storagePath: 'generated/output.png' }],
    });
  });

  it('imports large media sequentially and settles the durable ticket', async () => {
    const client = clientWithGeneration();
    const { processGenerationOutputImportJobs } = await import(
      '@/lib/generation-output-import-jobs-processor'
    );
    const summary = await processGenerationOutputImportJobs({
      client: client as never,
      lockedBy: 'import-worker',
    });

    expect(mocks.persistOne).toHaveBeenCalledWith(
      client,
      client,
      expect.objectContaining({ id: 'generation-1' }),
      'https://provider.invalid/output.mp4',
      '2026-08-10T00:01:00.000Z',
    );
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ succeeded: true }));
    expect(summary).toEqual({ claimed: 1, completed: 1, retried: 0, exhausted: 0 });
  });

  it('retries storage failures without settling the generation as failed', async () => {
    mocks.persistOne.mockRejectedValue(new Error('storage unavailable'));
    mocks.finish.mockResolvedValue('retry_scheduled');
    const { processGenerationOutputImportJobs } = await import(
      '@/lib/generation-output-import-jobs-processor'
    );
    const summary = await processGenerationOutputImportJobs({
      client: clientWithGeneration() as never,
      lockedBy: 'import-worker',
    });

    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({
      succeeded: false,
      error: 'storage unavailable',
      retryDelaySeconds: 60,
    }));
    expect(summary.retried).toBe(1);
  });

  it('uses the list importer for multi-output provider results', async () => {
    mocks.claim.mockResolvedValue([{
      ...job,
      output_urls: ['https://provider.invalid/a.png', 'https://provider.invalid/b.png'],
    }]);
    const { processGenerationOutputImportJobs } = await import(
      '@/lib/generation-output-import-jobs-processor'
    );
    await processGenerationOutputImportJobs({
      client: clientWithGeneration() as never,
      lockedBy: 'import-worker',
    });

    expect(mocks.persistList).toHaveBeenCalledTimes(1);
    expect(mocks.persistOne).not.toHaveBeenCalled();
  });
});
