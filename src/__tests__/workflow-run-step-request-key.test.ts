import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { ExternalServiceTimeoutError } from '@/lib/provider-fetch';
import {
  createCanvasEdge,
  createWorkflowNode,
  normalizeWorkflowGraph,
  type ImageInputNodeData,
  type TextInputNodeData,
  type VideoInputNodeData,
} from '@/lib/workflow-canvas';
import { advanceWorkflowRunOnce } from '@/lib/workflow-runner';

// The run worker starts a step with a request key made from the run and the
// node, so a start it repeats finds the generation its first try reserved
// (`workflow-run-replayed-start.test.ts` follows an image step through that).
// A voiceover step, a sound-effect step and a motion step on a bundled model
// were started without the key, so every repeat held the credits again and
// asked the provider for another render. These cases run the real worker and
// the real start services over one small database for each of those step
// types, and repeat the start in each of the ways it gets repeated: with the
// first generation still unresolved, with it already running, and after the
// provider refused it. Only the provider's HTTP calls are stubbed, and the copy
// a motion start keeps of its two inputs.

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

// Once the provider has the task, a motion start files a copy of its character
// image and its reference video. That is storage work with tests of its own.
vi.mock('@/lib/generation-input-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generation-input-media')>()),
  persistGenerationInputMedia: async () => undefined,
}));

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'in'; column: string; value: unknown };

const STEP_KINDS = ['voiceover-generate', 'sound-effects-generate', 'motion-generate'] as const;
// An image step and a video step have always carried the key.
const GENERATION_STEP_KINDS = ['image-generate', 'video-generate', ...STEP_KINDS] as const;
type StepKind = (typeof GENERATION_STEP_KINDS)[number];

const ACTIVE = ['pending', 'waiting', 'processing'];
const STARTING_CREDITS = 500;
const HELD_NOTE = /may still be running.*credits stay reserved/i;

/** The step under test and what feeds it: a prompt, or a character image and a performance to follow. */
function createStepGraph(kind: StepKind) {
  const step = createWorkflowNode(kind, { x: 320, y: 40 });

  if (kind === 'motion-generate') {
    const character = createWorkflowNode('image-input', { x: 40, y: 40 });
    const performance = createWorkflowNode('video-input', { x: 40, y: 240 });
    return {
      stepNodeId: step.id,
      graph: normalizeWorkflowGraph({
        nodes: [
          {
            ...character,
            data: { ...(character.data as ImageInputNodeData), imageUrl: 'https://cdn.example.com/character.png' },
          },
          {
            ...performance,
            data: { ...(performance.data as VideoInputNodeData), videoUrl: 'https://cdn.example.com/reference.mp4' },
          },
          // The node as the canvas makes it: a bundled model and no catalog
          // settings, which is what sends it down the bundled motion start.
          step,
        ],
        edges: [
          createCanvasEdge(character.id, 'image', step.id, 'reference-image'),
          createCanvasEdge(performance.id, 'video', step.id, 'reference-video'),
        ],
      }),
    };
  }

  const prompt = createWorkflowNode('text-input', { x: 40, y: 40 });
  return {
    stepNodeId: step.id,
    graph: normalizeWorkflowGraph({
      nodes: [
        { ...prompt, data: { ...(prompt.data as TextInputNodeData), text: 'Rain on a tin roof, then one roll of thunder.' } },
        step,
      ],
      edges: [createCanvasEdge(prompt.id, 'text', step.id, 'prompt')],
    }),
  };
}

/**
 * A workflow run of one generation step, and the generations it starts.
 *
 * `start_generation`, the task attach, the held mark and the start settlement
 * answer as the SQL functions do for the request key, including the shape
 * `start_generation` demands of one.
 */
