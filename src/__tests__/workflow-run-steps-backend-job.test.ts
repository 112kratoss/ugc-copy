import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findStalledWorkflowRuns: vi.fn(),
  findStrandedTemplateRuns: vi.fn(),
  finishBackendJobRun: vi.fn(),
  hasDueTemplateRunJobs: vi.fn(),
  hasDueWorkflowRunStepJobs: vi.fn(),
  processTemplateRunJobs: vi.fn(),
  processWorkflowRunStepJobs: vi.fn(),
}));

vi.mock('@/lib/server-helpers', () => ({ createServiceClient: vi.fn() }));

vi.mock('@/lib/backend-job-lock', () => ({
  withBackendJobLock: async (_client: unknown, _options: unknown, task: () => Promise<unknown>) => ({
    acquired: true,
    value: await task(),
  }),
}));

vi.mock('@/lib/backend-job-runs', () => ({
  finishBackendJobRun: (...args: unknown[]) => mocks.finishBackendJobRun(...args),
  maybePruneBackendJobRuns: async () => 0,
  startBackendJobRun: async (_client: unknown, options: Record<string, unknown>) => ({ id: 'job-run-1', ...options }),
}));

vi.mock('@/lib/workflow-run-jobs', () => ({
  findStalledWorkflowRuns: (...args: unknown[]) => mocks.findStalledWorkflowRuns(...args),
  hasDueWorkflowRunStepJobs: (...args: unknown[]) => mocks.hasDueWorkflowRunStepJobs(...args),
  maybePruneWorkflowRunStepJobs: async () => null,
}));

vi.mock('@/lib/template-run-jobs', () => ({
  findStrandedTemplateRuns: (...args: unknown[]) => mocks.findStrandedTemplateRuns(...args),
  hasDueTemplateRunJobs: (...args: unknown[]) => mocks.hasDueTemplateRunJobs(...args),
  pruneTemplateRunJobs: async () => 0,
}));

vi.mock('@/lib/workflow-run-jobs-processor', () => ({
  WORKFLOW_RUN_STEP_BATCH_LIMIT: 10,
  processWorkflowRunStepJobs: (...args: unknown[]) => mocks.processWorkflowRunStepJobs(...args),
}));

vi.mock('@/lib/template-run-jobs-processor', () => ({
  TEMPLATE_RUN_JOB_BATCH_LIMIT: 10,
  processTemplateRunJobs: (...args: unknown[]) => mocks.processTemplateRunJobs(...args),
}));

const client = { service: 'supabase' };
const STARTED_AT = Date.parse('2026-10-02T10:00:00.000Z');

async function runJob() {
  const { runWorkflowRunStepsBackendJob } = await import('@/lib/backend-job-executions');
  return runWorkflowRunStepsBackendJob({
    requestId: 'workflow-run-steps-1',
    startedAtMs: STARTED_AT,
    serviceClient: client as never,
  });
}

describe('the workflow run steps job, when it decides whether there is work', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Nothing is due anywhere, and no run is stranded.
    mocks.hasDueWorkflowRunStepJobs.mockResolvedValue(false);
    mocks.hasDueTemplateRunJobs.mockResolvedValue(false);
    mocks.findStalledWorkflowRuns.mockResolvedValue([]);
    mocks.findStrandedTemplateRuns.mockResolvedValue([]);
    mocks.processWorkflowRunStepJobs.mockResolvedValue({ claimed: 0 });
    mocks.processTemplateRunJobs.mockResolvedValue({ claimed: 0, adopted: 0, abandoned: 0 });
  });

  it('skips the run when no ticket is due and no run is stranded', async () => {
    expect(await runJob()).toMatchObject({ status: 'skipped', reason: 'no_due_workflow_run_steps' });

    expect(mocks.processWorkflowRunStepJobs).not.toHaveBeenCalled();
    expect(mocks.processTemplateRunJobs).not.toHaveBeenCalled();
  });

  it('runs for a stranded template run, which has no due ticket to be found by', async () => {
    mocks.findStrandedTemplateRuns.mockResolvedValue([
      { id: 'run-1', user_id: 'user-1', updated_at: '2026-10-02T09:00:00.000Z', last_error: 'boom' },
    ]);
    mocks.processTemplateRunJobs.mockResolvedValue({ claimed: 0, adopted: 0, abandoned: 1 });

    expect(await runJob()).toMatchObject({
      status: 'succeeded',
      summary: { templates: { abandoned: 1 } },
    });

    expect(mocks.processTemplateRunJobs).toHaveBeenCalledTimes(1);
    expect(mocks.processTemplateRunJobs).toHaveBeenCalledWith(expect.objectContaining({ client }));
    // The probe reads the runs before their tickets, so it is given the job's
    // clock and no limit of its own: a limit of one would look at the oldest
    // run in progress and no other.
    expect(mocks.findStrandedTemplateRuns).toHaveBeenCalledWith(client, { nowMs: STARTED_AT });
  });
});
