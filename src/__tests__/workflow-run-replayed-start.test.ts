import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  withMobileNotificationHistory,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { ExternalServiceTimeoutError } from '@/lib/provider-fetch';
import {
  createCanvasEdge,
  createWorkflowNode,
  normalizeWorkflowGraph,
  type ApprovalGateNodeData,
  type TextInputNodeData,
} from '@/lib/workflow-canvas';
import { advanceWorkflowRunOnce } from '@/lib/workflow-runner';

// The run worker starts a step with a request key made from the run and the
// node, so a start it repeats finds the generation its first try reserved.
// These cases run the real worker, the real start service and the real
// notifier over one small database, and lose the link between the step and
// that generation in each of the ways it can be lost. Only the provider's HTTP
// calls are stubbed.

// The provider key and the callback settings are read when the generation
// modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
  vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'test-webhook-secret');
  vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'hmac-key');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
});

// The worker makes its own service client for the credit hold and the provider
// gate. Each test hands it the database the run lives in.
const service = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/server-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server-helpers')>()),
  createServiceClient: () => service.client,
}));

vi.mock('@/lib/generation-model-catalog-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generation-model-catalog-store')>()),
  quotePublishedGenerationModel: async (input: { modelId: string; catalogRevision?: string | null }) => ({
    modelId: input.modelId,
    catalogRevision: input.catalogRevision ?? 'catalog-rev-1',
    normalizedSettings: {},
    costCredits: 12,
  }),
}));

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'in'; column: string; value: unknown };

const ACTIVE = ['pending', 'waiting', 'processing'];
const HELD_NOTE = /may still be running.*credits stay reserved/i;
const REAPED_MESSAGE = 'The generation provider is temporarily unavailable. Please retry this step shortly.';

/**
 * A workflow run of prompt, image, approval checkpoint, and the generations it
 * starts. The checkpoint is the step that depends on the image, so it shows
 * whether the image step is still alive (`queued`), has ended badly
 * (`blocked`) or has delivered (`awaiting_approval`).
 *
 * `start_generation`, the task attach, the held mark and the start settlement
 * answer as the SQL functions do for the request key.
 */
