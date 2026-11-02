import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { planWorkflowBlueprintForRoute, type WorkflowBlueprintRouteInput } from '@/lib/workflow-blueprint-service';
import { WORKFLOW_BLUEPRINT_COST } from '@/lib/workflow-blueprint';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
type ProviderFetch = NonNullable<WorkflowBlueprintRouteInput['providerFetch']>;
const input = {
  brandName: 'Audit fixture', productName: 'Ceramic mug', audience: 'Home cooks', objective: 'ugc-ad',
  primaryMessage: 'Keep drinks warm', offer: '', callToAction: 'Learn more', visualStyle: 'Studio',
  tone: 'Calm', aspectRatio: '9:16', durationSeconds: 20, platform: 'TikTok',
};
const providerResponse = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Fixture blueprint' }) } }] }), { status: 200 });

describe.skipIf(!configPath || !connectionString)('workflow blueprint billing with actual Auth and PostgREST', () => {
  let db: Client;
  let config: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
  let admin: SupabaseClient;
  let users: SupabaseClient[];
  let owners: string[];
  let key: string;
  let provider: ReturnType<typeof vi.fn<ProviderFetch>>;
  const balance = async (index = 0) => (await db.query('select credits,promotional_credits from public.profiles where id=$1', [owners[index]])).rows[0];
  const events = async () => (await db.query('select id,user_id,status,cost,refunded,promotional_credits_used,response_payload from public.ai_usage_events where user_id=any($1::uuid[]) order by created_at,id', [owners])).rows;
  const plan = (actor = 0, options: { admin?: SupabaseClient; key?: string; body?: Record<string, unknown> } = {}) => planWorkflowBlueprintForRoute({
    createUserSupabase: () => users[actor], createAdminSupabase: () => options.admin ?? admin,
    kieApiKey: 'local-controlled-provider', providerFetch: provider,
    readRequestBody: async () => ({ ...input, ...options.body }),
    request: new Request('http://127.0.0.1/api/workflow-blueprint', { method: 'POST', headers: { 'Idempotency-Key': options.key ?? key } }),
  });
  beforeAll(async () => {
    config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== new URL(config.API_URL).origin) throw new Error('External network access forbidden in local billing controls');
      return originalFetch(target, init);
    });
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
  });
  afterAll(async () => { await db?.end(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    users = []; owners = []; key = randomUUID();
    provider = vi.fn<ProviderFetch>(async () => providerResponse());
    for (let index = 0; index < 2; index++) {
      const email = `blueprint-billing-audit-${randomUUID()}@example.invalid`, password = randomUUID()+'aZ7!';
      const made = await admin.auth.admin.createUser({ email, password, email_confirm: true }); expect(made.error).toBeNull();
      owners.push(made.data.user!.id);
      await db.query('update public.profiles set credits=50,promotional_credits=10 where id=$1', [owners[index]]);
      const user = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await user.auth.signInWithPassword({ email, password })).error).toBeNull(); users.push(user);
    }
  });
  afterEach(async () => {
    await db.query('delete from public.ai_usage_events where user_id=any($1::uuid[])', [owners]);
    await db.query('delete from auth.users where id=any($1::uuid[])', [owners]);
    await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [owners]);
    expect((await db.query(`select
      (select count(*) from auth.users where id=any($1::uuid[]))::int as users,
      (select count(*) from public.profiles where id=any($1::uuid[]))::int as profiles,
      (select count(*) from public.ai_usage_events where user_id=any($1::uuid[]))::int as usage,
      (select count(*) from public.backend_rate_limits where subject_key=any($1::text[]))::int as rates`, [owners])).rows[0])
      .toEqual({ users: 0, profiles: 0, usage: 0, rates: 0 });
  });

  it('charges once, stores the response and replays success without resubmitting', async () => {
    const first = await plan(); expect(first.ok).toBe(true);
    expect(await balance()).toEqual({ credits: 50-WORKFLOW_BLUEPRINT_COST, promotional_credits: 10-WORKFLOW_BLUEPRINT_COST });
    const replay = await plan(); expect(replay).toMatchObject({ ok: true, body: { ...first.body, idempotentReplay: true } });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await events()).toHaveLength(1);
    expect((await events())[0]).toMatchObject({ status: 'succeeded', cost: WORKFLOW_BLUEPRINT_COST, refunded: false });
    expect((await users[0].rpc('settle_ai_usage_event', { p_event_id: (await events())[0].id, p_outcome: 'refunded' })).error).not.toBeNull();
    expect(await balance()).toEqual({ credits: 50-WORKFLOW_BLUEPRINT_COST, promotional_credits: 10-WORKFLOW_BLUEPRINT_COST });
  });

  it('scopes identical request keys to separate owners', async () => {
    expect((await plan(0)).ok).toBe(true); expect((await plan(1)).ok).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);
    expect((await events()).map(e => e.user_id).sort()).toEqual([...owners].sort());
    for (let index=0;index<2;index++) expect(await balance(index)).toEqual({ credits: 50-WORKFLOW_BLUEPRINT_COST, promotional_credits: 10-WORKFLOW_BLUEPRINT_COST });
  });

  it('holds one charge while a concurrent duplicate waits, then replays completion', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered=resolve; });
    const waiting = new Promise<void>(resolve => { release=resolve; });
    provider.mockImplementation(async () => { entered(); await waiting; return providerResponse(); });
    const first = plan();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider barrier was not reached')), 10000);
      })]);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(await plan()).toMatchObject({ ok: false, status: 409 });
      expect((await events())[0]).toMatchObject({ status: 'pending', refunded: false });
      expect(await balance()).toEqual({ credits: 50-WORKFLOW_BLUEPRINT_COST, promotional_credits: 10-WORKFLOW_BLUEPRINT_COST });
      release(); expect((await first).ok).toBe(true);
      expect(await plan()).toMatchObject({ ok: true, body: { idempotentReplay: true } });
      expect(provider).toHaveBeenCalledTimes(1); expect(await events()).toHaveLength(1);
    } finally { clearTimeout(timer); release(); await first; }
  }, 15000);

  it('refunds failed submission once and requires a new key for another paid attempt', async () => {
    provider.mockResolvedValueOnce(new Response('controlled provider failure', { status: 503 }));
    expect(await plan()).toMatchObject({ ok: false, status: 502 });
    expect(await balance()).toEqual({ credits: 50, promotional_credits: 10 });
    const [event] = await events(); expect(event).toMatchObject({ status: 'refunded', refunded: true });
    const again = await admin.rpc('settle_ai_usage_event', { p_event_id: event.id, p_outcome: 'refunded' });
    expect(again.error).toBeNull(); expect(again.data).toMatchObject({ status: 'already_refunded', settled: false });
    expect(await plan()).toMatchObject({ ok: false, status: 409 }); expect(provider).toHaveBeenCalledTimes(1);
    expect((await plan(0,{ key: randomUUID() })).ok).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2); expect(await events()).toHaveLength(2);
    expect(await balance()).toEqual({ credits: 50-WORKFLOW_BLUEPRINT_COST, promotional_credits: 10-WORKFLOW_BLUEPRINT_COST });
  });

  it.each(['invalid-json','invalid-content'])('refunds %s provider responses with the original credit buckets', async mode => {
    provider.mockResolvedValueOnce(new Response(mode==='invalid-json'?'{':JSON.stringify({ choices:[{ message:{ content:42 } }] }), { status:200 }));
    expect(await plan()).toMatchObject({ ok:false, status:502 });
    expect(await balance()).toEqual({ credits:50, promotional_credits:10 });
    expect((await events())[0]).toMatchObject({ status:'refunded', refunded:true, promotional_credits_used:WORKFLOW_BLUEPRINT_COST });
    expect(await plan()).toMatchObject({ ok:false, status:409 }); expect(provider).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost committed success reply without refunding or charging again', async () => {
    let lost = false;
    const faultFetch: typeof fetch = async (target,init) => {
      const response = await fetch(target,init);
      if (!lost && new URL(String(target)).pathname==='/rest/v1/rpc/settle_ai_usage_event' && JSON.parse(String(init?.body)).p_outcome==='succeeded' && response.ok) {
        lost=true; return new Response(JSON.stringify({ message:'Controlled committed reply loss' }), { status:503, headers:{'Content-Type':'application/json'} });
      }
      return response;
    };
    const faulty = createClient(config.API_URL,config.SERVICE_ROLE_KEY,{ auth:{persistSession:false,autoRefreshToken:false},global:{fetch:faultFetch} });
    expect(await plan(0,{admin:faulty})).toMatchObject({ ok:false, status:500 }); expect(lost).toBe(true);
    const [event] = await events(); expect(event).toMatchObject({status:'succeeded',refunded:false});
    expect(event.response_payload).toHaveProperty('blueprint');
    expect(await plan()).toMatchObject({ok:true,body:{idempotentReplay:true}});
    expect(await balance()).toEqual({credits:50-WORKFLOW_BLUEPRINT_COST,promotional_credits:10-WORKFLOW_BLUEPRINT_COST});
    expect(provider).toHaveBeenCalledTimes(1); expect(await events()).toHaveLength(1);
  });

  it('refuses insufficient credits before a usage event or provider submission', async () => {
    await db.query('update public.profiles set credits=$2,promotional_credits=0 where id=$1',[owners[0],WORKFLOW_BLUEPRINT_COST-1]);
    expect(await plan()).toMatchObject({ok:false,status:402});
    expect(await events()).toEqual([]); expect(provider).not.toHaveBeenCalled();
    expect(await balance()).toEqual({credits:WORKFLOW_BLUEPRINT_COST-1,promotional_credits:0});
  });

  it('rejects mismatched idempotency keys before a usage event or provider submission', async () => {
    expect(await plan(0,{body:{idempotencyKey:randomUUID()}})).toMatchObject({ok:false,status:400});
    expect(await events()).toEqual([]); expect(provider).not.toHaveBeenCalled();
    expect(await balance()).toEqual({credits:50,promotional_credits:10});
  });
});
