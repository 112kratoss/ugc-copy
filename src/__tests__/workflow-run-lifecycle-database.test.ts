import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveWorkflowRunStep, executeWorkflowRun, getWorkflowRunDetails } from '@/lib/workflow-runner';
import { processWorkflowRunStepJobs } from '@/lib/workflow-run-jobs-processor';
import { createCanvasEdge, createWorkflowNode, normalizeWorkflowGraph, type WorkflowCanvasGraph, type ImageGenerateNodeData, type VideoGenerateNodeData } from '@/lib/workflow-canvas';

vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'local-canvas-audit');
  vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'local-canvas-provider-secret');
  vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'local-canvas-hmac');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://local-canvas.invalid');
  vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code');
});
const service = vi.hoisted(() => ({ client: null as unknown }));
// Keep the real graph resolver, model quote, node executor, start services,
// queue, and SQL billing. Only external provider/media boundaries are fixtures.
vi.mock('@/lib/provider-admission', async (original) => ({
  ...(await original<typeof import('@/lib/provider-admission')>()),
  admitProviderSubmission: vi.fn(), recordProviderSubmissionOutcome: vi.fn(),
}));
vi.mock('@/lib/generation-status-sync', () => ({ syncGenerationStatuses: async () => undefined }));
vi.mock('@/lib/server-helpers', async (original) => ({
  ...(await original<typeof import('@/lib/server-helpers')>()),
  createServiceClient: () => service.client,
  resolveOwnedStoredMediaUrl: async (_client: unknown, value: string) => value,
}));
vi.mock('@/lib/generation-input-media', async (original) => ({
  ...(await original<typeof import('@/lib/generation-input-media')>()),
  persistGenerationInputMedia: async () => undefined,
}));
const connectionString = process.env.SUPABASE_TEST_DB_URL;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** Functions that return rows and are read as a table. Every other one returns a single value. */
const ROW_FUNCTIONS = new Set(['initialize_workflow_canvas_run', 'claim_workflow_run_step_jobs', 'list_stalled_workflow_runs_without_live_jobs']);

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
function databaseClient(db: Client, afterWrite?: (table: string, updates: Record<string, unknown>) => void): SupabaseClient {
  return {
    from(table: string) {
      identifier(table);
      const filters: string[] = [];
      const values: unknown[] = [];
      const orders: string[] = [];
      let rowLimit: number | null = null;
      let insert: Record<string, unknown> | null = null;
      let update: Record<string, unknown> | null = null;

      const run = async () => {
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
          const rows = (await db.query(
            `update public.${table} set ${keys.map((key, index) => `${key}=$${values.length + index + 1}`).join(',')}${where} returning *`,
            [...values, ...Object.values(update).map(writable)],
          )).rows;
          afterWrite?.(table, update);
          return rows;
        }
        return (await db.query(
          `select * from public.${table}${where}${orders.length ? ` order by ${orders.join(',')}` : ''}${rowLimit === null ? '' : ` limit ${rowLimit}`}`,
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
        limit(value: number) {
          if (!Number.isInteger(value) || value < 1) throw new Error('Invalid limit');
          rowLimit = value;
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
        const { rows } = await db.query(
          ROW_FUNCTIONS.has(name) ? `select * from ${call}` : `select ${call} as result`,
          Object.values(args).map(writable),
        );
        const data = ROW_FUNCTIONS.has(name) ? rows : rows[0].result;
        return { data, error: null };
      } catch (error) {
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

describe.skipIf(!connectionString)('canvas execution and billing with real PostgreSQL', () => {
  let admin: Client;
  let worker: Client;
  let owner: Client;
  let client: SupabaseClient;
  let ownerClient: SupabaseClient;
  let userId: string;
  let canvasId: string;
  let runId: string;
  let graph: WorkflowCanvasGraph;
  let imageId: string;
  let approvalId: string;
  let videoId: string;
  const initialCredits = 500;

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = new Client({ connectionString, statement_timeout: 10_000 });
    worker = new Client({ connectionString, statement_timeout: 10_000 });
    owner = new Client({ connectionString, statement_timeout: 10_000 });
    await Promise.all([admin.connect(), worker.connect(), owner.connect()]);
    await worker.query('set role service_role');
    await owner.query('set role authenticated');
  });
  afterAll(async () => {
    await Promise.all([admin?.end(), worker?.end(), owner?.end()]);
  });
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 200, data: { taskId: `task-${randomUUID()}` } })));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    userId = randomUUID();
    canvasId = randomUUID();
    runId = '';
    await admin.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated',now())", [userId, `${userId}@example.invalid`]);
    await admin.query('update public.profiles set credits=$2,promotional_credits=0 where id=$1', [userId, initialCredits]);
    await admin.query('insert into public.mobile_notification_preferences(user_id,push_enabled) values($1,false)', [userId]);
    await owner.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
    const prompt = createWorkflowNode('text-input', { x: 0, y: 0 });
    const image = createWorkflowNode('image-generate', { x: 200, y: 0 });
    const approval = createWorkflowNode('approval-gate', { x: 400, y: 0 });
    const video = createWorkflowNode('video-generate', { x: 600, y: 0 });
    imageId = image.id; approvalId = approval.id; videoId = video.id;
    graph = normalizeWorkflowGraph({
      nodes: [
        { ...prompt, data: { ...prompt.data, text: 'A ceramic mug on a linen cloth' } },
        { ...image, data: { ...(image.data as ImageGenerateNodeData), model: 'nano-banana-2' } },
        { ...approval, data: { ...approval.data, mediaKind: 'image' } },
        { ...video, data: { ...(video.data as VideoGenerateNodeData), model: 'kling-3.0-video', duration: 5, mode: 'std' } },
      ],
      edges: [
        createCanvasEdge(prompt.id, 'text', image.id, 'prompt'),
        createCanvasEdge(prompt.id, 'text', video.id, 'prompt'),
        createCanvasEdge(image.id, 'image', approval.id, 'image'),
        createCanvasEdge(approval.id, 'image', video.id, 'start-frame'),
      ],
    });
    await admin.query('insert into public.workflow_canvases(id,user_id,title,graph) values($1,$2,$3,$4)', [canvasId, userId, 'Canvas audit fixture', JSON.stringify(graph)]);
    client = databaseClient(worker);
    ownerClient = databaseClient(owner);
    service.client = client;
  });
  afterEach(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks(); service.client = null;
    await admin.query('delete from public.workflow_canvases where id=$1', [canvasId]);
    await admin.query('delete from public.generations where user_id=$1', [userId]);
    await admin.query('delete from auth.users where id=$1', [userId]);
  });
  async function start(key = 'canvas-fixture') {
    const result = await executeWorkflowRun({ supabase: client, userId, canvasId, graph, startNodeId: imageId, mode: 'branch', idempotencyKey: key });
    runId = result.runId;
    return result;
  }
  async function tick() {
    await admin.query("update public.workflow_run_step_jobs set next_attempt_at=now()-interval '1 second' where run_id=$1 and status='pending'", [runId]);
    return processWorkflowRunStepJobs({ supabase: client, lockedBy: randomUUID(), limit: 10, concurrency: 1 });
  }
  const details = () => getWorkflowRunDetails({ supabase: ownerClient, userId, canvasId, runId });
  async function rows() {
    return (await admin.query('select id,prediction_id,status,cost,refunded from public.generations where user_id=$1 order by created_at,id', [userId])).rows as Array<{ id: string; prediction_id: string; status: string; cost: number; refunded: boolean }>;
  }
  async function balance() {
    return (await admin.query('select credits from public.profiles where id=$1', [userId])).rows[0].credits;
  }
  async function settle(generation: Awaited<ReturnType<typeof rows>>[number], succeeded: boolean) {
    const result = await client.rpc(succeeded ? 'settle_generation_succeeded' : 'settle_generation_failed', succeeded ? {
      p_prediction_id: generation.prediction_id,
      p_output_url: `generated_images/${userId}/${generation.id}.png`,
    } : { p_prediction_id: generation.prediction_id, p_error_message: 'fixture provider failure' });
    expect(result.error).toBeNull();
  }
  async function approve() {
    const gate = (await details()).steps.find(step => step.node_id === approvalId)!;
    return approveWorkflowRunStep({ ownerSupabase: ownerClient, mutationSupabase: client, userId, canvasId, runId, stepId: gate.id });
  }
  async function reachApproval() {
    await start();
    expect((await tick()).deferred).toBe(1);
    const generations = await rows();
    expect(generations).toHaveLength(1);
    await settle(generations[0], true);
    await tick();
    expect((await details()).status).toBe('awaiting_approval');
    return generations[0];
  }

  it('starts one durable run, executes real nodes through approval and video, and settles duplicate callbacks once', async () => {
    const first = await start();
    expect((await start()).reused).toBe(true);
    expect(runId).toBe(first.runId);
    expect(await rows()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect((await tick()).deferred).toBe(1);
    const [image] = await rows();
    expect(image.status).toBe('processing');
    expect(image.cost).toBe(8);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).input.prompt).toBe('A ceramic mug on a linen cloth');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await balance()).toBe(initialCredits - image.cost);
    await settle(image, true); await settle(image, true);
    await tick();
    expect((await details()).status).toBe('awaiting_approval');
    expect(await rows()).toHaveLength(1);
    await approve();
    await tick();
    const generations = await rows();
    expect(generations).toHaveLength(2);
    const video = generations.find(row => row.id !== image.id)!;
    expect(video.status).toBe('processing');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)).input).toMatchObject({
      prompt: 'A ceramic mug on a linen cloth',
      image_urls: [`generated_images/${userId}/${image.id}.png`],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const output = (await details()).steps.find(step => step.node_id === videoId)!;
    expect(output.generation_id).toBe(video.id);
    await settle(video, true); await settle(video, true);
    await tick();
    expect((await details()).status).toBe('succeeded');
    expect(await balance()).toBe(initialCredits - image.cost - video.cost);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(2);
  });

  it('refunds a failed downstream video once while retaining the successful image charge', async () => {
    const image = await reachApproval();
    await approve(); await tick();
    const generations = await rows();
    expect(generations).toHaveLength(2);
    const video = generations.find(row => row.id !== image.id)!;
    await settle(video, false); await settle(video, false);
    await tick();
    expect((await details()).status).toBe('failed');
    expect(await balance()).toBe(initialCredits - image.cost);
    expect((await rows()).find(row => row.id === video.id)?.refunded).toBe(true);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('blocks downstream work after source failure and refunds only the source hold', async () => {
    await start(); await tick();
    const [image] = await rows();
    await settle(image, false); await settle(image, false);
    await tick();
    const run = await details();
    expect(run.status).toBe('failed');
    expect(run.steps.find(step => step.node_id === videoId)?.status).toBe('blocked');
    expect(run.steps.find(step => step.node_id === approvalId)?.status).toBe('blocked');
    expect(await balance()).toBe(initialCredits);
    expect(await rows()).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recovers a rejected step-link write without failing or charging the accepted generation again', async () => {
    await start();
    // Fail at the actual persistence boundary after provider acceptance and
    // durable task attachment. Remove only this fixture's trigger in finally.
    await admin.query(`create function public.audit_canvas_link_failure() returns trigger language plpgsql as $$
      begin
        if new.run_id = '${runId}'::uuid and new.generation_id is not null and old.generation_id is null then
          raise exception 'audit step link write rejected';
        end if;
        return new;
      end $$`);
    await admin.query(`create trigger audit_canvas_link_failure before update on public.workflow_canvas_run_steps
      for each row execute function public.audit_canvas_link_failure()`);
    try {
      const first = await tick();
      expect(first.retried).toBe(1);
      const generations = await rows();
      expect(generations).toHaveLength(1);
      expect(generations[0].status).toBe('processing');
      expect(await balance()).toBe(initialCredits - generations[0].cost);
      expect((await details()).steps.find(step => step.node_id === imageId)?.status).toBe('queued');
    } finally {
      await admin.query('drop trigger audit_canvas_link_failure on public.workflow_canvas_run_steps');
      await admin.query('drop function public.audit_canvas_link_failure()');
    }
    const before = await rows();
    expect((await tick()).deferred).toBe(1);
    expect(await rows()).toEqual(before);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await details()).steps.find(step => step.node_id === imageId)?.generation_id).toBe(before[0].id);
    await settle(before[0], true);
    await tick();
    expect((await details()).status).toBe('awaiting_approval');
  });

  it('recovers a committed step-link write whose acknowledgement was lost', async () => {
    await start();
    let lost = false;
    client = databaseClient(worker, (table, updates) => {
      if (!lost && table === 'workflow_canvas_run_steps' && updates.generation_id) {
        lost = true;
        throw new Error('audit committed write reply lost');
      }
    });
    service.client = client;
    expect((await tick()).retried).toBe(1);
    expect(lost).toBe(true);
    const [image] = await rows();
    // Independent admin connection confirms the write really committed.
    const saved = (await admin.query('select status,generation_id from public.workflow_canvas_run_steps where run_id=$1 and node_id=$2', [runId, imageId])).rows[0];
    expect(saved).toEqual({ status: 'processing', generation_id: image.id });
    expect((await tick()).deferred).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
    expect(await balance()).toBe(initialCredits - image.cost);
    await settle(image, true); await tick();
    expect((await details()).status).toBe('awaiting_approval');
  });

  it('retries provider backpressure without spending a queue attempt or retaining the refused hold', async () => {
    await start();
    vi.mocked(fetch).mockImplementation(async () => json({ msg: 'Too many requests' }, 429));
    expect((await tick()).deferred).toBe(1);
    expect(await balance()).toBe(initialCredits);
    expect((await details()).steps.find(step => step.node_id === imageId)?.status).toBe('queued');
    expect((await rows()).every(row => row.refunded)).toBe(true);
    expect((await admin.query('select attempt from public.workflow_run_step_jobs where run_id=$1', [runId])).rows).toEqual([{ attempt: 1 }]);
    vi.mocked(fetch).mockImplementation(async () => json({ code: 200, data: { taskId: `task-${randomUUID()}` } }));
    expect((await tick()).deferred).toBe(1);
    const active = (await rows()).filter(row => !row.refunded);
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('processing');
    expect(await balance()).toBe(initialCredits - active[0].cost);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps GET read-only while completed source state awaits the queue worker', async () => {
    await start(); await tick();
    const [image] = await rows();
    await settle(image, true);
    const snapshot = async () => (await admin.query(`select row_to_json(r) as run,
      (select jsonb_agg(to_jsonb(s) order by s.id) from public.workflow_canvas_run_steps s where s.run_id=r.id) as steps,
      (select jsonb_agg(to_jsonb(j) order by j.id) from public.workflow_run_step_jobs j where j.run_id=r.id) as jobs
      from public.workflow_canvas_runs r where r.id=$1`, [runId])).rows;
    const before = await snapshot();
    await details(); await details();
    expect(await snapshot()).toEqual(before);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await balance()).toBe(initialCredits - image.cost);
  });
});