function createRunDatabase() {
  const prompt = createWorkflowNode('text-input', { x: 40, y: 40 });
  const image = createWorkflowNode('image-generate', { x: 280, y: 40 });
  const gate = createWorkflowNode('approval-gate', { x: 520, y: 40 });
  const graph = normalizeWorkflowGraph({
    nodes: [
      { ...prompt, data: { ...(prompt.data as TextInputNodeData), text: 'A ceramic mug on a linen cloth' } },
      image,
      { ...gate, data: { ...(gate.data as ApprovalGateNodeData), mediaKind: 'image', label: 'Review the mug' } },
    ],
    edges: [
      createCanvasEdge(prompt.id, 'text', image.id, 'prompt'),
      createCanvasEdge(image.id, 'image', gate.id, 'image'),
    ],
  });
  const queuedStep = (id: string, nodeId: string): Row => ({
    id,
    run_id: 'run-1',
    node_id: nodeId,
    status: 'queued',
    generation_id: null,
    input_snapshot: null,
    output_snapshot: null,
    error_message: null,
    started_at: null,
    finished_at: null,
  });

  const tables: Record<string, Row[]> = {
    workflow_canvas_runs: [{
      id: 'run-1',
      canvas_id: 'canvas-1',
      user_id: 'user-1',
      start_node_id: image.id,
      mode: 'branch',
      status: 'processing',
      created_at: '2026-10-02T10:00:00.000Z',
      finished_at: null,
      catalog_revision: 'catalog-rev-1',
      graph_snapshot: graph,
    }],
    workflow_canvas_run_steps: [queuedStep('step-image', image.id), queuedStep('step-gate', gate.id)],
    generations: [],
  };
  const state = {
    credits: 500,
    /** Step writes that link a generation and are refused, as a lost connection would. */
    stepLinkWritesToRefuse: 0,
    /** What the database says when it refuses one. */
    stepLinkWriteError: 'connection reset',
    /** Task attaches that are refused, as an unreachable database would. */
    attachesToRefuse: 0,
  };
  const rpcCalls: string[] = [];

  function matching(table: string, filters: Filter[]) {
    return (tables[table] ?? []).filter((row) => filters.every((filter) => (
      filter.op === 'eq'
        ? row[filter.column] === filter.value
        : Array.isArray(filter.value) && filter.value.includes(row[filter.column])
    )));
  }

  function from(table: string) {
    if (!tables[table]) throw new Error(`Unexpected table: ${table}`);
    const filters: Filter[] = [];
    let update: Row | null = null;
    const run = (): { rows: Row[]; error: { message: string } | null } => {
      const rows = matching(table, filters);
      if (!update) return { rows, error: null };
      if (table === 'workflow_canvas_run_steps' && update.generation_id && state.stepLinkWritesToRefuse > 0) {
        state.stepLinkWritesToRefuse -= 1;
        return { rows: [], error: { message: state.stepLinkWriteError } };
      }
      for (const row of rows) Object.assign(row, update);
      return { rows, error: null };
    };
    const query = {
      select: () => query,
      update(values: Row) {
        update = values;
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push({ op: 'eq', column, value });
        return query;
      },
      in(column: string, value: unknown[]) {
        filters.push({ op: 'in', column, value });
        return query;
      },
      order: () => query,
      async single() {
        const row = run().rows[0];
        return row ? { data: { ...row }, error: null } : { data: null, error: { message: 'No rows found' } };
      },
      async maybeSingle() {
        const row = run().rows[0];
        return { data: row ? { ...row } : null, error: null };
      },
      then(resolve: (value: { data: Row[] | null; error: { message: string } | null }) => unknown) {
        const { rows, error } = run();
        return resolve(error ? { data: null, error } : { data: rows.map((row) => ({ ...row })), error: null });
      },
    };
    return query;
  }

  const generation = (id: unknown) => tables.generations.find((row) => row.id === id);

  async function rpc(fn: string, args: Row = {}) {
    rpcCalls.push(fn);

    if (fn === 'start_generation') {
      const cost = Number(args.p_cost);
      const existing = args.p_client_request_key_hash
        ? tables.generations.find((row) => (
            row.user_id === args.p_user_id && row.client_request_key_hash === args.p_client_request_key_hash
          ))
        : undefined;
      if (existing) {
        const replay = { generation_id: existing.id, remaining_credits: state.credits, cost: existing.cost };
        if (existing.prediction_id) {
          return { data: { status: 'already_started', prediction_id: existing.prediction_id, ...replay }, error: null };
        }
        return {
          data: { status: ACTIVE.includes(String(existing.status)) ? 'in_progress' : 'key_already_used', ...replay },
          error: null,
        };
      }
      if (state.credits < cost) {
        return { data: { status: 'insufficient_credits', remaining_credits: state.credits }, error: null };
      }
      state.credits -= cost;
      const started: Row = {
        id: `gen-${tables.generations.length + 1}`,
        user_id: args.p_user_id,
        model: args.p_model,
        category: args.p_category,
        cost,
        status: 'pending',
        prediction_id: null,
        output_url: null,
        refunded: false,
        client_request_key_hash: args.p_client_request_key_hash ?? null,
        submission_unknown_at: null,
        created_at: '2026-10-02T10:00:05.000Z',
        completed_at: null,
      };
      tables.generations.push(started);
      return {
        data: { status: 'started', generation_id: started.id, remaining_credits: state.credits, cost },
        error: null,
      };
    }

    if (fn === 'attach_generation_provider_task') {
      if (state.attachesToRefuse > 0) {
        state.attachesToRefuse -= 1;
        return { data: null, error: { message: 'database unavailable' } };
      }
      const row = generation(args.p_generation_id);
      if (!row) return { data: { status: 'missing' }, error: null };
      if (row.status === 'failed' || row.status === 'succeeded' || row.refunded) {
        return { data: { status: 'already_settled', generation_id: row.id }, error: null };
      }
      if (row.prediction_id) {
        return {
          data: {
            status: row.prediction_id === args.p_prediction_id ? 'already_attached' : 'prediction_conflict',
            generation_id: row.id,
          },
          error: null,
        };
      }
      Object.assign(row, { prediction_id: args.p_prediction_id, status: 'processing' });
      return { data: { status: 'attached', generation_id: row.id, prediction_id: row.prediction_id }, error: null };
    }

    if (fn === 'mark_generation_submission_unknown') {
      const row = generation(args.p_generation_id);
      if (!row) return { data: { status: 'missing' }, error: null };
      if (row.prediction_id) return { data: { status: 'provider_task_attached', generation_id: row.id }, error: null };
      if (!['pending', 'waiting'].includes(String(row.status)) || row.refunded) {
        return { data: { status: 'already_settled', generation_id: row.id }, error: null };
      }
      if (row.submission_unknown_at) return { data: { status: 'already_marked', generation_id: row.id }, error: null };
      row.submission_unknown_at = '2026-10-02T10:00:35.000Z';
      return { data: { status: 'held', generation_id: row.id }, error: null };
    }

    if (fn === 'settle_generation_start_failed') {
      const row = generation(args.p_generation_id);
      if (!row) return { data: { status: 'missing' }, error: null };
      if (row.prediction_id) return { data: { status: 'provider_task_attached', generation_id: row.id }, error: null };
      if (row.status === 'succeeded') return { data: { status: 'already_succeeded', generation_id: row.id }, error: null };
      const refunds = !row.refunded;
      if (refunds) state.credits += Number(row.cost);
      Object.assign(row, {
        status: 'failed',
        error_message: args.p_error_message,
        refunded: true,
        client_request_key_hash: null,
      });
      return {
        data: { status: refunds ? 'failed' : 'already_failed', generation_id: row.id, remaining_credits: state.credits },
        error: null,
      };
    }

    if (fn === 'reserve_provider_submission') {
      return {
        data: { allowed: true, reason: 'admitted', state: 'closed', retryAfterSeconds: 0, inFlight: 1 },
        error: null,
      };
    }

    return { data: null, error: null };
  }

  const [imageStep, gateStep] = tables.workflow_canvas_run_steps;

  return {
    client: {
      from,
      rpc,
      storage: {
        from: (bucket: string) => ({
          createSignedUrl: async (path: string) => ({
            data: { signedUrl: `https://signed.example.com/${bucket}/${path}` },
            error: null,
          }),
        }),
      },
    } as unknown as SupabaseClient,
    state,
    generations: tables.generations,
    run: tables.workflow_canvas_runs[0],
    imageStep,
    gateStep,
    /** The key the worker gives this step's start. */
    stepKey: createHash('sha256').update(`workflow-run:run-1:${image.id}:1`).digest('hex'),
    starts: () => rpcCalls.filter((fn) => fn === 'start_generation').length,
    /**
     * The step as the worker found it, with the generation left as it is: what
     * remains when the function instance dies after the start service returned
     * and before the step was written.
     */
    loseTheStepWrite() {
      Object.assign(imageStep, queuedStep('step-image', image.id));
    },
  };
}

