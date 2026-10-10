import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterGraph } from '@/lib/workflow-canvas';
import { DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT, WORKFLOW_ASSISTANT_COST } from '@/lib/workflow-assistant';
import { postWorkflowAssistantMessageRouteResponse } from '@/lib/workflow-assistant-message-route-adapter-service';

vi.mock('@/lib/provider-dependency-telemetry', () => ({ recordProviderDependencyEvent: vi.fn(async () => undefined) }));

const configPath = process.env.AUDIT_STORAGE_CONFIG, connectionString = process.env.SUPABASE_TEST_DB_URL;
type Fault = 'none' | 'provider-refusal' | 'provider-malformed' | 'proposal-insert' | 'message-insert' | 'discard' | 'settlement' | 'lost-reply' | 'malformed-reply' | 'lost-reply-read-outage';
describe.skipIf(!configPath || !connectionString)('assistant billing and persistence through actual Auth/PostgREST', () => {
  let db: Client, admin: SupabaseClient;
  let owner: string, token: string, canvasId: string, oldProposalId: string, key: string;
  let fault: Fault, providerCalls: number;
  let replyLost: boolean;
  let completionArgs: Record<string, unknown>;
  const graph = createStarterGraph();
  const invoke = (idempotencyKey = key, content = 'Make a ceramic mug workflow') => postWorkflowAssistantMessageRouteResponse({
    context: { params: Promise.resolve({ id: canvasId }) },
    request: new Request('http://127.0.0.1/api/workflow-canvases/'+canvasId+'/assistant/messages', {
      method: 'POST', headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ content }),
    }),
  });
  const balance = async () => (await db.query('select credits,promotional_credits from public.profiles where id=$1', [owner])).rows[0];
  const proposals = async () => (await db.query('select id,status,discarded_at from public.workflow_canvas_assistant_proposals where canvas_id=$1 order by created_at,id', [canvasId])).rows;
  const messages = async () => (await db.query('select role,content,proposal_id from public.workflow_canvas_assistant_messages where canvas_id=$1 order by created_at,id', [canvasId])).rows;
  const events = async () => (await db.query('select id,status,cost,refunded,response_payload from public.ai_usage_events where user_id=$1', [owner])).rows;
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', config.API_URL); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', config.ANON_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', config.SERVICE_ROLE_KEY); vi.stubEnv('KIE_AI_API_KEY', 'local-provider-fixture');
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.href === 'https://api.kie.ai/gemini-3-flash/v1/chat/completions') {
        providerCalls++;
        if (fault === 'provider-refusal') return Promise.resolve(new Response('Fixture refusal', { status: 503 }));
        return Promise.resolve(Response.json({ choices: [{ message: { content: fault === 'provider-malformed' ? 42 : JSON.stringify(DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT) } }] }));
      }
      if (url.origin !== new URL(config.API_URL).origin) throw new Error('Unexpected external request forbidden');
      if (url.pathname === '/rest/v1/rpc/complete_workflow_assistant_message') completionArgs = JSON.parse(String(init?.body));
      if (fault === 'lost-reply-read-outage' && replyLost && url.pathname === '/rest/v1/ai_usage_events') {
        return Response.json({ message: 'Fixture recovery read unavailable' }, { status: 503 });
      }
      const response = await originalFetch(target, init);
      if (!replyLost && ['lost-reply', 'malformed-reply', 'lost-reply-read-outage'].includes(fault) && url.pathname === '/rest/v1/rpc/complete_workflow_assistant_message' && response.ok) {
        await response.text(); replyLost = true;
        expect((await events())[0].status).toBe('succeeded');
        return new Response(fault === 'malformed-reply' ? '{}' : '{"message":"Committed reply lost"}', { status: fault === 'malformed-reply' ? 200 : 503, headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    fault = 'none'; providerCalls = 0; replyLost = false; completionArgs = {}; canvasId = randomUUID(); oldProposalId = randomUUID(); key = randomUUID();
    const email = 'assistant-billing-'+randomUUID()+'@example.invalid', password = randomUUID()+'aZ7!';
    const made = await admin.auth.admin.createUser({ email, password, email_confirm: true }); expect(made.error).toBeNull(); owner = made.data.user!.id;
    const user = createClient(JSON.parse(readFileSync(configPath!, 'utf8')).API_URL, JSON.parse(readFileSync(configPath!, 'utf8')).ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await user.auth.signInWithPassword({ email, password }); expect(signed.error).toBeNull(); token = signed.data.session!.access_token;
    await db.query('update public.profiles set credits=50,promotional_credits=10 where id=$1', [owner]);
    await db.query("insert into public.workflow_canvases(id,user_id,title,graph,revision) values($1,$2,'Assistant billing fixture',$3,4)", [canvasId, owner, JSON.stringify(graph)]);
    await db.query("insert into public.workflow_canvas_assistant_proposals(id,canvas_id,user_id,base_revision,status,summary,diff,proposed_graph) values($1,$2,$3,4,'ready','Previous usable proposal','{}',$4)", [oldProposalId, canvasId, owner, JSON.stringify(graph)]);
  });
  afterEach(async () => {
    fault = 'none';
    await db.query('delete from public.ai_usage_events where user_id=$1', [owner]);
    await db.query('delete from auth.users where id=$1', [owner]);
    await db.query('delete from public.backend_rate_limits where subject_key=$1', [owner]);
    expect((await db.query(`select
      (select count(*) from auth.users where id=$1)::int as users,
      (select count(*) from public.profiles where id=$1)::int as profiles,
      (select count(*) from public.ai_usage_events where user_id=$1)::int as usage,
      (select count(*) from public.workflow_canvases where id=$2)::int as canvases,
      (select count(*) from public.workflow_canvas_assistant_proposals where canvas_id=$2)::int as proposals,
      (select count(*) from public.workflow_canvas_assistant_messages where canvas_id=$2)::int as messages,
      (select count(*) from public.backend_rate_limits where subject_key=$1::text)::int as rates`, [owner, canvasId])).rows[0])
      .toEqual({ users: 0, profiles: 0, usage: 0, canvases: 0, proposals: 0, messages: 0, rates: 0 });
  });
  it('charges once, persists one message pair and replays without another provider request', async () => {
    const first = await invoke(); expect(first.status).toBe(200); const body = await first.json();
    expect(await balance()).toEqual({ credits: 50-WORKFLOW_ASSISTANT_COST, promotional_credits: 10-WORKFLOW_ASSISTANT_COST });
    expect(await proposals()).toHaveLength(2); expect((await proposals()).filter(row => row.status === 'ready')).toHaveLength(1);
    expect(await messages()).toHaveLength(2); expect((await events())[0]).toMatchObject({ status: 'succeeded', refunded: false });
    const replay = await invoke(); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ ...body, idempotentReplay: true });
    expect(providerCalls).toBe(1); expect(await events()).toHaveLength(1); expect(await messages()).toHaveLength(2);
  });
  it.each(['provider-refusal', 'provider-malformed'] as const)('refunds %s once and preserves the previous proposal', async mode => {
    fault = mode; const before = await proposals();
    expect((await invoke()).status).toBe(502);
    expect(await proposals()).toEqual(before); expect(await messages()).toEqual([]);
    expect(await balance()).toEqual({ credits: 50, promotional_credits: 10 });
    expect((await events())[0]).toMatchObject({ status: 'refunded', refunded: true });
    fault = 'none'; expect((await invoke()).status).toBe(409); expect(providerCalls).toBe(1);
  });
  it.each(['proposal-insert', 'message-insert', 'discard', 'settlement'] as const)('retains the previous complete state when %s fails and refunds the failed request', async mode => {
    fault = mode; const before = await proposals();
    const trigger = 'assistant_fault_'+canvasId.replaceAll('-', '');
    const table = mode === 'settlement' ? 'ai_usage_events' : mode === 'message-insert' ? 'workflow_canvas_assistant_messages' : 'workflow_canvas_assistant_proposals';
    await db.query(`create function public.${trigger}() returns trigger language plpgsql as $body$
      begin if ${mode === 'settlement' ? `new.user_id = '${owner}'::uuid and new.status = 'succeeded'` : `new.canvas_id = '${canvasId}'::uuid`} then raise exception 'Fixture persistence rejection'; end if; return new; end $body$`);
    await db.query(`create trigger ${trigger} before ${['discard', 'settlement'].includes(mode) ? 'update' : 'insert'} on public.${table} for each row execute function public.${trigger}()`);
    try {
    expect((await invoke()).status).toBe(502);
    expect(await proposals()).toEqual(before); expect(await messages()).toEqual([]);
    expect(await balance()).toEqual({ credits: 50, promotional_credits: 10 });
    expect((await events())[0]).toMatchObject({ status: 'refunded', refunded: true });
    } finally {
      await db.query(`drop trigger if exists ${trigger} on public.${table}`);
      await db.query(`drop function if exists public.${trigger}()`);
    }
  });
  it.each(['lost-reply', 'malformed-reply'] as const)('recovers a %s after the complete transaction commits without another charge', async mode => {
    fault = mode;
    const result = await invoke(); expect(result.status).toBe(200); expect(replyLost).toBe(true);
    const body = await result.json();
    expect(await messages()).toHaveLength(2); expect(await proposals()).toHaveLength(2);
    expect((await events())[0]).toMatchObject({ status: 'succeeded', refunded: false });
    fault = 'none'; const replay = await invoke(); expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ...body, idempotentReplay: true });
    expect(providerCalls).toBe(1); expect(await events()).toHaveLength(1);
    expect(await balance()).toEqual({ credits: 50-WORKFLOW_ASSISTANT_COST, promotional_credits: 10-WORKFLOW_ASSISTANT_COST });
  });
  it('serializes concurrent requests sharing one idempotency key', async () => {
    const replies = await Promise.all([invoke(), invoke()]);
    expect(replies.every(response => [200, 409].includes(response.status))).toBe(true);
    expect(replies.some(response => response.status === 200)).toBe(true);
    expect(providerCalls).toBe(1); expect(await events()).toHaveLength(1); expect(await messages()).toHaveLength(2);
    expect(await balance()).toEqual({ credits: 50-WORKFLOW_ASSISTANT_COST, promotional_credits: 10-WORKFLOW_ASSISTANT_COST });
  });
  it('denies direct authenticated and anonymous execution of the completion RPC', async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    const args = { p_event_id: randomUUID(), p_canvas_id: canvasId, p_user_id: owner, p_base_revision: 4,
      p_content: 'Fixture', p_reply: 'Fixture', p_summary: 'Fixture', p_diff: {}, p_proposed_graph: graph };
    for (const actor of [null, token]) {
      const untrusted = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false }, global: { headers: actor ? { Authorization: 'Bearer '+actor } : {} } });
      expect((await untrusted.rpc('complete_workflow_assistant_message', args)).error).not.toBeNull();
    }
    expect(providerCalls).toBe(0); expect(await events()).toEqual([]); expect(await messages()).toEqual([]);
  });

  it('does not refund an unconfirmed commit when recovery reads fail, then replays after recovery', async () => {
    fault = 'lost-reply-read-outage';
    expect((await invoke()).status).toBe(500); expect(replyLost).toBe(true);
    expect((await events())[0]).toMatchObject({ status: 'succeeded', refunded: false });
    fault = 'none'; expect((await invoke()).status).toBe(200);
    expect(providerCalls).toBe(1); expect(await messages()).toHaveLength(2);
    expect(await balance()).toEqual({ credits: 50-WORKFLOW_ASSISTANT_COST, promotional_credits: 10-WORKFLOW_ASSISTANT_COST });
  }, 30000);
  it('serializes two distinct paid replacements without leaving two ready proposals', async () => {
    const responses = await Promise.all([invoke(randomUUID()), invoke(randomUUID())]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(providerCalls).toBe(2); expect(await events()).toHaveLength(2); expect(await messages()).toHaveLength(4);
    expect((await proposals()).filter(row => row.status === 'ready')).toHaveLength(1);
    expect(await balance()).toEqual({ credits: 50-2*WORKFLOW_ASSISTANT_COST, promotional_credits: Math.max(0, 10-2*WORKFLOW_ASSISTANT_COST) });
  });
  it('replays a completed transaction and refuses a different owner or canvas', async () => {
    const response = await invoke(); expect(response.status).toBe(200); const body = await response.json();
    expect((await admin.rpc('complete_workflow_assistant_message', completionArgs)).data).toEqual(body);
    expect((await admin.rpc('complete_workflow_assistant_message', { ...completionArgs, p_user_id: randomUUID() })).error).not.toBeNull();
    expect((await admin.rpc('complete_workflow_assistant_message', { ...completionArgs, p_canvas_id: randomUUID() })).error).not.toBeNull();
    expect(await events()).toHaveLength(1); expect(await messages()).toHaveLength(2); expect(providerCalls).toBe(1);
  });

  it('preserves messages longer than the ledger prompt preview without changing admission', async () => {
    const content = 'A'.repeat(5001);
    expect((await invoke(key, content)).status).toBe(200);
    expect((await messages()).find(row => row.role === 'user')?.content).toBe(content);
    expect((await events())[0]).toMatchObject({ status: 'succeeded', refunded: false });
    expect(providerCalls).toBe(1);
  });

});
