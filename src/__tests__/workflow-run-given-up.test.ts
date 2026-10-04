import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  withMobileNotificationHistory,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { createWorkflowRunJobQueue } from '@/__tests__/fixtures/workflow-run-job-queue';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  createCanvasEdge,
  createWorkflowNode,
  normalizeWorkflowGraph,
  type ApprovalGateNodeData,
  type TextInputNodeData,
} from '@/lib/workflow-canvas';
import {
  WORKFLOW_RUN_MAX_LIFETIME_SECONDS,
  getWorkflowRunStepRetryDelaySeconds,
} from '@/lib/workflow-run-jobs';
import { processWorkflowRunStepJobs } from '@/lib/workflow-run-jobs-processor';
import {
  WORKFLOW_RUN_STOPPED_STEP_MESSAGE,
  WORKFLOW_RUN_STOPPED_UNLINKED_RENDER_MESSAGE,
  endGivenUpWorkflowRun,
  getWorkflowRunDetails,
} from '@/lib/workflow-runner';

// A canvas run's job gets five attempts over the life of the run, and a run
// may be 24 hours old. Past either, the queue gives the run up. These cases
// run the real job processor, the real worker, the real start service and the
// real notifier over one small database with the queue's functions in it, take
// a run to each of those ends, and then read it as its creator does. Only the
// provider's HTTP calls are stubbed.

// The provider key and the callback settings are read when the generation
// modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
  vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'test-webhook-secret');
  vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'hmac-key');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
});

// The worker makes its own service client for the credit hold, the provider
// gate and the generations it reads. Each test hands it the database the run
// lives in.
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

// The worker's fallback poll of the provider for a callback that never came.
// A generation here is what the test last made it, as a callback leaves it.
vi.mock('@/lib/generation-status-sync', () => ({ syncGenerationStatuses: async () => undefined }));

type Row = Record<string, unknown>;
type DatabaseError = { message: string; code?: string };
type Filter = { op: 'eq' | 'in' | 'is'; column: string; value: unknown };
type Call = { table: string; update: Row | null; filters: Filter[] };

const ACTIVE = ['pending', 'waiting', 'processing'];
const STARTED_AT = Date.parse('2026-10-04T10:00:00.000Z');
/** What the database said in the recorded case: a trigger refused the write that links a step to its generation. */
const REFUSED_LINK: DatabaseError = {
  message: 'duplicate key value violates unique constraint "probe_step_link"',
  code: '23505',
};
const REFUSED_LINK_AS_STORED = 'duplicate key value violates unique constraint "probe_step_link" (code 23505)';
const HELD_NOTE = /may still be running.*credits stay reserved/i;
const REAPED_MESSAGE = 'The generation provider is temporarily unavailable. Please retry this step shortly.';

/**
 * A workflow run of prompt, image, approval checkpoint, with the generations
 * it starts and the tickets of its job. The checkpoint depends on the image,
 * so it is the step the run never reaches. A run of the image node alone
 * (`mode: 'node'`) has no step after it.
 *
 * Tables answer `select`, `update`, `eq`, `in`, `is`, `order` and `limit` as
 * PostgREST does: an update returns its rows only when it selects them, and a
 * refused read or write is an error on the reply. `start_generation`, the task
 * attach, the held mark and the start settlement answer as the SQL functions
 * do for the request key, and the queue's functions come from
 * `fixtures/workflow-run-job-queue.ts`.
 */