function createRunDatabase(kind: StepKind) {
  const { graph, stepNodeId } = createStepGraph(kind);
  const queuedStep = (): Row => ({
    id: 'step-1',
    run_id: 'run-1',
    node_id: stepNodeId,
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
      start_node_id: stepNodeId,
      mode: 'node',
      status: 'processing',
      created_at: '2026-10-02T10:00:00.000Z',
      finished_at: null,
      catalog_revision: 'catalog-rev-1',
      graph_snapshot: graph,
    }],
    workflow_canvas_run_steps: [queuedStep()],
    generations: [],
  };
  const state = {
    credits: STARTING_CREDITS,
    /** Starts that held credits, which is one for every generation made. */
    holds: 0,
    /** Step writes that link a generation and are refused, as a lost connection would. */
    stepLinkWritesToRefuse: 0,
    /** Task attaches that are refused, as an unreachable database would. */
    attachesToRefuse: 0,
    /** Start settlements (the refund of a refused start) that are refused the same way. */
    settlementsToRefuse: 0,
  };

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
        return { rows: [], error: { message: 'connection reset' } };
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
    if (fn === 'start_generation') {
      const key = args.p_client_request_key_hash ?? null;
      if (key !== null && !(typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))) {
        return { data: { status: 'invalid_idempotency_key' }, error: null };
      }
      const cost = Number(args.p_cost);
      const existing = key
        ? tables.generations.find((row) => row.user_id === args.p_user_id && row.client_request_key_hash === key)
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
      state.holds += 1;
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
        client_request_key_hash: key,
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
      if (state.settlementsToRefuse > 0) {
        state.settlementsToRefuse -= 1;
        return { data: null, error: { message: 'database unavailable' } };
      }
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

  const [step] = tables.workflow_canvas_run_steps;

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
    step,
    /** The key the worker gives this step's start. */
    stepKey: createHash('sha256').update(`workflow-run:run-1:${stepNodeId}:1`).digest('hex'),
    /**
     * The step as the worker found it, with the generation left as it is: what
     * remains when the function instance dies after the start service returned
     * and before the step was written.
     */
    loseTheStepWrite() {
      Object.assign(step, queuedStep());
    },
  };
}

type RunDatabase = ReturnType<typeof createRunDatabase>;

function connect(database: RunDatabase) {
  service.client = database.client;
  return database.client;
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

/** The provider takes every task it is asked for, and gives each one its own id. */
function providerAccepts() {
  let tasks = 0;
  vi.mocked(fetch).mockImplementation(async () => json({ code: 200, data: { taskId: `task-${++tasks}` } }));
}

/** The provider answers and says it is busy: nothing will run, nothing is billed. */
function providerIsBusy() {
  vi.mocked(fetch).mockImplementation(async () => json({ msg: 'Too many requests' }, 429));
}

/** Calls that asked the provider to create a task, across the whole test. */
function tasksRequested() {
  return vi.mocked(fetch).mock.calls
    .filter(([input]) => String(input instanceof Request ? input.url : input).includes('/jobs/createTask'))
    .length;
}

const logged: BackendLogRecord[] = [];
let restoreLogSink = () => {};

function relinksLogged() {
  return logged.filter((record) => record.msg === 'workflow_run_step_relinked_to_earlier_start');
}

/** What was logged as an error. The worker and the start services log some failures and carry on. */
function errorsLogged() {
  return logged.filter((record) => record.level === 'error').map((record) => record.msg);
}

/** One generation, one hold for what it costs, and the key on it that the worker made. */
function expectOneGenerationToHaveBeenBought(database: RunDatabase) {
  expect(database.generations).toHaveLength(1);
  expect(database.generations[0]).toMatchObject({ id: 'gen-1', refunded: false, client_request_key_hash: database.stepKey });
  expect(database.state.holds).toBe(1);
  expect(Number(database.generations[0].cost)).toBeGreaterThan(0);
  expect(database.state.credits).toBe(STARTING_CREDITS - Number(database.generations[0].cost));
}

/** The step has the generation its first start reserved, in the shape a held submission leaves. */
function expectTheStepToHaveItsGenerationBack(database: RunDatabase, run: { status: string }) {
  expect(database.step).toMatchObject({
    status: 'processing',
    generation_id: 'gen-1',
    output_snapshot: { submissionPending: true },
    error_message: expect.stringMatching(HELD_NOTE),
    started_at: expect.any(String),
    finished_at: null,
  });
  expect(run.status).toBe('processing');
  expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
  expect(relinksLogged()).toEqual([expect.objectContaining({
    level: 'warn',
    runId: 'run-1',
    stepId: 'step-1',
    generationId: 'gen-1',
  })]);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  // The provider client reports every refused or unanswered call on the console.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logged.length = 0;
  restoreLogSink = setBackendLogSink((record) => { logged.push(record); });
});

