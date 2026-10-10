import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterGraph } from '@/lib/workflow-canvas';
import { createWorkflowAssistantStateRouteHandlers } from '@/lib/workflow-assistant-state-route-adapter-service';
import { postWorkflowAssistantMessageRouteResponse } from '@/lib/workflow-assistant-message-route-adapter-service';
import { postWorkflowAssistantProposalApplyRouteResponse } from '@/lib/workflow-assistant-proposal-apply-route-adapter-service';
import { postWorkflowAssistantProposalDiscardRouteResponse } from '@/lib/workflow-assistant-proposal-discard-route-adapter-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG, connectionString = process.env.SUPABASE_TEST_DB_URL;
type Action = 'state' | 'message' | 'apply' | 'discard';
describe.skipIf(!configPath || !connectionString)('workflow assistant actual Auth/PostgREST boundaries', () => {
  let db: Client, admin: SupabaseClient;
  let canvasId: string, proposalId: string;
  const owners: string[] = [], tokens: string[] = [];
  let externalRequests = 0;
  const state = createWorkflowAssistantStateRouteHandlers();
  const request = (action: Action, actor: number | null, raw: string) => new Request('http://127.0.0.1/api/workflow-canvases/'+canvasId+'/assistant', {
    method: action === 'state' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(actor === null ? {} : { Authorization: 'Bearer '+(tokens[actor] ?? 'invalid-token') }) },
    ...(action === 'state' ? {} : { body: raw }),
  });
  const call = (action: Action, actor: number | null = 0, raw = '{"content":"Create a simple workflow"}') => {
    const context = { params: Promise.resolve({ id: canvasId, proposalId }) }, req = request(action, actor, raw);
    return action === 'state' ? state.GET(req, context) : action === 'message'
      ? postWorkflowAssistantMessageRouteResponse({ request: req, context }) : action === 'apply'
        ? postWorkflowAssistantProposalApplyRouteResponse({ request: req, context })
        : postWorkflowAssistantProposalDiscardRouteResponse({ request: req, context });
  };
  const snapshot = async () => ({
    canvas: (await db.query('select * from public.workflow_canvases where id=$1', [canvasId])).rows,
    proposals: (await db.query('select * from public.workflow_canvas_assistant_proposals where canvas_id=$1 order by id', [canvasId])).rows,
    messages: (await db.query('select * from public.workflow_canvas_assistant_messages where canvas_id=$1 order by id', [canvasId])).rows,
    history: (await db.query('select * from public.workflow_canvas_history where canvas_id=$1 order by id', [canvasId])).rows,
  });
  async function json(response: Response, status = 200) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toContain('private'); expect(response.headers.get('cache-control')).toContain('no-store');
    return response.json();
  }
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY); vi.stubEnv('KIE_AI_API_KEY', '');
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== new URL(config.API_URL).origin) { externalRequests++; throw new Error('External request forbidden in assistant admission controls'); }
      return originalFetch(target, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    for (let index = 0; index < 2; index++) {
      const email = `assistant-auth-${randomUUID()}@example.invalid`, password = randomUUID()+'aZ7!';
      const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(made.error).toBeNull(); owners.push(made.data.user!.id);
      await db.query('update public.profiles set credits=500,promotional_credits=0 where id=$1', [owners[index]]);
      const user = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const signed = await user.auth.signInWithPassword({ email, password }); expect(signed.error).toBeNull(); tokens.push(signed.data.session!.access_token);
    }
  });
  afterAll(async () => {
    try {
      await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
      expect((await db.query('select id from auth.users where id=any($1::uuid[])', [owners])).rows).toEqual([]);
    } finally { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });
  beforeEach(async () => {
    externalRequests = 0; canvasId = randomUUID(); proposalId = randomUUID();
    const graph = createStarterGraph();
    await db.query("insert into public.workflow_canvases(id,user_id,title,graph,revision) values($1,$2,'Assistant identity fixture',$3,4)", [canvasId, owners[0], JSON.stringify(graph)]);
    await db.query("insert into public.workflow_canvas_assistant_proposals(id,canvas_id,user_id,base_revision,status,summary,diff,proposed_graph) values($1,$2,$3,4,'ready','Fixture proposal','{}',$4)", [proposalId, canvasId, owners[0], JSON.stringify(graph)]);
  });
  afterEach(async () => {
    try {
      expect(externalRequests).toBe(0);
      expect((await db.query('select credits,promotional_credits from public.profiles where id=any($1::uuid[])', [owners])).rows).toEqual(owners.map(() => ({ credits: 500, promotional_credits: 0 })));
      expect((await db.query('select id from public.ai_usage_events where user_id=any($1::uuid[])', [owners])).rows).toEqual([]);
    } finally {
      await db.query('delete from public.workflow_canvases where id=$1', [canvasId]);
      await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [owners]);
      const empty = await snapshot(); expect(empty).toEqual({ canvas: [], proposals: [], messages: [], history: [] });
      expect((await db.query('select scope from public.backend_rate_limits where subject_key=any($1::text[])', [owners])).rows).toEqual([]);
    }
  });
  for (const action of ['state', 'message', 'apply', 'discard'] as const) {
    it.each([{ actor: 1, label: 'foreign', status: 404 }, { actor: null, label: 'unsigned', status: 401 }, { actor: 2, label: 'invalid', status: 401 }])(`${action} denies $label identity without writes or usage`, async ({ actor, status }) => {
      const before = await snapshot(); await json(await call(action, actor), status); expect(await snapshot()).toEqual(before);
    });
  }
  it.each(['null', '[]', '"text"', '42', 'true', '{}', '{', '{"content":{}}', '{"content":"  "}'])('rejects malformed message %s before state changes or usage', async raw => {
    const before = await snapshot(); await json(await call('message', 0, raw), 400); expect(await snapshot()).toEqual(before);
  });
  it('reads the newest 100 messages in chronological order and its owned proposal without writes', async () => {
    for (let index = 0; index < 101; index++) {
      await db.query("insert into public.workflow_canvas_assistant_messages(canvas_id,user_id,role,content,proposal_id,created_at) values($1,$2,'user',$3,$4,'2020-01-01'::timestamptz + $5 * interval '1 second')", [canvasId, owners[0], String(index), proposalId, index]);
    }
    const before = await snapshot(), response = await json(await call('state'));
    expect(response.messages.map((message: { content: string }) => message.content)).toEqual(Array.from({ length: 100 }, (_, index) => String(index+1)));
    expect(response.proposal.id).toBe(proposalId); expect(await snapshot()).toEqual(before);
  });
  it('discards an owned ready proposal once without allowing later apply', async () => {
    expect((await json(await call('discard'))).proposal.status).toBe('discarded');
    const before = await snapshot(); await json(await call('discard'), 409); await json(await call('apply'), 409);
    expect(await snapshot()).toEqual(before); expect((await json(await call('state'))).proposal).toBeNull();
  });
  it('applies an owned proposal once without allowing a later discard', async () => {
    expect((await json(await call('apply'))).proposal.status).toBe('applied');
    const before = await snapshot(); await json(await call('apply'), 409); await json(await call('discard'), 409);
    expect(await snapshot()).toEqual(before);
  });
  it('rejects a proposal based on an older canvas revision', async () => {
    await db.query('update public.workflow_canvases set revision=5 where id=$1', [canvasId]);
    const before = await snapshot(); await json(await call('apply'), 409);
    const after = await snapshot();
    expect(after.canvas).toEqual(before.canvas); expect(after.history).toEqual(before.history); expect(after.messages).toEqual(before.messages);
    expect(after.proposals[0]).toMatchObject({ ...before.proposals[0], status: 'discarded', discarded_at: expect.any(Date) });
  });
});
