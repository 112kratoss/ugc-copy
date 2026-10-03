import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  withUniqueDedupeKeys,
} from '@/__tests__/fixtures/mobile-notification-history';
import {
  createTemplateRunDatabase,
  TEMPLATE_RUN_ID,
  TEMPLATE_RUN_USER_ID,
} from '@/__tests__/fixtures/template-run-database';
import { createTemplateRunJobQueue } from '@/__tests__/fixtures/template-run-job-queue';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { startImageGeneration, type TemplateGenerationContext } from '@/lib/generation-services';
import { processTemplateRunJobs } from '@/lib/template-run-jobs-processor';
import { getTemplateRun, retryTemplateRunStep, syncTemplateRun } from '@/lib/template-run-service';

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

// The job processor and the run worker are under test, with the real start
// service and the real notifier. The node executor is stood in for by the one
// thing it does for an image step: that start service, called with the
// context the worker gave it.
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

type Row = Record<string, unknown>;
type Answer = { data: unknown; error: unknown };
type LooseClient = {
  from: (table: string) => unknown;
  rpc: (fn: string, args?: Row) => Promise<Answer>;
};

const STARTING_CREDITS = 100;
const MINUTE = 60_000;
const RUN_LINK = `/template-runs/${TEMPLATE_RUN_ID}`;
/** What the person reads on a step the database refused, when a retry can start. */
const REFUSED = 'This step could not be started because of a problem on our side. No credits were used for it. Retry it to continue.';
/** And when a retry would be refused as well. */
const REFUSED_FOR_GOOD = 'This step could not be started because of a problem on our side, and retrying it will not help. No credits were used for it. Start a new run to try again.';
/** What a step whose generation the provider refused reads. */
const PROVIDER_REFUSED = 'The generation provider could not accept this request. Check the template inputs before retrying.';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The provider answers and turns the request down for good: nothing will run. */
function providerRefuses() {
  vi.mocked(fetch).mockImplementation(async () => json({ code: 422, msg: 'The request was not accepted.' }));
}

let tasks = 0;
function providerHasRoom() {
  vi.mocked(fetch).mockImplementation(async () => json({ code: 200, data: { taskId: `task-${tasks += 1}` } }));
}

/**
 * A run of the starter template with its ticket, the worker that passes over
 * it, and the person's notifications. The run's rows and the start function
 * live in `database`, its ticket in `queue`.
 */
function createWorld() {
  const database = createTemplateRunDatabase({ credits: STARTING_CREDITS });
  const queue = createTemplateRunJobQueue();
  const notifications = withUniqueDedupeKeys(createMobileNotificationHistory());
  const runDatabase = database.client as unknown as LooseClient;
  const hooks = {
    /** Runs just ahead of each start the worker sends: another pass, or the person, gets in first. */
    beforeStart: null as null | ((args: Row) => Promise<void> | void),
    /** Runs just ahead of each write to a step row, with what is about to be written. */
    beforeStepWrite: null as null | ((values: Row) => void),
  };
  const client = {
    ...database.client,
    from: (table: string) => {
      if (notifications.handles(table)) return notifications.from(table);
      const query = runDatabase.from(table) as { update: (values: Row) => unknown };
      if (table === 'template_run_steps') {
        const update = query.update.bind(query);
        query.update = (values: Row) => {
          hooks.beforeStepWrite?.(values);
          return update(values);
        };
      }
      return query;
    },
    rpc: async (fn: string, args: Row = {}) => {
      if (notifications.handlesRpc(fn)) return notifications.rpc(fn, args);
      // A retry by hand writes the run's ticket.
      if (fn === 'enqueue_template_run_job') return (queue.client as unknown as LooseClient).rpc(fn, args);
      if (fn === 'start_template_generation') await hooks.beforeStart?.(args);
      return runDatabase.rpc(fn, args);
    },
  } as unknown as SupabaseClient;
  service.client = client;

  // The start route: the run is queued, and the status change writes its ticket.
  queue.addRun({ id: TEMPLATE_RUN_ID, userId: TEMPLATE_RUN_USER_ID, status: 'collecting_inputs' });
  queue.setRunStatus(TEMPLATE_RUN_ID, 'queued');

  return { database, queue, notifications, client, runDatabase, hooks, abandonRun: vi.fn(async () => false) };
}

