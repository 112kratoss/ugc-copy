import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startImageGeneration, startVideoGeneration, type TemplateGenerationContext } from '@/lib/generation-services';
import { validateAndCompileTemplateGraph } from '@/lib/template-graph-compiler';
import { processTemplateRunJobs } from '@/lib/template-run-jobs-processor';
import { approveTemplateRunStep, cancelTemplateRun, getTemplateRun, retryTemplateRunStep, syncTemplateRun } from '@/lib/template-run-service';
import { createTemplateReadyStarterGraph } from '@/lib/workflow-canvas';

// The provider key and the callback settings are read when the generation
// modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'local-template-run-test');
  vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'local-template-run-provider-secret');
  vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'local-template-run-hmac');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://local-template-run.invalid');
  vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code');
});

const service = vi.hoisted(() => ({ client: null as unknown }));

// The provider, the gate in front of it and the poll of a running generation
// are outside boundaries. The run worker, the start service, the job queue,
// the credit hold and its refund run their real code against real SQL.
vi.mock('@/lib/provider-admission', async (original) => ({
  ...(await original<typeof import('@/lib/provider-admission')>()),
  admitProviderSubmission: vi.fn(),
  recordProviderSubmissionOutcome: vi.fn(),
}));
vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: async () => undefined,
}));
vi.mock('@/lib/server-helpers', async (original) => ({
  ...(await original<typeof import('@/lib/server-helpers')>()),
  createServiceClient: () => service.client,
  resolveOwnedStoredMediaUrl: async (_client: unknown, value: string) => `signed:${value}`,
}));

type StepStart = {
  node: { type: string };
  supabase: SupabaseClient;
  userId: string;
  clientRequestKeyHash?: string | null;
  persistInputMedia?: boolean;
  privateRecipe?: boolean;
  templateContext?: TemplateGenerationContext;
};

// The node executor uses controlled image/video settings, while each step
// calls its real start service with the context the worker gave it.
vi.mock('@/lib/workflow-runner', () => ({
  executeWorkflowRunnableNode: async (params: StepStart) => {
    const startParams = {
      supabase: params.supabase,
      creditSupabase: params.supabase,
      userId: params.userId,
      prompt: 'A ceramic mug on a linen cloth',
      clientRequestKeyHash: params.clientRequestKeyHash,
      persistInputMedia: params.persistInputMedia,
      privateRecipe: params.privateRecipe,
      templateContext: params.templateContext,
    };
    const started = params.node.type === 'video-generate'
      ? await startVideoGeneration({ ...startParams, model: 'kling-3.0-video', duration: 5, mode: 'std' })
      : await startImageGeneration({ ...startParams, model: 'nano-banana-2' });
    return {
      status: 'processing',
      generation_id: started.generationId ?? null,
      input_snapshot: {},
      output_snapshot: { predictionId: started.predictionId, cost: started.cost },
      error_message: null,
    };
  },
}));

const connectionString = process.env.SUPABASE_TEST_DB_URL;
const STARTING_CREDITS = 500;
const BUSY_MESSAGE = 'The generation provider is busy right now. Please retry this step shortly.';
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** Functions that return rows and are read as a table. Every other one returns a single value. */
const ROW_FUNCTIONS = new Set(['claim_template_run_jobs']);

function identifier(name: string) {
  if (!IDENTIFIER.test(name)) throw new Error(`Unexpected identifier: ${name}`);
  return name;
}

/** jsonb columns take JSON text; everything else is passed as it is. */
function writable(value: unknown) {
  return value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value;
}