function createRunDatabase(options: { mode?: 'branch' | 'node'; runCreatedAt?: number } = {}) {
  const mode = options.mode ?? 'branch';
  const clock = { ms: STARTED_AT };
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
  const imageStep = queuedStep('step-image', image.id);
  const gateStep = queuedStep('step-gate', gate.id);

  const tables: Record<string, Row[]> = {
    workflow_canvas_runs: [{
      id: 'run-1',
      canvas_id: 'canvas-1',
      user_id: 'user-1',
      start_node_id: image.id,
      mode,
      status: 'processing',
      created_at: new Date(options.runCreatedAt ?? STARTED_AT - 1000).toISOString(),
      finished_at: null,
      catalog_revision: 'catalog-rev-1',
      graph_snapshot: graph,
    }],
    workflow_canvas_run_steps: mode === 'node' ? [imageStep] : [imageStep, gateStep],
    generations: [],
  };
  const queue = createWorkflowRunJobQueue({
    runs: () => tables.workflow_canvas_runs as Array<{ id: string; canvas_id: string; status: string; created_at: string }>,
    now: () => clock.ms,
  });
  tables.workflow_run_step_jobs = queue.jobs as unknown as Row[];

  const state = {
    credits: 500,
    /** Every write that links a step to a generation is refused, as the trigger in the recorded case did. */
    refuseStepLinkWrites: false,
    /**
     * Sees every read and write before it runs. An error it returns is the
     * database's answer, and it may change a row first, as something running
     * beside the caller would.
     */
    intercept: null as ((call: Call) => DatabaseError | void) | null,
  };
  const rpcCalls: string[] = [];

  function matching(table: string, filters: Filter[]) {
    return tables[table].filter((row) => filters.every((filter) => {
      if (filter.op === 'eq') return row[filter.column] === filter.value;
      if (filter.op === 'is') return (row[filter.column] ?? null) === filter.value;
      return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
    }));
  }

  function from(table: string) {
    if (!tables[table]) throw new Error(`Unexpected table: ${table}`);
    const filters: Filter[] = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let rowLimit: number | null = null;
    let update: Row | null = null;
    let returning = false;

    const run = (): { rows: Row[] | null; error: DatabaseError | null } => {
      const refused = state.intercept?.({ table, update, filters });
      if (refused) return { rows: null, error: refused };
      let rows = matching(table, filters);
      if (update) {
        if (table === 'workflow_canvas_run_steps' && update.generation_id && state.refuseStepLinkWrites) {
          return { rows: null, error: REFUSED_LINK };
        }
        for (const row of rows) Object.assign(row, update);
        return { rows: returning ? rows : null, error: null };
      }
      // Postgres sorts NULL as larger than every value.
      for (const { column, ascending } of [...orders].reverse()) {
        rows = [...rows].sort((left, right) => {
          const [a, b] = [left[column] ?? null, right[column] ?? null];
          const order = a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
          return ascending ? order : -order;
        });
      }
      return { rows: rowLimit === null ? rows : rows.slice(0, rowLimit), error: null };
    };
    const filter = (op: Filter['op']) => (column: string, value: unknown) => {
      filters.push({ op, column, value });
      return query;
    };
    const query = {
      select() {
        returning = true;
        return query;
      },
      update(values: Row) {
        update = values;
        returning = false;
        return query;
      },
      eq: filter('eq'),
      in: filter('in'),
      is: filter('is'),
      order(column: string, direction?: { ascending?: boolean }) {
        orders.push({ column, ascending: direction?.ascending !== false });
        return query;
      },
      limit(count: number) {
        rowLimit = count;
        return query;
      },
      async single() {
        const { rows, error } = run();
        if (error) return { data: null, error };
        return rows?.length === 1
          ? { data: { ...rows[0] }, error: null }
          : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      },
      async maybeSingle() {
        const { rows, error } = run();
        if (error) return { data: null, error };
        return { data: rows?.[0] ? { ...rows[0] } : null, error: null };
      },
      then(
        resolve: (value: { data: Row[] | null; error: DatabaseError | null }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) {
        const { rows, error } = run();
        return Promise.resolve({ data: rows ? rows.map((row) => ({ ...row })) : null, error }).then(resolve, reject);
      },
    };
    return query;
  }

  const generation = (id: unknown) => tables.generations.find((row) => row.id === id);

  async function rpc(fn: string, args: Row = {}) {
    rpcCalls.push(fn);
    if (queue.handlesRpc(fn)) return queue.rpc(fn, args);

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
        error_message: null,
        refunded: false,
        client_request_key_hash: args.p_client_request_key_hash ?? null,
        submission_unknown_at: null,
        created_at: new Date(clock.ms).toISOString(),
        completed_at: null,
      };
      tables.generations.push(started);
      return {
        data: { status: 'started', generation_id: started.id, remaining_credits: state.credits, cost },
        error: null,
      };
    }

    if (fn === 'attach_generation_provider_task') {
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
      row.submission_unknown_at = new Date(clock.ms).toISOString();
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

  // The ticket the run was started with.
  queue.rpc('enqueue_workflow_run_step_job', { p_run_id: 'run-1', p_node_id: image.id, p_attempt: 1 });

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
    clock,
    state,
    queue,
    jobs: queue.jobs,
    generations: tables.generations,
    run: tables.workflow_canvas_runs[0],
    imageStep,
    gateStep,
    /** The key the worker gives the image step's start. */
    stepKey: createHash('sha256').update(`workflow-run:run-1:${image.id}:1`).digest('hex'),
    starts: () => rpcCalls.filter((fn) => fn === 'start_generation').length,
  };
}