afterEach(() => {
  restoreLogSink();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  service.client = null;
});

// The key is also what a refund that goes missing leaves behind. A start the
// provider turns away is refunded on the spot, which takes the key off the
// refused generation. When that refund is not written, the generation keeps
// the key, and the step's next start finds it in the way. Every kind of step
// returns those credits through the same settlement.
describe.each(GENERATION_STEP_KINDS)('a %s step turned away as busy whose refund is not written at once', (kind) => {
  it('starts again on the next tick when the refund went through on a second try', async () => {
    providerIsBusy();
    const database = createRunDatabase(kind);
    const client = connect(database);
    database.state.settlementsToRefuse = 1;

    const first = await advance(client);

    // The same ending as a refund that was written at the first try.
    expect(first.status).toBe('processing');
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'failed',
      refunded: true,
      client_request_key_hash: null,
    })]);
    expect(database.state.credits).toBe(STARTING_CREDITS);
    expect(database.step).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: expect.stringContaining('busy'),
    });

    providerAccepts();
    const run = await advance(client);

    // The step is not tied to the generation the provider refused. It is
    // started again, and that start is the only one paid for.
    expect(database.generations).toHaveLength(2);
    expect(database.generations[1]).toMatchObject({
      id: 'gen-2',
      status: 'processing',
      refunded: false,
      client_request_key_hash: database.stepKey,
    });
    expect(database.state.credits).toBe(STARTING_CREDITS - Number(database.generations[1].cost));
    // No held note either: nothing about this step is waiting on the provider's word.
    expect(database.step).toMatchObject({ status: 'processing', generation_id: 'gen-2', error_message: null });
    expect(database.step.output_snapshot).not.toHaveProperty('submissionPending');
    expect(run.status).toBe('processing');
    expect(tasksRequested()).toBe(2);
    expect(relinksLogged()).toEqual([]);
    expect(errorsLogged()).toEqual([]);
  });

  it('buys no second generation while a refund that could not be written at all still holds its credits', async () => {
    providerIsBusy();
    const database = createRunDatabase(kind);
    const client = connect(database);
    database.state.settlementsToRefuse = 3;

    await advance(client);

    // Three tries, none written: the refused generation keeps its hold and the key.
    expect(database.state.settlementsToRefuse).toBe(0);
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'pending',
      prediction_id: null,
      refunded: false,
      client_request_key_hash: database.stepKey,
    })]);
    expect(database.step).toMatchObject({ status: 'queued', generation_id: null });
    expect(errorsLogged()).toEqual(['generation_start_failure_settlement_failed']);

    providerAccepts();
    const run = await advance(client);

    // The key still names that generation, and nothing on its row tells it
    // from a submission the provider may have taken. The step follows it, so
    // the credits are held once and the provider is not asked again.
    expect(database.step).toMatchObject({ status: 'processing', generation_id: 'gen-1', finished_at: null });
    expect(run.status).toBe('processing');
    expectOneGenerationToHaveBeenBought(database);
    expect(tasksRequested()).toBe(1);

    // What the reaper does 45 minutes after the start: release the hold.
    const settled = await client.rpc('settle_generation_start_failed', {
      p_generation_id: 'gen-1',
      p_error_message: 'The generation provider is temporarily unavailable. Please retry this step shortly.',
    });
    expect(settled.data).toMatchObject({ status: 'failed' });

    const ended = await advance(client);

    expect(database.step).toMatchObject({ status: 'failed', generation_id: 'gen-1' });
    expect(ended.status).toBe('failed');
    expect(database.state.credits).toBe(STARTING_CREDITS);
    expect(database.generations).toHaveLength(1);
    expect(tasksRequested()).toBe(1);
  });
});

