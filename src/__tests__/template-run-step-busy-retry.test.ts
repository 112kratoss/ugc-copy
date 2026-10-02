import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTemplateRunDatabase,
  TEMPLATE_RUN_ID,
  TEMPLATE_RUN_USER_ID,
  type TemplateRunDatabase,
} from '@/__tests__/fixtures/template-run-database';
import { setBackendLogSink } from '@/lib/backend-logger';
import { startImageGeneration, type TemplateGenerationContext } from '@/lib/generation-services';
import { retryTemplateRunStep, syncTemplateRun } from '@/lib/template-run-service';

// The provider key and the callback settings are read when the generation
// modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
  vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'test-webhook-secret');
  vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'hmac-key');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
});

// The provider gate makes its own service client. Each test hands it the
// database the run lives in.
const service = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/server-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server-helpers')>()),
  createServiceClient: () => service.client,
  resolveOwnedStoredMediaUrl: async (_client: unknown, value: string) => `signed:${value}`,
}));

// Retrying a step by hand asks for a worker. None runs here: each test drives
// the worker's ticks itself.
vi.mock('@/lib/template-run-jobs', () => ({
  enqueueTemplateRunJob: async () => 'job-1',
}));

// Polling the provider about a generation that is already running is the
// status sync's work. Here a generation changes only when a test says so.
vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: async () => undefined,
}));

type StepStart = {
  supabase: SupabaseClient;
  userId: string;
  clientRequestKeyHash?: string | null;
  persistInputMedia?: boolean;
  privateRecipe?: boolean;
  templateContext?: TemplateGenerationContext;
};

// The run worker's own code is under test. The node executor is stood in for
// by the one thing it does for an image step: the real start service, called
// with the template context the worker gave it.
vi.mock('@/lib/workflow-runner', () => ({
  executeWorkflowRunnableNode: async (params: StepStart) => {
    const started = await startImageGeneration({
      supabase: params.supabase,
      creditSupabase: params.supabase,
      userId: params.userId,
      prompt: 'A ceramic mug on a linen cloth',
      model: 'nano-banana-2',
      clientRequestKeyHash: params.clientRequestKeyHash,
      persistInputMedia: params.persistInputMedia,
      privateRecipe: params.privateRecipe,
      templateContext: params.templateContext,
    });
    return {
      status: 'processing',
      generation_id: started.generationId ?? null,
      input_snapshot: {},
      output_snapshot: { predictionId: started.predictionId, cost: started.cost },
      error_message: null,
    };
  },
}));

const BUSY_MESSAGE = 'The generation provider is busy right now. Please retry this step shortly.';
const STARTING_CREDITS = 100;
const MINUTE = 60_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function providerIsBusy() {
  vi.mocked(fetch).mockImplementation(async () => json({ msg: 'Too many requests' }, 429));
}

let tasks = 0;
function providerHasRoom() {
  vi.mocked(fetch).mockImplementation(async () => json({ code: 200, data: { taskId: `task-${tasks += 1}` } }));
}

/** The provider answers and turns the request down for good: nothing will run. */
function providerRefuses() {
  vi.mocked(fetch).mockImplementation(async () => json({ code: 422, msg: 'The request was not accepted.' }));
}

function connect(database: TemplateRunDatabase) {
  service.client = database.client;
  return database;
}

/** One pass of the run worker, as the job processor makes it. Returns what the person is shown. */
async function tick(database: TemplateRunDatabase) {
  vi.mocked(fetch).mockClear();
  return syncTemplateRun({ adminClient: database.client, runId: TEMPLATE_RUN_ID, userId: TEMPLATE_RUN_USER_ID });
}

const providerCalls = () => vi.mocked(fetch).mock.calls.length;

/** The image steps as the run page and the app receive them. */
function shownImageSteps(run: Awaited<ReturnType<typeof tick>>) {
  return run.steps.filter((step) => step.kind === 'generation' && step.mediaKind === 'image');
}

/** The credits each image step holds while it runs. */
function imageStepCost(database: TemplateRunDatabase) {
  const cost = database.generations[0]?.cost;
  if (typeof cost !== 'number' || cost <= 0) throw new Error('No image step has held credits yet.');
  return cost;
}

let restoreLogSink = () => {};

beforeEach(() => {
  // Only the clock is faked: the half-hour wait is counted on it.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T10:00:00.000Z'));
  vi.stubGlobal('fetch', vi.fn());
  // The provider client reports every refused call on the console, and the
  // start service logs each refund. Neither is what these tests assert on.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  restoreLogSink = setBackendLogSink(() => undefined);
});

afterEach(() => {
  restoreLogSink();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  service.client = null;
});

