import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { startImageGeneration, type TemplateGenerationContext } from '@/lib/generation-services';
import { ExternalServiceTimeoutError } from '@/lib/provider-fetch';
import { validateAndCompileTemplateGraph } from '@/lib/template-graph-compiler';
import { syncTemplateRun } from '@/lib/template-run-service';
import { createTemplateReadyStarterGraph } from '@/lib/workflow-canvas';

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

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'neq' | 'in'; column: string; value: unknown };

/** What the start settlement answers, whatever the row said before it. */
type StartSettlement = 'failed' | 'already_failed' | 'unavailable';

type RunDatabaseOptions = {
  settlement?: StartSettlement;
  /** The credit hold is refused: nothing is reserved and no generation exists. */
  insufficientCredits?: boolean;
  /** Our own gate in front of the provider turns the submission away. */
  admissionRefused?: boolean;
  /** The refused generation cannot be read back to announce it. */
  generationsUnreadable?: boolean;
};

/**
 * A queued run of the starter template: two image steps the worker starts in
 * one pass, then the approvals and the video step that wait on them.
 */
function seedTemplateRun() {
  const graph = createTemplateReadyStarterGraph();
  const output = graph.nodes.find((node) => node.type === 'video-generate');
  if (!output) throw new Error('Starter output is missing.');
  const { compiled } = validateAndCompileTemplateGraph({
    graph,
    outputNodeId: output.id,
    canvasRevision: 3,
    catalogRevision: null,
  });
  if (!compiled) throw new Error('Starter graph must compile.');

  const run: Row = {
    id: 'run-1',
    template_id: 'template-1',
    template_version_id: 'version-1',
    user_id: 'user-1',
    graph_snapshot: {
      ...compiled,
      catalogRevision: 'catalog-rev-1',
      templateId: 'template-1',
      templateVersionId: 'version-1',
      templateTitle: 'Starter template',
      sourceCanvasId: 'canvas-1',
      sourceCanvasRevision: 3,
      demoOutputUrl: null,
    },
    graph_hash: compiled.graphHash,
    input_manifest: compiled.inputSlots,
    input_storage_paths: Object.fromEntries(compiled.inputSlots.map((slot) => [
      slot.key,
      `template_inputs/user-1/run-1/final/${slot.key}/input.png`,
    ])),
    output_node_id: compiled.outputNodeId,
    output_kind: compiled.outputKind,
    status: 'queued',
    estimated_total_credits: compiled.estimatedTotalCredits,
    estimated_remaining_credits: compiled.estimatedTotalCredits,
    credits_used: 0,
    result_url: null,
    result_generation_id: null,
    error_message: null,
    is_test: false,
    source_canvas_revision: 3,
    catalog_revision: 'catalog-rev-1',
    completed_at: null,
    inputs_deleted_at: null,
    usage_counted_at: null,
    created_at: '2026-10-02T10:00:00.000Z',
    updated_at: '2026-10-02T10:00:00.000Z',
  };

  const nodes = (compiled.graph as { nodes?: Array<{ id: string; type: string; data: { title?: string } }> }).nodes ?? [];
  const steps: Row[] = nodes
    .filter((node) => ['image-generate', 'video-generate', 'approval-gate'].includes(node.type))
    .map((node, index) => ({
      id: `step-${index + 1}`,
      run_id: 'run-1',
      node_id: node.id,
      attempt: 0,
      kind: node.type === 'approval-gate' ? 'approval' : 'generation',
      media_kind: node.type === 'video-generate' ? 'video' : 'image',
      label: node.data.title ?? node.id,
      status: 'queued',
      generation_id: null,
      output_url: null,
      error_message: null,
      can_retry: true,
      estimated_credits: compiled.nodeCosts[node.id] ?? 0,
      input_snapshot: null,
      output_snapshot: null,
      approved_at: null,
      started_at: null,
      finished_at: null,
      created_at: '2026-10-02T10:00:00.000Z',
    }));

  return { run, steps };
}

/**
 * A template run and the generations it starts, as the worker and the start
 * service use them: the run tables, the credit hold and its settlement.
 */