type RunDatabase = ReturnType<typeof createRunDatabase>;

/** The worker's client: the run database, with the notification tables served by `history`. */
function connect(database: RunDatabase) {
  // The notification fixture passes on tables and RPCs only. Signing a
  // finished output needs the storage half as well.
  const client = Object.assign(withMobileNotificationHistory(database.client, history), {
    storage: database.client.storage,
  });
  service.client = client;
  return client;
}

function advance(client: SupabaseClient) {
  return advanceWorkflowRunOnce({ supabase: client, canvasId: 'canvas-1', runId: 'run-1' });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Task creation gets no answer: the provider may or may not have taken it. */
function providerDoesNotAnswer() {
  vi.mocked(fetch).mockRejectedValue(new ExternalServiceTimeoutError('KIE task creation', 30_000));
}

function providerAccepts(taskId: string) {
  vi.mocked(fetch).mockImplementation(async () => json({ code: 200, data: { taskId } }));
}

/** The provider answers and turns the request down: nothing will run, nothing is billed. */
function providerRefuses() {
  vi.mocked(fetch).mockImplementation(async () => json({ code: 422, msg: 'The request was not accepted.' }));
}

/** Calls that asked the provider to create a task, across the whole test. */
function tasksRequested() {
  return vi.mocked(fetch).mock.calls
    .filter(([input]) => String(input instanceof Request ? input.url : input).includes('/jobs/createTask'))
    .length;
}

const logged: BackendLogRecord[] = [];
let restoreLogSink = () => {};
let history: MobileNotificationHistory;

function relinksLogged() {
  return logged.filter((record) => record.msg === 'workflow_run_step_relinked_to_earlier_start');
}

/**
 * The image step has the generation its first start reserved, in the shape a
 * held submission leaves, and nothing downstream has been given up on.
 */
function expectTheStepToHaveItsGenerationBack(database: RunDatabase, run: { status: string }, generationId: string) {
  expect(database.imageStep).toMatchObject({
    status: 'processing',
    generation_id: generationId,
    output_snapshot: { submissionPending: true },
    error_message: expect.stringMatching(HELD_NOTE),
    started_at: expect.any(String),
    finished_at: null,
  });
  expect(database.gateStep).toMatchObject({ status: 'queued', finished_at: null });
  expect(run.status).toBe('processing');
  expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
  // One generation, one hold, and nobody told that anything failed.
  expect(database.generations).toEqual([expect.objectContaining({
    id: generationId,
    status: 'pending',
    prediction_id: null,
    refunded: false,
    client_request_key_hash: database.stepKey,
  })]);
  expect(database.state.credits).toBe(488);
  expect(history.sent).toEqual([]);
  expect(relinksLogged()).toEqual([expect.objectContaining({
    level: 'warn',
    runId: 'run-1',
    stepId: 'step-image',
    generationId,
  })]);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  // The provider client reports every refused or unanswered call on the console.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logged.length = 0;
  restoreLogSink = setBackendLogSink((record) => { logged.push(record); });
  history = createMobileNotificationHistory();
});

