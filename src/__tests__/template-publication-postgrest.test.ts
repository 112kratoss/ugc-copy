import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTemplateReadyStarterGraph } from '@/lib/workflow-canvas';
import { compileTemplateGraph } from '@/lib/template-graph-compiler';
import { createMediaTemplatesRouteHandlers, createOwnedMediaTemplatesRouteHandlers, createMediaTemplateDetailRouteHandlers, createMediaTemplatePublishRouteHandlers, createMediaTemplateDisableRouteHandlers, createMediaTemplateValidationRouteHandlers } from '@/lib/media-template-route-adapter-service';

vi.hoisted(() => { vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code'); });
const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');

describe.skipIf(!configPath || !connectionString)('template publication with actual Auth, Storage and PostgREST', () => {
  let db: Client, admin: SupabaseClient;
  let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  let owners: string[], tokens: string[], users: SupabaseClient[];
  let canvasId: string, templateId: string, runId: string, sourcePath: string;
  let compiled: ReturnType<typeof compileTemplateGraph>;
  let fault: 'timeout' | 'malformed' | 'missing-inserted' | null;
  let faultApplied: boolean;
  let activationBarrier: (() => Promise<void>) | null;
  const collection = createMediaTemplatesRouteHandlers(), detail = createMediaTemplateDetailRouteHandlers();
  const publisher = createMediaTemplatePublishRouteHandlers(), disable = createMediaTemplateDisableRouteHandlers();
  const mine = createOwnedMediaTemplatesRouteHandlers(), validation = createMediaTemplateValidationRouteHandlers();
  const context = () => ({ params: Promise.resolve({ id: templateId }) });
  const request = (method: string, body?: unknown, actor: number | null = 0, url = '/api/templates') => new Request('http://127.0.0.1' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(actor === null ? {} : { Authorization: `Bearer ${tokens[actor]}` }) },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const publishBody = () => ({ rightsConfirmed: true, expectedRevision: 3, graphHash: compiled.graphHash, testRunId: runId, outputNodeId: compiled.outputNodeId });
  const publish = (body: unknown = publishBody(), actor: number | null = 0) => publisher.POST(request('POST', body, actor), context());
  async function json(response: Response, status = 200, privateResponse = true) {
    expect(response.status).toBe(status);
    if (privateResponse) { expect(response.headers.get('cache-control')).toContain('private'); expect(response.headers.get('cache-control')).toContain('no-store'); }
    return response.json();
  }
  const versions = async () => (await db.query('select id,demo_output_url,graph_hash,source_canvas_revision from public.template_versions where template_id=$1 order by version_number', [templateId])).rows;
  const objects = async () => (await db.query("select name from storage.objects where bucket_id='template_assets' and name like $1 order by name", [templateId+'/%'])).rows.map(row => row.name as string);
  const template = async () => (await db.query('select status,is_active,active_version_id,thumbnail_url from public.templates where id=$1', [templateId])).rows[0];
  const upload = async (owner = 0) => {
    const path = owners[owner] + '/template-publication-demo.png';
    expect((await admin.storage.from('generated_images').upload(path, new Blob([new Uint8Array(imageBytes)], { type: 'image/png' }), { upsert: true, contentType: 'image/png' })).error).toBeNull();
    return path;
  };
  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY);
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== new URL(config.API_URL).origin) throw new Error('External network forbidden in local template publication controls');
      if (url.pathname === '/rest/v1/rpc/activate_template_version') await activationBarrier?.();
      const response = await originalFetch(target, init);
      if (fault && !faultApplied && url.pathname === '/rest/v1/rpc/activate_template_version' && response.ok) {
        expect(await versions()).toHaveLength(1); expect((await template()).status).toBe('active');
        await response.text(); faultApplied = true;
        return new Response(fault === 'malformed' ? '{' : fault === 'missing-inserted' ? '{}' : JSON.stringify({ message: 'Controlled committed activation reply loss' }), {
          status: fault === 'timeout' ? 504 : 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return response;
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    owners = []; tokens = []; users = []; fault = null; faultApplied = false; activationBarrier = null;
    canvasId = randomUUID(); runId = randomUUID(); templateId = '';
    for (let index = 0; index < 2; index++) {
      const email = `template-publication-audit-${randomUUID()}@example.invalid`, password = randomUUID()+'aZ7!';
      const made = await admin.auth.admin.createUser({ email, password, email_confirm: true }); expect(made.error).toBeNull(); owners.push(made.data.user!.id);
      await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1', [owners[index]]);
      const user = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const signed = await user.auth.signInWithPassword({ email, password }); expect(signed.error).toBeNull(); tokens.push(signed.data.session!.access_token); users.push(user);
    }
    const graph = createTemplateReadyStarterGraph(), output = graph.nodes.find(node => node.type === 'image-generate')!;
    compiled = compileTemplateGraph({ graph, outputNodeId: output.id, canvasRevision: 3, catalogRevision: null });
    await db.query("insert into public.workflow_canvases(id,user_id,title,graph,revision) values($1,$2,'Publication fixture',$3,3)", [canvasId, owners[0], JSON.stringify(graph)]);
    const created = await json(await collection.POST(request('POST', { sourceCanvasId: canvasId, name: 'Publication '+canvasId, outputNodeId: output.id })), 201);
    templateId = created.template.id;
    sourcePath = await upload();
    await db.query(`insert into public.template_runs(id,template_id,user_id,graph_snapshot,graph_hash,input_manifest,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits,is_test,source_canvas_revision,catalog_revision,result_url)
      values($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',$9,0,true,3,null,$10)`, [runId, templateId, owners[0], JSON.stringify(compiled), compiled.graphHash, JSON.stringify(compiled.inputSlots), compiled.outputNodeId, compiled.outputKind, compiled.estimatedTotalCredits, 'generated_images/'+sourcePath]);
  });
  afterEach(async () => {
    fault = null;
    expect((await db.query('select credits,promotional_credits from public.profiles where id=any($1::uuid[])', [owners])).rows).toEqual(owners.map(() => ({ credits: 500, promotional_credits: 0 })));
    expect((await db.query('select id from public.ai_usage_events where user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
    if (templateId) {
      const copied = await objects(); if (copied.length) expect((await admin.storage.from('template_assets').remove(copied)).error).toBeNull();
      expect(await objects()).toEqual([]);
    }
    expect((await admin.storage.from('generated_images').remove(owners.map(owner => owner+'/template-publication-demo.png'))).error).toBeNull();
    await db.query('delete from public.template_runs where user_id=any($1::uuid[])', [owners]);
    // Immutable publication rows have no product deletion path. Only exact owned
    // local fixtures are removed, with trigger bypass scoped to this transaction.
    await db.query('begin');
    try {
      await db.query('set local session_replication_role=replica');
      await db.query('delete from public.template_versions where template_id in (select id from public.templates where creator_user_id=any($1::uuid[]))', [owners]);
      await db.query('delete from public.templates where creator_user_id=any($1::uuid[])', [owners]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
    await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [owners]);
    expect((await db.query(`select
      (select count(*) from auth.users where id=any($1::uuid[]))::int as users,
      (select count(*) from public.profiles where id=any($1::uuid[]))::int as profiles,
      (select count(*) from public.templates where creator_user_id=any($1::uuid[]))::int as templates,
      (select count(*) from public.template_versions where template_id=$2::uuid)::int as versions,
      (select count(*) from public.template_runs where user_id=any($1::uuid[]))::int as runs,
      (select count(*) from public.workflow_canvases where user_id=any($1::uuid[]))::int as canvases,
      (select count(*) from public.backend_rate_limits where subject_key=any($1::text[]))::int as rates,
      (select count(*) from storage.objects where (bucket_id='template_assets' and name like $2::text||'/%') or (bucket_id='generated_images' and name=any($3::text[])))::int as objects`, [owners, templateId || null, owners.map(owner => owner+'/template-publication-demo.png')])).rows[0])
      .toEqual({ users: 0, profiles: 0, templates: 0, versions: 0, runs: 0, canvases: 0, rates: 0, objects: 0 });
  });

  it('keeps drafts private and reuses the owned canvas draft across create/update', async () => {
    expect((await json(await mine.GET(request('GET')))).templates.map((entry: { id: string }) => entry.id)).toEqual([templateId]);
    expect((await json(await collection.GET(request('GET', undefined, 0, '/api/templates?mine=1')))).templates.map((entry: { id: string }) => entry.id)).toEqual([templateId]);
    await json(await detail.GET(request('GET', undefined, 1), context()), 404); await json(await detail.GET(request('GET', undefined, null), context()), 404);
    const updated = await json(await detail.PATCH(request('PATCH', { name: 'Edited '+canvasId }), context())); expect(updated.template.name).toBe('Edited '+canvasId);
    const duplicate = await json(await collection.POST(request('POST', { sourceCanvasId: canvasId, name: 'Reused '+canvasId })), 201); expect(duplicate.template.id).toBe(templateId);
    expect((await db.query('select id from public.templates where creator_user_id=$1', [owners[0]])).rows).toHaveLength(1);
  });

  it('denies foreign publication, update, disable and source ownership without copies', async () => {
    const before = await template();
    await json(await detail.PATCH(request('PATCH', { name: 'foreign' }, 1), context()), 404);
    await json(await publish(publishBody(), 1), 404); await json(await disable.POST(request('POST', {}, 1), context()), 404);
    await json(await collection.POST(request('POST', { sourceCanvasId: canvasId }, 1)), 404);
    expect(await template()).toEqual(before); expect(await versions()).toEqual([]); expect(await objects()).toEqual([]);
  });

  it('rejects unsigned authoring and publication handlers before side effects', async () => {
    const responses = [await collection.POST(request('POST', {}, null)), await mine.GET(request('GET', undefined, null)), await detail.PATCH(request('PATCH', {}, null), context()), await publish(publishBody(), null), await disable.POST(request('POST', {}, null), context()), await validation.POST(request('POST', {}, null))];
    for (const response of responses) await json(response, 401);
    expect(await versions()).toEqual([]); expect(await objects()).toEqual([]);
  });

  it.each(['rights', 'revision', 'hash'] as const)('rejects invalid publication %s before Storage copies', async field => {
    const body = { ...publishBody(), ...(field==='rights'?{rightsConfirmed:false}:field==='revision'?{expectedRevision:2}:{graphHash:'wrong-hash'}) };
    await json(await publish(body), field==='rights'?400:409);
    expect(await versions()).toEqual([]); expect(await objects()).toEqual([]);
  });

  it.each(['failed', 'not-test'] as const)('requires an exact successful test: %s', async mode => {
    await db.query(mode==='failed'?"update public.template_runs set status='failed' where id=$1":"update public.template_runs set is_test=false where id=$1", [runId]);
    expect(await json(await publish(), 409)).toMatchObject({ code: 'TEST_REQUIRED' }); expect(await objects()).toEqual([]); expect(await versions()).toEqual([]);
  });

  it('publishes one immutable snapshot and serves a public projection with real signed demo bytes', async () => {
    expect((await json(await publish())).template.status).toBe('active');
    const [version] = await versions(); expect(version).toMatchObject({ graph_hash: compiled.graphHash, source_canvas_revision: 3 });
    expect(await objects()).toEqual([version.demo_output_url.replace('template_assets/', '')]);
    const publicTemplate = (await json(await detail.GET(request('GET', undefined, null), context()))).template;
    expect(publicTemplate).not.toHaveProperty('authoring');
    const bytes = await fetch(publicTemplate.thumbnailUrl); expect(bytes.status).toBe(200); expect(Buffer.from(await bytes.arrayBuffer())).toEqual(imageBytes);
    const denied = await users[1].rpc('activate_template_version', {
      p_version_id: randomUUID(), p_template_id: templateId, p_creator_id: owners[0],
      p_source_canvas_id: canvasId, p_source_canvas_revision: 3, p_graph_snapshot: compiled,
      p_graph_hash: compiled.graphHash, p_snapshot_hash: 'fixture', p_output_node_id: compiled.outputNodeId,
      p_output_kind: compiled.outputKind, p_input_manifest: compiled.inputSlots,
      p_estimated_total_credits: compiled.estimatedTotalCredits, p_catalog_revision: null,
      p_demo_output_url: version.demo_output_url, p_rights_confirmed_at: new Date().toISOString(),
    });
    expect(denied.error?.code).toBe('42501');
    await json(await publish()); expect(await versions()).toHaveLength(1); expect(await objects()).toHaveLength(1);
  });

  it.each(['timeout', 'malformed', 'missing-inserted'] as const)('preserves committed version assets after %s activation reply loss', async mode => {
    fault = mode; await json(await publish(), 500); expect(faultApplied).toBe(true);
    const [version] = await versions(); expect(await objects()).toEqual([version.demo_output_url.replace('template_assets/', '')]);
    const publicTemplate = (await json(await detail.GET(request('GET', undefined, null), context()))).template;
    expect(publicTemplate.status).toBe('active'); expect((await fetch(publicTemplate.thumbnailUrl)).status).toBe(200);
    fault = null; await json(await publish()); expect(await versions()).toEqual([version]); expect(await objects()).toHaveLength(1);
  });

  it('cleans copied assets after an actual constraint rejection and permits retry', async () => {
    await db.query(`create function public.audit_template_activation_failure() returns trigger language plpgsql as $$ begin if new.template_id='${templateId}'::uuid then raise exception 'Audit activation rejected' using errcode='23514'; end if; return new; end $$`);
    await db.query('create trigger audit_template_activation_failure before insert on public.template_versions for each row execute function public.audit_template_activation_failure()');
    try { await json(await publish(), 500); expect(await versions()).toEqual([]); expect(await objects()).toEqual([]); expect((await template()).status).toBe('draft'); }
    finally { await db.query('drop trigger audit_template_activation_failure on public.template_versions'); await db.query('drop function public.audit_template_activation_failure()'); }
    await json(await publish()); expect(await versions()).toHaveLength(1); expect(await objects()).toHaveLength(1);
  });

  it('rejects missing or foreign demo sources without activating a version', async () => {
    expect((await admin.storage.from('generated_images').remove([sourcePath])).error).toBeNull();
    await json(await publish(), 400); expect(await versions()).toEqual([]); expect(await objects()).toEqual([]);
    const foreign = await upload(1); await db.query('update public.template_runs set result_url=$2 where id=$1', [runId, 'generated_images/'+foreign]);
    expect(await json(await publish(), 400)).toMatchObject({ code:'TEMPLATE_ASSET_NOT_OWNED' }); expect(await versions()).toEqual([]); expect(await objects()).toEqual([]);
  });

  it('serializes concurrent publication into one snapshot and removes the losing copies', async () => {
    let entered = 0, release!: () => void, rejectBarrier!: (error: Error) => void;
    const barrier = new Promise<void>((resolve, reject) => { release = resolve; rejectBarrier = reject; });
    const timer = setTimeout(() => rejectBarrier(new Error('Both publication requests did not reach activation')), 5000);
    activationBarrier = async () => {
      entered += 1;
      if (entered === 2) { expect(await versions()).toEqual([]); expect(await objects()).toHaveLength(2); release(); }
      await barrier;
    };
    try {
      const responses = await Promise.all([publish(), publish()]); for (const response of responses) await json(response);
      expect(entered).toBe(2); expect(await versions()).toHaveLength(1); expect(await objects()).toHaveLength(1);
    } finally { clearTimeout(timer); release(); activationBarrier = null; }
  }, 15000);

  it('disables public discovery while preserving the immutable version and owned view', async () => {
    await json(await publish()); const version = (await versions())[0], beforeObjects = await objects();
    expect((await json(await disable.POST(request('POST'), context()))).template.status).toBe('disabled');
    await json(await detail.GET(request('GET', undefined, null), context()), 404); await json(await detail.GET(request('GET', undefined, 1), context()), 404);
    expect((await json(await detail.GET(request('GET'), context()))).template.status).toBe('disabled');
    expect(await versions()).toEqual([version]); expect(await objects()).toEqual(beforeObjects);
  });
});
