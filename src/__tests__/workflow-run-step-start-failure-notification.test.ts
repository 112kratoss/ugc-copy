import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { getRefundedStartGenerationId, markRefundedGenerationStart } from '@/lib/generation-public-failure';
import { startImageGeneration } from '@/lib/generation-services';
import { ExternalServiceTimeoutError } from '@/lib/provider-fetch';
import { notifyRunStepStartFailure } from '@/lib/run-step-start-failure-notification';
import {
  createCanvasEdge,
  createWorkflowNode,
  normalizeWorkflowGraph,
  type TextInputNodeData,
} from '@/lib/workflow-canvas';
import { advanceWorkflowRunOnce } from '@/lib/workflow-runner';

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

/** What the start settlement answers, whatever the row said before it. */
type StartSettlement = 'failed' | 'already_failed' | 'unavailable';

type RunDatabaseOptions = {
  settlement?: StartSettlement;
  /** The credit hold is refused: nothing is reserved and no generation exists. */
  insufficientCredits?: boolean;
  /** Our own gate in front of the provider turns the submission away. */
  admissionRefused?: boolean;
  /** The refused generation cannot be read back. */
  generationsUnreadable?: boolean;
};

/**
 * A workflow run and the generations it starts, as the worker and the start
 * service use them: the run tables, the credit hold and its settlement.
 */
function createRunDatabase(kind: 'image' | 'video' | 'voiceover', options: RunDatabaseOptions = {}) {
  const prompt = createWorkflowNode('text-input', { x: 40, y: 40 });
  const generator = createWorkflowNode(`${kind}-generate`, { x: 280, y: 40 });
  const graph = normalizeWorkflowGraph({
    nodes: [
      { ...prompt, data: { ...(prompt.data as TextInputNodeData), text: 'A ceramic mug on a linen cloth' } },
      generator,
    ],
    edges: [createCanvasEdge(prompt.id, 'text', generator.id, 'prompt')],
  });

  const tables: Record<string, Row[]> = {
    workflow_canvas_runs: [{
      id: 'run-1',
      canvas_id: 'canvas-1',
      user_id: 'user-1',
      start_node_id: generator.id,
      mode: 'node',
      status: 'processing',
      created_at: '2026-10-02T10:00:00.000Z',
      finished_at: null,
      catalog_revision: 'catalog-rev-1',
      graph_snapshot: graph,
    }],
    workflow_canvas_run_steps: [{
      id: 'step-1',
      run_id: 'run-1',
      node_id: generator.id,
      status: 'queued',
      generation_id: null,
      input_snapshot: null,
      output_snapshot: null,
      error_message: null,
      started_at: null,
      finished_at: null,
    }],
    generations: [],
  };
  const rpcCalls: Array<{ fn: string; args: Row }> = [];

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
    const run = () => {
      const rows = matching(table, filters);
      if (update) for (const row of rows) Object.assign(row, update);
      return rows;
    };
    const unreadable = () => table === 'generations' && options.generationsUnreadable;
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
        const row = run()[0];
        return row ? { data: { ...row }, error: null } : { data: null, error: { message: 'No rows found' } };
      },
      async maybeSingle() {
        if (unreadable()) return { data: null, error: { message: 'database unavailable' } };
        const row = run()[0];
        return { data: row ? { ...row } : null, error: null };
      },
      then(resolve: (value: { data: Row[]; error: null }) => unknown) {
        return resolve({ data: run().map((row) => ({ ...row })), error: null });
      },
    };
    return query;
  }

  async function rpc(fn: string, args: Row = {}) {
    rpcCalls.push({ fn, args });

    if (fn === 'start_generation') {
      if (options.insufficientCredits) {
        return { data: { status: 'insufficient_credits', cost: args.p_cost }, error: null };
      }
      const generation: Row = {
        id: `gen-${tables.generations.length + 1}`,
        user_id: args.p_user_id,
        model: args.p_model,
        category: args.p_category,
        status: 'pending',
        prediction_id: null,
        output_url: null,
        refunded: false,
        client_request_key_hash: args.p_client_request_key_hash,
        submission_unknown_at: null,
        // A canvas step is an ordinary creation: it belongs to no template run.
        template_run_id: null,
        template_run_step_id: null,
      };
      tables.generations.push(generation);
      return {
        data: { status: 'started', generation_id: generation.id, remaining_credits: 88, cost: args.p_cost },
        error: null,
      };
    }

    if (fn === 'settle_generation_start_failed') {
      const settlement = options.settlement ?? 'failed';
      if (settlement === 'unavailable') return { data: null, error: { message: 'settlement unavailable' } };
      const generation = tables.generations.find((row) => row.id === args.p_generation_id);
      if (!generation) return { data: { status: 'missing' }, error: null };
      Object.assign(generation, { status: 'failed', refunded: true, client_request_key_hash: null });
      return {
        data: { status: settlement, generation_id: generation.id, refunded: true, remaining_credits: 100 },
        error: null,
      };
    }

    if (fn === 'mark_generation_submission_unknown') {
      const generation = tables.generations.find((row) => row.id === args.p_generation_id);
      if (!generation) return { data: { status: 'missing' }, error: null };
      generation.submission_unknown_at = '2026-10-02T10:00:30.000Z';
      return { data: { status: 'held', generation_id: generation.id }, error: null };
    }

    if (fn === 'reserve_provider_submission') {
      return {
        data: options.admissionRefused
          ? { allowed: false, reason: 'rate_limited', state: 'closed', retryAfterSeconds: 5, inFlight: 3 }
          : { allowed: true, reason: 'admitted', state: 'closed', retryAfterSeconds: 0, inFlight: 1 },
        error: null,
      };
    }

    return { data: null, error: null };
  }

  return {
    client: { from, rpc } as unknown as SupabaseClient,
    options,
    rpcCalls,
    generations: tables.generations,
    step: tables.workflow_canvas_run_steps[0],
    run: tables.workflow_canvas_runs[0],
    settlements: () => rpcCalls.filter((call) => call.fn === 'settle_generation_start_failed'),
  };
}