afterEach(() => {
  restoreLogSink();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  service.client = null;
});

describe('a workflow run step whose start is repeated while the first one is unresolved', () => {
  it('takes its generation back when the worker died after the start service held the submission', async () => {
    providerDoesNotAnswer();
    const database = createRunDatabase();
    const client = connect(database);

    await advance(client);
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'pending',
      prediction_id: null,
      submission_unknown_at: expect.any(String),
    })]);
    // An ordinary held link: nothing was lost yet, so nothing is taken back.
    expect(database.imageStep).toMatchObject({ status: 'processing', generation_id: 'gen-1' });
    expect(relinksLogged()).toEqual([]);
    database.loseTheStepWrite();

    const run = await advance(client);

    expectTheStepToHaveItsGenerationBack(database, run, 'gen-1');
    // The second start reached the database with the same key and stopped there.
    expect(database.starts()).toBe(2);
    expect(tasksRequested()).toBe(1);
  });

  it('takes its generation back when the step could not be written after the start service held the submission', async () => {
    providerDoesNotAnswer();
    const database = createRunDatabase();
    const client = connect(database);
    database.state.stepLinkWritesToRefuse = 1;

    // The tick fails, so its job is retried. Nothing recorded the generation.
    await expect(advance(client)).rejects.toMatchObject({ message: 'connection reset' });
    expect(database.imageStep).toMatchObject({ status: 'queued', generation_id: null });
    expect(database.generations).toEqual([expect.objectContaining({ id: 'gen-1', status: 'pending' })]);

    const run = await advance(client);

    expectTheStepToHaveItsGenerationBack(database, run, 'gen-1');
    expect(tasksRequested()).toBe(1);
  });

  it('takes its generation back when the provider took the task and the task could not be recorded', async () => {
    providerAccepts('task-not-recorded');
    const database = createRunDatabase();
    const client = connect(database);
    database.state.attachesToRefuse = 3;

    // No worker dies here. The start gives up after three attach attempts and
    // the step is put back in the queue as if the provider were unavailable.
    const first = await advance(client);
    expect(first.status).toBe('processing');
    expect(database.imageStep).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: expect.stringContaining('temporarily unavailable'),
    });

    const run = await advance(client);

    // The provider is rendering it, and must not be asked for a second one.
    expectTheStepToHaveItsGenerationBack(database, run, 'gen-1');
    expect(tasksRequested()).toBe(1);
  });

  it('takes its generation back from a start that never came back at all', async () => {
    const database = createRunDatabase();
    const client = connect(database);
    // The credits were held and the instance died inside the provider call:
    // no task, and no held mark either.
    database.state.credits = 488;
    database.generations.push({
      id: 'gen-unanswered',
      user_id: 'user-1',
      cost: 12,
      status: 'pending',
      prediction_id: null,
      output_url: null,
      refunded: false,
      client_request_key_hash: database.stepKey,
      submission_unknown_at: null,
    });

    const run = await advance(client);

    expectTheStepToHaveItsGenerationBack(database, run, 'gen-unanswered');
    expect(tasksRequested()).toBe(0);
  });

  it('asks for the start once more, and never again after it has the generation', async () => {
    providerDoesNotAnswer();
    const database = createRunDatabase();
    const client = connect(database);
    await advance(client);
    database.loseTheStepWrite();

    await advance(client);
    await advance(client);
    const run = await advance(client);

    expectTheStepToHaveItsGenerationBack(database, run, 'gen-1');
    expect(database.starts()).toBe(2);
    expect(tasksRequested()).toBe(1);
  });
});

