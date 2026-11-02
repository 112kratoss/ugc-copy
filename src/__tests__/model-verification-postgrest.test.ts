import { readFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/backend-logger', () => ({ logBackendError: vi.fn(), logBackendEvent: vi.fn(), logBackendWarning: vi.fn() }));
import { runGenerationModelVerificationBackendJob } from '@/lib/backend-job-executions';
import { verifyPublishedGenerationModels } from '@/lib/generation-model-provider-verification';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('catalog verification with real HTTP and PostgREST', () => {
  let db: Client, admin: SupabaseClient, server: Server;
  let fixture: string, original: string | null, destination: string;
  let models: string[], requests: Array<{ method?: string; authorization?: string }>;
  let status: number, disconnect: boolean, hold: boolean, insertFailure: 'before' | 'after' | null;
  let historyFailure: boolean;
  let sequence: number;
  let held: ServerResponse[], received: (() => void) | undefined;
  const managedNow = new Date('2007-01-01T00:06:00Z').getTime();
  const managed = () => runGenerationModelVerificationBackendJob({ serviceClient: admin, requestId: `audit-model-${fixture}-${sequence++}`, startedAtMs: managedNow });
  const runs = async () => (await db.query('select status,summary,error_message from public.backend_job_runs where request_id like $1 order by request_id', [`audit-model-${fixture}-%`])).rows;
  const originalFetch = globalThis.fetch;
  const run = () => verifyPublishedGenerationModels(admin, { now: new Date(Date.UTC(2007, 0, 1, 0, sequence++)) });
  const checks = async () => (await db.query('select model_id,status,consecutive_discrepancies,observed_hash,sanitized_details from public.generation_model_provider_checks where release_id=$1 order by checked_at,model_id,id', [fixture])).rows;
  const configure = async (config: Record<string, unknown>) => {
    await db.query('begin');
    try {
      await db.query("update public.generation_model_catalog_releases set status='draft' where id=$1", [fixture]);
      await db.query('update public.generation_model_catalog_entries set verification_config=$2 where release_id=$1', [fixture, config]);
      await db.query("update public.generation_model_catalog_releases set status='active' where id=$1", [fixture]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
  };
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    models = (await db.query("select model_id from public.generation_models where kind='image' order by model_id limit 2")).rows.map(row => row.model_id);
    expect(models).toHaveLength(2);
    server = createServer((request, response) => {
      requests.push({ method: request.method, authorization: request.headers.authorization });
      received?.();
      if (disconnect) request.socket.destroy();
      else if (hold) held.push(response);
      else if (!hold) { response.statusCode = status; response.setHeader('etag', 'audit-local'); response.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No local HTTP endpoint');
    destination = `http://127.0.0.1:${address.port}`;
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (historyFailure && url.pathname.endsWith('/rpc/latest_generation_model_provider_checks')) {
        return new Response(JSON.stringify({ code: 'XX000', message: 'Injected history read outage' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/generation_model_provider_checks') && init?.method === 'POST' && insertFailure) {
        if (insertFailure === 'after') expect((await originalFetch(input, init)).ok).toBe(true);
        return new Response(JSON.stringify({ code: 'XX000', message: 'Injected check persistence outage' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, init);
    } } });
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db?.end();
  });
  beforeEach(async () => {
    fixture = randomUUID(); sequence = 0; requests = []; status = 200; disconnect = false; hold = false; insertFailure = null; historyFailure = false; held = []; received = undefined;
    vi.stubEnv('KIE_AI_API_KEY', 'local-audit-only');
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'api.kie.ai') throw Error('Unexpected non-fixture provider host');
      return originalFetch(destination + url.pathname, init);
    });
    original = (await db.query("select id from public.generation_model_catalog_releases where status='active'")).rows[0]?.id ?? null;
    await db.query('begin');
    try {
      await db.query("insert into public.generation_model_catalog_releases(id,revision,defaults) values($1,$2,'{\"web\":{},\"mobile\":{}}')", [fixture, 'audit-' + fixture]);
      for (const model of models) await db.query("insert into public.generation_model_catalog_entries(release_id,model_id,public_descriptor,adapter_key,provider_model_map,pricing_strategy,pricing_config,validation_strategy,verification_config) values($1,$2,'{}','image-v1','{}','image-v1','{}','image-v1',$3)", [fixture, model, { mode: 'http', url: 'https://api.kie.ai/audit-local' }]);
      if (original) await db.query("update public.generation_model_catalog_releases set status='retired' where id=$1", [original]);
      await db.query("update public.generation_model_catalog_releases set status='active' where id=$1", [fixture]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
  });
  afterEach(async () => {
    server.closeAllConnections(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
    await db.query('delete from public.backend_job_runs where request_id like $1', [`audit-model-${fixture}-%`]);
    await db.query('begin');
    try {
      await db.query("update public.generation_model_catalog_releases set status='draft' where id=$1", [fixture]);
      await db.query('delete from public.generation_model_catalog_entries where release_id=$1', [fixture]);
      await db.query('delete from public.generation_model_catalog_releases where id=$1', [fixture]);
      if (original) await db.query("update public.generation_model_catalog_releases set status='active' where id=$1", [original]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    expect(await checks()).toEqual([]);
    expect(await runs()).toEqual([]);
    expect((await db.query('select name from public.backend_job_locks where locked_by like $1', [`%audit-model-${fixture}-%`])).rows).toEqual([]);
    expect((await db.query("select id from public.generation_model_catalog_releases where status='active'")).rows.map(row => row.id)).toEqual(original ? [original] : []);
  });
  it('does no work when there is no active catalog release', async () => {
    await db.query("update public.generation_model_catalog_releases set status='draft' where id=$1", [fixture]);
    expect(await run()).toEqual({ checked: 0, discrepancies: 0, unverifiable: 0 });
    expect(requests).toEqual([]); expect(await checks()).toEqual([]);
  });
  it('does no work when the selected catalog has no entries', async () => {
    await db.query("update public.generation_model_catalog_releases set status='draft' where id=$1", [fixture]);
    await db.query('delete from public.generation_model_catalog_entries where release_id=$1', [fixture]);
    await db.query("update public.generation_model_catalog_releases set status='active' where id=$1", [fixture]);
    expect(await run()).toEqual({ checked: 0, discrepancies: 0, unverifiable: 0 });
    expect(requests).toEqual([]); expect(await checks()).toEqual([]);
  });
  it('records manual configurations without contacting a provider', async () => {
    await configure({ mode: 'manual' });
    expect(await run()).toMatchObject({ checked: 2, discrepancies: 0, unverifiable: 2 });
    expect(requests).toEqual([]);
    expect(await checks()).toEqual(models.map(model_id => expect.objectContaining({ model_id, status: 'unverifiable', consecutive_discrepancies: 0 })));
  });
  it('refuses disallowed verification endpoints without HTTP', async () => {
    await configure({ mode: 'http', url: 'https://other.example.invalid/model' });
    expect(await run()).toMatchObject({ checked: 2, unverifiable: 2 });
    expect(requests).toEqual([]);
  });
  it('persists successful HEAD fingerprints and detects changed metadata', async () => {
    expect(await run()).toMatchObject({ checked: 2, discrepancies: 0, degraded: 0 });
    const saved = await checks();
    expect(saved.every(row => row.status === 'available' && /^[a-f0-9]{64}$/.test(row.observed_hash))).toBe(true);
    expect(requests).toEqual(models.map(() => ({ method: 'HEAD', authorization: 'Bearer local-audit-only' })));
    await configure({ mode: 'http', url: 'https://api.kie.ai/audit-local', expectedHash: 'changed' });
    expect(await run()).toMatchObject({ discrepancies: 2, degraded: 0 });
    expect((await checks()).slice(2).every(row => row.status === 'changed')).toBe(true);
  });
  it.each([404, 503])('records consecutive HTTP %s discrepancies and resets on recovery', async code => {
    status = code;
    expect(await run()).toMatchObject({ discrepancies: 2, degraded: 0 });
    expect(await run()).toMatchObject({ discrepancies: 2, degraded: 2 });
    status = 200;
    expect(await run()).toMatchObject({ discrepancies: 0, degraded: 0 });
    expect((await checks()).map(row => row.consecutive_discrepancies)).toEqual([1, 1, 2, 2, 0, 0]);
  });
  it('records connection loss without persisting transport details or credentials', async () => {
    disconnect = true;
    expect(await run()).toMatchObject({ checked: 2, discrepancies: 2 });
    expect((await checks()).map(row => row.sanitized_details)).toEqual([{ reason: 'network_error' }, { reason: 'network_error' }]);
    expect(JSON.stringify(await checks())).not.toContain('local-audit-only');
  });
  it('reports a failed bulk insert and retries without partial rows', async () => {
    insertFailure = 'before';
    await expect(run()).rejects.toMatchObject({ message: 'Injected check persistence outage' });
    expect(await checks()).toEqual([]);
    insertFailure = null;
    expect(await run()).toMatchObject({ checked: 2 });
    expect(await checks()).toHaveLength(2);
  });
  it('stops before provider requests when previous history cannot be read', async () => {
    historyFailure = true;
    await expect(run()).rejects.toMatchObject({ message: 'Injected history read outage' });
    expect(requests).toEqual([]); expect(await checks()).toEqual([]);
    historyFailure = false;
    expect(await run()).toMatchObject({ checked: 2 });
    expect(await checks()).toHaveLength(2);
  });
  it('preserves the latest discrepancy count for a model behind a busy history prefix', async () => {
    await db.query("insert into public.generation_model_provider_checks(release_id,model_id,status,consecutive_discrepancies,checked_at) values($1,$2,'error',7,'2006-01-01')", [fixture, models[1]]);
    await db.query("insert into public.generation_model_provider_checks(release_id,model_id,status,consecutive_discrepancies,checked_at) select $1,$2,'available',0,'2006-02-01'::timestamptz+n*interval '1 minute' from generate_series(1,101) n", [fixture, models[0]]);
    status = 503;
    expect(await run()).toMatchObject({ checked: 2, discrepancies: 2, degraded: 1 });
    expect((await checks()).slice(-2)).toEqual([
      expect.objectContaining({ model_id: models[0], consecutive_discrepancies: 1 }),
      expect.objectContaining({ model_id: models[1], consecutive_discrepancies: 8 }),
    ]);
  });
  it('uses insertion identity to resolve equal check timestamps', async () => {
    await db.query("insert into public.generation_model_provider_checks(release_id,model_id,status,consecutive_discrepancies,checked_at) values($1,$2,'error',7,'2006-01-01'),($1,$2,'available',0,'2006-01-01')", [fixture, models[1]]);
    status = 503;
    expect(await run()).toMatchObject({ checked: 2, discrepancies: 2, degraded: 0 });
    expect((await checks()).slice(-2).map(row => row.consecutive_discrepancies)).toEqual([1, 1]);
  });
  it('retains a committed snapshot after lost acknowledgement and records a later retry', async () => {
    insertFailure = 'after'; status = 503;
    await expect(run()).rejects.toMatchObject({ message: 'Injected check persistence outage' });
    expect(await checks()).toHaveLength(2);
    insertFailure = null;
    expect(await run()).toMatchObject({ checked: 2, degraded: 2 });
    expect(await checks()).toHaveLength(4);
  });
  it('uses the real eight-second HTTP timeout and persists sanitized errors', async () => {
    hold = true; const started = Date.now();
    expect(await run()).toMatchObject({ checked: 2, discrepancies: 2 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(7500);
    expect(Date.now() - started).toBeLessThan(11500);
    expect((await checks()).map(row => row.sanitized_details)).toEqual([{ reason: 'timeout' }, { reason: 'timeout' }]);
  }, 15000);
  it('records a managed history outage then a successful retry', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(managedNow);
    historyFailure = true;
    expect(await managed()).toMatchObject({ status: 'failed', success: false });
    expect((await runs())[0]).toMatchObject({ status: 'failed', error_message: 'Injected history read outage' });
    expect(requests).toEqual([]);
    historyFailure = false;
    expect(await managed()).toMatchObject({ status: 'succeeded', summary: { checked: 2 } });
    expect((await runs()).map(row => row.status)).toEqual(['failed', 'succeeded']);
  });
  it('suppresses overlapping managed provider requests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(managedNow);
    hold = true;
    const boundary = new Promise<void>(resolve => { received = () => { if (requests.length === 2) resolve(); }; });
    const first = managed();
    try {
      await boundary;
      expect(await managed()).toMatchObject({ status: 'skipped', reason: 'already_running' });
      expect(requests).toHaveLength(2);
      hold = false; held.forEach(response => { response.statusCode = 200; response.end(); });
      expect(await first).toMatchObject({ status: 'succeeded' });
      expect((await runs()).map(row => row.status).sort()).toEqual(['skipped', 'succeeded']);
      expect(await checks()).toHaveLength(2);
    } finally { server.closeAllConnections(); await first; }
  });
  it('waits for an abandoned managed lease to expire', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(managedNow);
    const acquired = await admin.rpc('try_acquire_backend_job_lock', { p_name: 'generation-model-verification', p_ttl_seconds: 1, p_locked_by: `audit-model-${fixture}-abandoned` });
    expect(acquired.error).toBeNull(); expect(acquired.data).toBe(true);
    expect(await managed()).toMatchObject({ status: 'skipped', reason: 'already_running' });
    expect(requests).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(await managed()).toMatchObject({ status: 'succeeded' });
    expect(await checks()).toHaveLength(2);
  });
  it.each(['provider-completed', 'snapshot-committed'])('recovers after SIGKILL at %s', async checkpoint => {
    vi.spyOn(Date, 'now').mockReturnValue(managedNow);
    const child = fork('src/__tests__/model-verification-worker.cjs', [], {
      execArgv: ['--import', 'tsx'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tsconfig.mobile-push-worker.json', AUDIT_STORAGE_CONFIG: configPath, AUDIT_REQUEST_ID: `audit-model-${fixture}-killed`, AUDIT_PROVIDER_URL: destination, AUDIT_STOP_PHASE: checkpoint },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child did not reach checkpoint')), 8000);
        child.once('message', message => { clearTimeout(timer); if ((message as { stage: string }).stage === checkpoint) resolve(); else reject(new Error('Worker failed')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited early')); });
      });
      const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
      child.kill('SIGKILL'); expect(await exited).toBe('SIGKILL');
      expect(await checks()).toHaveLength(checkpoint === 'snapshot-committed' ? 2 : 0);
      expect((await runs())[0]).toMatchObject({ status: 'started' });
      expect(await managed()).toMatchObject({ status: 'skipped', reason: 'already_running' });
      await new Promise(resolve => setTimeout(resolve, 2200));
      expect(await managed()).toMatchObject({ status: 'succeeded', summary: { checked: 2 } });
      expect(await checks()).toHaveLength(checkpoint === 'snapshot-committed' ? 4 : 2);
      expect((await runs()).map(row => row.status).sort()).toEqual(['skipped', 'started', 'succeeded']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      }
    }
  }, 15000);
});