function createRunDatabase(options: RunDatabaseOptions = {}) {
  const { run, steps } = seedTemplateRun();
  const tables: Record<string, Row[]> = {
    template_runs: [run],
    template_run_steps: steps,
    generations: [],
  };
  const rpcCalls: Array<{ fn: string; args: Row }> = [];

  function matching(table: string, filters: Filter[]) {
    return (tables[table] ?? []).filter((row) => filters.every((filter) => {
      if (filter.op === 'eq') return row[filter.column] === filter.value;
      if (filter.op === 'neq') return row[filter.column] !== filter.value;
      return Array.isArray(filter.value) && filter.value.includes(row[filter.column]);
    }));
  }

  function from(table: string) {
    if (!tables[table]) throw new Error(`Unexpected table: ${table}`);
    const filters: Filter[] = [];
    let update: Row | null = null;
    let inserted: Row | null = null;
    const run = () => {
      if (inserted) return [inserted];
      const rows = matching(table, filters);
      if (update) for (const row of rows) Object.assign(row, update);
      return rows;
    };
    const filter = (op: Filter['op']) => (column: string, value: unknown) => {
      filters.push({ op, column, value });
      return query;
    };
    const query = {
      select: () => query,
      update(values: Row) {
        update = values;
        return query;
      },
      // The worker queues the next attempt of a step that was turned away as busy.
      insert(values: Row) {
        inserted = {
          id: `step-${tables[table].length + 1}`,
          generation_id: null,
          output_url: null,
          error_message: null,
          input_snapshot: null,
          output_snapshot: null,
          approved_at: null,
          started_at: null,
          finished_at: null,
          created_at: '2026-10-02T10:00:03.000Z',
          ...values,
        };
        tables[table].push(inserted);
        return query;
      },
      async single() {
        const row = run()[0];
        return { data: row ? { ...row } : null, error: null };
      },
      eq: filter('eq'),
      neq: filter('neq'),
      in: filter('in'),
      order: () => query,
      async maybeSingle() {
        // Only the read made to announce a refused start asks for a
        // generation by its id.
        if (
          table === 'generations'
          && options.generationsUnreadable
          && filters.some((filter) => filter.column === 'id')
        ) {
          return { data: null, error: { message: 'database unavailable' } };
        }
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

    if (fn === 'start_template_generation') {
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
        error_message: null,
        cost: args.p_cost,
        actual_cost: null,
        refunded: false,
        client_request_key_hash: args.p_client_request_key_hash,
        template_run_id: args.p_template_run_id,
        template_run_step_id: args.p_template_run_step_id,
        submission_unknown_at: null,
        created_at: '2026-10-02T10:00:01.000Z',
        completed_at: null,
      };
      tables.generations.push(generation);
      const step = tables.template_run_steps.find((row) => row.id === args.p_template_run_step_id);
      if (step) Object.assign(step, { generation_id: generation.id, status: 'processing', error_message: null });
      return {
        data: { status: 'started', generation_id: generation.id, remaining_credits: 88, cost: args.p_cost },
        error: null,
      };
    }

    if (fn === 'settle_template_generation_start_failed') {
      const settlement = options.settlement ?? 'failed';
      if (settlement === 'unavailable') return { data: null, error: { message: 'settlement unavailable' } };
      const generation = tables.generations.find((row) => row.id === args.p_generation_id);
      if (!generation) return { data: { status: 'missing' }, error: null };
      Object.assign(generation, {
        status: 'failed',
        refunded: true,
        client_request_key_hash: null,
        error_message: args.p_error_message,
        completed_at: '2026-10-02T10:00:02.000Z',
      });
      // The settlement fails the step it was started for in the same statement.
      const step = tables.template_run_steps.find((row) => (
        row.id === generation.template_run_step_id
        && row.generation_id === generation.id
        && row.status === 'processing'
      ));
      if (step) Object.assign(step, { status: 'failed', error_message: args.p_error_message });
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

  const client = {
    from,
    rpc,
    storage: {
      from: () => ({
        remove: async () => ({ error: null }),
        download: async () => ({ data: null, error: null }),
      }),
    },
  } as unknown as SupabaseClient;

  return {
    client,
    rpcCalls,
    generations: tables.generations,
    run,
    /** The two image steps, in the order the worker starts them. */
    imageSteps: steps.filter((step) => step.kind === 'generation' && step.media_kind === 'image'),
    settlements: () => rpcCalls.filter((call) => call.fn === 'settle_template_generation_start_failed'),
  };
}

type RunDatabase = ReturnType<typeof createRunDatabase>;

/** The worker's client: the run database, with the notification tables served by `history`. */
function connect(database: RunDatabase, history?: MobileNotificationHistory) {
  const client = history
    ? Object.assign(withMobileNotificationHistory(database.client, history), { storage: database.client.storage })
    : database.client;
  service.client = client;
  return client;
}

function sync(client: SupabaseClient) {
  return syncTemplateRun({ adminClient: client, runId: 'run-1', userId: 'user-1' });
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

const REFUSED_MESSAGE = 'The generation provider could not accept this request. Check the template inputs before retrying.';

describe('template run steps the provider refuses at start', () => {
  it('tells the creator about each image that failed', async () => {
    providerRefuses();
    const database = createRunDatabase();
    const history = createMobileNotificationHistory();

    const run = await withCapturedLog(() => sync(connect(database, history)));

    // Nobody is waiting on a request here: the steps were started by a worker,
    // and the run has no notification of its own.
    expect(history.sent).toEqual(['gen-1', 'gen-2'].map((generationId) => expect.objectContaining({
      user_id: 'user-1',
      type: 'generation_failed',
      category: 'generation',
      title: 'Your image failed',
      // A step's creation is kept out of the library, so the tap opens the
      // run, where the step is retried.
      body: 'Open your template run to retry this step.',
      deep_link: '/template-runs/run-1',
      object_type: 'generation',
      object_id: generationId,
      dedupe_key: `generation:${generationId}:failed`,
    })));
    expect(run.status).toBe('needs_attention');
    expect(database.imageSteps).toEqual([
      expect.objectContaining({ status: 'failed', generation_id: 'gen-1' }),
      expect.objectContaining({ status: 'failed', generation_id: 'gen-2' }),
    ]);
  });

  it('leaves the credit settlement exactly as it was', async () => {
    providerRefuses();
    const database = createRunDatabase();

    await withCapturedLog(() => sync(connect(database, createMobileNotificationHistory())));

    expect(database.settlements()).toEqual(['gen-1', 'gen-2'].map((generationId) => ({
      fn: 'settle_template_generation_start_failed',
      args: { p_generation_id: generationId, p_error_message: REFUSED_MESSAGE },
    })));
    expect(database.generations).toEqual(['gen-1', 'gen-2'].map((id) => expect.objectContaining({
      id,
      status: 'failed',
      refunded: true,
      client_request_key_hash: null,
    })));
  });

  it('has sent the notification before it records why the step failed and starts the next one', async () => {
    providerRefuses();
    const database = createRunDatabase();
    const history = createMobileNotificationHistory();
    history.hold();

    await withCapturedLog(async () => {
      const syncing = sync(connect(database, history));

      try {
        // A worker has no response to send it behind, and a send let go of
        // unfinished is cut off when the function is frozen.
        expect(await hasAnswered(syncing)).toBe(false);
        expect(history.started).toEqual(['generation:gen-1:failed']);
        expect(database.imageSteps[0].output_snapshot).toBeNull();
        expect(database.generations).toHaveLength(1);
      } finally {
        history.release();
      }
      await expect(syncing).resolves.toMatchObject({ status: 'needs_attention' });
    });

    expect(history.sent).toHaveLength(2);
    expect(database.imageSteps[0].output_snapshot).toEqual({ failureCode: 'provider_rejected' });
  });

  it.each([
    ['the provider says it is busy', providerIsBusy, {}],
    ['our own gate turns the submission away', providerRefuses, { admissionRefused: true }],
  ] as const)('sends nothing while the steps wait to be tried again because %s', async (_reason, provider, options) => {
    provider();
    const database = createRunDatabase(options);
    const history = createMobileNotificationHistory();

    const run = await withCapturedLog(() => sync(connect(database, history)));

    // The credits came back, so each settlement answered `failed`, and the
    // refused attempts are over. The steps have not failed: the worker put
    // each back in line as its next attempt.
    expect(database.settlements()).toHaveLength(2);
    expect(database.generations.map((row) => [row.status, row.refunded])).toEqual([['failed', true], ['failed', true]]);
    expect(database.imageSteps.map((step) => step.status)).toEqual(['failed', 'failed']);
    expect(run.steps.filter((step) => step.kind === 'generation' && step.mediaKind === 'image').map((step) => step.status))
      .toEqual(['queued', 'queued']);
    expect(run.status).toBe('queued');
    expect(history.started).toEqual([]);
  });

  it('tells the creator once a step that kept being turned away as busy stops being tried', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-02T10:00:00.000Z'));
      providerIsBusy();
      const database = createRunDatabase();
      const history = createMobileNotificationHistory();
      const client = connect(database, history);

      await withCapturedLog(() => sync(client));
      expect(history.started).toEqual([]);

      // Half an hour after the first refusal the worker gives up on the steps.
      vi.setSystemTime(new Date('2026-10-02T10:31:00.000Z'));
      const run = await withCapturedLog(() => sync(client));

      expect(run.status).toBe('needs_attention');
      // The attempts that ended the wait are the ones announced.
      expect(history.sent.map((row) => [row.type, row.object_id])).toEqual([
        ['generation_failed', 'gen-3'],
        ['generation_failed', 'gen-4'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing for submissions the provider may have accepted', async () => {
    providerDoesNotAnswer();
    const database = createRunDatabase();
    const history = createMobileNotificationHistory();

    const run = await withCapturedLog(() => sync(connect(database, history)));

    // Nothing has failed yet: the credits stay held and each step follows its
    // generation until it resolves or the reaper releases the hold.
    expect(database.settlements()).toEqual([]);
    expect(database.generations.map((row) => [row.status, row.refunded])).toEqual([['pending', false], ['pending', false]]);
    expect(database.imageSteps).toEqual([
      expect.objectContaining({ status: 'processing', generation_id: 'gen-1' }),
      expect.objectContaining({ status: 'processing', generation_id: 'gen-2' }),
    ]);
    expect(run.status).toBe('processing');
    expect(history.started).toEqual([]);
  });

  it.each([
    ['had already returned the credits', 'already_failed'],
    ['could not be reached', 'unavailable'],
  ] as const)('sends nothing when the settlement %s', async (_outcome, settlement) => {
    providerRefuses();
    const database = createRunDatabase({ settlement });
    const history = createMobileNotificationHistory();

    await withCapturedLog(() => sync(connect(database, history)));

    // Only a settlement that released the hold itself is announced from here.
    expect(database.settlements()).toHaveLength(2);
    expect(database.imageSteps.map((step) => step.status)).toEqual(['failed', 'failed']);
    expect(history.started).toEqual([]);
  });

  it('sends nothing for steps that failed before any credits were held', async () => {
    providerRefuses();
    const database = createRunDatabase({ insufficientCredits: true });
    const history = createMobileNotificationHistory();

    await withCapturedLog(() => sync(connect(database, history)));

    // There is no generation to open from the notification.
    expect(database.generations).toEqual([]);
    expect(database.imageSteps.map((step) => step.status)).toEqual(['failed', 'failed']);
    expect(fetch).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('still fails the steps when the notification cannot be written', async () => {
    providerRefuses();
    const database = createRunDatabase();
    // No notification tables behind this client: every notifier call throws.
    const client = connect(database);

    await withCapturedLog(async (logged) => {
      await expect(sync(client)).resolves.toMatchObject({ status: 'needs_attention' });
      expect(errors(logged).filter((msg) => msg === 'failed_to_create_mobile_notification')).toHaveLength(2);
    });

    expect(database.imageSteps).toEqual([
      expect.objectContaining({ status: 'failed', output_snapshot: { failureCode: 'provider_rejected' } }),
      expect.objectContaining({ status: 'failed', output_snapshot: { failureCode: 'provider_rejected' } }),
    ]);
    expect(database.generations.map((row) => [row.status, row.refunded])).toEqual([['failed', true], ['failed', true]]);
  });

  it('still fails the steps when a refused generation cannot be read', async () => {
    providerRefuses();
    const database = createRunDatabase({ generationsUnreadable: true });
    const history = createMobileNotificationHistory();

    await withCapturedLog(async (logged) => {
      await expect(sync(connect(database, history))).resolves.toMatchObject({ status: 'needs_attention' });
      expect(errors(logged).filter((msg) => msg === 'failed_to_notify_run_step_start_failure')).toHaveLength(2);
    });

    expect(database.imageSteps.map((step) => step.status)).toEqual(['failed', 'failed']);
    expect(history.started).toEqual([]);
  });
});
