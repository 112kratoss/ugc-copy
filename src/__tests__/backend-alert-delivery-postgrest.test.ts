import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/backend-alerts', () => ({ collectBackendAlerts: vi.fn() }));
vi.mock('@/lib/backend-logger', () => ({ logBackendError: vi.fn(), logBackendEvent: vi.fn(), logBackendWarning: vi.fn() }));
vi.mock('@/lib/provider-dependency-telemetry', async () => ({ ...await vi.importActual<Record<string, unknown>>('@/lib/provider-dependency-telemetry'), recordProviderDependencyEvent: vi.fn() }));
import { collectBackendAlerts, type BackendAlertSummary } from '@/lib/backend-alerts';
import { runBackendAlertDeliveryJob } from '@/lib/backend-job-executions';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('alert dispatch with actual HTTP and durable job state', () => {
  let db: Client;
  let admin: SupabaseClient;
  let server: Server;
  let destination: string;
  let prefix: string;
  let requests: Array<{ body: Record<string, unknown>; authorization?: string; dedupe?: string }>;
  let mode: 'accept' | 'reject' | 'disconnect' | 'hold';
  let held: ServerResponse | null;
  let received: (() => void) | undefined;
  let sequence: number;
  const summary = (quiet = false): BackendAlertSummary => ({
    status: quiet ? 'ok' : 'degraded', checkedAt: '2026-10-05T16:00:00Z', buildId: 'audit',
    counts: { total: quiet ? 0 : 1, degraded: quiet ? 0 : 1, warning: 0 },
    signals: { healthStatus: quiet ? 'ok' : 'degraded', costStatus: 'ok', costWindowHours: 24, moderationStatus: 'ok', moderationOpenCount: 0, moderationOldestAgeMinutes: null },
    delivery: { severity: quiet ? 'ok' : 'degraded', title: 'Audit fixture', summary: 'Local only', dedupeKey: quiet ? 'backend-alerts:ok' : 'backend-alerts:degraded:AUDIT_FIXTURE', runbookPath: 'docs/production-deployment-runbook.md', monitorEndpoints: [] },
    monitorEndpoints: [], alerts: quiet ? [] : [{ source: 'health', severity: 'degraded', code: 'AUDIT_FIXTURE', message: 'Local only' }],
  });
  const run = () => runBackendAlertDeliveryJob({ serviceClient: admin, requestId: `${prefix}-${sequence++}` });
  const runs = async () => (await db.query('select status,summary,error_message,skip_reason from public.backend_job_runs where request_id like $1 order by started_at,id', [prefix + '%'])).rows;
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 }); await db.connect();
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), authorization: request.headers.authorization, dedupe: request.headers['x-magicbooklet-alert-dedupe-key'] as string });
      if (mode === 'hold') held = response;
      received?.();
      if (mode === 'disconnect') request.socket.destroy();
      else if (mode !== 'hold') { response.statusCode = mode === 'reject' ? 503 : 202; response.end('{}'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing local receiver');
    destination = `http://127.0.0.1:${address.port}/audit`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db?.end();
  });
  beforeEach(() => {
    prefix = 'audit-alert-' + randomUUID(); sequence = 0; requests = []; mode = 'accept'; held = null; received = undefined;
    vi.mocked(collectBackendAlerts).mockReset().mockResolvedValue(summary());
    vi.stubEnv('BACKEND_ALERT_DELIVERY_URL', destination);
    vi.stubEnv('BACKEND_ALERT_DELIVERY_AUTH_HEADER', 'Bearer local-audit-only');
    vi.stubEnv('BACKEND_ALERT_DELIVERY_NOTIFY_OK', 'false');
  });
  afterEach(async () => {
    held?.destroy(); received = undefined;
    vi.unstubAllEnvs();
    try {
      expect((await db.query('select name from public.backend_job_locks where locked_by like $1', ['%' + prefix + '%'])).rows).toEqual([]);
    } finally {
      await db.query('delete from public.backend_job_runs where request_id like $1', [prefix + '%']);
      expect(await runs()).toEqual([]);
    }
  });
  it('collects the real isolated backend reports and persists the receiver result', async () => {
    const actual = await vi.importActual<typeof import('@/lib/backend-alerts')>('@/lib/backend-alerts');
    vi.mocked(collectBackendAlerts).mockImplementation(actual.collectBackendAlerts);
    vi.stubEnv('BACKEND_ALERT_DELIVERY_NOTIFY_OK', 'true');
    expect(await run()).toMatchObject({ success: true, status: 'succeeded', summary: { delivered: true } });
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({ event: 'backend_alerts', counts: { total: expect.any(Number) }, signals: { costWindowHours: 24 } });
    expect((await runs())[0]).toMatchObject({ status: 'succeeded', summary: { delivered: true } });
  });
  it('records collector failure without contacting the receiver', async () => {
    vi.mocked(collectBackendAlerts).mockRejectedValue(new Error('Injected collector outage'));
    expect(await run()).toMatchObject({ success: false, status: 'failed' });
    expect(requests).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ status: 'failed', error_message: 'Injected collector outage' });
  });
  it('runs after an abandoned short test lease really expires', async () => {
    const acquired = await admin.rpc('try_acquire_backend_job_lock', {
      p_name: 'backend-alert-delivery', p_ttl_seconds: 1, p_locked_by: prefix + '-abandoned',
    });
    expect(acquired.error).toBeNull(); expect(acquired.data).toBe(true);
    expect(await run()).toMatchObject({ status: 'skipped', reason: 'already_running' });
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(await run()).toMatchObject({ status: 'succeeded', summary: { delivered: true } });
    expect(requests).toHaveLength(1);
  });
  it('recovers after SIGKILL at the receiver boundary and real lease expiry', async () => {
    mode = 'hold';
    let timer: ReturnType<typeof setTimeout>;
    const boundary = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Child never reached local receiver')), 8000);
      received = () => { clearTimeout(timer); resolve(); };
    });
    const child = fork('src/__tests__/backend-alert-delivery-worker.cjs', [], {
      execArgv: ['--import', 'tsx'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tsconfig.mobile-push-worker.json', AUDIT_STORAGE_CONFIG: configPath, AUDIT_REQUEST_ID: prefix + '-killed', BACKEND_ALERT_DELIVERY_URL: destination, BACKEND_ALERT_DELIVERY_NOTIFY_OK: 'true' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      await boundary;
      const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
      child.kill('SIGKILL'); expect(await exited).toBe('SIGKILL');
      expect((await runs())[0]).toMatchObject({ status: 'started' });
      mode = 'accept';
      expect(await run()).toMatchObject({ status: 'skipped', reason: 'already_running' });
      await new Promise(resolve => setTimeout(resolve, 2200));
      expect(await run()).toMatchObject({ status: 'succeeded', summary: { delivered: true } });
      expect(requests).toHaveLength(2);
      expect((await runs()).map(row => row.status).sort()).toEqual(['skipped', 'started', 'succeeded']);
    } finally {
      clearTimeout(timer!);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      }
    }
  }, 15000);
  it('records unconfigured dispatch without collecting or sending', async () => {
    vi.stubEnv('BACKEND_ALERT_DELIVERY_URL', '');
    expect(await run()).toMatchObject({ success: true, status: 'skipped', summary: { configured: false, delivered: false } });
    expect(collectBackendAlerts).not.toHaveBeenCalled(); expect(requests).toEqual([]);
    expect(await runs()).toEqual([expect.objectContaining({ status: 'skipped' })]);
  });
  it('records quiet suppression and honors explicit notify-ok', async () => {
    vi.mocked(collectBackendAlerts).mockResolvedValue(summary(true));
    expect(await run()).toMatchObject({ status: 'succeeded', summary: { delivered: false, reason: 'no_alerts' } });
    expect(requests).toHaveLength(0);
    vi.stubEnv('BACKEND_ALERT_DELIVERY_NOTIFY_OK', 'true');
    expect(await run()).toMatchObject({ status: 'succeeded', summary: { delivered: true, responseStatus: 202 } });
    expect(requests).toHaveLength(1);
    expect((await runs()).map(row => row.status)).toEqual(['succeeded', 'succeeded']);
  });
  it('persists an accepted delivery with the receiver auth and dedupe headers', async () => {
    expect(await run()).toMatchObject({ status: 'succeeded', summary: { delivered: true, responseStatus: 202 } });
    expect(requests).toEqual([expect.objectContaining({ authorization: 'Bearer local-audit-only', dedupe: summary().delivery.dedupeKey, body: expect.objectContaining({ event: 'backend_alerts', source: 'magicbooklet-backend' }) })]);
    expect(await runs()).toEqual([expect.objectContaining({ status: 'succeeded', summary: expect.objectContaining({ delivered: true }) })]);
  });
  it('records sink rejection and permits a later successful dispatch', async () => {
    mode = 'reject'; expect(await run()).toMatchObject({ success: false, status: 'failed' });
    mode = 'accept'; expect(await run()).toMatchObject({ success: true, status: 'succeeded' });
    expect(requests).toHaveLength(2);
    expect((await runs()).map(row => row.status)).toEqual(['failed', 'succeeded']);
    expect((await runs())[0].error_message).toContain('503');
  });
  it('retries a lost acknowledgement with a stable dedupe key but no exactly-once claim', async () => {
    mode = 'disconnect'; expect(await run()).toMatchObject({ success: false, status: 'failed' });
    mode = 'accept'; expect(await run()).toMatchObject({ success: true, status: 'succeeded' });
    expect(requests).toHaveLength(2);
    expect(requests.map(request => request.dedupe)).toEqual([summary().delivery.dedupeKey, summary().delivery.dedupeKey]);
    expect((await runs()).map(row => row.status)).toEqual(['failed', 'succeeded']);
  });
  it('bounds an unacknowledged HTTP request and releases the job lock', async () => {
    mode = 'hold'; const started = Date.now();
    expect(await run()).toMatchObject({ success: false, status: 'failed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    expect(Date.now() - started).toBeLessThan(9000);
    expect(requests).toHaveLength(1);
    expect((await runs())[0].error_message).toContain('timed out');
  }, 12000);
  it('suppresses overlapping dispatch while the first HTTP acknowledgement is pending', async () => {
    mode = 'hold'; const boundary = new Promise<void>(resolve => { received = resolve; });
    const first = run();
    try {
      await boundary;
      expect(await run()).toMatchObject({ status: 'skipped', reason: 'already_running' });
      expect(requests).toHaveLength(1);
      held!.statusCode = 202; held!.end('{}');
      expect(await first).toMatchObject({ status: 'succeeded' });
      expect((await runs()).map(row => row.status).sort()).toEqual(['skipped', 'succeeded']);
    } finally { held?.destroy(); await first; }
  });
});