function databaseError(error: unknown) {
  return {
    code: (error as { code?: string } | null)?.code,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** The PostgREST calls the run worker, the start service and the job queue make, over one connection. */
function databaseClient(db: Client, startAnswers: string[], beforeWrite?: (table: string) => Promise<void>): SupabaseClient {
  return {
    from(table: string) {
      identifier(table);
      const filters: string[] = [];
      const values: unknown[] = [];
      const orders: string[] = [];
      let insert: Record<string, unknown> | null = null;
      let update: Record<string, unknown> | null = null;

      const run = async () => {
        if (insert || update) await beforeWrite?.(table);
        if (insert) {
          const keys = Object.keys(insert).map(identifier);
          return (await db.query(
            `insert into public.${table}(${keys.join(',')}) values(${keys.map((_, index) => `$${index + 1}`).join(',')}) returning *`,
            Object.values(insert).map(writable),
          )).rows;
        }
        if (!filters.length) throw new Error(`Unbounded query on ${table}`);
        const where = ` where ${filters.join(' and ')}`;
        if (update) {
          const keys = Object.keys(update).map(identifier);
          return (await db.query(
            `update public.${table} set ${keys.map((key, index) => `${key}=$${values.length + index + 1}`).join(',')}${where} returning *`,
            [...values, ...Object.values(update).map(writable)],
          )).rows;
        }
        return (await db.query(
          `select * from public.${table}${where}${orders.length ? ` order by ${orders.join(',')}` : ''}`,
          values,
        )).rows;
      };
      const answer = async (single: boolean, required: boolean) => {
        try {
          const rows = await run();
          if (!single) return { data: rows, error: null };
          if (rows.length > 1 || (required && !rows.length)) {
            return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
          }
          return { data: rows[0] ?? null, error: null };
        } catch (error) {
          return { data: null, error: databaseError(error) };
        }
      };
      const compare = (operator: string) => (column: string, value: unknown) => {
        values.push(value);
        filters.push(`${identifier(column)}${operator}$${values.length}`);
        return query;
      };
      const query = {
        select: () => query,
        insert(value: Record<string, unknown>) {
          insert = value;
          return query;
        },
        update(value: Record<string, unknown>) {
          update = value;
          return query;
        },
        eq: compare('='),
        neq: compare('<>'),
        in(column: string, value: unknown[]) {
          values.push(value);
          filters.push(`${identifier(column)}=any($${values.length})`);
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          orders.push(`${identifier(column)} ${options?.ascending === false ? 'desc' : 'asc'}`);
          return query;
        },
        single: () => answer(true, true),
        maybeSingle: () => answer(true, false),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => (
          answer(false, false).then(resolve, reject)
        ),
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      identifier(name);
      const call = `public.${name}(${Object.keys(args).map((key, index) => `${identifier(key)}=>$${index + 1}`).join(',')})`;
      try {
        if (name === 'retry_template_checkpoint') await beforeWrite?.('template_run_steps');
        const { rows } = await db.query(
          ROW_FUNCTIONS.has(name) ? `select * from ${call}` : `select ${call} as result`,
          Object.values(args).map(writable),
        );
        const data = ROW_FUNCTIONS.has(name) ? rows : rows[0].result;
        if (name === 'start_template_generation') startAnswers.push(data.status);
        return { data, error: null };
      } catch (error) {
        if (name === 'start_template_generation') startAnswers.push(databaseError(error).message);
        return { data: null, error: databaseError(error) };
      }
    },
    storage: {
      from: () => ({
        remove: async () => ({ error: null }),
        download: async () => ({ data: null, error: null }),
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((path) => ({ path, signedUrl: `https://storage.test/${path}`, error: null })),
          error: null,
        }),
      }),
    },
  } as unknown as SupabaseClient;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe.skipIf(!connectionString)('template run step starts the provider turns away, with real PostgreSQL', () => {
  let admin: Client;
  let worker: Client;
  let client: SupabaseClient;
  let userId: string;
  let templateId: string;
  let runId: string;
  /** What `start_template_generation` answered, in order: a status, or the database error. */
  const startAnswers: string[] = [];

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = new Client({ connectionString, statement_timeout: 10_000 });
    worker = new Client({ connectionString, statement_timeout: 10_000 });
    await admin.connect();
    await worker.connect();
    // The worker runs as the service role, under the grants it has in production.
    await worker.query('set role service_role');
  });
  afterAll(async () => {
    await worker?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn());
    // The provider client reports every refused call on the console, and the
    // start service logs each refund. Neither is what these tests assert on.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    startAnswers.length = 0;

    userId = randomUUID();
    await admin.query(
      "insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())",
      [userId, `${userId}@example.invalid`],
    );
    await admin.query('update public.profiles set credits=$2,promotional_credits=0 where id=$1', [userId, STARTING_CREDITS]);
    await admin.query(
      'insert into public.mobile_notification_preferences(user_id,push_enabled) values($1,false) on conflict(user_id) do update set push_enabled=false',
      [userId],
    );

    // A queued run of the starter template: two image steps the worker starts
    // in one pass, then the approvals and the video step that wait on them.
    const graph = createTemplateReadyStarterGraph();
    const output = graph.nodes.find((node) => node.type === 'video-generate')!;
    const { compiled } = validateAndCompileTemplateGraph({
      graph, outputNodeId: output.id, canvasRevision: 3, catalogRevision: null,
    });
    if (!compiled) throw new Error('Starter graph must compile.');
    // A run of the creator's own draft, as the publish drawer's test run is:
    // it has no published version, and a published version can never be
    // deleted again, so a fixture with one would stay in the database.
    templateId = randomUUID();
    await admin.query(
      "insert into public.templates(id,name,creator_user_id,status,is_active) values($1,'Busy retry fixture',$2,'draft',true)",
      [templateId, userId],
    );
    runId = randomUUID();
    const snapshot = {
      ...compiled,
      catalogRevision: 'catalog-rev-1',
      templateId,
      templateVersionId: null,
      templateTitle: 'Busy retry fixture',
      sourceCanvasId: null,
      sourceCanvasRevision: 3,
      demoOutputUrl: null,
    };
    const inputPaths = Object.fromEntries(compiled.inputSlots.map((slot) => [
      slot.key,
      `template_inputs/${userId}/${runId}/final/${slot.key}/input.png`,
    ]));
    await admin.query(
      `insert into public.template_runs(id,template_id,user_id,graph_snapshot,graph_hash,input_manifest,input_storage_paths,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits,is_test,catalog_revision)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$10,true,'catalog-rev-1')`,
      [runId, templateId, userId, JSON.stringify(snapshot), compiled.graphHash, JSON.stringify(compiled.inputSlots), JSON.stringify(inputPaths), compiled.outputNodeId, compiled.outputKind, compiled.estimatedTotalCredits],
    );
    const nodes = (compiled.graph as { nodes?: Array<{ id: string; type: string; data: { title?: string } }> }).nodes ?? [];
    for (const node of nodes.filter((candidate) => ['image-generate', 'video-generate', 'approval-gate'].includes(candidate.type))) {
      await admin.query(
        `insert into public.template_run_steps(run_id,node_id,kind,media_kind,label,status,estimated_credits)
         values($1,$2,$3,$4,$5,'queued',$6)`,
        [runId, node.id, node.type === 'approval-gate' ? 'approval' : 'generation', node.type === 'video-generate' ? 'video' : 'image', node.data.title ?? node.id, compiled.nodeCosts[node.id] ?? 0],
      );
    }

    client = databaseClient(worker, startAnswers);
    service.client = client;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    service.client = null;
    await admin.query('delete from public.generations where user_id=$1', [userId]);
    await admin.query('delete from public.template_runs where id=$1', [runId]);
    await admin.query('delete from public.templates where id=$1', [templateId]);
    await admin.query('delete from auth.users where id=$1', [userId]);
  });

  function providerIsBusy() {
    vi.mocked(fetch).mockImplementation(async () => json({ msg: 'Too many requests' }, 429));
  }
  function providerHasRoom() {
    vi.mocked(fetch).mockImplementation(async () => json({ code: 200, data: { taskId: `task-${randomUUID()}` } }));
  }
  function providerRefuses() {
    vi.mocked(fetch).mockImplementation(async () => json({ code: 422, msg: 'The request was not accepted.' }));
  }
  const providerCalls = () => vi.mocked(fetch).mock.calls.length;

  /** One pass of the run worker. Returns what the person is shown. */
  async function tick() {
    vi.mocked(fetch).mockClear();
    return syncTemplateRun({ adminClient: client, runId, userId });
  }

  /** Every attempt of each image step: [attempt, step status, its generation's status], oldest attempt first. */
  async function imageAttempts() {
    const { rows } = await admin.query(
      `select steps.node_id, steps.attempt, steps.status, generations.status as generation_status
       from public.template_run_steps as steps
       left join public.generations as generations on generations.id = steps.generation_id
       where steps.run_id=$1 and steps.kind='generation' and steps.media_kind='image'
       order by steps.node_id, steps.attempt`,
      [runId],
    );
    const byNode = new Map<string, Array<[number, string, string | null]>>();
    for (const row of rows) {
      byNode.set(row.node_id, [...(byNode.get(row.node_id) ?? []), [row.attempt, row.status, row.generation_status]]);
    }
    return [...byNode.values()];
  }
  async function credits() {
    return (await admin.query('select credits from public.profiles where id=$1', [userId])).rows[0].credits as number;
  }
  async function generations() {
    return (await admin.query(
      `select status, refunded, cost, client_request_key_hash is null as key_cleared, studio_visible
       from public.generations where user_id=$1 order by created_at, id`,
      [userId],
    )).rows as Array<{ status: string; refunded: boolean; cost: number; key_cleared: boolean; studio_visible: boolean }>;
  }
  /** Moves the moment the waiting steps were first turned away into the past. */
  async function waitingSince(minutesAgo: number) {
    const { rowCount } = await admin.query(
      `update public.template_run_steps
       set output_snapshot = jsonb_set(output_snapshot, '{busySince}', to_jsonb($2::text))
       where run_id=$1 and status='queued' and output_snapshot ? 'busySince'`,
      [runId, new Date(Date.now() - minutesAgo * 60_000).toISOString()],
    );
    expect(rowCount).toBe(2);
  }
  type ShownRun = Awaited<ReturnType<typeof tick>>;
  const shownImageSteps = (run: ShownRun) => run.steps.filter((step) => step.kind === 'generation' && step.mediaKind === 'image');

  it('cancels a queued run twice without starting or charging any generation', async () => {
    const cancelled = await cancelTemplateRun(client, runId, userId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.steps.every(step => step.status === 'cancelled')).toBe(true);
    expect(await credits()).toBe(STARTING_CREDITS);
    expect(await generations()).toEqual([]);
    expect(providerCalls()).toBe(0);
    expect((await cancelTemplateRun(client, runId, userId)).status).toBe('cancelled');
    expect((await tick()).status).toBe('cancelled');
    expect(providerCalls()).toBe(0);
    expect(await credits()).toBe(STARTING_CREDITS);
  });

  it('cancellation keeps in-flight charges and later failure refunds each generation only once', async () => {
    providerHasRoom();
    const started = await tick();
    expect(started.status).toBe('processing');
    const rows = (await admin.query('select id,prediction_id,cost from public.generations where user_id=$1', [userId])).rows;
    expect(rows).toHaveLength(2);
    const spent = rows.reduce((sum, row) => sum + row.cost, 0);
    expect(await credits()).toBe(STARTING_CREDITS - spent);
    const cancelled = await cancelTemplateRun(client, runId, userId);
    expect(cancelled.status).toBe('cancelled');
    expect(await credits()).toBe(STARTING_CREDITS - spent);
    expect((await generations()).every(row => row.status === 'processing' && !row.refunded)).toBe(true);
    let remainingSpent = spent;
    for (const row of rows) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = await client.rpc('settle_generation_failed', { p_prediction_id: row.prediction_id, p_error_message: 'fixture provider failure' });
        expect(result.error).toBeNull();
      }
      remainingSpent -= row.cost;
      expect((await getTemplateRun({ adminClient: client, runId, userId })).creditsUsed).toBe(remainingSpent);
      expect(await credits()).toBe(STARTING_CREDITS - remainingSpent);
    }
    expect(await credits()).toBe(STARTING_CREDITS);
    const refundedRun = await getTemplateRun({ adminClient: client, runId, userId });
    expect(refundedRun.status).toBe('cancelled');
    expect(refundedRun.creditsUsed).toBe(0);
    expect((await tick()).creditsUsed).toBe(0);
    expect((await cancelTemplateRun(client, runId, userId)).creditsUsed).toBe(0);
    expect(await credits()).toBe(STARTING_CREDITS);
    expect(await generations()).toHaveLength(2);
  });

  it('refuses a foreign cancellation and preserves the owner run and balance', async () => {
    await expect(cancelTemplateRun(client, runId, randomUUID())).rejects.toMatchObject({ status: 404 });
    expect((await admin.query('select status from public.template_runs where id=$1', [runId])).rows[0].status).toBe('queued');
    expect(await credits()).toBe(STARTING_CREDITS);
    expect(await generations()).toEqual([]);
  });

  async function finishImagesAndAwaitApproval() {
    providerHasRoom();
    await tick();
    const rows = (await admin.query('select id,prediction_id,cost from public.generations where user_id=$1', [userId])).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const result = await client.rpc('settle_generation_succeeded', {
        p_prediction_id: row.prediction_id,
        p_output_url: `generated_images/${userId}/${row.id}.png`,
      });
      expect(result.error).toBeNull();
    }
    const run = await tick();
    expect(run.status).toBe('awaiting_approval');
    const gates = run.steps.filter(step => step.kind === 'approval');
    expect(gates.map(step => step.status)).toEqual(['awaiting_approval', 'awaiting_approval']);
    return { run, gates, spent: rows.reduce((sum, row) => sum + row.cost, 0) };
  }

  it('completes approved images through a real video hold and canonical final settlement without double charging', async () => {
    const { gates } = await finishImagesAndAwaitApproval();
    for (const gate of gates) {
      await approveTemplateRunStep({ adminClient: client, runId, stepId: gate.id, userId });
    }
    const processing = await tick();
    expect(processing.status, JSON.stringify(processing.steps.map(step => ({ status: step.status, error: step.errorMessage })))).toBe('processing');
    const video = (await admin.query("select id,prediction_id,cost from public.generations where user_id=$1 and category='video'", [userId])).rows;
    expect(video).toHaveLength(1);
    expect(await generations()).toHaveLength(3);
    const spent = (await generations()).reduce((sum, row) => sum + row.cost, 0);
    expect(await credits()).toBe(STARTING_CREDITS - spent);
    await tick();
    expect(await generations()).toHaveLength(3);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect((await client.rpc('settle_generation_succeeded', {
        p_prediction_id: video[0].prediction_id,
        p_output_url: `generated_videos/${userId}/${video[0].id}.mp4`,
      })).error).toBeNull();
    }
    const completed = await tick();
    expect(completed.status).toBe('succeeded');
    expect(completed.creditsUsed).toBe(spent);
    expect((await admin.query('select result_generation_id from public.template_runs where id=$1', [runId])).rows[0].result_generation_id).toBe(video[0].id);
    expect((await tick()).status).toBe('succeeded');
    expect((await cancelTemplateRun(client, runId, userId)).status).toBe('succeeded');
    expect(await credits()).toBe(STARTING_CREDITS - spent);
    expect(await generations()).toHaveLength(3);
  });

  it('refunds a failed downstream video once and completes one manual retry while retaining image charges', async () => {
    const { gates, spent: imageCost } = await finishImagesAndAwaitApproval();
    for (const gate of gates) {
      await approveTemplateRunStep({ adminClient: client, runId, stepId: gate.id, userId });
    }
    const started = await tick();
    const step = started.steps.find(item => item.kind === 'generation' && item.mediaKind === 'video')!;
    expect(step.status).toBe('processing');
    const original = (await admin.query("select id,prediction_id from public.generations where user_id=$1 and category='video'", [userId])).rows[0];
    for (let repeat = 0; repeat < 2; repeat++) {
      expect((await client.rpc('settle_generation_failed', {
        p_prediction_id: original.prediction_id, p_error_message: 'fixture downstream failure',
      })).error).toBeNull();
    }
    expect(await credits()).toBe(STARTING_CREDITS - imageCost);
    expect((await tick()).status).toBe('needs_attention');
    expect((await getTemplateRun({ adminClient: client, runId, userId })).creditsUsed).toBe(imageCost);
    for (let repeat = 0; repeat < 2; repeat++) {
      await retryTemplateRunStep({ adminClient: client, runId, stepId: step.id, userId });
    }
    const retried = await tick();
    expect(retried.status).toBe('processing');
    const retry = (await admin.query("select id,prediction_id,cost from public.generations where user_id=$1 and category='video' and id<>$2", [userId,original.id])).rows;
    expect(retry).toHaveLength(1);
    expect(await credits()).toBe(STARTING_CREDITS - imageCost - retry[0].cost);
    expect((await client.rpc('settle_generation_succeeded', {
      p_prediction_id: retry[0].prediction_id,
      p_output_url: `generated_videos/${userId}/${retry[0].id}.mp4`,
    })).error).toBeNull();
    const completed = await tick();
    expect(completed.status).toBe('succeeded');
    expect(completed.creditsUsed).toBe(imageCost + retry[0].cost);
    expect((await tick()).creditsUsed).toBe(completed.creditsUsed);
    expect(await generations()).toHaveLength(4);
    expect(await credits()).toBe(STARTING_CREDITS - completed.creditsUsed);
  });

  it('approves a checkpoint once and rejects duplicate/foreign approval without extra charges', async () => {
    const { gates, spent } = await finishImagesAndAwaitApproval();
    await expect(approveTemplateRunStep({ adminClient: client, runId, stepId: gates[0].id, userId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    const approved = await approveTemplateRunStep({ adminClient: client, runId, stepId: gates[0].id, userId });
    expect(approved.steps.find(step => step.id === gates[0].id)?.status).toBe('succeeded');
    await expect(approveTemplateRunStep({ adminClient: client, runId, stepId: gates[0].id, userId })).rejects.toMatchObject({ status: 409 });
    expect(await credits()).toBe(STARTING_CREDITS - spent);
    expect(await generations()).toHaveLength(2);
  });

  it('cancel after settled images retains the successful work and rejects retry', async () => {
    const { run, spent } = await finishImagesAndAwaitApproval();
    const cancelled = await cancelTemplateRun(client, runId, userId);
    expect(cancelled.steps.filter(step => step.kind === 'generation' && step.mediaKind === 'image').map(step => step.status)).toEqual(['succeeded', 'succeeded']);
    expect(cancelled.steps.filter(step => step.kind === 'approval').every(step => step.status === 'cancelled')).toBe(true);
    expect(await credits()).toBe(STARTING_CREDITS - spent);
    await expect(retryTemplateRunStep({ adminClient: client, runId, stepId: run.steps[0].id, userId })).rejects.toMatchObject({ code: 'RUN_TERMINAL' });
    expect(await generations()).toHaveLength(2);
  });

  it('duplicate retry of a checkpoint creates only one next generation attempt and one next gate', async () => {
    const { gates, spent } = await finishImagesAndAwaitApproval();
    const args = { adminClient: client, runId, stepId: gates[0].id, userId };
    await retryTemplateRunStep(args);
    await retryTemplateRunStep(args);
    const next = (await admin.query('select kind,status from public.template_run_steps where run_id=$1 and attempt=1 order by kind', [runId])).rows;
    expect(next).toEqual([{kind:'approval',status:'queued'},{kind:'generation',status:'queued'}]);
    expect(await credits()).toBe(STARTING_CREDITS - spent);
    const restarted = await tick();
    expect(restarted.status).toBe('processing');
    const rows = await generations();
    expect(rows).toHaveLength(3);
    const totalSpent = rows.reduce((sum, row) => sum + row.cost, 0);
    expect(await credits()).toBe(STARTING_CREDITS - totalSpent);
    expect(restarted.creditsUsed).toBe(totalSpent);
    expect((await getTemplateRun({ adminClient: client, runId, userId })).creditsUsed).toBe(totalSpent);
    await tick();
    expect(await generations()).toHaveLength(3);
  });

  it('two database clients cannot approve the same checkpoint twice', async () => {
    const { gates, spent } = await finishImagesAndAwaitApproval();
    const second = new Client({ connectionString, statement_timeout: 10_000 });
    await second.connect();
    try {
      await second.query('set role service_role');
      const other = databaseClient(second, []);
      const results = await Promise.allSettled([client, other].map(adminClient => approveTemplateRunStep({ adminClient, runId, stepId: gates[0].id, userId })));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ status: 409 });
      expect(await credits()).toBe(STARTING_CREDITS - spent);
      expect(await generations()).toHaveLength(2);
    } finally { await second.end(); }
  });

  it.each(['approval', 'cancellation'] as const)('does not retry a checkpoint when concurrent %s wins after the retry read', async action => {
    const { gates, spent } = await finishImagesAndAwaitApproval();
    const second = new Client({ connectionString, statement_timeout: 10_000 });
    await second.connect();
    let releaseWrite!: () => void;
    let reachedWrite!: () => void;
    const held = new Promise<void>(resolve => { releaseWrite = resolve; });
    const reached = new Promise<void>(resolve => { reachedWrite = resolve; });
    try {
      await second.query('set role service_role');
      let paused = false;
      const other = databaseClient(second, [], async table => {
        if (table === 'template_run_steps' && !paused) {
          paused = true;
          reachedWrite();
          await held;
        }
      });
      const retry = retryTemplateRunStep({ adminClient: other, runId, stepId: gates[0].id, userId });
      const result = retry.then(value => ({ value, error: null }), error => ({ value: null, error }));
      await reached;
      if (action === 'approval') {
        await approveTemplateRunStep({ adminClient: client, runId, stepId: gates[0].id, userId });
      } else {
        await cancelTemplateRun(client, runId, userId);
      }
      releaseWrite();
      const outcome = await result;
      expect((await admin.query('select id from public.template_run_steps where run_id=$1 and attempt=1', [runId])).rows).toEqual([]);
      expect(outcome.error).toMatchObject({ status: 409 });
      expect(await credits()).toBe(STARTING_CREDITS - spent);
      expect(await generations()).toHaveLength(2);
    } finally { releaseWrite(); await second.end(); }
  });

  it('rolls back the cancelled checkpoint and first replacement if the second insert fails', async () => {
    const { gates, spent } = await finishImagesAndAwaitApproval();
    await admin.query(`create or replace function pg_temp.reject_audit_checkpoint_insert() returns trigger
      language plpgsql as $$ begin
        if new.run_id = '${runId}'::uuid and new.kind = 'approval' and new.attempt = 1 then
          raise exception 'audit checkpoint insert failure';
        end if;
        return new;
      end $$`);
    await admin.query(`create trigger audit_checkpoint_insert_failure before insert on public.template_run_steps
      for each row execute function pg_temp.reject_audit_checkpoint_insert()`);
    try {
      await expect(retryTemplateRunStep({ adminClient: client, runId, stepId: gates[0].id, userId }))
        .rejects.toMatchObject({ message: 'audit checkpoint insert failure' });
      expect((await admin.query('select status from public.template_run_steps where id=$1', [gates[0].id])).rows[0].status)
        .toBe('awaiting_approval');
      expect((await admin.query('select id from public.template_run_steps where run_id=$1 and attempt=1', [runId])).rows).toEqual([]);
      expect((await admin.query('select status from public.template_runs where id=$1', [runId])).rows[0].status).toBe('awaiting_approval');
      expect(await credits()).toBe(STARTING_CREDITS - spent);
    } finally {
      await admin.query('drop trigger audit_checkpoint_insert_failure on public.template_run_steps');
    }
    await retryTemplateRunStep({ adminClient: client, runId, stepId: gates[0].id, userId });
    expect((await admin.query('select id from public.template_run_steps where run_id=$1 and attempt=1', [runId])).rows).toHaveLength(2);
  });

  it('restricts the atomic checkpoint RPC to service_role and checks run ownership', async () => {
    const { gates } = await finishImagesAndAwaitApproval();
    const permissions = await admin.query(`select
      has_function_privilege('anon', 'public.retry_template_checkpoint(uuid,uuid,uuid,uuid)', 'execute') as anon,
      has_function_privilege('authenticated', 'public.retry_template_checkpoint(uuid,uuid,uuid,uuid)', 'execute') as authenticated,
      has_function_privilege('service_role', 'public.retry_template_checkpoint(uuid,uuid,uuid,uuid)', 'execute') as service`);
    expect(permissions.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
    const foreign = await client.rpc('retry_template_checkpoint', {
      p_run_id: runId, p_step_id: gates[0].id, p_source_step_id: randomUUID(), p_user_id: randomUUID(),
    });
    expect(foreign).toEqual({ data: 'RUN_NOT_FOUND', error: null });
    expect((await admin.query('select id from public.template_run_steps where run_id=$1 and attempt=1', [runId])).rows).toEqual([]);
  });

  it('two database clients retry a checkpoint into one next attempt without another credit hold', async () => {
    const { gates, spent } = await finishImagesAndAwaitApproval();
    const second = new Client({ connectionString, statement_timeout: 10_000 });
    await second.connect();
    try {
      await second.query('set role service_role');
      const other = databaseClient(second, []);
      const results = await Promise.allSettled([client, other].map(adminClient => retryTemplateRunStep({ adminClient, runId, stepId: gates[0].id, userId })));
      expect(results.every(result => result.status === 'fulfilled')).toBe(true);
      expect((await admin.query('select kind,status from public.template_run_steps where run_id=$1 and attempt=1 order by kind', [runId])).rows)
        .toEqual([{kind:'approval',status:'queued'},{kind:'generation',status:'queued'}]);
      expect(await credits()).toBe(STARTING_CREDITS - spent);
      expect(await generations()).toHaveLength(2);
    } finally { await second.end(); }
  });

  it('a busy step starts on a later tick once the provider has room, and holds credits only then', async () => {
    providerIsBusy();
    const waiting = await tick();

    expect(waiting.status).toBe('queued');
    expect(shownImageSteps(waiting).map((step) => [step.status, step.failureCode, step.errorMessage])).toEqual([
      ['queued', 'provider_busy', BUSY_MESSAGE],
      ['queued', 'provider_busy', BUSY_MESSAGE],
    ]);
    // The refused attempt keeps its refunded generation and is over; the step
    // waits as a new row that has none.
    expect(await imageAttempts()).toEqual([
      [[0, 'failed', 'failed'], [1, 'queued', null]],
      [[0, 'failed', 'failed'], [1, 'queued', null]],
    ]);
    expect(await credits()).toBe(STARTING_CREDITS);

    await tick();
    expect(providerCalls()).toBe(2);
    expect(await credits()).toBe(STARTING_CREDITS);

    providerHasRoom();
    const started = await tick();

    expect(providerCalls()).toBe(2);
    // Every start the worker asked for was one the database could make.
    expect(startAnswers).toEqual(['started', 'started', 'started', 'started', 'started', 'started']);
    expect(await imageAttempts()).toEqual([
      [[0, 'failed', 'failed'], [1, 'failed', 'failed'], [2, 'processing', 'processing']],
      [[0, 'failed', 'failed'], [1, 'failed', 'failed'], [2, 'processing', 'processing']],
    ]);
    expect(started.status).toBe('processing');
    expect(shownImageSteps(started).map((step) => [step.status, step.failureCode, step.errorMessage])).toEqual([
      ['processing', null, null],
      ['processing', null, null],
    ]);

    const rows = await generations();
    expect(rows.map((row) => [row.status, row.refunded, row.key_cleared, row.studio_visible])).toEqual([
      ['failed', true, true, false],
      ['failed', true, true, false],
      ['failed', true, true, false],
      ['failed', true, true, false],
      ['processing', false, false, false],
      ['processing', false, false, false],
    ]);
    expect(await credits()).toBe(STARTING_CREDITS - rows[4].cost - rows[5].cost);
  });

  it('a busy step can only wait as a new step row: the database starts a step row once', async () => {
    providerIsBusy();
    await tick();
    const refused = (await admin.query(
      `select id, estimated_credits from public.template_run_steps
       where run_id=$1 and kind='generation' and media_kind='image' and attempt=0 order by node_id limit 1`,
      [runId],
    )).rows[0];
    const startAgain = () => client.rpc('start_template_generation', {
      p_user_id: userId,
      p_template_run_id: runId,
      p_template_run_step_id: refused.id,
      p_cost: refused.estimated_credits,
      p_model: 'nano-banana-2',
      p_category: 'image',
      p_duration: null,
      p_creation_mode: null,
      p_source_generation_id: null,
      p_client_request_key_hash: 'a'.repeat(64),
    });

    // The row still carries its refunded generation.
    expect((await startAgain()).data).toEqual({ status: 'template_step_already_started' });

    // Taking the generation off the row and putting the row back in line does
    // not make it startable either: the generation still points at the row.
    await admin.query("update public.template_run_steps set generation_id=null, status='queued' where id=$1", [refused.id]);
    const unlinked = await startAgain();

    expect(unlinked.data).toBeNull();
    expect(unlinked.error).toMatchObject({
      code: '23505',
      message: expect.stringContaining('generations_template_run_step_unique_idx'),
    });
    expect(await credits()).toBe(STARTING_CREDITS);
  });

  it('the run job waits with a busy step, and is let go when the step stops being tried', async () => {
    const otherJobs = await admin.query(
      "select count(*)::int as waiting from public.template_run_jobs where run_id<>$1 and status in ('pending','processing')",
      [runId],
    );
    // The processor claims whichever job is due. Another run's job would be worked on here.
    expect(otherJobs.rows[0].waiting).toBe(0);
    const process = () => processTemplateRunJobs({ client, lockedBy: `busy-retry-${runId}` });
    const job = async () => (await admin.query(
      'select status, attempt_count, next_attempt_at > now() as later from public.template_run_jobs where run_id=$1',
      [runId],
    )).rows[0];
    await admin.query('select public.enqueue_template_run_job($1)', [runId]);

    providerIsBusy();
    expect(await process()).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    // Deferred, not failed: waiting on the provider costs the job no attempt.
    expect(await job()).toEqual({ status: 'pending', attempt_count: 0, later: true });

    // Half an hour after the first refusal the steps stop being tried.
    await waitingSince(31);
    await admin.query('update public.template_run_jobs set next_attempt_at=now() where run_id=$1', [runId]);
    vi.mocked(fetch).mockClear();
    expect(await process()).toMatchObject({ claimed: 1, deferred: 0, completed: 1 });

    expect(providerCalls()).toBe(2);
    expect(await imageAttempts()).toEqual([
      [[0, 'failed', 'failed'], [1, 'failed', 'failed']],
      [[0, 'failed', 'failed'], [1, 'failed', 'failed']],
    ]);
    const run = (await admin.query('select status, error_message from public.template_runs where id=$1', [runId])).rows[0];
    expect(run).toEqual({ status: 'needs_attention', error_message: BUSY_MESSAGE });
    expect((await job()).status).toBe('succeeded');
    expect(await credits()).toBe(STARTING_CREDITS);
    // Nothing is left for a worker to pick up.
    expect(await process()).toMatchObject({ claimed: 0 });
  });

  it('a busy step that stopped being tried starts again with a fresh wait when the person retries it', async () => {
    providerIsBusy();
    await tick();
    await waitingSince(31);
    const stopped = await tick();
    expect(stopped.status).toBe('needs_attention');
    expect(shownImageSteps(stopped).map((step) => [step.status, step.canRetry])).toEqual([
      ['failed', true],
      ['failed', true],
    ]);

    for (const step of shownImageSteps(stopped)) {
      await retryTemplateRunStep({ adminClient: client, runId, stepId: step.id, userId });
    }
    const retried = await tick();

    // Still busy, and tried again rather than given up on at once.
    expect(providerCalls()).toBe(2);
    expect(shownImageSteps(retried).map((step) => step.status)).toEqual(['queued', 'queued']);
    expect(retried.status).toBe('queued');

    providerHasRoom();
    const started = await tick();
    expect(shownImageSteps(started).map((step) => step.status)).toEqual(['processing', 'processing']);
    expect(started.status).toBe('processing');
  });

  it('the steps after a step refused outright stay in line', async () => {
    providerRefuses();

    const run = await tick();

    expect(run.status).toBe('needs_attention');
    const steps = (await admin.query(
      'select kind, media_kind, status, error_message from public.template_run_steps where run_id=$1 order by kind desc, media_kind',
      [runId],
    )).rows;
    expect(steps).toEqual([
      expect.objectContaining({ kind: 'generation', media_kind: 'image', status: 'failed' }),
      expect.objectContaining({ kind: 'generation', media_kind: 'image', status: 'failed' }),
      { kind: 'generation', media_kind: 'video', status: 'queued', error_message: null },
      { kind: 'approval', media_kind: 'image', status: 'queued', error_message: null },
      { kind: 'approval', media_kind: 'image', status: 'queued', error_message: null },
    ]);
    expect(await credits()).toBe(STARTING_CREDITS);
  });
});
