import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterGraph } from '@/lib/workflow-canvas';
import { createWorkflowCanvasCollectionRouteHandlers } from '@/lib/workflow-canvas-collection-route-adapter-service';
import { getWorkflowCanvasRouteResponse, patchWorkflowCanvasRouteResponse, deleteWorkflowCanvasRouteResponse } from '@/lib/workflow-canvas-route-adapter-service';
import { getWorkflowCanvasHistoryRouteResponse, publishWorkflowCanvasRouteResponse, restoreWorkflowCanvasHistoryRouteResponse } from '@/lib/workflow-canvas-lifecycle-route-adapter-service';
import { postWorkflowShareCreateRouteResponse, getWorkflowSharePreviewRouteResponse, postWorkflowShareImportRouteResponse } from '@/lib/workflow-share-route-adapter-service';
import { postWorkflowBlueprintRouteResponse } from '@/lib/workflow-blueprint-route-adapter-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('workflow authoring handlers with real Auth and PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  let owners: string[];
  let tokens: string[];
  let users: SupabaseClient[];
  const collection = createWorkflowCanvasCollectionRouteHandlers();
  const planner = { productName: 'Ceramic mug', audience: 'Home cooks', primaryMessage: 'Keep drinks warm' };
  const request = (method: string, body?: unknown, actor: number | null = 0, raw?: string) => new Request('http://127.0.0.1/api/workflow-canvases', {
    method, headers: { 'Content-Type': 'application/json', ...(actor === null ? {} : { Authorization: `Bearer ${tokens[actor]}` }) },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ?? JSON.stringify(body ?? {}) }),
  });
  async function json(response: Response, status = 200) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    return await response.json();
  }
  async function create(actor = 0) {
    const result = await json(await collection.POST(request('POST', { title: 'Audit canvas', graph: createStarterGraph() }, actor)));
    return result.canvas as { id: string; revision: number; title: string; status: string };
  }
  const row = async (id: string) => (await db.query('select title,graph,revision,status,published_at from public.workflow_canvases where id=$1', [id])).rows[0];

  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['127.0.0.1', 'localhost']).toContain(new URL(config.API_URL).hostname);
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    // Set only this isolated test process; never consume .env.local.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY);
    vi.stubEnv('KIE_AI_API_KEY', '');
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== new URL(config.API_URL).origin) throw new Error('External network access forbidden in local authoring controls');
      return originalFetch(input, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    owners = []; tokens = []; users = [];
    for (let index = 0; index < 2; index++) {
      const email = `workflow-audit-${randomUUID()}@example.invalid`, password = randomUUID() + 'aZ7!';
      const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(made.error).toBeNull();
      owners.push(made.data.user!.id);
      await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1', [owners[index]]);
      const user = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const signed = await user.auth.signInWithPassword({ email, password });
      expect(signed.error).toBeNull();
      tokens.push(signed.data.session!.access_token); users.push(user);
    }
  });
  afterEach(async () => {
    expect((await db.query('select credits,promotional_credits from public.profiles where id=any($1::uuid[])', [owners])).rows)
      .toEqual(owners.map(() => ({ credits: 500, promotional_credits: 0 })));
    expect((await db.query('select id from public.ai_usage_events where user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
    await db.query('delete from public.workflow_shares where owner_user_id=any($1::uuid[])', [owners]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
    await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [owners]);
    expect((await db.query(`select
      (select count(*) from auth.users where id=any($1::uuid[]))::int as users,
      (select count(*) from public.profiles where id=any($1::uuid[]))::int as profiles,
      (select count(*) from public.workflow_canvases where user_id=any($1::uuid[]))::int as canvases,
      (select count(*) from public.workflow_canvas_history where user_id=any($1::uuid[]))::int as history,
      (select count(*) from public.workflow_shares where owner_user_id=any($1::uuid[]))::int as shares,
      (select count(*) from public.ai_usage_events where user_id=any($1::uuid[]))::int as usage`, [owners])).rows[0])
      .toEqual({ users: 0, profiles: 0, canvases: 0, history: 0, shares: 0, usage: 0 });
  });

  it('creates, lists, reads, publishes, restores history and deletes only the owned canvas', async () => {
    const canvas = await create();
    expect((await json(await collection.GET(request('GET')))).canvases.map((c: { id: string }) => c.id)).toEqual([canvas.id]);
    expect((await json(await getWorkflowCanvasRouteResponse({ request: request('GET'), canvasId: canvas.id }))).canvas.id).toBe(canvas.id);
    const saved = await json(await patchWorkflowCanvasRouteResponse({ request: request('PATCH', { title: 'Edited canvas', baseRevision: canvas.revision }), canvasId: canvas.id }));
    expect(saved.canvas.title).toBe('Edited canvas');
    const published = await json(await publishWorkflowCanvasRouteResponse({ request: request('POST'), canvasId: canvas.id }));
    expect(published.canvas.status).toBe('published');
    const history = (await json(await getWorkflowCanvasHistoryRouteResponse({ request: request('GET'), canvasId: canvas.id }))).history;
    expect(history.length).toBeGreaterThan(0);
    const restored = await json(await restoreWorkflowCanvasHistoryRouteResponse({ request: request('POST'), canvasId: canvas.id, entryId: history[0].id }));
    expect(restored.canvas.revision).toBeGreaterThan(published.canvas.revision);
    expect((await json(await deleteWorkflowCanvasRouteResponse({ request: request('DELETE'), canvasId: canvas.id }))).success).toBe(true);
    await json(await getWorkflowCanvasRouteResponse({ request: request('GET'), canvasId: canvas.id }), 404);
    expect(await row(canvas.id)).toBeUndefined();
  });

  it('hides foreign reads/history and rejects foreign mutations without changing the owner row', async () => {
    const canvas = await create(), before = await row(canvas.id);
    expect((await json(await collection.GET(request('GET', undefined, 1)))).canvases).toEqual([]);
    await json(await getWorkflowCanvasRouteResponse({ request: request('GET', undefined, 1), canvasId: canvas.id }), 404);
    expect((await json(await getWorkflowCanvasHistoryRouteResponse({ request: request('GET', undefined, 1), canvasId: canvas.id }))).history).toEqual([]);
    await json(await patchWorkflowCanvasRouteResponse({ request: request('PATCH', { title: 'foreign' }, 1), canvasId: canvas.id }), 404);
    await json(await publishWorkflowCanvasRouteResponse({ request: request('POST', {}, 1), canvasId: canvas.id }), 404);
    await json(await deleteWorkflowCanvasRouteResponse({ request: request('DELETE', {}, 1), canvasId: canvas.id }));
    expect(await row(canvas.id)).toEqual(before);
    expect((await users[1].from('workflow_canvases').select('id').eq('id', canvas.id)).data).toEqual([]);
    const direct = await users[1].from('workflow_canvases').update({ title: 'direct foreign' }).eq('id', canvas.id).select('id');
    expect(direct.error).toBeNull(); expect(direct.data).toEqual([]);
    expect(await row(canvas.id)).toEqual(before);
  });

  it('rejects unauthenticated read/write handlers before interpreting invalid bodies', async () => {
    const id = randomUUID();
    const responses = [
      await collection.GET(request('GET', undefined, null)),
      await collection.POST(request('POST', undefined, null, 'null')),
      await getWorkflowCanvasRouteResponse({ request: request('GET', undefined, null), canvasId: id }),
      await patchWorkflowCanvasRouteResponse({ request: request('PATCH', undefined, null, 'null'), canvasId: id }),
      await deleteWorkflowCanvasRouteResponse({ request: request('DELETE', undefined, null), canvasId: id }),
      await getWorkflowCanvasHistoryRouteResponse({ request: request('GET', undefined, null), canvasId: id }),
    ];
    for (const response of responses) expect(await json(response, 401)).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('creates an immutable share snapshot, previews it for another owner and imports one private copy', async () => {
    const canvas = await create();
    const share = (await json(await postWorkflowShareCreateRouteResponse({ request: request('POST'), context: { params: Promise.resolve({ id: canvas.id }) } }))).share;
    const preview = await json(await getWorkflowSharePreviewRouteResponse({ request: request('GET', undefined, 1), context: { params: Promise.resolve({ shareId: share.id }) } }));
    expect(preview.share.sourceCanvasId).toBe(canvas.id);
    const imported = await json(await postWorkflowShareImportRouteResponse({ request: request('POST', {}, 1), context: { params: Promise.resolve({ shareId: share.id }) } }));
    expect(imported.canvas.id).not.toBe(canvas.id);
    expect((await db.query('select user_id,status from public.workflow_canvases where id=$1', [imported.canvas.id])).rows)
      .toEqual([{ user_id: owners[1], status: 'draft' }]);
    expect((await db.query('select import_count from public.workflow_shares where id=$1', [share.id])).rows[0].import_count).toBe(1);
  });

  it('permits an active anonymous Auth identity to own and edit its private canvas', async () => {
    const guest = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await guest.auth.signInAnonymously();
    expect(signed.error).toBeNull();
    expect(signed.data.user?.is_anonymous).toBe(true);
    const actor = owners.length;
    owners.push(signed.data.user!.id); tokens.push(signed.data.session!.access_token); users.push(guest);
    await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1', [owners[actor]]);
    const canvas = await create(actor);
    const saved = await json(await patchWorkflowCanvasRouteResponse({ request: request('PATCH', { title: 'Guest private canvas' }, actor), canvasId: canvas.id }));
    expect(saved.canvas.title).toBe('Guest private canvas');
    await json(await getWorkflowCanvasRouteResponse({ request: request('GET'), canvasId: canvas.id }), 404);
    await json(await deleteWorkflowCanvasRouteResponse({ request: request('DELETE', {}, actor), canvasId: canvas.id }));
    expect(await row(canvas.id)).toBeUndefined();
  });

  it.each(['null', '[]', '1', '"text"', '{'])('rejects invalid canvas PATCH root %s without modifying the canvas', async raw => {
    const canvas = await create(), before = await row(canvas.id);
    await json(await patchWorkflowCanvasRouteResponse({ request: request('PATCH', undefined, 0, raw), canvasId: canvas.id }), 400);
    expect(await row(canvas.id)).toEqual(before);
  });

  it.each(['productName', 'audience', 'primaryMessage'])('rejects non-string blueprint %s before billing', async field => {
    await json(await postWorkflowBlueprintRouteResponse({ request: request('POST', { ...planner, [field]: 42 }) }), 400);
    expect((await db.query('select credits from public.profiles where id=$1', [owners[0]])).rows[0].credits).toBe(500);
    expect((await db.query('select id from public.ai_usage_events where user_id=$1', [owners[0]])).rows).toEqual([]);
  });

  it.each(['null', '[]', '{'])('rejects invalid blueprint root %s before billing', async raw => {
    await json(await postWorkflowBlueprintRouteResponse({ request: request('POST', undefined, 0, raw) }), 400);
    expect((await db.query('select credits from public.profiles where id=$1', [owners[0]])).rows[0].credits).toBe(500);
    expect((await db.query('select id from public.ai_usage_events where user_id=$1', [owners[0]])).rows).toEqual([]);
  });
});