type World = ReturnType<typeof createWorld>;

/** One call of the job processor, as the cron job, a provider callback and the run's routes make it. */
function pass(world: World) {
  return processTemplateRunJobs({
    client: world.queue.client,
    lockedBy: 'worker',
    abandonRun: world.abandonRun,
    syncRun: async (params) => {
      const run = await syncTemplateRun({ ...params, adminClient: world.client });
      // What the run row's triggers do in the database: every pass that works
      // writes the run, and a status that changes to queued or processing
      // writes its ticket.
      world.queue.setRunStatus(run.id, run.status);
      return run;
    },
  });
}

/** What the run page and the app are sent. */
function shown(world: World) {
  return getTemplateRun({ adminClient: world.client, runId: TEMPLATE_RUN_ID, userId: TEMPLATE_RUN_USER_ID });
}

/** The image steps as the person sees them: status, message, failure code and whether a retry is offered. */
async function shownImageSteps(world: World) {
  const ids = world.database.imageSteps().map((step) => step.id);
  return (await shown(world)).steps.filter((step) => ids.includes(step.id))
    .map((step) => [step.status, step.errorMessage, step.failureCode, step.canRetry]);
}

/** The approvals and the video step, which wait on the two image steps. */
async function shownLaterSteps(world: World) {
  const imageStepIds = world.database.imageSteps().map((step) => step.id);
  return (await shown(world)).steps.filter((step) => !imageStepIds.includes(step.id))
    .map((step) => [step.kind, step.status, step.errorMessage]);
}

/** Writes the run's status by hand, as the arrangement of a state does. */
function setRunStatus(world: World, status: 'queued' | 'processing') {
  Object.assign(world.database.run, { status, error_message: null });
  world.queue.setRunStatus(TEMPLATE_RUN_ID, status);
}

/** Puts the image step rows, which were started once, back in line, and the run with them. */
function putBackInLine(world: World) {
  for (const step of world.database.imageSteps()) {
    Object.assign(step, { status: 'queued', error_message: null, finished_at: null, output_snapshot: null });
  }
  setRunStatus(world, 'queued');
}

/** The person retries a failed step from the run page. */
async function retryByHand(world: World, stepId: string) {
  const run = await retryTemplateRunStep({
    adminClient: world.client, runId: TEMPLATE_RUN_ID, stepId, userId: TEMPLATE_RUN_USER_ID,
  });
  // The run row's trigger: its status changed, so its ticket is written.
  world.queue.setRunStatus(TEMPLATE_RUN_ID, run.status);
  return run;
}

/** The request key the worker sends for a step row. */
function requestKey(step: Row) {
  return createHash('sha256').update(`template-run:${step.run_id}:${step.node_id}:${step.attempt}`).digest('hex');
}

/** A generation of the same person that belongs to another run. */
function strayGeneration(world: World, values: Row) {
  const generation: Row = {
    id: `gen-stray-${world.database.generations.length + 1}`,
    user_id: TEMPLATE_RUN_USER_ID,
    model: 'nano-banana-2',
    category: 'image',
    status: 'failed',
    prediction_id: null,
    output_url: null,
    error_message: null,
    cost: 4,
    actual_cost: null,
    refunded: true,
    client_request_key_hash: null,
    template_run_id: 'run-other',
    template_run_step_id: 'step-other',
    studio_visible: false,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    ...values,
  };
  world.database.generations.push(generation);
  return generation;
}

let logs: BackendLogRecord[] = [];
let restoreLogSink = () => {};
const logged = (event: string) => logs.filter((record) => record.msg === event);

beforeEach(() => {
  // Only the clock is faked: the processor's heartbeat timer and the
  // provider client's timeouts run as they are.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T06:00:00.000Z'));
  vi.stubGlobal('fetch', vi.fn());
  // The provider client reports every refused call on the console.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logs = [];
  restoreLogSink = setBackendLogSink((record) => logs.push(record));
});

afterEach(() => {
  restoreLogSink();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  service.client = null;
});

/**
 * Passes of the worker ten minutes apart, as the cron job alone makes them.
 * For each: what the start function answered, what the pass reported, and
 * where the run stood afterwards.
 */