describe('template run steps the provider turns away as busy', () => {
  it('start on the next tick once the provider has room', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();
    await tick(database);

    providerHasRoom();
    const run = await tick(database);

    // One request per image step: the refused starts were made again.
    expect(providerCalls()).toBe(2);
    expect(database.imageSteps().map((step) => [step.status, database.generationOf(step)?.status])).toEqual([
      ['processing', 'processing'],
      ['processing', 'processing'],
    ]);
    expect(run.status).toBe('processing');
  });

  /** Who turned the steps away, how to arrange it, and the requests that reach the provider. */
  const turnedAway: Array<[string, (database: TemplateRunDatabase) => void, number]> = [
    ['the provider answers that it is busy', () => providerIsBusy(), 2],
    ['our own gate in front of the provider is full', (database) => {
      providerHasRoom();
      database.conditions.admissionRefused = true;
    }, 0],
  ];

  it.each(turnedAway)('wait as the next attempt of the step when %s', async (_reason, arrange, requests) => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    arrange(database);

    const run = await tick(database);

    expect(providerCalls()).toBe(requests);
    // The refused attempt keeps its refunded generation and is over. The
    // database holds one generation per step row, so the step can only be
    // tried again as a new row.
    expect(database.imageAttempts().map((attempts) => attempts.map((step) => [
      step.attempt, step.status, database.generationOf(step)?.status ?? null, step.finished_at !== null,
    ]))).toEqual([
      [[0, 'failed', 'failed', true], [1, 'queued', null, false]],
      [[0, 'failed', 'failed', true], [1, 'queued', null, false]],
    ]);
    expect(database.generations.map((row) => [row.status, row.refunded])).toEqual([['failed', true], ['failed', true]]);
    expect(database.credits()).toBe(STARTING_CREDITS);
    expect(run.status).toBe('queued');
  });

  it('are never left in line as a row the database would refuse to start', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();
    await tick(database);
    await tick(database);
    providerHasRoom();
    await tick(database);

    // `start_template_generation` answers "already started" for a step row
    // that has a generation, and a second generation for one row breaks its
    // unique index. Either answer would keep the step waiting for good.
    expect(database.starts().map((entry) => entry.status ?? entry.error)).toEqual([
      'started', 'started', 'started', 'started', 'started', 'started',
    ]);
  });

  it('keep showing why they are waiting', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();

    const run = await tick(database);

    expect(shownImageSteps(run).map((step) => [step.status, step.failureCode, step.errorMessage])).toEqual([
      ['queued', 'provider_busy', BUSY_MESSAGE],
      ['queued', 'provider_busy', BUSY_MESSAGE],
    ]);
    expect(run.errorMessage).toBeNull();
  });

  it('drop the note once they start', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();
    await tick(database);

    providerHasRoom();
    const run = await tick(database);

    expect(shownImageSteps(run).map((step) => [step.status, step.failureCode, step.errorMessage])).toEqual([
      ['processing', null, null],
      ['processing', null, null],
    ]);
  });

  it('are tried on every tick while the provider stays busy, and hold credits only once they start', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();

    for (let pass = 1; pass <= 3; pass += 1) {
      await tick(database);
      expect(providerCalls()).toBe(2);
      // Every hold a refused start placed has been returned.
      expect(database.credits()).toBe(STARTING_CREDITS);
      vi.advanceTimersByTime(MINUTE);
    }

    providerHasRoom();
    await tick(database);

    expect(database.imageSteps().map((step) => [step.attempt, step.status])).toEqual([
      [3, 'processing'],
      [3, 'processing'],
    ]);
    expect(database.generations.map((row) => row.status)).toEqual([
      'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'processing', 'processing',
    ]);
    expect(database.credits()).toBe(STARTING_CREDITS - 2 * imageStepCost(database));
  });

  it('wait in place when they are turned away before any credits are held', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerHasRoom();
    database.conditions.startUnavailable = true;

    const waiting = await tick(database);

    // Nothing was started, so the step row is unused and can be started as it is.
    expect(providerCalls()).toBe(0);
    expect(database.generations).toEqual([]);
    expect(database.imageAttempts().map((attempts) => attempts.map((step) => [
      step.attempt, step.status, step.finished_at,
    ]))).toEqual([
      [[0, 'queued', null]],
      [[0, 'queued', null]],
    ]);
    expect(shownImageSteps(waiting).map((step) => step.failureCode)).toEqual([
      'provider_unavailable', 'provider_unavailable',
    ]);

    database.conditions.startUnavailable = false;
    const run = await tick(database);

    expect(providerCalls()).toBe(2);
    expect(database.imageSteps().map((step) => [step.attempt, step.status])).toEqual([
      [0, 'processing'],
      [0, 'processing'],
    ]);
    expect(run.status).toBe('processing');
  });

  it('follow a refused generation that still holds its credits, and never start a second one beside it', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();
    database.conditions.settlementUnavailable = true;

    const held = await tick(database);

    // The refund did not land: each generation is still pending with its hold.
    const cost = imageStepCost(database);
    expect(database.credits()).toBe(STARTING_CREDITS - 2 * cost);
    expect(database.imageAttempts().map((attempts) => attempts.map((step) => [
      step.attempt, step.status, database.generationOf(step)?.status ?? null,
    ]))).toEqual([
      [[0, 'processing', 'pending']],
      [[0, 'processing', 'pending']],
    ]);
    expect(held.status).toBe('processing');

    database.conditions.settlementUnavailable = false;
    providerHasRoom();
    await tick(database);

    expect(providerCalls()).toBe(0);
    expect(database.generations).toHaveLength(2);
    expect(database.credits()).toBe(STARTING_CREDITS - 2 * cost);

    // The stalled-generation reaper is what ends a hold like this one.
    for (const generation of database.generations) {
      Object.assign(generation, { status: 'failed', refunded: true, error_message: 'Generation timed out.' });
    }
    const ended = await tick(database);

    expect(shownImageSteps(ended).map((step) => [step.status, step.canRetry])).toEqual([
      ['failed', true],
      ['failed', true],
    ]);
    expect(ended.status).toBe('needs_attention');
  });

  it('are not put back in line when the worker cannot tell whether their start held credits', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();
    database.conditions.generationUnreadable = true;

    // The pass ends there, and the run job tries it again later.
    await expect(tick(database)).rejects.toMatchObject({ message: 'canceling statement due to statement timeout' });

    // A row that was started and then queued again is the one shape that
    // never moves. The refused row stays as its settlement left it, and the
    // other image step was not reached.
    expect(database.steps.filter((step) => step.status === 'queued' && step.generation_id !== null)).toEqual([]);
    expect(database.imageSteps().map((step) => [step.attempt, step.status, step.generation_id !== null])).toEqual(
      expect.arrayContaining([[0, 'failed', true], [0, 'queued', false]]),
    );

    database.conditions.generationUnreadable = false;
    const run = await tick(database);

    // The refused step can be retried by hand; the other one is tried again as usual.
    expect(shownImageSteps(run).map((step) => [step.status, step.errorMessage, step.canRetry])).toEqual(
      expect.arrayContaining([['failed', BUSY_MESSAGE, true], ['queued', BUSY_MESSAGE, false]]),
    );
    expect(run.status).toBe('needs_attention');
    expect(database.credits()).toBe(STARTING_CREDITS);
  });

  it('still fail at once when the provider refuses them outright', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerRefuses();

    const run = await tick(database);

    expect(database.imageAttempts().map((attempts) => attempts.map((step) => [step.attempt, step.status]))).toEqual([
      [[0, 'failed']],
      [[0, 'failed']],
    ]);
    expect(shownImageSteps(run).map((step) => step.failureCode)).toEqual(['provider_rejected', 'provider_rejected']);
    expect(run.status).toBe('needs_attention');
    expect(database.credits()).toBe(STARTING_CREDITS);
  });
});

