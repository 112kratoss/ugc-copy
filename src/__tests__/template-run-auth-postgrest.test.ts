import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTemplateReadyStarterGraph } from '@/lib/workflow-canvas';
import { compileTemplateGraph } from '@/lib/template-graph-compiler';
import {
  createTemplateRunRouteHandlers, createTemplateRunCancelRouteHandlers,
  createTemplateRunStepRetryRouteHandlers, createTemplateRunStepApprovalRouteHandlers,
} from '@/lib/media-template-route-adapter-service';

vi.hoisted(() => { vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code'); });
const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
type Action = 'read' | 'cancel' | 'retry' | 'approve';
type Actor = 'owner' | 'foreign' | 'unsigned' | 'invalid';

// Native Request/Response handlers, actual Auth bearer verification, PostgREST
// and Storage. Deferred workers are captured, never executed or simulated.
describe.skipIf(!configPath || !connectionString)('template run identity through actual Auth and PostgREST', () => {
  let db: Client, admin: SupabaseClient;
  let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  const owners: string[] = [], tokens: string[] = [];
  let runId: string, templateId: string, approvalId: string, generationId: string;
  let deferred: Array<() => Promise<void> | void>;
  let externalRequests = 0;
  let faultPath: string | null = null;
  let faultHits = 0;
  const read = createTemplateRunRouteHandlers(), cancel = createTemplateRunCancelRouteHandlers();
  const scheduleAfter = (callback: () => Promise<void> | void) => { deferred.push(callback); };
  const retry = createTemplateRunStepRetryRouteHandlers({ scheduleAfter });
  const approve = createTemplateRunStepApprovalRouteHandlers({ scheduleAfter });
  const outputPath = () => owners[0] + '/template-run-auth.png';
  const invoke = (action: Action, actor: Actor = 'owner', stepId = approvalId) => {
    const token = actor === 'unsigned' ? null : actor === 'invalid' ? 'invalid-token' : tokens[actor === 'owner' ? 0 : 1];
    const request = new Request(`http://127.0.0.1/api/template-runs/${runId}`, {
      method: action === 'read' ? 'GET' : 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const context = { params: Promise.resolve({ id: runId, stepId }) };
    return action === 'read' ? read.GET(request, context) : action === 'cancel' ? cancel.POST(request, context)
      : action === 'retry' ? retry.POST(request, context) : approve.POST(request, context);
  };
  async function json(response: Response, status = 200) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    return response.json();
  }
  const snapshot = async () => ({
    run: (await db.query('select * from public.template_runs where id=$1', [runId])).rows,
    steps: (await db.query('select * from public.template_run_steps where run_id=$1 order by node_id,attempt', [runId])).rows,
    jobs: (await db.query('select * from public.template_run_jobs where run_id=$1', [runId])).rows,
  });
  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY);
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== new URL(config.API_URL).origin) {
        externalRequests++;
        throw new Error('External network forbidden in template identity controls');
      }
      if (url.pathname === faultPath) {
        faultHits++;
        return Promise.resolve(Response.json({ message: 'Controlled local backend outage' }, { status: 503 }));
      }
      return originalFetch(target, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    for (let index = 0; index < 2; index++) {
      const email = `template-run-auth-${randomUUID()}@example.invalid`, password = randomUUID()+'aZ7!';
      const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(made.error).toBeNull(); owners.push(made.data.user!.id);
      await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1', [owners[index]]);
      const user = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const signed = await user.auth.signInWithPassword({ email, password });
      expect(signed.error).toBeNull(); tokens.push(signed.data.session!.access_token);
    }
    expect((await admin.storage.from('generated_images').upload(outputPath(), new Blob([new Uint8Array(imageBytes)], { type: 'image/png' }), { contentType: 'image/png' })).error).toBeNull();
  });
  afterAll(async () => {
    try {
      if (owners.length) {
        expect((await admin.storage.from('generated_images').remove([outputPath()])).error).toBeNull();
        await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
        expect((await db.query('select id from auth.users where id=any($1::uuid[])', [owners])).rows).toEqual([]);
        expect((await db.query("select id from storage.objects where bucket_id='generated_images' and name=$1", [outputPath()])).rows).toEqual([]);
      }
    } finally { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });
  beforeEach(async () => {
    deferred = []; externalRequests = 0; faultPath = null; faultHits = 0;
    runId = randomUUID(); templateId = randomUUID();
    const graph = createTemplateReadyStarterGraph(), output = graph.nodes.find(node => node.type === 'video-generate')!;
    const compiled = compileTemplateGraph({ graph, outputNodeId: output.id, canvasRevision: 3, catalogRevision: null });
    await db.query("insert into public.templates(id,name,creator_user_id,status,is_active) values($1,'Identity fixture',$2,'draft',true)", [templateId, owners[0]]);
    await db.query(`insert into public.template_runs(id,template_id,user_id,graph_snapshot,graph_hash,input_manifest,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits,is_test)
      values($1,$2,$3,$4,$5,'[]',$6,$7,'awaiting_approval',$8,$8,true)`,
    [runId, templateId, owners[0], JSON.stringify({ ...compiled, templateTitle: 'Identity fixture' }), compiled.graphHash, compiled.outputNodeId, compiled.outputKind, compiled.estimatedTotalCredits]);
    const gate = graph.nodes.find(node => node.type === 'approval-gate')!;
    const source = graph.edges.find(edge => edge.target === gate.id)!.source;
    generationId = (await db.query(`insert into public.template_run_steps(run_id,node_id,kind,media_kind,label,status,output_url)
      values($1,$2,'generation','image','Image','succeeded',$3) returning id`, [runId, source, 'generated_images/'+outputPath()])).rows[0].id;
    approvalId = (await db.query(`insert into public.template_run_steps(run_id,node_id,kind,media_kind,label,status,output_url)
      values($1,$2,'approval','image','Approval','awaiting_approval',$3) returning id`, [runId, gate.id, 'generated_images/'+outputPath()])).rows[0].id;
  });
  afterEach(async () => {
    faultPath = null;
    // A denied request cannot secretly schedule paid work; successful mutations
    // only enqueue it. No test invokes a provider or consumes a credit hold.
    try {
      expect(externalRequests).toBe(0);
      expect((await db.query('select credits,promotional_credits from public.profiles where id=any($1::uuid[])', [owners])).rows).toEqual(owners.map(() => ({ credits: 500, promotional_credits: 0 })));
      expect((await db.query('select id from public.generations where user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
      expect((await db.query('select id from public.ai_usage_events where user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
    } finally {
      await db.query('delete from public.template_runs where id=$1', [runId]);
      await db.query('delete from public.templates where id=$1', [templateId]);
      await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [owners]);
      expect((await db.query(`select
        (select count(*) from public.template_runs where id=$1)::int as runs,
        (select count(*) from public.template_run_steps where run_id=$1)::int as steps,
        (select count(*) from public.template_run_jobs where run_id=$1)::int as jobs,
        (select count(*) from public.templates where id=$2)::int as templates,
        (select count(*) from public.backend_rate_limits where subject_key=any($3::text[]))::int as rates`, [runId, templateId, owners])).rows[0])
        .toEqual({ runs: 0, steps: 0, jobs: 0, templates: 0, rates: 0 });
    }
  });

  for (const action of ['read', 'cancel', 'retry', 'approve'] as const) {
    it.each(['foreign', 'unsigned', 'invalid'] as const)(`${action} denies %s identity without changing the run`, async actor => {
      const before = await snapshot();
      const result = await json(await invoke(action, actor), actor === 'foreign' ? 404 : 401);
      expect(result.code).toBe(actor === 'foreign' ? 'RUN_NOT_FOUND' : 'UNAUTHORIZED');
      expect(result.run).toBeUndefined(); expect(await snapshot()).toEqual(before); expect(deferred).toHaveLength(0);
    });
  }
  it('returns owned signed image bytes without mutating or executing the run', async () => {
    const before = await snapshot();
    const { run } = await json(await invoke('read'));
    expect(run.id).toBe(runId); expect(run.userId).toBe(owners[0]); expect(run.status).toBe('awaiting_approval');
    const step = run.steps.find((entry: { id: string }) => entry.id === approvalId);
    expect(step.outputUrl).toBeTruthy();
    const response = await fetch(step.outputUrl); expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(imageBytes);
    expect(await snapshot()).toEqual(before); expect(deferred).toHaveLength(0);
  });
  it('cancels owned waiting steps and repeats cancellation without changing state', async () => {
    expect((await json(await invoke('cancel'))).run.status).toBe('cancelled');
    const before = await snapshot();
    expect(before.steps.find(step => step.id === approvalId).status).toBe('cancelled');
    expect((await json(await invoke('cancel'))).run.status).toBe('cancelled');
    expect(await snapshot()).toEqual(before); expect(deferred).toHaveLength(0);
  });
  it('approves once through the atomic RPC and durably queues the owned run', async () => {
    expect((await json(await invoke('approve'))).run.status).toBe('processing');
    const before = await snapshot();
    expect(before.steps.find(step => step.id === approvalId)).toMatchObject({ status: 'succeeded', approved_at: expect.any(Date) });
    expect(before.jobs).toHaveLength(1); expect(deferred).toHaveLength(1);
    expect((await json(await invoke('approve'), 409)).code).toBe('APPROVAL_NOT_READY');
    expect(await snapshot()).toEqual(before); expect(deferred).toHaveLength(1);
  });
  it('retries a checkpoint once and replays without duplicate attempts or tickets', async () => {
    await json(await invoke('retry'));
    const before = await snapshot();
    expect(before.steps.filter(step => step.attempt === 1)).toHaveLength(2);
    expect(before.jobs).toHaveLength(1);
    await json(await invoke('retry'));
    expect(await snapshot()).toEqual(before); expect(deferred).toHaveLength(2);
  });
  it('retries a failed generation once through PostgREST and resumes its queue', async () => {
    await db.query("update public.template_run_steps set status='failed',output_url=null where id=$1", [generationId]);
    await db.query("update public.template_runs set status='needs_attention' where id=$1", [runId]);
    expect((await json(await invoke('retry', 'owner', generationId))).run.status).toBe('queued');
    await json(await invoke('retry', 'owner', generationId));
    const state = await snapshot();
    expect(state.steps.filter(step => step.attempt === 1)).toHaveLength(1);
    expect(state.jobs).toHaveLength(1); expect(deferred).toHaveLength(2);
  });
  it.each(['retry', 'approve'] as const)('%s rejects an unrelated step ID without writing or scheduling', async action => {
    const before = await snapshot();
    expect((await json(await invoke(action, 'owner', randomUUID()), 404)).code).toBe('STEP_NOT_FOUND');
    expect(await snapshot()).toEqual(before); expect(deferred).toHaveLength(0);
  });
  it.each(['retry', 'approve'] as const)('%s rejects a real step belonging to another user and run', async action => {
    const otherRun = randomUUID();
    await db.query(`insert into public.template_runs(id,template_id,user_id,graph_snapshot,graph_hash,input_manifest,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits,is_test)
      select $2,template_id,$3,graph_snapshot,graph_hash,input_manifest,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits,is_test from public.template_runs where id=$1`, [runId, otherRun, owners[1]]);
    try {
      const otherStep = (await db.query(`insert into public.template_run_steps(run_id,node_id,kind,media_kind,label,status,output_url)
        select $2,node_id,kind,media_kind,label,status,output_url from public.template_run_steps where id=$1 returning *`, [approvalId, otherRun])).rows[0];
      const before = await snapshot();
      expect((await json(await invoke(action, 'owner', otherStep.id), 404)).code).toBe('STEP_NOT_FOUND');
      expect(await snapshot()).toEqual(before); expect(deferred).toHaveLength(0);
      expect((await db.query('select * from public.template_run_steps where id=$1', [otherStep.id])).rows).toEqual([otherStep]);
      expect((await db.query('select id from public.template_run_jobs where run_id=$1', [otherRun])).rows).toEqual([]);
    } finally {
      await db.query('delete from public.template_runs where id=$1', [otherRun]);
      expect((await db.query('select id from public.template_run_steps where run_id=$1', [otherRun])).rows).toEqual([]);
    }
  });
  it.each([
    { action: 'read' as const, path: '/rest/v1/template_runs' },
    { action: 'approve' as const, path: '/rest/v1/rpc/approve_template_checkpoint' },
  ])('$action reports a backend outage and succeeds on a healthy retry', async ({ action, path }) => {
    const before = await snapshot(); faultPath = path;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await json(await invoke(action), 500)).code).toBe('INTERNAL_ERROR');
      expect(faultHits).toBeGreaterThan(0);
      expect(await snapshot()).toEqual(before); expect(deferred).toHaveLength(0);
    } finally { faultPath = null; quiet.mockRestore(); }
    await json(await invoke(action));
    expect(deferred).toHaveLength(action === 'approve' ? 1 : 0);
  }, 30000);
  it.each(['retry', 'approve'] as const)('%s refuses a cancelled run', async action => {
    await json(await invoke('cancel'));
    const before = await snapshot();
    expect((await json(await invoke(action), 409)).code).toBe('RUN_TERMINAL');
    expect(await snapshot()).toEqual(before); expect(deferred).toHaveLength(0);
  });
});