type RunDatabase = ReturnType<typeof createRunDatabase>;

/** The worker's client: the run database, with the notification tables served by `history`. */
function connect(database: RunDatabase, history?: MobileNotificationHistory) {
  const client = history ? withMobileNotificationHistory(database.client, history) : database.client;
  service.client = client;
  return client;
}

function advance(client: SupabaseClient) {
  return advanceWorkflowRunOnce({ supabase: client, canvasId: 'canvas-1', runId: 'run-1' });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The provider answers and turns the request down: nothing will run, nothing is billed. */
function providerRefuses() {
  vi.mocked(fetch).mockImplementation(async () => json({ code: 422, msg: 'The request was not accepted.' }));
}

function providerIsBusy() {
  vi.mocked(fetch).mockImplementation(async () => json({ msg: 'Too many requests' }, 429));
}

function providerDoesNotAnswer() {
  vi.mocked(fetch).mockRejectedValue(new ExternalServiceTimeoutError('KIE task creation', 30_000));
}

/** Runs `run` with the backend log captured, so a logged failure is asserted on and not printed. */
async function withCapturedLog<T>(run: (logged: BackendLogRecord[]) => Promise<T>) {
  const logged: BackendLogRecord[] = [];
  const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });
  try {
    return await run(logged);
  } finally {
    restoreLogSink();
  }
}

function errors(logged: BackendLogRecord[]) {
  return logged.filter((record) => record.level === 'error').map((record) => record.msg);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  // The provider client reports every refused or unanswered call on the console.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  service.client = null;
});