async function passes(world: World, count: number) {
  const seen = [];
  for (let index = 0; index < count; index += 1) {
    if (index > 0) vi.setSystemTime(Date.now() + 10 * MINUTE);
    const before = world.database.starts().length;
    const summary = await pass(world);
    seen.push({
      answers: world.database.starts().slice(before).map((entry) => entry.status ?? entry.error),
      worked: [summary.claimed, summary.completed, summary.deferred],
      steps: world.database.imageSteps().map((step) => step.status),
      run: (await shown(world)).status,
      ticket: world.queue.job(TEMPLATE_RUN_ID)?.status ?? null,
    });
  }
  return seen;
}

/** A pass that ended the wait: the ticket is closed, and the run is with the person. */
const ENDED = { worked: [1, 1, 0], run: 'needs_attention', ticket: 'succeeded' };
/** A pass that found nothing to do: the run has no ticket due. */
const NOTHING_DUE = { answers: [], worked: [0, 0, 0] };

/**
 * Both image steps were started once, the provider refused them, and their
 * credits were returned. Then the rows were put back in line: what the worker
 * did with a busy refusal before it retried a busy step as a new attempt, and
 * what an edit by hand can still do. The refund cleared each generation's
 * request key, so the database answers `template_step_already_started`.
 */
async function startedOnceAndPutBackInLine(world: World) {
  providerRefuses();
  await pass(world);
  putBackInLine(world);
}

/**
 * As above, but each failed generation still holds its request key, so the
 * database answers `key_already_used`. No code path writes this today: the
 * settlement of a refused start clears the key.
 */
async function failedStartKeptItsKey(world: World) {
  await startedOnceAndPutBackInLine(world);
  for (const step of world.database.imageSteps()) {
    Object.assign(world.database.generationOf(step)!, { client_request_key_hash: requestKey(step) });
  }
}