describe.each(STEP_KINDS)('a %s step of a workflow run', (kind) => {
  it('starts with the request key the worker makes from the run and the node', async () => {
    providerAccepts();
    const database = createRunDatabase(kind);

    const run = await advance(connect(database));

    // 64 lowercase hex characters, which is all `start_generation` accepts.
    expect(database.stepKey).toMatch(/^[a-f0-9]{64}$/);
    expectOneGenerationToHaveBeenBought(database);
    expect(database.generations[0]).toMatchObject({ status: 'processing', prediction_id: 'task-1' });
    expect(database.step).toMatchObject({
      status: 'processing',
      generation_id: 'gen-1',
      output_snapshot: { predictionId: 'task-1' },
      error_message: null,
    });
    expect(run.status).toBe('processing');
    expect(tasksRequested()).toBe(1);
    expect(errorsLogged()).toEqual([]);
  });

  it('buys one generation when the provider took the task and the task could not be recorded', async () => {
    providerAccepts();
    const database = createRunDatabase(kind);
    const client = connect(database);
    database.state.attachesToRefuse = 3;

    // No worker dies here. The start gives up after three attach attempts and
    // the step is put back in the queue as if the provider were unavailable.
    const first = await advance(client);
    expect(first.status).toBe('processing');
    expect(database.step).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: expect.stringContaining('temporarily unavailable'),
    });
    expect(database.generations).toEqual([expect.objectContaining({ id: 'gen-1', status: 'pending', prediction_id: null })]);

    const run = await advance(client);

    // The provider is rendering it, and must not be asked for a second one.
    expectTheStepToHaveItsGenerationBack(database, run);
    expectOneGenerationToHaveBeenBought(database);
    expect(tasksRequested()).toBe(1);

    // The provider's callback names the generation, so the webhook attaches the
    // task the start could not, and the output import settles the render.
    const attached = await client.rpc('attach_generation_provider_task', {
      p_generation_id: 'gen-1',
      p_prediction_id: 'task-1',
    });
    expect(attached.data).toMatchObject({ status: 'attached' });
    const output = kind === 'motion-generate' ? 'generated_videos/user-1/late.mp4' : 'generated_audio/user-1/late.mp3';
    Object.assign(database.generations[0], { status: 'succeeded', output_url: output });

    const finished = await advance(client);

    // The run delivers that render. One was made and one was paid for.
    expect(database.step).toMatchObject({
      status: 'succeeded',
      generation_id: 'gen-1',
      error_message: null,
      output_snapshot: { outputUrl: expect.stringContaining(output.slice(output.indexOf('/') + 1)) },
    });
    expect(finished.status).toBe('succeeded');
    expectOneGenerationToHaveBeenBought(database);
    expect(tasksRequested()).toBe(1);
    // The first start's failed attach, and nothing after it.
    expect(errorsLogged()).toEqual(['generation_provider_task_attach_failed']);
  });

  it('takes its generation back when the worker died after the start service held the submission', async () => {
    providerDoesNotAnswer();
    const database = createRunDatabase(kind);
    const client = connect(database);

    await advance(client);
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'pending',
      prediction_id: null,
      submission_unknown_at: expect.any(String),
    })]);
    // An ordinary held link: nothing was lost yet, so nothing is taken back.
    expect(database.step).toMatchObject({ status: 'processing', generation_id: 'gen-1' });
    expect(relinksLogged()).toEqual([]);
    database.loseTheStepWrite();

    const run = await advance(client);

    expectTheStepToHaveItsGenerationBack(database, run);
    expectOneGenerationToHaveBeenBought(database);
    expect(tasksRequested()).toBe(1);

    // A step that has its generation is not started again.
    await advance(client);
    await advance(client);
    expectOneGenerationToHaveBeenBought(database);
    expect(tasksRequested()).toBe(1);
    expect(relinksLogged()).toHaveLength(1);
    expect(errorsLogged()).toEqual([]);
  });

  it('takes its generation back when the step could not be written after the start service held the submission', async () => {
    providerDoesNotAnswer();
    const database = createRunDatabase(kind);
    const client = connect(database);
    database.state.stepLinkWritesToRefuse = 1;

    // The tick fails, so its job is retried. Nothing recorded the generation.
    await expect(advance(client)).rejects.toMatchObject({ message: 'connection reset' });
    expect(database.step).toMatchObject({ status: 'queued', generation_id: null });
    expect(database.generations).toEqual([expect.objectContaining({ id: 'gen-1', status: 'pending' })]);

    const run = await advance(client);

    expectTheStepToHaveItsGenerationBack(database, run);
    expectOneGenerationToHaveBeenBought(database);
    expect(tasksRequested()).toBe(1);
    expect(errorsLogged()).toEqual([]);
  });

  it('starts again under the same key once a start the provider turned away as busy has been refunded', async () => {
    providerIsBusy();
    const database = createRunDatabase(kind);
    const client = connect(database);

    const first = await advance(client);

    // Refused outright, so the hold came back at once and took the key off
    // that generation. The step waits in the queue to be tried again.
    expect(first.status).toBe('processing');
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'failed',
      refunded: true,
      client_request_key_hash: null,
    })]);
    expect(database.state.credits).toBe(STARTING_CREDITS);
    expect(database.step).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: expect.stringContaining('busy'),
    });

    providerAccepts();
    const run = await advance(client);

    // The key did not strand the step: it names no generation any more, so
    // this is a start of its own, and the only one that is paid for.
    expect(database.generations).toHaveLength(2);
    expect(database.generations[1]).toMatchObject({
      id: 'gen-2',
      status: 'processing',
      refunded: false,
      client_request_key_hash: database.stepKey,
    });
    expect(database.state.credits).toBe(STARTING_CREDITS - Number(database.generations[1].cost));
    expect(database.step).toMatchObject({ status: 'processing', generation_id: 'gen-2', error_message: null });
    expect(run.status).toBe('processing');
    expect(relinksLogged()).toEqual([]);
    expect(errorsLogged()).toEqual([]);
  });

  it('takes back the generation its first start already gave a task, when the worker died before writing the step', async () => {
    providerAccepts();
    const database = createRunDatabase(kind);
    const client = connect(database);

    // The start succeeded in full: credits held, task taken and recorded.
    await advance(client);
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'processing',
      prediction_id: 'task-1',
    })]);
    database.loseTheStepWrite();

    const run = await advance(client);

    // The repeated start is answered with the first one's generation and task.
    // Nothing was lost but the link, so there is no held note to show.
    expect(database.step).toMatchObject({
      status: 'processing',
      generation_id: 'gen-1',
      output_snapshot: { predictionId: 'task-1' },
      error_message: null,
      finished_at: null,
    });
    expect(run.status).toBe('processing');
    expect(relinksLogged()).toEqual([]);
    expectOneGenerationToHaveBeenBought(database);
    expect(tasksRequested()).toBe(1);
    expect(errorsLogged()).toEqual([]);
  });
});