type RunDatabase = ReturnType<typeof createRunDatabase>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function providerAccepts(taskId: string) {
  vi.mocked(fetch).mockImplementation(async () => json({ code: 200, data: { taskId } }));
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
let workers = 0;

function logsOf(event: string) {
  return logged.filter((record) => record.msg === event);
}

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

/** One call of the job processor, as the cron job, a provider callback and the run routes make it. */
function tick(database: RunDatabase, client: SupabaseClient) {
  workers += 1;
  return processWorkflowRunStepJobs({
    supabase: client,
    lockedBy: `worker-${workers}`,
    concurrency: 1,
    nowMs: database.clock.ms,
  });
}

/** The run as the canvas page polls it. */
function readAsTheCreator(client: SupabaseClient) {
  return getWorkflowRunDetails({ supabase: client, userId: 'user-1', canvasId: 'canvas-1', runId: 'run-1' });
}

/** The image step as the creator's read gives it. */
async function imageStepAsRead(client: SupabaseClient) {
  return (await readAsTheCreator(client)).steps.find((step) => step.id === 'step-image')!;
}

/**
 * Five ticks that each start the image step, or find it started, and are
 * refused the write that links it. Each is taken as its job comes due: 60,
 * 120, 240 and 480 seconds after the one before.
 */
async function spendEveryAttempt(database: RunDatabase, client: SupabaseClient) {
  database.state.refuseStepLinkWrites = true;
  const summaries = [];
  for (const secondsLater of [0, 60, 120, 240, 480]) {
    database.clock.ms += secondsLater * 1000;
    summaries.push(await tick(database, client));
  }
  return summaries;
}

/**
 * The same five tickets, failed with no worker at them: the run as the queue
 * leaves it when its ticks failed before they reached a step.
 */
function spendEveryTicketUnworked(database: RunDatabase, lastError = 'Workflow run not found.') {
  for (const secondsLater of [0, 60, 120, 240, 480]) {
    database.clock.ms += secondsLater * 1000;
    const [job] = database.queue.rpc('claim_workflow_run_step_jobs', { p_limit: 1, p_locked_by: 'nobody' })
      .data as Array<{ id: string; attempt: number }>;
    database.queue.rpc('finish_workflow_run_step_job', {
      p_id: job.id,
      p_locked_by: 'nobody',
      p_succeeded: false,
      p_error: lastError,
      p_retry_delay_seconds: getWorkflowRunStepRetryDelaySeconds(job.attempt),
    });
  }
  // The next call of the processor comes a minute after the last ticket closed.
  database.clock.ms += 60_000;
}

/** The recorded case: the image was started and charged, five ticks were refused its link, and no ticket is left. */
async function afterTheQueueGaveUp(options: Parameters<typeof createRunDatabase>[0] = {}) {
  providerAccepts('task-1');
  const database = createRunDatabase(options);
  const client = connect(database);
  await spendEveryAttempt(database, client);
  database.clock.ms += 60_000;
  return { database, client };
}

/** What the provider's callback and the output import leave on a generation that finished. */
function renderComesIn(database: RunDatabase) {
  Object.assign(database.generations[0], {
    status: 'succeeded',
    output_url: 'generated_images/user-1/mug.png',
    completed_at: new Date(database.clock.ms).toISOString(),
  });
}

/** What the settlement leaves on a generation the provider failed: its credits are back. */
function renderFails(database: RunDatabase) {
  database.state.credits += Number(database.generations[0].cost);
  Object.assign(database.generations[0], {
    status: 'failed',
    error_message: 'The provider could not complete this image.',
    refunded: true,
    completed_at: new Date(database.clock.ms).toISOString(),
  });
}

const STOPPED_NOTIFICATION = {
  user_id: 'user-1',
  type: 'generation_failed',
  category: 'generation',
  title: 'Your workflow run stopped',
  body: 'A problem on our side ended it. Open the workflow to run it again.',
  deep_link: '/studio?workflowCanvas=canvas-1',
  object_type: 'workflow_run',
  object_id: 'run-1',
  dedupe_key: 'workflow-run:run-1:stopped',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  // The provider client reports every refused or unanswered call on the console.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logged.length = 0;
  restoreLogSink = setBackendLogSink((record) => { logged.push(record); });
  history = createMobileNotificationHistory();
  workers = 0;
});

afterEach(() => {
  restoreLogSink();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  service.client = null;
});