describe('how a step that took its generation back ends', () => {
  /** A held start whose step was never written, and the tick that finds it. */
  async function afterTakingTheGenerationBack() {
    providerDoesNotAnswer();
    const database = createRunDatabase();
    const client = connect(database);
    await advance(client);
    database.loseTheStepWrite();
    expectTheStepToHaveItsGenerationBack(database, await advance(client), 'gen-1');
    return { database, client };
  }

  it('delivers the render once the callback has attached its task and it finishes', async () => {
    const { database, client } = await afterTakingTheGenerationBack();

    // What the webhook does first with a callback that names a held
    // generation, and what the output import does last.
    const attached = await client.rpc('attach_generation_provider_task', {
      p_generation_id: 'gen-1',
      p_prediction_id: 'task-late',
    });
    expect(attached.data).toMatchObject({ status: 'attached' });
    Object.assign(database.generations[0], {
      status: 'succeeded',
      output_url: 'generated_images/user-1/late.png',
    });

    const run = await advance(client);

    expect(database.imageStep).toMatchObject({
      status: 'succeeded',
      generation_id: 'gen-1',
      error_message: null,
      output_snapshot: { outputUrl: expect.stringContaining('user-1/late.png') },
    });
    expect(database.imageStep.output_snapshot).not.toHaveProperty('submissionPending');
    expect(database.gateStep).toMatchObject({ status: 'awaiting_approval' });
    expect(run.status).toBe('awaiting_approval');
    // One generation, one provider task, one charge, and no failure announced.
    expect(database.generations).toHaveLength(1);
    expect(database.starts()).toBe(2);
    expect(tasksRequested()).toBe(1);
    expect(database.state.credits).toBe(488);
    expect(history.sent).toEqual([]);
  });

  it('fails with the reason once the reaper has released the hold', async () => {
    const { database, client } = await afterTakingTheGenerationBack();

    // What the reaper does to a start still unresolved after its 45 minutes.
    // It tells the creator itself, which this stand-in does not.
    const settled = await client.rpc('settle_generation_start_failed', {
      p_generation_id: 'gen-1',
      p_error_message: REAPED_MESSAGE,
    });
    expect(settled.data).toMatchObject({ status: 'failed' });

    const run = await advance(client);

    // The ending of a held step whose link was never lost.
    expect(database.imageStep).toMatchObject({
      status: 'failed',
      generation_id: 'gen-1',
      error_message: REAPED_MESSAGE,
      finished_at: expect.any(String),
    });
    expect(database.imageStep.output_snapshot).not.toHaveProperty('submissionPending');
    expect(database.gateStep).toMatchObject({ status: 'blocked' });
    expect(run.status).toBe('failed');
    // The hold is back, no second generation was bought, and the worker adds
    // no notification of its own to the reaper's.
    expect(database.state.credits).toBe(500);
    expect(database.generations).toHaveLength(1);
    expect(database.starts()).toBe(2);
    expect(tasksRequested()).toBe(1);
    expect(history.sent).toEqual([]);
  });
});