describe('the steps after a template run step that fails at start', () => {
  const REFUSED_MESSAGE = 'The generation provider could not accept this request. Check the template inputs before retrying.';

  /** The approvals and the video step, which wait on the two image steps. */
  function laterSteps(run: Awaited<ReturnType<typeof tick>>) {
    return run.steps.filter((step) => step.kind === 'approval' || step.mediaKind === 'video');
  }

  it('stay in line instead of failing with it', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerRefuses();

    const run = await tick(database);

    expect(shownImageSteps(run).map((step) => [step.status, step.errorMessage])).toEqual([
      ['failed', REFUSED_MESSAGE],
      ['failed', REFUSED_MESSAGE],
    ]);
    expect(laterSteps(run).map((step) => [step.kind, step.status, step.errorMessage])).toEqual([
      ['approval', 'queued', null],
      ['approval', 'queued', null],
      ['generation', 'queued', null],
    ]);
    expect(run.status).toBe('needs_attention');
    expect(run.errorMessage).toBe(REFUSED_MESSAGE);
  });

  it('carry on once it is retried by hand', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerRefuses();
    const refused = await tick(database);

    for (const step of shownImageSteps(refused)) {
      await retryTemplateRunStep({
        adminClient: database.client, runId: TEMPLATE_RUN_ID, stepId: step.id, userId: TEMPLATE_RUN_USER_ID,
      });
    }
    providerHasRoom();
    const retried = await tick(database);

    expect(shownImageSteps(retried).map((step) => step.status)).toEqual(['processing', 'processing']);
    expect(retried.status).toBe('processing');

    // The retried images finish, and the run moves on to their approvals.
    database.imageSteps().forEach((step, index) => {
      Object.assign(database.generationOf(step)!, {
        status: 'succeeded',
        output_url: `generated_images/${TEMPLATE_RUN_USER_ID}/retried-${index + 1}.png`,
        completed_at: new Date().toISOString(),
      });
    });
    const finished = await tick(database);

    expect(laterSteps(finished).map((step) => [step.kind, step.status])).toEqual([
      ['approval', 'awaiting_approval'],
      ['approval', 'awaiting_approval'],
      ['generation', 'queued'],
    ]);
    expect(finished.status).toBe('awaiting_approval');
  });
});