describe('a canvas run whose job ran out of attempts', () => {
  it('spends an attempt on every tick that fails, and the fifth is the last', async () => {
    providerAccepts('task-1');
    const database = createRunDatabase();
    const client = connect(database);

    const summaries = await spendEveryAttempt(database, client);

    expect(summaries.map(({ claimed, retried, exhausted }) => ({ claimed, retried, exhausted }))).toEqual([
      { claimed: 1, retried: 1, exhausted: 0 },
      { claimed: 1, retried: 1, exhausted: 0 },
      { claimed: 1, retried: 1, exhausted: 0 },
      { claimed: 1, retried: 1, exhausted: 0 },
      { claimed: 1, retried: 0, exhausted: 1 },
    ]);
    expect(database.jobs.map(({ attempt, status, last_error }) => ({ attempt, status, last_error }))).toEqual(
      [1, 2, 3, 4, 5].map((attempt) => ({ attempt, status: 'failed', last_error: REFUSED_LINK_AS_STORED })),
    );
    // One render was started and charged, and no step has it.
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'processing',
      prediction_id: 'task-1',
      client_request_key_hash: database.stepKey,
    })]);
    expect(database.state.credits).toBe(488);
    expect(tasksRequested()).toBe(1);
    expect(database.imageStep).toMatchObject({ status: 'queued', generation_id: null });
    // While a ticket is still to come, the run is nobody's to end.
    expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
    expect(history.sent).toEqual([]);
  });

  it('is over for the creator once the queue has given it up', async () => {
    const { database, client } = await afterTheQueueGaveUp();

    // The next call of the processor finds the run with no ticket left to claim.
    expect(await tick(database, client)).toMatchObject({ claimed: 0, adopted: 0 });

    const endedAt = new Date(database.clock.ms).toISOString();
    expect(database.run).toMatchObject({ status: 'failed', finished_at: endedAt });
    const read = await readAsTheCreator(client);
    // The canvas page polls for as long as this says `processing`, and keeps its run controls off.
    expect(read.status).toBe('failed');
    expect(read.finished_at).toBe(endedAt);
  });

  it('closes every step the run never finished, with a note of why', async () => {
    const { database, client } = await afterTheQueueGaveUp();

    await tick(database, client);

    const endedAt = new Date(database.clock.ms).toISOString();
    // The write that links the image to its render is refused here as it was
    // on every tick, so the step says where the render is.
    expect(database.imageStep).toMatchObject({
      status: 'blocked',
      generation_id: null,
      error_message: WORKFLOW_RUN_STOPPED_UNLINKED_RENDER_MESSAGE,
      finished_at: endedAt,
    });
    expect(database.gateStep).toMatchObject({
      status: 'blocked',
      generation_id: null,
      error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE,
      started_at: null,
      finished_at: endedAt,
    });
    expect((await readAsTheCreator(client)).steps.map(({ id, status, error_message }) => ({ id, status, error_message })))
      .toEqual(expect.arrayContaining([
        { id: 'step-image', status: 'blocked', error_message: WORKFLOW_RUN_STOPPED_UNLINKED_RENDER_MESSAGE },
        { id: 'step-gate', status: 'blocked', error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE },
      ]));
    // Nothing is started, charged or returned by ending the run.
    expect(database.starts()).toBe(5);
    expect(tasksRequested()).toBe(1);
    expect(database.state.credits).toBe(488);
    expect(database.generations).toEqual([expect.objectContaining({ id: 'gen-1', status: 'processing', refunded: false })]);
    expect(database.jobs).toHaveLength(5);
    expect(logsOf('workflow_run_step_link_refused_at_give_up')).toEqual([expect.objectContaining({
      level: 'error',
      runId: 'run-1',
      stepId: 'step-image',
      generationId: 'gen-1',
      errorMessage: REFUSED_LINK.message,
    })]);
  });

  it('tells the creator once, and the operator what the last tick failed on', async () => {
    const { database, client } = await afterTheQueueGaveUp();

    await tick(database, client);
    database.clock.ms += 10 * 60_000;
    await tick(database, client);
    await tick(database, client);

    expect(history.sent).toEqual([expect.objectContaining(STOPPED_NOTIFICATION)]);
    expect(logsOf('workflow_run_given_up')).toEqual([expect.objectContaining({
      level: 'error',
      runId: 'run-1',
      canvasId: 'canvas-1',
      userId: 'user-1',
      status: 'failed',
      pastLifetime: false,
      lastError: REFUSED_LINK_AS_STORED,
      closedStepIds: ['step-image', 'step-gate'],
      linkedGenerationIds: [],
      unlinkedStepIds: ['step-image'],
    })]);
    expect(logsOf('workflow_run_adopt_failed')).toEqual([]);
  });
});