describe('a workflow run step that could not be written after its start succeeded', () => {
  // The start service has returned: the credits are held, the provider has the
  // task and the task is on the generation. Only the step write that records
  // it is missing. What the database says when it refuses that write is not
  // the provider's answer, so it must not decide how the step ends. The first
  // three are words the start-failure classifier does not know and reads as a
  // refusal: while the write shared the start's catch, they failed the step
  // and the run over a render that was running and paid for. The last two it
  // reads as an outage.
  const REFUSED_WRITES = [
    'connection reset',
    'JWT expired',
    'duplicate key value violates unique constraint',
    'canceling statement due to statement timeout',
    'TypeError: fetch failed',
  ];

  /** A start that succeeded in full, and the tick that could not write its step. */
  async function afterTheStepWriteWasRefused(message: string) {
    providerAccepts('task-1');
    const database = createRunDatabase();
    const client = connect(database);
    database.state.stepLinkWritesToRefuse = 1;
    database.state.stepLinkWriteError = message;

    // The tick fails with what the database said, so its durable job is retried.
    await expect(advance(client)).rejects.toMatchObject({ message });
    return { database, client };
  }

  it.each(REFUSED_WRITES)('fails the tick, not the step, when the database says "%s"', async (message) => {
    const { database, client } = await afterTheStepWriteWasRefused(message);

    // The step is still in line as the worker found it, with no note of a
    // refusal, and nothing after it has been given up on.
    expect(database.imageStep).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: null,
      started_at: null,
      finished_at: null,
    });
    expect(database.gateStep).toMatchObject({ status: 'queued', finished_at: null });
    expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
    // The render is running and paid for once, and nobody was told it failed.
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'processing',
      prediction_id: 'task-1',
      refunded: false,
      client_request_key_hash: database.stepKey,
    })]);
    expect(database.state.credits).toBe(488);
    expect(history.sent).toEqual([]);

    const run = await advance(client);

    // The retried tick repeats the start under the same key and is answered
    // with that generation and its task. Nothing was lost but the link, so
    // there is no held note to show and nothing was taken back.
    expect(database.imageStep).toMatchObject({
      status: 'processing',
      generation_id: 'gen-1',
      output_snapshot: { predictionId: 'task-1' },
      error_message: null,
      started_at: expect.any(String),
      finished_at: null,
    });
    expect(database.gateStep).toMatchObject({ status: 'queued', finished_at: null });
    expect(run.status).toBe('processing');
    expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
    expect(database.generations).toHaveLength(1);
    expect(database.state.credits).toBe(488);
    expect(database.starts()).toBe(2);
    expect(tasksRequested()).toBe(1);
    expect(relinksLogged()).toEqual([]);
    expect(history.sent).toEqual([]);
  });

  it('delivers the render once the retried tick has written the step', async () => {
    const { database, client } = await afterTheStepWriteWasRefused('connection reset');
    await advance(client);

    // What the output import does when the provider's callback arrives.
    Object.assign(database.generations[0], {
      status: 'succeeded',
      output_url: 'generated_images/user-1/render.png',
    });

    const run = await advance(client);

    expect(database.imageStep).toMatchObject({
      status: 'succeeded',
      generation_id: 'gen-1',
      error_message: null,
      output_snapshot: { outputUrl: expect.stringContaining('user-1/render.png') },
    });
    expect(database.gateStep).toMatchObject({ status: 'awaiting_approval' });
    expect(run.status).toBe('awaiting_approval');
    // One generation, one provider task, one charge, and no failure announced.
    expect(database.generations).toHaveLength(1);
    expect(database.starts()).toBe(2);
    expect(tasksRequested()).toBe(1);
    expect(database.state.credits).toBe(488);
    expect(history.sent).toEqual([]);
  });
});

describe('a repeated or refused start with no live generation to take back', () => {
  it('fails the step when its key is on a generation that already ended without a task', async () => {
    const database = createRunDatabase();
    const client = connect(database);
    database.generations.push({
      id: 'gen-ended',
      user_id: 'user-1',
      cost: 12,
      status: 'failed',
      prediction_id: null,
      output_url: null,
      refunded: true,
      client_request_key_hash: database.stepKey,
      submission_unknown_at: null,
    });

    const run = await advance(client);

    // Nothing will free that key or revive that generation, so a step left
    // queued would hold its run in `processing` until the 24-hour cap.
    expect(run.status).toBe('failed');
    expect(database.run).toMatchObject({ status: 'failed', finished_at: expect.any(String) });
    expect(database.imageStep).toMatchObject({
      status: 'failed',
      generation_id: null,
      finished_at: expect.any(String),
    });
    expect(database.imageStep.error_message).not.toMatch(HELD_NOTE);
    expect(database.gateStep).toMatchObject({ status: 'blocked' });
    expect(tasksRequested()).toBe(0);
    expect(relinksLogged()).toEqual([]);
    expect(history.sent).toEqual([]);
  });

  it('still tells the creator when the provider really refuses the start', async () => {
    providerRefuses();
    const database = createRunDatabase();

    const run = await advance(connect(database));

    // The same notification history that stayed empty above does record one.
    expect(run.status).toBe('failed');
    expect(database.imageStep).toMatchObject({ status: 'failed', generation_id: null });
    expect(history.sent).toEqual([expect.objectContaining({
      user_id: 'user-1',
      type: 'generation_failed',
      title: 'Your image failed',
      object_id: 'gen-1',
    })]);
    expect(relinksLogged()).toEqual([]);
  });
});