// The same loss with the worker still alive: the start succeeded in full and
// the database refused the step write that records it. The retried tick can
// only take the generation back because the start carries the key, so this
// runs for every kind of step that starts a generation.
describe.each(GENERATION_STEP_KINDS)('a %s step that could not be written after its start succeeded', (kind) => {
  it('keeps the generation its start bought and takes it back on the retried tick', async () => {
    providerAccepts();
    const database = createRunDatabase(kind);
    const client = connect(database);
    database.state.stepLinkWritesToRefuse = 1;

    // What the database said is not the provider refusing the start: the tick
    // fails, so its job is retried, and the step stays in line as the worker
    // found it.
    await expect(advance(client)).rejects.toMatchObject({ message: 'connection reset' });
    expect(database.step).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: null,
      finished_at: null,
    });
    expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'processing',
      prediction_id: 'task-1',
    })]);

    const run = await advance(client);

    // The retried tick's start is answered with that generation and its task.
    expect(database.step).toMatchObject({
      status: 'processing',
      generation_id: 'gen-1',
      output_snapshot: { predictionId: 'task-1' },
      error_message: null,
      finished_at: null,
    });
    expect(run.status).toBe('processing');
    expect(relinksLogged()).toEqual([]);
    expectOneGenerationToHaveBeenBought(database);
    expect(tasksRequested()).toBe(1);
    expect(errorsLogged()).toEqual([]);
  });
});