describe('a template run step that is in line but was already started', () => {
  it.each([
    ['its refund cleared the request key', startedOnceAndPutBackInLine],
    ['its failed start still holds the request key', failedStartKeptItsKey],
  ])('takes the failure of the generation it was started with when %s', async (_shape, arrange) => {
    const world = createWorld();
    await arrange(world);
    const announced = world.notifications.sent.length;
    logs = [];

    const seen = await passes(world, 3);

    expect(seen).toEqual([
      // The first pass ends the wait, and never asks the database to start the rows.
      { answers: [], steps: ['failed', 'failed'], ...ENDED },
      { steps: ['failed', 'failed'], run: 'needs_attention', ticket: 'succeeded', ...NOTHING_DUE },
      { steps: ['failed', 'failed'], run: 'needs_attention', ticket: 'succeeded', ...NOTHING_DUE },
    ]);
    // The person reads why the generation failed, and can retry the step.
    expect(await shownImageSteps(world)).toEqual([
      ['failed', PROVIDER_REFUSED, 'provider_rejected', true],
      ['failed', PROVIDER_REFUSED, 'provider_rejected', true],
    ]);
    expect((await shown(world)).errorMessage).toBe(PROVIDER_REFUSED);
    // The steps after them stay in line for when they are retried.
    expect(await shownLaterSteps(world)).toEqual([
      ['approval', 'queued', null],
      ['approval', 'queued', null],
      ['generation', 'queued', null],
    ]);
    expect(world.database.imageSteps().map((step) => step.finished_at)).toEqual([expect.any(String), expect.any(String)]);
    expect(logged('template_run_step_followed_its_generation')).toEqual(world.database.imageSteps().map((step) => (
      expect.objectContaining({
        level: 'warn', runId: TEMPLATE_RUN_ID, stepId: step.id, generationId: step.generation_id, generationStatus: 'failed',
      })
    )));
    // Each failure was announced when the provider refused it, and is not announced twice.
    expect(announced).toBe(2);
    expect(world.notifications.sent).toHaveLength(2);
    expect(world.database.credits()).toBe(STARTING_CREDITS);
  });

  it('tells the person its generation failed when nobody had', async () => {
    const world = createWorld();
    await startedOnceAndPutBackInLine(world);
    // The pass that put the rows back in line had not failed the steps, so it announced nothing.
    world.notifications.sent.length = 0;

    await passes(world, 2);

    expect(world.notifications.sent.map((row) => [row.type, row.body, row.deep_link, row.dedupe_key])).toEqual(
      world.database.generations.map((generation) => [
        'generation_failed',
        'Open your template run to retry this step.',
        RUN_LINK,
        `generation:${generation.id}:failed`,
      ]),
    );
  });

  it('is retried by hand as its next attempt, which starts', async () => {
    const world = createWorld();
    await startedOnceAndPutBackInLine(world);
    await pass(world);

    for (const step of world.database.imageSteps()) await retryByHand(world, step.id as string);
    providerHasRoom();
    const [retried] = await passes(world, 1);

    expect(retried).toMatchObject({ answers: ['started', 'started'], steps: ['processing', 'processing'], run: 'processing' });
    expect(world.database.imageAttempts().map((attempts) => attempts.map((step) => [step.attempt, step.status]))).toEqual([
      [[0, 'failed'], [1, 'processing']],
      [[0, 'failed'], [1, 'processing']],
    ]);
  });

  it('takes the result of a generation the provider accepted, and the run goes on', async () => {
    const world = createWorld();
    providerHasRoom();
    await pass(world);
    const cost = world.database.generations[0].cost as number;
    putBackInLine(world);
    // The provider finishes both images.
    world.database.generations.forEach((generation, index) => {
      Object.assign(generation, {
        status: 'succeeded',
        output_url: `generated_images/${TEMPLATE_RUN_USER_ID}/finished-${index + 1}.png`,
        completed_at: new Date().toISOString(),
      });
    });
    vi.mocked(fetch).mockClear();

    const [seen] = await passes(world, 1);

    // Nothing is started again: the results the person paid for are the steps' results.
    expect(seen).toEqual({
      answers: [], worked: [1, 1, 0], steps: ['succeeded', 'succeeded'], run: 'awaiting_approval', ticket: 'succeeded',
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(world.database.generations).toHaveLength(2);
    expect(world.database.credits()).toBe(STARTING_CREDITS - 2 * cost);
    expect((await shown(world)).steps.filter((step) => step.kind === 'generation' && step.mediaKind === 'image')
      .map((step) => [step.status, step.outputUrl !== null, step.errorMessage])).toEqual([
      ['succeeded', true, null],
      ['succeeded', true, null],
    ]);
    // The run has reached its reviews.
    expect(await shownLaterSteps(world)).toEqual([
      ['approval', 'awaiting_approval', null],
      ['approval', 'awaiting_approval', null],
      ['generation', 'queued', null],
    ]);
  });

  it('takes its generation back when its row has lost the link to it', async () => {
    const world = createWorld();
    providerHasRoom();
    await pass(world);
    putBackInLine(world);
    // The rows no longer name their generations, which still name the rows.
    for (const step of world.database.imageSteps()) step.generation_id = null;
    world.database.generations.forEach((generation, index) => {
      Object.assign(generation, {
        status: 'succeeded',
        output_url: `generated_images/${TEMPLATE_RUN_USER_ID}/finished-${index + 1}.png`,
        completed_at: new Date().toISOString(),
      });
    });

    const [seen] = await passes(world, 1);

    expect(seen).toMatchObject({ answers: [], steps: ['succeeded', 'succeeded'], run: 'awaiting_approval' });
    expect(world.database.imageSteps().map((step) => step.generation_id)).toEqual(
      world.database.generations.map((generation) => generation.id),
    );
  });

  it('follows a generation that is still running, and starts nothing beside it', async () => {
    const world = createWorld();
    providerHasRoom();
    await pass(world);
    const cost = world.database.generations[0].cost as number;
    putBackInLine(world);
    vi.mocked(fetch).mockClear();

    const [following] = await passes(world, 1);

    expect(following).toEqual({
      answers: [], worked: [1, 0, 1], steps: ['processing', 'processing'], run: 'processing', ticket: 'pending',
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(world.database.generations).toHaveLength(2);
    expect(world.database.credits()).toBe(STARTING_CREDITS - 2 * cost);
    expect(world.database.imageSteps().map((step) => [step.error_message, step.finished_at])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(world.notifications.sent).toEqual([]);

    // The first image finishes, which writes the run's ticket, and its step takes the result.
    Object.assign(world.database.generations[0], {
      status: 'succeeded',
      output_url: `generated_images/${TEMPLATE_RUN_USER_ID}/finished-1.png`,
      completed_at: new Date().toISOString(),
    });
    world.queue.generationTurnedTerminal(TEMPLATE_RUN_ID);
    const [finished] = await passes(world, 1);

    expect(finished.steps).toEqual(['succeeded', 'processing']);
  });

  it('follows a generation that turned up on its row after the pass had read the run', async () => {
    const world = createWorld();
    providerHasRoom();
    // Another pass started each row after this pass read the run, and then
    // wrote the row back in line over its own start.
    world.hooks.beforeStart = async (args) => {
      await world.runDatabase.rpc('start_template_generation', args);
      world.database.steps.find((step) => step.id === args.p_template_run_step_id)!.status = 'queued';
    };

    const [seen] = await passes(world, 1);

    // The database refuses a second start, and the row takes the one it has.
    expect(seen).toEqual({
      answers: ['started', 'in_progress', 'started', 'in_progress'],
      worked: [1, 0, 1],
      steps: ['processing', 'processing'],
      run: 'processing',
      ticket: 'pending',
    });
    expect(world.database.generations).toHaveLength(2);
    expect(logged('template_run_step_followed_its_generation')).toHaveLength(2);
    expect(logged('template_run_step_start_refused')).toEqual([]);
    expect(world.notifications.sent).toEqual([]);
  });
});

describe('a template run step the database refuses to start, with nothing behind it', () => {
  it('fails in the pass that meets the refusal, with no retry, when its row disagrees with what its node starts', async () => {
    const world = createWorld();
    // The rows say video, and the worker starts the image generations their nodes ask for.
    for (const step of world.database.imageSteps()) step.media_kind = 'video';

    const seen = await passes(world, 3);

    expect(seen).toEqual([
      { answers: ['invalid_template_context', 'invalid_template_context'], steps: ['failed', 'failed'], ...ENDED },
      // The database is asked once, not on every pass.
      { steps: ['failed', 'failed'], run: 'needs_attention', ticket: 'succeeded', ...NOTHING_DUE },
      { steps: ['failed', 'failed'], run: 'needs_attention', ticket: 'succeeded', ...NOTHING_DUE },
    ]);
    // A retry is a new row for the same node, which would be refused as well.
    expect(await shownImageSteps(world)).toEqual([
      ['failed', REFUSED_FOR_GOOD, 'provider_rejected', false],
      ['failed', REFUSED_FOR_GOOD, 'provider_rejected', false],
    ]);
    expect((await shown(world)).errorMessage).toBe(REFUSED_FOR_GOOD);
    expect(world.database.imageSteps().map((step) => step.finished_at)).toEqual([expect.any(String), expect.any(String)]);
    // The steps after them are not failed with them.
    expect(await shownLaterSteps(world)).toEqual([
      ['approval', 'queued', null],
      ['approval', 'queued', null],
      ['generation', 'queued', null],
    ]);
    // Nothing was ever held for them.
    expect(world.database.generations).toEqual([]);
    expect(world.database.credits()).toBe(STARTING_CREDITS);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    // The person is told once for each step, and the operator's log says what the database answered.
    expect(world.notifications.sent).toEqual(world.database.imageSteps().map((step) => expect.objectContaining({
      user_id: TEMPLATE_RUN_USER_ID,
      type: 'generation_failed',
      category: 'generation',
      title: 'A step in your template run could not start',
      body: 'A problem on our side stopped it. Open the run to start a new one.',
      deep_link: RUN_LINK,
      object_type: 'template_run',
      object_id: TEMPLATE_RUN_ID,
      dedupe_key: `template-run:${TEMPLATE_RUN_ID}:step:${step.id}:refused`,
    })));
    expect(logged('template_run_step_start_refused')).toEqual(world.database.imageSteps().map((step) => (
      expect.objectContaining({
        level: 'error',
        runId: TEMPLATE_RUN_ID,
        stepId: step.id,
        nodeId: step.node_id,
        attempt: 0,
        refusal: 'invalid_template_context',
        canRetry: false,
      })
    )));

    const [step] = world.database.imageSteps();
    await expect(retryByHand(world, step.id as string)).rejects.toMatchObject({ status: 409, code: 'STEP_NOT_RETRYABLE' });
  });

  /** A row the database refuses for the generation on it or for its key, and the answer it gives. */
  const REFUSED_FOR_THE_ROW: Array<[string, (world: World, step: Row) => void, string]> = [
    ['its row names a generation that is not its own', (world, step) => {
      step.generation_id = strayGeneration(world, { status: 'succeeded' }).id;
    }, 'template_step_already_started'],
    ['its request key belongs to another start that is over', (world, step) => {
      strayGeneration(world, { client_request_key_hash: requestKey(step) });
    }, 'key_already_used'],
    // A generation the run does not hold can never be followed to an end.
    ['the generation on its row belongs to no step of this run', (world, step) => {
      step.generation_id = strayGeneration(world, { status: 'processing', template_run_step_id: step.id }).id;
    }, 'template_step_already_started'],
  ];

  it.each(REFUSED_FOR_THE_ROW)('fails with a retry when %s, and the retry starts', async (_shape, arrange, answer) => {
    const world = createWorld();
    const [refused, other] = world.database.imageSteps();
    arrange(world, refused);
    providerHasRoom();

    const seen = await passes(world, 2);

    expect(seen).toEqual([
      // The other image step starts as usual.
      { answers: [answer, 'started'], steps: ['failed', 'processing'], ...ENDED },
      { steps: ['failed', 'processing'], run: 'needs_attention', ticket: 'succeeded', ...NOTHING_DUE },
    ]);
    expect(await shownImageSteps(world)).toEqual([
      ['failed', REFUSED, 'provider_rejected', true],
      ['processing', null, null, false],
    ]);
    expect((await shown(world)).errorMessage).toBe(REFUSED);
    expect(world.notifications.sent).toEqual([expect.objectContaining({
      type: 'generation_failed',
      title: 'A step in your template run could not start',
      body: 'A problem on our side stopped it. Open the run to retry the step.',
      deep_link: RUN_LINK,
      dedupe_key: `template-run:${TEMPLATE_RUN_ID}:step:${refused.id}:refused`,
    })]);
    expect(logged('template_run_step_start_refused')).toEqual([
      expect.objectContaining({ level: 'error', stepId: refused.id, refusal: answer, canRetry: true }),
    ]);
    const cost = world.database.generationOf(other)!.cost as number;
    expect(world.database.credits()).toBe(STARTING_CREDITS - cost);

    // A retry is a new row with a new request key, which the database starts.
    await retryByHand(world, refused.id as string);
    const [retried] = await passes(world, 1);

    expect(retried).toMatchObject({ answers: ['started'], steps: ['processing', 'processing'], run: 'processing' });
    expect(world.database.imageAttempts()[0].map((step) => [step.attempt, step.status])).toEqual([
      [0, 'failed'],
      [1, 'processing'],
    ]);
    expect(world.database.credits()).toBe(STARTING_CREDITS - 2 * cost);
  });
});

describe('a template run step two passes of the worker reach at once', () => {
  const quiet = (world: World) => ({
    told: world.notifications.sent,
    refused: logged('template_run_step_start_refused'),
    followed: logged('template_run_step_followed_its_generation'),
  });

  it('is left to the pass that started it first', async () => {
    const world = createWorld();
    providerHasRoom();
    // The other pass starts each row a moment before this pass's start arrives.
    world.hooks.beforeStart = async (args) => {
      await world.runDatabase.rpc('start_template_generation', args);
    };

    const [seen] = await passes(world, 1);

    expect(seen).toEqual({
      answers: ['started', 'in_progress', 'started', 'in_progress'],
      worked: [1, 0, 1],
      steps: ['processing', 'processing'],
      run: 'processing',
      ticket: 'pending',
    });
    // One generation for each row, and it is the other pass's.
    expect(world.database.imageSteps().map((step) => [step.error_message, world.database.generationOf(step)?.status])).toEqual([
      [null, 'pending'],
      [null, 'pending'],
    ]);
    expect(world.database.generations).toHaveLength(2);
    expect(quiet(world)).toEqual({ told: [], refused: [], followed: [] });
  });

  it('is left as the other pass ended it when that pass had its start refused meanwhile', async () => {
    const world = createWorld();
    providerHasRoom();
    // The other pass starts each row, the provider refuses it, and that pass
    // fails the step, all before this pass's start arrives.
    world.hooks.beforeStart = async (args) => {
      const started = await world.runDatabase.rpc('start_template_generation', args);
      await world.runDatabase.rpc('settle_template_generation_start_failed', {
        p_generation_id: (started.data as { generation_id: string }).generation_id,
        p_error_message: 'What the other pass wrote.',
      });
    };

    const [seen] = await passes(world, 1);

    expect(seen).toMatchObject({
      answers: ['started', 'template_step_already_started', 'started', 'template_step_already_started'],
      steps: ['failed', 'failed'],
    });
    // This pass wrote nothing over it, and told nobody: the step is the other pass's to announce.
    expect(world.database.imageSteps().map((step) => [step.error_message, step.can_retry])).toEqual([
      ['What the other pass wrote.', true],
      ['What the other pass wrote.', true],
    ]);
    expect(quiet(world)).toEqual({ told: [], refused: [], followed: [] });
  });

  /** The other pass ends both image steps the moment this pass is about to write one with `status`. */
  function otherPassEndsTheStepsBeforeAWriteOf(world: World, status: string) {
    world.hooks.beforeStepWrite = (values) => {
      if (values.status !== status) return;
      world.hooks.beforeStepWrite = null;
      for (const step of world.database.imageSteps()) {
        Object.assign(step, { status: 'failed', error_message: 'What the other pass wrote.', finished_at: new Date().toISOString() });
      }
    };
  }

  it('is failed and announced once when both passes meet the same refusal', async () => {
    const world = createWorld();
    for (const step of world.database.imageSteps()) step.media_kind = 'video';
    // This pass has looked at the rows and found them in line. The other pass
    // fails them before this pass's own write arrives.
    otherPassEndsTheStepsBeforeAWriteOf(world, 'failed');

    const [seen] = await passes(world, 1);

    expect(seen).toMatchObject({
      answers: ['invalid_template_context', 'invalid_template_context'],
      steps: ['failed', 'failed'],
    });
    expect(world.database.imageSteps().map((step) => [step.error_message, step.can_retry])).toEqual([
      ['What the other pass wrote.', true],
      ['What the other pass wrote.', true],
    ]);
    expect(quiet(world)).toEqual({ told: [], refused: [], followed: [] });
  });

  it('is left as the other pass ended it when both passes find it already started', async () => {
    const world = createWorld();
    await startedOnceAndPutBackInLine(world);
    world.notifications.sent.length = 0;
    logs = [];
    otherPassEndsTheStepsBeforeAWriteOf(world, 'processing');

    const [seen] = await passes(world, 1);

    // The rows are read again, so nothing is started over what the other pass did.
    expect(seen).toMatchObject({ answers: [], steps: ['failed', 'failed'], run: 'needs_attention' });
    expect(world.database.imageSteps().map((step) => step.error_message)).toEqual([
      'What the other pass wrote.',
      'What the other pass wrote.',
    ]);
    expect(quiet(world)).toEqual({ told: [], refused: [], followed: [] });
  });

  it('is left alone when the person cancels the run under the pass', async () => {
    const world = createWorld();
    providerHasRoom();
    // The cancel has written the run and not yet its steps.
    world.hooks.beforeStart = () => {
      world.database.run.status = 'cancelled';
    };

    const [seen] = await passes(world, 1);

    expect(seen).toMatchObject({
      answers: ['invalid_template_context', 'invalid_template_context'],
      // The cancel marks the steps itself.
      steps: ['queued', 'queued'],
      run: 'cancelled',
    });
    expect(world.database.imageSteps().map((step) => [step.error_message, step.can_retry, step.finished_at])).toEqual([
      [null, true, null],
      [null, true, null],
    ]);
    expect(quiet(world)).toEqual({ told: [], refused: [], followed: [] });
  });
});