describe('a render the run started and its step never got', () => {
  /** The fault has passed by the time the queue gives the run up: the link is accepted now. */
  async function afterTheSweepLinkedIt(options: Parameters<typeof createRunDatabase>[0] = {}) {
    const { database, client } = await afterTheQueueGaveUp(options);
    database.state.refuseStepLinkWrites = false;
    expect(await tick(database, client)).toMatchObject({ claimed: 0, adopted: 0 });
    return { database, client };
  }

  it('is linked to its step, and the run is left open while it is still going', async () => {
    const { database, client } = await afterTheSweepLinkedIt();

    // As the worker links a step it starts.
    expect(database.imageStep).toMatchObject({
      status: 'processing',
      generation_id: 'gen-1',
      output_snapshot: { predictionId: 'task-1', cost: 12 },
      error_message: null,
      started_at: database.generations[0].created_at,
      finished_at: null,
    });
    expect(database.gateStep).toMatchObject({ status: 'queued', finished_at: null });
    expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
    const read = await readAsTheCreator(client);
    expect(read).toMatchObject({ status: 'processing', finished_at: null });
    expect(history.sent).toEqual([]);
    expect(logsOf('workflow_run_given_up')).toEqual([]);
    expect(logsOf('workflow_run_step_linked_at_give_up')).toEqual([expect.objectContaining({
      level: 'warn',
      runId: 'run-1',
      stepId: 'step-image',
      generationId: 'gen-1',
    })]);
  });

  it('is waited for on every sweep, with nothing started and nothing said', async () => {
    const { database, client } = await afterTheSweepLinkedIt();
    const linked = { ...database.imageStep };

    for (let sweep = 0; sweep < 3; sweep += 1) {
      database.clock.ms += 10 * 60_000;
      expect(await tick(database, client)).toMatchObject({ claimed: 0, adopted: 0 });
    }

    expect(database.imageStep).toEqual(linked);
    expect(database.gateStep).toMatchObject({ status: 'queued' });
    expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
    expect(database.jobs).toHaveLength(5);
    expect(database.starts()).toBe(5);
    expect(tasksRequested()).toBe(1);
    expect(history.sent).toEqual([]);
    expect(logsOf('workflow_run_step_linked_at_give_up')).toHaveLength(1);
    expect(logsOf('workflow_run_adopt_failed')).toEqual([]);
  });

  it('shows on its step the moment it lands, and then ends the run with the later steps closed', async () => {
    const { database, client } = await afterTheSweepLinkedIt();
    database.clock.ms += 90_000;
    renderComesIn(database);

    // The creator's poll, before any sweep: the render is there.
    const landed = await readAsTheCreator(client);
    expect(landed.status).toBe('processing');
    expect(landed.steps.find((step) => step.id === 'step-image')).toMatchObject({
      status: 'succeeded',
      output_snapshot: { outputUrl: expect.stringContaining('user-1/mug.png') },
    });

    // The callback that finished the render runs the processor in the same breath.
    await tick(database, client);

    const endedAt = new Date(database.clock.ms).toISOString();
    expect(database.imageStep).toMatchObject({
      status: 'succeeded',
      generation_id: 'gen-1',
      error_message: null,
      output_snapshot: { outputUrl: expect.stringContaining('user-1/mug.png'), cost: 12 },
    });
    expect(database.gateStep).toMatchObject({
      status: 'blocked',
      error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE,
      finished_at: endedAt,
    });
    expect(database.run).toMatchObject({ status: 'failed', finished_at: endedAt });
    expect(await readAsTheCreator(client)).toMatchObject({ status: 'failed', finished_at: endedAt });
    expect(history.sent).toEqual([expect.objectContaining(STOPPED_NOTIFICATION)]);
    expect(logsOf('workflow_run_given_up')).toEqual([expect.objectContaining({
      status: 'failed',
      closedStepIds: ['step-gate'],
      unlinkedStepIds: [],
    })]);
    // One render, one task, one charge.
    expect(database.generations).toHaveLength(1);
    expect(tasksRequested()).toBe(1);
    expect(database.state.credits).toBe(488);
  });

  it('ends a run it was the last step of as succeeded, and tells nobody the run stopped', async () => {
    const { database, client } = await afterTheSweepLinkedIt({ mode: 'node' });
    expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
    expect((await readAsTheCreator(client)).status).toBe('processing');
    database.clock.ms += 90_000;
    renderComesIn(database);

    // Nothing else is unfinished, so the poll has the whole run before the sweep does.
    expect((await readAsTheCreator(client)).status).toBe('succeeded');
    await tick(database, client);

    expect(database.imageStep).toMatchObject({
      status: 'succeeded',
      generation_id: 'gen-1',
      output_snapshot: { outputUrl: expect.stringContaining('user-1/mug.png') },
    });
    expect(database.run).toMatchObject({ status: 'succeeded', finished_at: new Date(database.clock.ms).toISOString() });
    expect(await readAsTheCreator(client)).toMatchObject({ status: 'succeeded', finished_at: database.run.finished_at });
    expect(history.sent).toEqual([]);
    // The operator still hears that the queue gave a run up.
    expect(logsOf('workflow_run_given_up')).toEqual([expect.objectContaining({
      level: 'error',
      status: 'succeeded',
      lastError: REFUSED_LINK_AS_STORED,
      closedStepIds: [],
    })]);
  });

  it('ends the run as failed when it fails, which its own settlement has announced', async () => {
    const { database, client } = await afterTheSweepLinkedIt({ mode: 'node' });
    database.clock.ms += 90_000;
    renderFails(database);

    await tick(database, client);

    expect(database.imageStep).toMatchObject({ status: 'failed', generation_id: 'gen-1' });
    expect(database.run).toMatchObject({ status: 'failed', finished_at: expect.any(String) });
    expect((await readAsTheCreator(client)).status).toBe('failed');
    // Its credits are back, and nothing of the run was left unfinished by us.
    expect(database.state.credits).toBe(500);
    expect(history.sent).toEqual([]);
    expect(logsOf('workflow_run_given_up')).toEqual([expect.objectContaining({ status: 'failed', closedStepIds: [] })]);
  });

  it('is taken as it is when it had finished before the queue gave the run up', async () => {
    const { database, client } = await afterTheQueueGaveUp();
    database.state.refuseStepLinkWrites = false;
    renderComesIn(database);

    // One sweep: there is nothing to wait for.
    await tick(database, client);

    expect(database.imageStep).toMatchObject({
      status: 'succeeded',
      generation_id: 'gen-1',
      output_snapshot: { outputUrl: expect.stringContaining('user-1/mug.png') },
    });
    expect(database.gateStep).toMatchObject({ status: 'blocked', error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE });
    expect(database.run).toMatchObject({ status: 'failed' });
    expect(history.sent).toEqual([expect.objectContaining(STOPPED_NOTIFICATION)]);
  });

  it('is linked as a held submission when the provider never confirmed it, and followed to the reaper', async () => {
    const database = createRunDatabase();
    const client = connect(database);
    // The credits were held and the instance died inside the provider call. No
    // tick after that got as far as the step.
    database.state.credits = 488;
    database.generations.push({
      id: 'gen-unanswered',
      user_id: 'user-1',
      cost: 12,
      status: 'pending',
      prediction_id: null,
      output_url: null,
      error_message: null,
      refunded: false,
      client_request_key_hash: database.stepKey,
      submission_unknown_at: null,
      created_at: new Date(STARTED_AT).toISOString(),
    });
    spendEveryTicketUnworked(database);

    await tick(database, client);

    expect(database.imageStep).toMatchObject({
      status: 'processing',
      generation_id: 'gen-unanswered',
      output_snapshot: { submissionPending: true },
      error_message: expect.stringMatching(HELD_NOTE),
      finished_at: null,
    });
    expect(database.run).toMatchObject({ status: 'processing' });
    expect(history.sent).toEqual([]);

    // What the reaper does to a start still unresolved after its 45 minutes.
    database.clock.ms += 45 * 60_000;
    await client.rpc('settle_generation_start_failed', {
      p_generation_id: 'gen-unanswered',
      p_error_message: REAPED_MESSAGE,
    });
    await tick(database, client);

    expect(database.imageStep).toMatchObject({
      status: 'failed',
      generation_id: 'gen-unanswered',
      error_message: REAPED_MESSAGE,
    });
    expect(database.imageStep.output_snapshot).not.toHaveProperty('submissionPending');
    expect(database.gateStep).toMatchObject({ status: 'blocked', error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE });
    expect(database.run).toMatchObject({ status: 'failed' });
    expect(database.state.credits).toBe(500);
    expect(tasksRequested()).toBe(0);
    expect(logsOf('workflow_run_given_up')).toEqual([expect.objectContaining({ lastError: 'Workflow run not found.' })]);
  });

  it('is not looked for under another creator, or for a step that already has a generation', async () => {
    const database = createRunDatabase();
    const client = connect(database);
    database.generations.push({
      id: 'gen-of-another-creator',
      user_id: 'user-2',
      cost: 12,
      status: 'succeeded',
      prediction_id: 'task-theirs',
      output_url: 'generated_images/user-2/theirs.png',
      error_message: null,
      refunded: false,
      client_request_key_hash: database.stepKey,
      created_at: new Date(STARTED_AT).toISOString(),
    });
    spendEveryTicketUnworked(database);

    await tick(database, client);

    expect(database.imageStep).toMatchObject({
      status: 'blocked',
      generation_id: null,
      error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE,
    });
    expect(database.run).toMatchObject({ status: 'failed' });
    expect(logsOf('workflow_run_step_linked_at_give_up')).toEqual([]);
  });
});

