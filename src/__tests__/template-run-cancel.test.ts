import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTemplateRunDatabase,
  TEMPLATE_RUN_ID,
  TEMPLATE_RUN_USER_ID,
  type TemplateRunDatabase,
} from '@/__tests__/fixtures/template-run-database';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { cancelTemplateRun } from '@/lib/template-run-service';

// The provider key is read once, when the generation modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
});

vi.mock('@/lib/server-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server-helpers')>()),
  resolveOwnedStoredMediaUrl: async (_client: unknown, value: string) => `signed:${value}`,
}));

// Asking the provider about a generation that is still running is the status
// sync's work. Here a generation changes only when a test says so.
vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: async () => undefined,
}));

const NOW = '2026-10-03T09:00:00.000Z';
const REFUSED = { code: '57014', message: 'canceling statement due to statement timeout' };
const STILL_GENERATING = 'This step was already generating when the run was cancelled, so its credits stay spent.';

describe('cancelling a template run', () => {
  let database: TemplateRunDatabase;
  let logs: BackendLogRecord[];
  let restoreLogSink: () => void;

  beforeEach(() => {
    // Only the clock is faked: the run and what is written to it are stamped with it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Nothing here may reach the network.');
    }));
    logs = [];
    restoreLogSink = setBackendLogSink((record) => logs.push(record));
    database = createTemplateRunDatabase();
  });
  afterEach(() => {
    restoreLogSink();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const cancel = () => cancelTemplateRun(database.client, TEMPLATE_RUN_ID, TEMPLATE_RUN_USER_ID);
  const logged = (event: string) => logs.filter((record) => record.msg === event);
  const stepStates = () => database.steps.map((step) => [step.id, step.status, step.error_message]);
  const rows = () => structuredClone({ run: database.run, steps: database.steps, generations: database.generations });
  /** The uploads as storage is asked to delete them. */
  const uploads = () => Object.values(database.run.input_storage_paths as Record<string, string>)
    .map((value) => value.replace(/^template_inputs\//, '')).sort();
  /** The first step as a pass of the worker leaves it once the provider has taken it. */
  function firstStepIsGenerating() {
    const [step] = database.steps;
    database.generations.push({
      id: 'gen-1',
      user_id: TEMPLATE_RUN_USER_ID,
      status: 'processing',
      prediction_id: 'task-gen-1',
      output_url: null,
      error_message: null,
      cost: step.estimated_credits,
      actual_cost: null,
      template_run_id: TEMPLATE_RUN_ID,
      template_run_step_id: step.id,
      created_at: NOW,
      completed_at: null,
    });
    Object.assign(step, { status: 'processing', generation_id: 'gen-1', started_at: NOW });
    database.run.status = 'processing';
    return step;
  }

  it('cancels the run, closes its unfinished steps and removes its uploads', async () => {
    const generating = firstStepIsGenerating();
    const stored = uploads();
    expect(stored.length).toBeGreaterThan(0);

    const shown = await cancel();

    expect(shown.status).toBe('cancelled');
    expect(database.run).toMatchObject({
      status: 'cancelled',
      completed_at: NOW,
      error_message: null,
      input_storage_paths: {},
      inputs_deleted_at: NOW,
    });
    expect(stepStates()).toEqual(database.steps.map((step) => [
      step.id, 'cancelled', step === generating ? STILL_GENERATING : null,
    ]));
    expect(database.steps.map((step) => step.finished_at)).toEqual(database.steps.map(() => NOW));
    expect(database.removedInputs.sort()).toEqual(stored);
    expect(logs).toEqual([]);
  });

  it('answers with the error and closes no step when the run could not be cancelled', async () => {
    firstStepIsGenerating();
    database.conditions.writeRefused = (table, values) => table === 'template_runs' && values.status === 'cancelled';
    const before = rows();

    await expect(cancel()).rejects.toMatchObject(REFUSED);

    // The run is in progress as it was, and so is every step: closing them
    // would leave it in progress with nothing left to run.
    expect(rows()).toEqual(before);
    expect(database.removedInputs).toEqual([]);

    // The person asks again once the database answers.
    database.conditions.writeRefused = null;
    expect((await cancel()).status).toBe('cancelled');
    expect(database.steps.map((step) => step.status)).toEqual(database.steps.map(() => 'cancelled'));
  });

  it('cancels the run and logs each write that closes its steps when the database refuses it', async () => {
    const generating = firstStepIsGenerating();
    const stored = uploads();
    database.conditions.writeRefused = (table, values) => table === 'template_run_steps' && values.status === 'cancelled';

    const shown = await cancel();

    // The run is cancelled and the person is answered. Its steps are as they were.
    expect(shown.status).toBe('cancelled');
    expect(database.run).toMatchObject({ status: 'cancelled', completed_at: NOW, input_storage_paths: {}, inputs_deleted_at: NOW });
    expect(stepStates()).toEqual(database.steps.map((step) => [step.id, step === generating ? 'processing' : 'queued', null]));
    // One for the steps that were in line, one for the step that was generating.
    expect(logged('template_run_cancel_cleanup_failed')).toEqual([
      expect.objectContaining({ level: 'error', runId: TEMPLATE_RUN_ID, errorMessage: REFUSED.message }),
      expect.objectContaining({ level: 'error', runId: TEMPLATE_RUN_ID, errorMessage: REFUSED.message }),
    ]);
    // A refused write does not cost the run the rest of its tidying.
    expect(database.removedInputs.sort()).toEqual(stored);
  });

  it('logs it and keeps the upload paths when the run cannot be told its uploads are gone', async () => {
    const paths = { ...(database.run.input_storage_paths as Record<string, string>) };
    const stored = uploads();
    database.conditions.writeRefused = (table, values) => table === 'template_runs' && 'inputs_deleted_at' in values;

    const shown = await cancel();

    expect(shown.status).toBe('cancelled');
    expect(database.removedInputs.sort()).toEqual(stored);
    expect(database.run).toMatchObject({ status: 'cancelled', input_storage_paths: paths, inputs_deleted_at: null });
    expect(logged('failed_to_clean_up_template_inputs')).toEqual([
      expect.objectContaining({ level: 'error', runId: TEMPLATE_RUN_ID, errorMessage: REFUSED.message }),
    ]);

    // The next call for the run finishes the job.
    database.conditions.writeRefused = null;
    await cancel();
    expect(database.run).toMatchObject({ input_storage_paths: {}, inputs_deleted_at: NOW });
  });
});
