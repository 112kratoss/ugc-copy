import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  defer: vi.fn(),
  finish: vi.fn(),
  heartbeat: vi.fn(),
  sync: vi.fn(),
}));

vi.mock('@/lib/template-run-jobs', () => ({
  claimTemplateRunJobs: (...args: unknown[]) => mocks.claim(...args),
  deferTemplateRunJob: (...args: unknown[]) => mocks.defer(...args),
  finishTemplateRunJob: (...args: unknown[]) => mocks.finish(...args),
  heartbeatTemplateRunJob: (...args: unknown[]) => mocks.heartbeat(...args),
  // No run is stranded here. The sweep has its own tests in
  // template-run-job-exhaustion.test.ts.
  findStrandedTemplateRuns: async () => [],
  TEMPLATE_RUN_GIVE_UP_SECONDS: 30 * 60,
}));

vi.mock('@/lib/template-run-service', () => ({
  syncTemplateRun: (...args: unknown[]) => mocks.sync(...args),
}));

const job = {
  id: 'template-job-1',
  run_id: 'template-run-1',
  user_id: 'user-1',
  status: 'processing',
  attempt_count: 0,
  next_attempt_at: '2026-08-10T00:00:00.000Z',
  locked_at: '2026-08-10T00:00:00.000Z',
  locked_by: 'worker-1',
  heartbeat_at: '2026-08-10T00:00:00.000Z',
  last_error: null,
  created_at: '2026-08-10T00:00:00.000Z',
  updated_at: '2026-08-10T00:00:00.000Z',
  completed_at: null,
};

describe('durable template run processor', () => {
  let logs: BackendLogRecord[];
  let restoreLogSink: () => void;

  beforeEach(() => {
    logs = [];
    restoreLogSink = setBackendLogSink((record) => logs.push(record));
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue([{ ...job }]);
    mocks.heartbeat.mockResolvedValue(true);
    mocks.defer.mockResolvedValue(true);
    mocks.finish.mockResolvedValue('succeeded');
  });
  afterEach(() => {
    restoreLogSink();
  });

  it('defers the same leased ticket while provider work is active', async () => {
    mocks.sync.mockResolvedValue({ status: 'processing' });
    const { processTemplateRunJobs } = await import('@/lib/template-run-jobs-processor');

    const result = await processTemplateRunJobs({
      client: { rpc: vi.fn() } as never,
      lockedBy: 'worker-1',
    });

    expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'template-run-1',
      userId: 'user-1',
    }));
    expect(mocks.defer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'template-job-1',
      lockedBy: 'worker-1',
      delaySeconds: 60,
    }));
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
  });

  it.each(['succeeded', 'failed', 'cancelled', 'awaiting_approval', 'needs_attention'])(
    'closes the queue ticket when the run reaches %s',
    async (status) => {
      mocks.sync.mockResolvedValue({ status });
      const { processTemplateRunJobs } = await import('@/lib/template-run-jobs-processor');
      const result = await processTemplateRunJobs({
        client: { rpc: vi.fn() } as never,
        lockedBy: 'worker-1',
      });

      expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({
        id: 'template-job-1',
        succeeded: true,
      }));
      expect(result.completed).toBe(1);
    },
  );

  it('schedules a bounded retry when execution throws', async () => {
    mocks.sync.mockRejectedValue(new Error('transient database failure'));
    mocks.finish.mockResolvedValue('retry_scheduled');
    const { processTemplateRunJobs } = await import('@/lib/template-run-jobs-processor');

    const result = await processTemplateRunJobs({
      client: { rpc: vi.fn() } as never,
      lockedBy: 'worker-1',
    });

    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({
      succeeded: false,
      error: 'transient database failure',
      retryDelaySeconds: 60,
    }));
    expect(result.retried).toBe(1);
    // A pass that fails is on the record, with the run it failed for.
    expect(logs).toEqual([expect.objectContaining({
      level: 'error',
      msg: 'template_run_pass_failed',
      jobId: 'template-job-1',
      runId: 'template-run-1',
      outcome: 'retry_scheduled',
      errorMessage: 'transient database failure',
    })]);
  });

  it('does not finish work after losing its database lease', async () => {
    mocks.sync.mockResolvedValue({ status: 'succeeded' });
    mocks.heartbeat.mockResolvedValue(false);
    const { processTemplateRunJobs } = await import('@/lib/template-run-jobs-processor');

    const result = await processTemplateRunJobs({
      client: { rpc: vi.fn() } as never,
      lockedBy: 'worker-1',
    });

    expect(mocks.finish).not.toHaveBeenCalled();
    expect(result.leaseLost).toBe(1);
  });
});