describe('a canvas run that outlived its maximum lifetime', () => {
  /** Nothing worked the run's first ticket for a day and an hour, and then a worker did. */
  async function afterTheLastTick(mode: 'branch' | 'node') {
    providerAccepts('task-1');
    const database = createRunDatabase({
      mode,
      runCreatedAt: STARTED_AT - (WORKFLOW_RUN_MAX_LIFETIME_SECONDS + 3600) * 1000,
    });
    const client = connect(database);
    expect(await tick(database, client)).toMatchObject({ claimed: 1, deferred: 0, exhausted: 1 });
    return { database, client };
  }

  it('is over for the creator once the worker has stopped polling it', async () => {
    const { database, client } = await afterTheLastTick('branch');

    const endedAt = new Date(database.clock.ms).toISOString();
    expect(database.jobs).toEqual([expect.objectContaining({
      attempt: 1,
      status: 'failed',
      last_error: 'Workflow run exceeded its maximum lifetime without finishing.',
    })]);
    expect(database.run).toMatchObject({ status: 'failed', finished_at: endedAt });
    expect(await readAsTheCreator(client)).toMatchObject({ status: 'failed', finished_at: endedAt });
    expect(database.gateStep).toMatchObject({
      status: 'blocked',
      error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE,
      finished_at: endedAt,
    });
    expect(history.sent).toEqual([expect.objectContaining(STOPPED_NOTIFICATION)]);
    expect(logsOf('workflow_run_given_up')).toEqual([expect.objectContaining({
      status: 'failed',
      pastLifetime: true,
      lastError: 'Workflow run exceeded its maximum lifetime without finishing.',
      closedStepIds: ['step-gate'],
    })]);
  });

  it('is not held open for a render that is still going, and that render keeps its step', async () => {
    const { database, client } = await afterTheLastTick('branch');

    // The tick that ended the run had just started the image.
    expect(database.imageStep).toMatchObject({ status: 'processing', generation_id: 'gen-1', error_message: null });
    expect(await imageStepAsRead(client)).toMatchObject({ status: 'processing', generation_id: 'gen-1' });

    database.clock.ms += 90_000;
    renderComesIn(database);

    expect(await imageStepAsRead(client)).toMatchObject({
      status: 'succeeded',
      output_snapshot: { outputUrl: expect.stringContaining('user-1/mug.png') },
    });
    expect((await readAsTheCreator(client)).status).toBe('failed');
    // No sweep comes back to a run that is stored as ended.
    expect(await tick(database, client)).toMatchObject({ claimed: 0, adopted: 0 });
    expect(history.sent).toHaveLength(1);
  });

  it('stays failed when its only step was a render it was not waited for', async () => {
    const { database, client } = await afterTheLastTick('node');

    // No step was closed: the one there is has a render going.
    expect(database.imageStep).toMatchObject({ status: 'processing', generation_id: 'gen-1' });
    expect(database.run).toMatchObject({ status: 'failed', finished_at: expect.any(String) });
    // A stored `failed` is what is read, whatever the steps add up to.
    expect(await readAsTheCreator(client)).toMatchObject({ status: 'failed', finished_at: database.run.finished_at });
    expect(history.sent).toEqual([expect.objectContaining(STOPPED_NOTIFICATION)]);

    database.clock.ms += 90_000;
    renderComesIn(database);

    expect(await readAsTheCreator(client)).toMatchObject({ status: 'failed', finished_at: database.run.finished_at });
    expect(await imageStepAsRead(client)).toMatchObject({ status: 'succeeded' });
  });

  it('is ended even when its steps cannot be read', async () => {
    const database = createRunDatabase({ runCreatedAt: STARTED_AT - (WORKFLOW_RUN_MAX_LIFETIME_SECONDS + 3600) * 1000 });
    const client = connect(database);
    const unreadable = { message: 'canceling statement due to statement timeout', code: '57014' };
    database.state.intercept = ({ table, update }) => (
      table === 'workflow_canvas_run_steps' && !update ? unreadable : undefined
    );

    await expect(endGivenUpWorkflowRun({ supabase: client, runId: 'run-1', nowMs: database.clock.ms }))
      .resolves.toBe('failed');

    expect(database.run).toMatchObject({ status: 'failed', finished_at: new Date(database.clock.ms).toISOString() });
    // The steps are closed by what they are, unread.
    expect(database.imageStep).toMatchObject({ status: 'blocked', error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE });
    expect(database.gateStep).toMatchObject({ status: 'blocked', error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE });
    expect(logsOf('workflow_run_given_up_steps_unread')).toEqual([expect.objectContaining({
      level: 'error',
      runId: 'run-1',
      errorMessage: unreadable.message,
    })]);
    expect(history.sent).toEqual([expect.objectContaining(STOPPED_NOTIFICATION)]);
  });

  it('is ended even when its steps cannot be written', async () => {
    const database = createRunDatabase({ runCreatedAt: STARTED_AT - (WORKFLOW_RUN_MAX_LIFETIME_SECONDS + 3600) * 1000 });
    const client = connect(database);
    const refused = { message: 'connection reset', code: '08006' };
    database.state.intercept = ({ table, update }) => (
      table === 'workflow_canvas_run_steps' && update ? refused : undefined
    );

    await expect(endGivenUpWorkflowRun({ supabase: client, runId: 'run-1', nowMs: database.clock.ms }))
      .resolves.toBe('failed');

    expect(database.imageStep).toMatchObject({ status: 'queued', error_message: null });
    expect(database.run).toMatchObject({ status: 'failed' });
    database.state.intercept = null;
    // The stored ending is what the creator reads, over steps nobody could close.
    expect((await readAsTheCreator(client)).status).toBe('failed');
    expect(logsOf('workflow_run_given_up_steps_unclosed')).toEqual([expect.objectContaining({
      runId: 'run-1',
      errorMessage: refused.message,
    })]);
  });
});

