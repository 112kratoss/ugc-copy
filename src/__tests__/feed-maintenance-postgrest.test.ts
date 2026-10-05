import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { maintainFeedPersonalization } from '@/lib/feed-maintenance';
const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
const order = ['refresh_post_feed_stats', 'refresh_post_feed_engagement_stats', 'refresh_creator_feed_stats', 'refresh_user_interest_weights', 'refresh_feed_delivery_fact_daily', 'prune_feed_personalization_data'];

describe.skipIf(!configPath || !connectionString)('feed maintenance interruptions with actual PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let owner: string, post: string, algorithm: string, session: string;
  let fail: string | null, afterCommit: boolean, calls: string[];
  const now = new Date('1805-01-02T00:00:00Z');
  const invalidation = vi.fn();
  const run = () => maintainFeedPersonalization(admin, { now, invalidateFeedCache: invalidation });
  const rollups = async () => (await db.query('select deliveries,opens from public.feed_delivery_fact_daily where algorithm_version_id=$1', [algorithm])).rows;
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const rpc = path.startsWith('/rest/v1/rpc/') ? path.slice('/rest/v1/rpc/'.length) : null;
      if (rpc) calls.push(rpc);
      if (rpc === fail) {
        if (afterCommit) { const response = await fetch(input, init); expect(response.ok).toBe(true); }
        return new Response(JSON.stringify({ code: 'XX000', message: 'Injected feed phase failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(input, init);
    } } });
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    [owner, post, algorithm, session] = Array.from({ length: 4 }, () => randomUUID());
    fail = null; afterCommit = false; calls = []; invalidation.mockClear();
    await db.query("insert into auth.users(id,email,aud,role,created_at) values($1,$2,'authenticated','authenticated','1800-01-01')", [owner, owner + '@example.invalid']);
    await db.query("insert into public.posts(id,user_id,visibility,category,source_kind,post_format,review_status,body) values($1,$2,'public','image','magicbooklet','text','visible','Local audit fixture')", [post, owner]);
    await db.query("insert into public.feed_algorithm_versions(id,algorithm_key,version) values($1,$2,1)", [algorithm, 'audit-' + algorithm]);
    await db.query('insert into public.feed_sessions(id,algorithm_version_id,viewer_user_id) values($1,$2,$3)', [session, algorithm, owner]);
    await db.query("insert into public.feed_delivery_facts(delivery_id,session_id,algorithm_version_id,post_id,position,candidate_source,final_score,surface,mode,ranked_at,served_at,opened_at) select (random()*1e15)::bigint,$1,$2,$3,n,'recent',0.5,'feed','for-you','1805-01-01','1805-01-01',case when n=1 then '1805-01-01'::timestamptz else null end from generate_series(1,2) n", [session, algorithm, post]);
    await db.query("insert into public.generations(user_id,status,category,model,completed_at,created_at) values($1,'completed','image','audit-local','1805-01-01','1805-01-01')", [owner]);
  });
  afterEach(async () => {
    await db.query('delete from public.feed_delivery_fact_daily where algorithm_version_id=$1', [algorithm]);
    await db.query('delete from public.feed_delivery_facts where algorithm_version_id=$1', [algorithm]);
    await db.query('delete from public.feed_sessions where id=$1', [session]);
    await db.query('delete from public.feed_algorithm_versions where id=$1', [algorithm]);
    await db.query('delete from auth.users where id=$1', [owner]);
    expect(await rollups()).toEqual([]);
    expect((await db.query('select id from public.generations where user_id=$1', [owner])).rows).toEqual([]);
  });
  it.each(order)('preserves retryability after %s fails', async phase => {
    fail = phase;
    await expect(run()).rejects.toThrow(`Feed maintenance RPC ${phase} failed`);
    expect(calls).toEqual(order.slice(0, order.indexOf(phase) + 1));
    expect(invalidation).toHaveBeenCalledTimes(order.indexOf(phase) > 2 ? 1 : 0);
    if (phase === 'prune_feed_personalization_data') expect(await rollups()).toEqual([{ deliveries: '2', opens: '1' }]);
    else expect(await rollups()).toEqual([]);
    fail = null; calls = [];
    expect(await run()).toMatchObject({ asOf: now.toISOString(), userInterestProfilesRefreshed: 1, dailyRollup: { bucketsRefreshed: 1 } });
    expect(calls).toEqual(order);
    expect(await rollups()).toEqual([{ deliveries: '2', opens: '1' }]);
    await run(); expect(await rollups()).toEqual([{ deliveries: '2', opens: '1' }]);
  });
  it.each(order)('recovers after SIGKILL following committed %s', async phase => {
    const child = fork('src/__tests__/feed-maintenance-worker.cjs', [], {
      execArgv: ['--import', 'tsx'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tsconfig.mobile-push-worker.json', AUDIT_STORAGE_CONFIG: configPath, AUDIT_STOP_PHASE: phase },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child did not reach committed RPC')), 8000);
        child.once('message', message => { clearTimeout(timer); if ((message as { stage: string }).stage === 'rpc-committed') resolve(); else reject(new Error('Worker failed')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited early')); });
      });
      const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
      child.kill('SIGKILL'); expect(await exited).toBe('SIGKILL');
      if (order.indexOf(phase) >= 4) expect(await rollups()).toEqual([{ deliveries: '2', opens: '1' }]);
      else expect(await rollups()).toEqual([]);
      await run();
      expect(await rollups()).toEqual([{ deliveries: '2', opens: '1' }]);
      expect((await db.query('select user_id from public.user_interest_weights where user_id=$1', [owner])).rows).toHaveLength(2);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      }
    }
  }, 12000);
  it('recovers a committed rollup whose acknowledgement was lost without doubling counts', async () => {
    fail = 'refresh_feed_delivery_fact_daily'; afterCommit = true;
    await expect(run()).rejects.toThrow('Feed maintenance RPC refresh_feed_delivery_fact_daily failed');
    expect(await rollups()).toEqual([{ deliveries: '2', opens: '1' }]);
    expect(calls).not.toContain('prune_feed_personalization_data');
    fail = null; await run();
    expect(await rollups()).toEqual([{ deliveries: '2', opens: '1' }]);
  });
});