describe('a workflow run step the provider refuses at start', () => {
  it.each([
    ['image', 'Your image failed'],
    ['video', 'Your video failed'],
    ['voiceover', 'Your voiceover failed'],
  ] as const)('tells the creator their %s failed', async (kind, title) => {
    providerRefuses();
    const database = createRunDatabase(kind);
    const history = createMobileNotificationHistory();

    const run = await withCapturedLog(() => advance(connect(database, history)));

    // Nobody is waiting on a request here: the step was started by a worker,
    // and the run has no notification of its own.
    expect(history.sent).toEqual([expect.objectContaining({
      user_id: 'user-1',
      type: 'generation_failed',
      category: 'generation',
      title,
      // A canvas step's creation is in the library, and the tap opens it there.
      deep_link: '/viewer?source=studio-creations&initialId=gen-1',
      object_type: 'generation',
      object_id: 'gen-1',
      dedupe_key: 'generation:gen-1:failed',
    })]);
    expect(run.status).toBe('failed');
    expect(database.step).toMatchObject({ status: 'failed', generation_id: null });
  });

  it('leaves the credit settlement exactly as it was', async () => {
    providerRefuses();
    const database = createRunDatabase('image');

    await withCapturedLog(() => advance(connect(database, createMobileNotificationHistory())));

    expect(database.settlements()).toEqual([{
      fn: 'settle_generation_start_failed',
      args: {
        p_generation_id: 'gen-1',
        p_error_message: 'The generation provider could not accept this request. Check the template inputs before retrying.',
      },
    }]);
    expect(database.generations).toEqual([expect.objectContaining({
      id: 'gen-1',
      status: 'failed',
      refunded: true,
      client_request_key_hash: null,
    })]);
  });

  it('has sent the notification before the step is marked failed', async () => {
    providerRefuses();
    const database = createRunDatabase('image');
    const history = createMobileNotificationHistory();
    history.hold();

    await withCapturedLog(async () => {
      const advancing = advance(connect(database, history));

      try {
        // A worker has no response to send it behind, and a send let go of
        // unfinished is cut off when the function is frozen. It also goes out
        // first: a worker that died after marking the step would never be
        // asked about it again, and nobody would be told.
        expect(await hasAnswered(advancing)).toBe(false);
        expect(history.started).toEqual(['generation:gen-1:failed']);
        expect(database.step.status).toBe('queued');
      } finally {
        history.release();
      }
      await expect(advancing).resolves.toMatchObject({ status: 'failed' });
    });

    expect(history.sent).toHaveLength(1);
    expect(database.step.status).toBe('failed');
  });

  it.each([
    ['the provider says it is busy', providerIsBusy, {}],
    ['our own gate turns the submission away', providerRefuses, { admissionRefused: true }],
  ] as const)('sends nothing while the step waits to be tried again because %s', async (_reason, provider, options) => {
    provider();
    const database = createRunDatabase('image', options);
    const history = createMobileNotificationHistory();

    const run = await withCapturedLog(() => advance(connect(database, history)));

    // The credits came back, so the settlement answered `failed`, but the step
    // has not failed: it stays queued and the worker starts it again.
    expect(database.settlements()).toHaveLength(1);
    expect(database.generations[0]).toMatchObject({ status: 'failed', refunded: true });
    expect(database.step.status).toBe('queued');
    expect(run.status).toBe('processing');
    expect(history.started).toEqual([]);
  });

  it('sends one notification when a step that waited is refused on a later try', async () => {
    const database = createRunDatabase('image');
    const history = createMobileNotificationHistory();
    const client = connect(database, history);

    await withCapturedLog(async () => {
      providerIsBusy();
      await advance(client);
      await advance(client);
      expect(history.started).toEqual([]);

      providerRefuses();
      await advance(client);
    });

    // Every try holds credits on a generation of its own. Only the one that
    // ended the step is announced.
    expect(database.generations.map((row) => row.id)).toEqual(['gen-1', 'gen-2', 'gen-3']);
    expect(history.sent.map((row) => row.dedupe_key)).toEqual(['generation:gen-3:failed']);
    expect(database.step.status).toBe('failed');
  });

  it('sends nothing for a submission the provider may have accepted', async () => {
    providerDoesNotAnswer();
    const database = createRunDatabase('image');
    const history = createMobileNotificationHistory();

    const run = await withCapturedLog(() => advance(connect(database, history)));

    // Nothing has failed yet: the credits stay held and the step follows that
    // generation until it resolves or the reaper releases the hold.
    expect(database.settlements()).toEqual([]);
    expect(database.generations[0]).toMatchObject({ status: 'pending', refunded: false });
    expect(database.step).toMatchObject({ status: 'processing', generation_id: 'gen-1' });
    expect(run.status).toBe('processing');
    expect(history.started).toEqual([]);
  });

  it.each([
    ['had already returned the credits', 'already_failed'],
    ['could not be reached', 'unavailable'],
  ] as const)('sends nothing when the settlement %s', async (_outcome, settlement) => {
    providerRefuses();
    const database = createRunDatabase('image', { settlement });
    const history = createMobileNotificationHistory();

    await withCapturedLog(() => advance(connect(database, history)));

    // Only a settlement that released the hold itself is announced from here.
    expect(database.settlements()).toHaveLength(1);
    expect(database.step.status).toBe('failed');
    expect(history.started).toEqual([]);
  });

  it('sends nothing for a step that failed before any credits were held', async () => {
    providerRefuses();
    const database = createRunDatabase('image', { insufficientCredits: true });
    const history = createMobileNotificationHistory();

    await withCapturedLog(() => advance(connect(database, history)));

    // There is no generation to open from the notification.
    expect(database.generations).toEqual([]);
    expect(database.step.status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('still fails the step when the notification cannot be written', async () => {
    providerRefuses();
    const database = createRunDatabase('image');
    // No notification tables behind this client: every notifier call throws.
    const client = connect(database);

    await withCapturedLog(async (logged) => {
      await expect(advance(client)).resolves.toMatchObject({ status: 'failed' });
      expect(errors(logged)).toContain('failed_to_create_mobile_notification');
    });

    expect(database.step.status).toBe('failed');
    expect(database.generations[0]).toMatchObject({ status: 'failed', refunded: true });
  });

  it('still fails the step when the refused generation cannot be read', async () => {
    providerRefuses();
    const database = createRunDatabase('image', { generationsUnreadable: true });
    const history = createMobileNotificationHistory();

    await withCapturedLog(async (logged) => {
      await expect(advance(connect(database, history))).resolves.toMatchObject({ status: 'failed' });
      expect(errors(logged)).toContain('failed_to_notify_run_step_start_failure');
    });

    expect(database.step.status).toBe('failed');
    expect(history.started).toEqual([]);
  });
});

describe('a standalone creation the provider refuses at start', () => {
  it('is settled without a notification: the request that started it carries the answer', async () => {
    providerRefuses();
    const database = createRunDatabase('image');
    const history = createMobileNotificationHistory();
    const client = connect(database, history);

    const refusal = await withCapturedLog(() => startImageGeneration({
      supabase: client,
      creditSupabase: client,
      userId: 'user-1',
      prompt: 'A ceramic mug on a linen cloth',
      model: 'nano-banana-2',
    }).catch((error: unknown) => error));

    expect(refusal).toMatchObject({ message: 'The request was not accepted.' });
    expect(database.settlements()).toHaveLength(1);
    expect(database.generations[0]).toMatchObject({ status: 'failed', refunded: true });
    // The start service says what it refunded and leaves the telling to its
    // caller. A push from here would hold the response the person is waiting on.
    expect(getRefundedStartGenerationId(refusal)).toBe('gen-1');
    expect(history.started).toEqual([]);
  });
});

describe('announcing a refused start', () => {
  it('reaches only the person whose run it was', async () => {
    const database = createRunDatabase('image');
    database.generations.push({ id: 'gen-theirs', user_id: 'user-2', category: 'image', model: 'nano-banana-2' });
    const history = createMobileNotificationHistory();
    const client = connect(database, history);
    const refusal = new Error('The request was not accepted.');
    markRefundedGenerationStart(refusal, 'gen-theirs');

    // The mark only names a generation. It is read as the run owner's own, so
    // a run can never announce a creation that belongs to someone else.
    await notifyRunStepStartFailure({ client, error: refusal, userId: 'user-1' });
    expect(history.started).toEqual([]);

    await notifyRunStepStartFailure({ client, error: refusal, userId: 'user-2' });
    expect(history.sent).toEqual([expect.objectContaining({
      user_id: 'user-2',
      dedupe_key: 'generation:gen-theirs:failed',
    })]);
  });
});