describe('what the creator reads of a run', () => {
  it('is failed once the run is stored as failed, over steps that were left unfinished', async () => {
    const database = createRunDatabase();
    const client = connect(database);
    // A run the queue gave up before its steps were closed with it.
    Object.assign(database.run, { status: 'failed', finished_at: '2026-10-03T08:00:00.000Z' });

    const read = await readAsTheCreator(client);

    expect(read).toMatchObject({ status: 'failed', finished_at: '2026-10-03T08:00:00.000Z' });
    expect(read.steps.map((step) => step.status)).toEqual(['queued', 'queued']);
  });

  it('comes from the steps while the run is still open, so a render shows before the worker stores it', async () => {
    const { database, client } = await afterTheQueueGaveUp({ mode: 'node' });
    database.state.refuseStepLinkWrites = false;
    await tick(database, client);
    renderComesIn(database);

    expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
    expect(await readAsTheCreator(client)).toMatchObject({ status: 'succeeded', finished_at: expect.any(String) });
  });
});

describe('ending a run the queue gave up', () => {
  function end(database: RunDatabase, client: SupabaseClient) {
    return endGivenUpWorkflowRun({ supabase: client, runId: 'run-1', nowMs: database.clock.ms, lastError: 'boom' });
  }

  it.each(['awaiting_approval', 'succeeded', 'failed'])('leaves a run that is %s alone', async (status) => {
    const database = createRunDatabase();
    const client = connect(database);
    database.run.status = status;
    const before = JSON.stringify([database.run, database.imageStep, database.gateStep]);

    await expect(end(database, client)).resolves.toBe('not_in_progress');

    expect(JSON.stringify([database.run, database.imageStep, database.gateStep])).toBe(before);
    expect(history.sent).toEqual([]);
    expect(logsOf('workflow_run_given_up')).toEqual([]);
  });

  it('answers for a run that is gone', async () => {
    const database = createRunDatabase();
    const client = connect(database);

    await expect(endGivenUpWorkflowRun({ supabase: client, runId: 'run-of-a-deleted-canvas' }))
      .resolves.toBe('not_in_progress');
    expect(history.sent).toEqual([]);
  });

  it('closes a checkpoint that was waiting for review', async () => {
    const database = createRunDatabase();
    const client = connect(database);
    Object.assign(database.imageStep, {
      status: 'succeeded',
      output_snapshot: { outputUrl: 'https://signed.example.com/mug.png' },
      started_at: '2026-10-04T09:59:00.000Z',
      finished_at: '2026-10-04T09:59:30.000Z',
    });
    Object.assign(database.gateStep, {
      status: 'awaiting_approval',
      output_snapshot: { pendingOutputUrl: 'https://signed.example.com/mug.png', mediaKind: 'image' },
      started_at: '2026-10-04T09:59:31.000Z',
    });

    await expect(end(database, client)).resolves.toBe('failed');

    expect(database.gateStep).toMatchObject({
      status: 'blocked',
      error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE,
      // What was waiting to be reviewed stays on the step.
      output_snapshot: { pendingOutputUrl: 'https://signed.example.com/mug.png', mediaKind: 'image' },
      started_at: '2026-10-04T09:59:31.000Z',
    });
    expect(database.imageStep).toMatchObject({ status: 'succeeded', finished_at: '2026-10-04T09:59:30.000Z' });
    expect(history.sent).toEqual([expect.objectContaining(STOPPED_NOTIFICATION)]);
  });

  it('stores a run whose steps had all succeeded as succeeded', async () => {
    const database = createRunDatabase();
    const client = connect(database);
    // Every step was written, and the write of the run itself kept failing.
    for (const step of [database.imageStep, database.gateStep]) {
      Object.assign(step, { status: 'succeeded', started_at: '2026-10-04T09:59:00.000Z', finished_at: '2026-10-04T09:59:30.000Z' });
    }

    await expect(end(database, client)).resolves.toBe('succeeded');

    expect(database.run).toMatchObject({ status: 'succeeded', finished_at: new Date(database.clock.ms).toISOString() });
    expect(history.sent).toEqual([]);
    expect(logsOf('workflow_run_given_up')).toEqual([expect.objectContaining({ status: 'succeeded', lastError: 'boom' })]);
  });

  it('does not say we stopped a run that had failed by its own steps', async () => {
    const database = createRunDatabase();
    const client = connect(database);
    Object.assign(database.imageStep, {
      status: 'failed',
      error_message: 'The provider could not accept this request.',
      finished_at: '2026-10-04T09:59:30.000Z',
    });
    Object.assign(database.gateStep, {
      status: 'blocked',
      error_message: 'Image has no image output to review yet.',
      finished_at: '2026-10-04T09:59:30.000Z',
    });

    await expect(end(database, client)).resolves.toBe('failed');

    expect(database.run).toMatchObject({ status: 'failed' });
    // The steps keep their own notes.
    expect(database.imageStep.error_message).toBe('The provider could not accept this request.');
    expect(database.gateStep.error_message).toBe('Image has no image output to review yet.');
    expect(history.sent).toEqual([]);
  });

  it('says nothing when a sweep beside it ended the run first', async () => {
    const database = createRunDatabase();
    const client = connect(database);
    database.state.intercept = ({ table, update }) => {
      // The other sweep's write lands between this one's read and its write.
      if (table === 'workflow_canvas_runs' && update) {
        Object.assign(database.run, { status: 'failed', finished_at: '2026-10-04T10:00:00.500Z' });
      }
    };

    await expect(end(database, client)).resolves.toBe('not_in_progress');

    expect(database.run).toMatchObject({ status: 'failed', finished_at: '2026-10-04T10:00:00.500Z' });
    expect(history.sent).toEqual([]);
    expect(logsOf('workflow_run_given_up')).toEqual([]);
  });

  it.each([
    ['its steps cannot be read', ({ table, update }: Call) => table === 'workflow_canvas_run_steps' && !update],
    ['its generations cannot be read', ({ table }: Call) => table === 'generations'],
    ['its steps cannot be closed', ({ table, update }: Call) => table === 'workflow_canvas_run_steps' && Boolean(update)],
    ['the run cannot be written', ({ table, update }: Call) => table === 'workflow_canvas_runs' && Boolean(update)],
  ])('leaves the run for the next sweep when %s', async (_what, refuses) => {
    const { database, client } = await afterTheQueueGaveUp();
    database.state.refuseStepLinkWrites = false;
    renderComesIn(database);
    const refused = { message: 'canceling statement due to statement timeout', code: '57014' };
    database.state.intercept = (call) => (refuses(call) ? refused : undefined);

    // The sweep logs the run it could not end and goes on to the tickets.
    expect(await tick(database, client)).toMatchObject({ claimed: 0, adopted: 0 });

    expect(database.run).toMatchObject({ status: 'processing', finished_at: null });
    expect(history.sent).toEqual([]);
    expect(logsOf('workflow_run_given_up')).toEqual([]);
    expect(logsOf('workflow_run_adopt_failed')).toEqual([expect.objectContaining({
      level: 'error',
      runId: 'run-1',
      errorMessage: refused.message,
    })]);

    // The fault passes, and the next sweep ends the run as it would have.
    database.state.intercept = null;
    database.clock.ms += 10 * 60_000;
    await tick(database, client);

    expect(database.imageStep).toMatchObject({ status: 'succeeded', generation_id: 'gen-1' });
    expect(database.gateStep).toMatchObject({ status: 'blocked', error_message: WORKFLOW_RUN_STOPPED_STEP_MESSAGE });
    expect(database.run).toMatchObject({ status: 'failed', finished_at: new Date(database.clock.ms).toISOString() });
    expect(history.sent).toEqual([expect.objectContaining(STOPPED_NOTIFICATION)]);
    expect(logsOf('workflow_run_given_up')).toHaveLength(1);
  });
});