describe('a template run step the provider keeps turning away as busy', () => {
  /** Ticks while the provider stays busy, one every ten minutes, as the cron alone would. */
  async function staysBusyFor(database: TemplateRunDatabase, minutes: number) {
    let run = await tick(database);
    for (let waited = 10; waited <= minutes; waited += 10) {
      vi.advanceTimersByTime(10 * MINUTE);
      run = await tick(database);
    }
    return run;
  }

  it('is still being tried just before half an hour has passed', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();

    const run = await staysBusyFor(database, 20);
    vi.advanceTimersByTime(9 * MINUTE);
    const stillWaiting = await tick(database);

    expect(run.status).toBe('queued');
    expect(stillWaiting.status).toBe('queued');
    expect(providerCalls()).toBe(2);
  });

  it('stops after half an hour, says why and can be retried by hand', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();

    const run = await staysBusyFor(database, 30);

    expect(shownImageSteps(run).map((step) => [step.status, step.failureCode, step.errorMessage, step.canRetry])).toEqual([
      ['failed', 'provider_busy', BUSY_MESSAGE, true],
      ['failed', 'provider_busy', BUSY_MESSAGE, true],
    ]);
    expect(run.status).toBe('needs_attention');
    expect(run.errorMessage).toBe(BUSY_MESSAGE);
    expect(database.imageSteps().map((step) => step.finished_at)).toEqual([expect.any(String), expect.any(String)]);
    expect(database.credits()).toBe(STARTING_CREDITS);

    // Nothing is waiting any more, so later ticks leave the provider alone.
    vi.advanceTimersByTime(10 * MINUTE);
    await tick(database);
    expect(providerCalls()).toBe(0);
    expect(database.imageSteps().map((step) => step.status)).toEqual(['failed', 'failed']);
  });

  it('is given half an hour from its first refusal, not from each attempt', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();

    await staysBusyFor(database, 30);

    // Four ticks, ten minutes apart: three attempts waited, the fourth gave up.
    expect(database.imageAttempts().map((attempts) => attempts.map((step) => [step.attempt, step.status]))).toEqual([
      [[0, 'failed'], [1, 'failed'], [2, 'failed'], [3, 'failed']],
      [[0, 'failed'], [1, 'failed'], [2, 'failed'], [3, 'failed']],
    ]);
  });

  it('gets a fresh half hour when the person retries it', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();
    const stopped = await staysBusyFor(database, 30);

    for (const step of shownImageSteps(stopped)) {
      await retryTemplateRunStep({
        adminClient: database.client, runId: TEMPLATE_RUN_ID, stepId: step.id, userId: TEMPLATE_RUN_USER_ID,
      });
    }
    const retried = await tick(database);

    expect(providerCalls()).toBe(2);
    expect(shownImageSteps(retried).map((step) => step.status)).toEqual(['queued', 'queued']);
    expect(retried.status).toBe('queued');
  });

  it('still follows a refused generation that holds its credits when the half hour is up', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerIsBusy();
    await staysBusyFor(database, 20);

    vi.advanceTimersByTime(10 * MINUTE);
    database.conditions.settlementUnavailable = true;
    const run = await tick(database);

    // Failing the step here would offer a retry while the first hold is
    // still in place, and a retry would place a second one.
    expect(database.imageSteps().map((step) => [step.status, database.generationOf(step)?.status])).toEqual([
      ['processing', 'pending'],
      ['processing', 'pending'],
    ]);
    expect(run.status).toBe('processing');
  });

  it('is given the same half hour when it waits in place', async () => {
    const database = connect(createTemplateRunDatabase({ credits: STARTING_CREDITS }));
    providerHasRoom();
    database.conditions.startUnavailable = true;

    const run = await staysBusyFor(database, 30);

    expect(database.imageAttempts().map((attempts) => attempts.map((step) => [step.attempt, step.status]))).toEqual([
      [[0, 'failed']],
      [[0, 'failed']],
    ]);
    expect(shownImageSteps(run).map((step) => [step.failureCode, step.canRetry])).toEqual([
      ['provider_unavailable', true],
      ['provider_unavailable', true],
    ]);
    expect(run.status).toBe('needs_attention');
  });
});
