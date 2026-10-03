import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  withUniqueDedupeKeys,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import {
  createTemplateRunDatabase,
  TEMPLATE_RUN_ID,
  TEMPLATE_RUN_USER_ID,
  type TemplateRunDatabase,
} from '@/__tests__/fixtures/template-run-database';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { getPublicGenerationStartFailure } from '@/lib/generation-public-failure';
import { abandonTemplateRun, TEMPLATE_RUN_ABANDONED_MESSAGE } from '@/lib/template-run-service';

// The provider key is read once, when the generation modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
});

const NOW = '2026-10-02T10:00:00.000Z';
/** Half an hour on: nothing has written the run since the give-up time began. */
const IDLE_BEFORE = '2026-10-02T10:30:00.000Z';
const NOT_FINISHED = 'This step was not finished because the run stopped.';
const STOPPED_MID_GENERATION = 'This step was still generating when the run stopped, so its credits stay spent.';

describe('ending a template run the worker could not carry on with', () => {
  let database: TemplateRunDatabase;
  let history: MobileNotificationHistory;
  let client: SupabaseClient;
  let logs: BackendLogRecord[];
  let restoreLogSink: () => void;

  beforeEach(() => {
    // Only the clock is faked: the run is stamped with it when it is seeded.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Nothing here may reach the network.');
    }));
    logs = [];
    restoreLogSink = setBackendLogSink((record) => logs.push(record));
    database = createTemplateRunDatabase();
    history = withUniqueDedupeKeys(createMobileNotificationHistory());
    client = withNotifications(database.client);
  });
  afterEach(() => {
    restoreLogSink();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** The run's tables and storage, with the notification tables served by the history. */
  function withNotifications(base: SupabaseClient) {
    return {
      ...base,
      from: (table: string) => (history.handles(table) ? history.from(table) : base.from(table)),
    } as unknown as SupabaseClient;
  }
  const abandon = (overrides: Partial<Parameters<typeof abandonTemplateRun>[0]> = {}) => abandonTemplateRun({
    client,
    runId: TEMPLATE_RUN_ID,
    userId: TEMPLATE_RUN_USER_ID,
    idleBefore: IDLE_BEFORE,
    lastError: 'canceling statement due to statement timeout',
    ...overrides,
  });
  const logged = (event: string) => logs.filter((record) => record.msg === event);
  const stepStates = () => database.steps.map((step) => [step.id, step.status, step.error_message]);
  /** A step the worker started, with the generation it started it with. */
  function started(stepId: string, generation: Record<string, unknown>) {
    const step = database.steps.find((candidate) => candidate.id === stepId)!;
    const id = `gen-${database.generations.length + 1}`;
    database.generations.push({
      id,
      user_id: TEMPLATE_RUN_USER_ID,
      status: 'processing',
      prediction_id: `task-${id}`,
      output_url: null,
      error_message: null,
      cost: 12,
      actual_cost: null,
      template_run_id: TEMPLATE_RUN_ID,
      template_run_step_id: step.id,
      created_at: NOW,
      completed_at: null,
      ...generation,
    });
    Object.assign(step, { status: 'processing', generation_id: id, started_at: NOW });
    return step;
  }

  it('ends a queued run as failed, cancels its steps, removes its uploads and tells the person', async () => {
    const uploads = Object.values(database.run.input_storage_paths as Record<string, string>);
    expect(uploads.length).toBeGreaterThan(0);

    expect(await abandon()).toBe(true);

    expect(database.run).toMatchObject({
      status: 'failed',
      error_message: TEMPLATE_RUN_ABANDONED_MESSAGE,
      completed_at: NOW,
      input_storage_paths: {},
      inputs_deleted_at: NOW,
    });
    expect(TEMPLATE_RUN_ABANDONED_MESSAGE).toBe(
      'This run stopped because of a problem on our side and could not be resumed. Start a new run to try again.',
    );
    // Each step says why it has nothing to show. Left without a note, the run
    // page would draw the advice to retry it.
    expect(stepStates()).toEqual(database.steps.map((step) => [step.id, 'cancelled', NOT_FINISHED]));
    expect(database.steps.map((step) => step.finished_at)).toEqual(database.steps.map(() => NOW));
    expect(database.removedInputs.sort()).toEqual(uploads.map((value) => value.replace(/^template_inputs\//, '')).sort());
    expect(database.credits()).toBe(100);

    expect(history.sent).toEqual([{
      user_id: TEMPLATE_RUN_USER_ID,
      actor_user_id: null,
      type: 'generation_failed',
      category: 'generation',
      title: 'Your template run stopped',
      body: 'A problem on our side ended it. Open it to start again.',
      deep_link: `/template-runs/${TEMPLATE_RUN_ID}`,
      object_type: 'template_run',
      object_id: TEMPLATE_RUN_ID,
      dedupe_key: `template-run:${TEMPLATE_RUN_ID}:stopped`,
      aggregation_key: null,
    }]);
    expect(logged('template_run_abandoned')).toEqual([expect.objectContaining({
      level: 'error',
      runId: TEMPLATE_RUN_ID,
      userId: TEMPLATE_RUN_USER_ID,
      lastError: 'canceling statement due to statement timeout',
    })]);
    expect(logged('template_run_abandon_cleanup_failed')).toEqual([]);
  });

  it('leaves each step showing what became of its generation', async () => {
    database.run.status = 'processing';
    const [first, second, third, fourth, fifth] = database.steps;
    // Finished while no pass could record it.
    started(first.id as string, { status: 'succeeded', output_url: 'generations/user-1/first.png', actual_cost: 9, completed_at: NOW });
    // Failed while no pass could record it. Its own settlement returned its credits.
    started(second.id as string, { status: 'failed', error_message: 'The provider could not finish this image.', completed_at: NOW });
    // Still with the provider.
    started(third.id as string, {});
    fourth.status = 'awaiting_approval';

    expect(await abandon()).toBe(true);

    expect(stepStates()).toEqual([
      [first.id, 'succeeded', null],
      [second.id, 'failed', getPublicGenerationStartFailure({ message: 'The provider could not finish this image.' }).message],
      [third.id, 'cancelled', STOPPED_MID_GENERATION],
      [fourth.id, 'cancelled', NOT_FINISHED],
      [fifth.id, 'cancelled', NOT_FINISHED],
    ]);
    expect(first.output_url).toBe('generations/user-1/first.png');
    // Ending the run moves no credits and touches no generation.
    expect(database.credits()).toBe(100);
    expect(database.generations.map((generation) => generation.status)).toEqual(['succeeded', 'failed', 'processing']);
    expect(database.run).toMatchObject({ status: 'failed', error_message: TEMPLATE_RUN_ABANDONED_MESSAGE });
  });

  it('ends a run whose stored graph cannot be read, which no pass of the worker gets past', async () => {
    database.run.graph_snapshot = {};

    expect(await abandon()).toBe(true);

    expect(database.run).toMatchObject({ status: 'failed', error_message: TEMPLATE_RUN_ABANDONED_MESSAGE });
    expect(history.sent).toHaveLength(1);
    expect(logged('template_run_abandon_cleanup_failed')).toEqual([]);
  });

  it('leaves a run alone that was written after the give-up time began', async () => {
    // A pass that worked, or the person, a minute before the sweep's write.
    database.run.updated_at = '2026-10-02T10:29:00.000Z';

    expect(await abandon({ idleBefore: '2026-10-02T10:29:00.000Z' })).toBe(false);
    expect(await abandon({ idleBefore: '2026-10-02T10:00:00.000Z' })).toBe(false);

    expect(database.run).toMatchObject({ status: 'queued', error_message: null, completed_at: null });
    expect(stepStates()).toEqual(database.steps.map((step) => [step.id, 'queued', null]));
    expect(database.removedInputs).toEqual([]);
    expect(history.sent).toEqual([]);
    expect(logged('template_run_abandoned')).toEqual([]);
  });

  it.each([
    'collecting_inputs', 'awaiting_approval', 'needs_attention', 'succeeded', 'failed', 'cancelled',
  ])('leaves a run alone that is %s', async (status) => {
    database.run.status = status;

    expect(await abandon()).toBe(false);

    expect(database.run).toMatchObject({ status, error_message: null, completed_at: null });
    expect(history.sent).toEqual([]);
  });

  it('leaves another person\'s run alone', async () => {
    expect(await abandon({ userId: 'someone-else' })).toBe(false);

    expect(database.run.status).toBe('queued');
    expect(history.sent).toEqual([]);
  });

  it('tells the person once, however many sweeps reach the run', async () => {
    expect(await Promise.all([abandon(), abandon()])).toEqual([true, false]);
    expect(await abandon()).toBe(false);

    expect(history.sent).toHaveLength(1);
    expect(logged('template_run_abandoned')).toHaveLength(1);
  });

  it('still ends the run and tells the person when tidying it up fails', async () => {
    client = withNotifications({
      ...database.client,
      storage: {
        from: () => ({
          remove: async () => {
            throw new Error('storage is unreachable');
          },
        }),
      },
    } as unknown as SupabaseClient);

    expect(await abandon()).toBe(true);

    expect(database.run).toMatchObject({ status: 'failed', error_message: TEMPLATE_RUN_ABANDONED_MESSAGE });
    expect(logged('template_run_abandon_cleanup_failed')).toEqual([
      expect.objectContaining({ level: 'error', runId: TEMPLATE_RUN_ID, errorMessage: 'storage is unreachable' }),
    ]);
    expect(history.sent).toHaveLength(1);
    expect(logged('template_run_abandoned')).toHaveLength(1);
  });

  it('keeps the uploads on the run when storage refuses to delete them', async () => {
    const uploads = { ...(database.run.input_storage_paths as Record<string, string>) };
    client = withNotifications({
      ...database.client,
      storage: { from: () => ({ remove: async () => ({ error: { message: 'storage said no' } }) }) },
    } as unknown as SupabaseClient);

    expect(await abandon()).toBe(true);

    expect(database.run).toMatchObject({ status: 'failed', input_storage_paths: uploads, inputs_deleted_at: null });
    expect(logged('failed_to_clean_up_template_inputs')).toHaveLength(1);
    expect(history.sent).toHaveLength(1);
  });
});
