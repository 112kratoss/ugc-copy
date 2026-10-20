// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  DEFAULT_KIE_BALANCE_ALERT_CREDITS,
  KIE_ACCOUNT_BALANCE_JOB_NAME,
  checkKieAccountBalance,
  collectKieBalanceStatus,
  resolveKieBalanceAlertPolicy,
  type KieBalanceCheckSummary,
  kieBalanceAlertFromStatus,
} from '@/lib/kie-account-balance-alert';

import {
  createFakeBackendJobRunsDatabase,
  createFakeKieAndAlertReceiver,
} from './fixtures/fake-backend-job-runs-database';

const KIE_KEY = 'kie-live-key-7f3a9c41-never-print-me';
const RECEIVER_URL = 'https://alerts.example.com/hooks/backend';
const RECEIVER_AUTH = 'Bearer receiver-secret-1';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    KIE_AI_API_KEY: KIE_KEY,
    BACKEND_ALERT_DELIVERY_URL: RECEIVER_URL,
    BACKEND_ALERT_DELIVERY_AUTH_HEADER: RECEIVER_AUTH,
    ...overrides,
  };
}

const T0 = Date.parse('2026-10-20T06:00:00.000Z');
const minutes = (count: number) => T0 + count * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('Kie balance alert policy', () => {
  it('defaults the threshold to 2000 credits and recovers 10% above it', () => {
    expect(DEFAULT_KIE_BALANCE_ALERT_CREDITS).toBe(2000);
    expect(resolveKieBalanceAlertPolicy({ NODE_ENV: 'test' })).toEqual({
      thresholdCredits: 2000,
      recoveryCredits: 2200,
      source: 'default',
    });
  });

  it('reads KIE_BALANCE_ALERT_CREDITS and ignores a value that is not a positive number', () => {
    expect(resolveKieBalanceAlertPolicy({ NODE_ENV: 'test', KIE_BALANCE_ALERT_CREDITS: ' 5000 ' })).toEqual({
      thresholdCredits: 5000,
      recoveryCredits: 5500,
      source: 'env',
    });
    for (const value of ['abc', '0', '-20', 'Infinity']) {
      expect(resolveKieBalanceAlertPolicy({ NODE_ENV: 'test', KIE_BALANCE_ALERT_CREDITS: value })).toEqual({
        thresholdCredits: 2000,
        recoveryCredits: 2200,
        source: 'invalid_env',
      });
    }
  });
});

describe('checkKieAccountBalance', () => {
  let clock: { nowMs: number };
  let db: ReturnType<typeof createFakeBackendJobRunsDatabase>;
  let providers: ReturnType<typeof createFakeKieAndAlertReceiver>;
  let logs: BackendLogRecord[];
  let restoreSink: () => void;
  let consoleOutput: string[];
  let checks: number;

  beforeEach(() => {
    clock = { nowMs: T0 };
    db = createFakeBackendJobRunsDatabase(clock);
    providers = createFakeKieAndAlertReceiver(RECEIVER_URL);
    logs = [];
    restoreSink = setBackendLogSink((record) => logs.push(record));
    consoleOutput = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
    }
    checks = 0;
  });

  afterEach(() => {
    restoreSink();
    vi.restoreAllMocks();
  });

  /**
   * One check as its runner makes it: a started row carrying the lock owner,
   * then the check. The row is deliberately never finished, so every test also
   * proves the check records its own state before it gives up the lock.
   */
  async function check(
    atMs: number,
    options: { trigger?: 'schedule' | 'provider-refusal'; environment?: NodeJS.ProcessEnv } = {},
  ): Promise<KieBalanceCheckSummary> {
    clock.nowMs = atMs;
    checks += 1;
    const lockOwner = `${KIE_ACCOUNT_BALANCE_JOB_NAME}:check-${checks}:${atMs}`;
    db.runs.push({
      id: `started-${checks}`,
      job_name: KIE_ACCOUNT_BALANCE_JOB_NAME,
      route: '/api/cron/kie-account-balance',
      request_id: `check-${checks}`,
      lock_owner: lockOwner,
      status: 'started',
      started_at: iso(atMs),
      summary: null,
    });
    return checkKieAccountBalance(db.client as never, {
      trigger: options.trigger ?? 'schedule',
      lockOwner,
      now: new Date(atMs),
      environment: options.environment ?? env(),
      fetcher: providers.fetcher,
    });
  }

  it('raises once when the balance crosses below the threshold, and stays quiet on later polls', async () => {
    providers.state.balance = 2500;
    expect(await check(minutes(0))).toMatchObject({ transition: 'none', episodeLevel: 'ok', delivery: null });

    providers.state.balance = 1900;
    const raised = await check(minutes(10));
    expect(raised).toMatchObject({
      transition: 'raised',
      episodeLevel: 'low',
      episodeStartedAt: iso(minutes(10)),
      read: { ok: true, credits: 1900 },
      // An open episode is degraded on both paths: it is what makes /api/ops/backend-alerts answer 503.
      delivery: { configured: true, delivered: true, severity: 'degraded', responseStatus: 202 },
    });
    expect(providers.posts).toHaveLength(1);
    const [{ body, headers }] = providers.posts;
    expect(body).toMatchObject({
      event: 'backend_alerts',
      source: 'magicbooklet-backend',
      status: 'degraded',
      delivery: {
        severity: 'degraded',
        dedupeKey: `kie-account-balance:${iso(minutes(10))}`,
        runbookPath: 'docs/production-deployment-runbook.md#alert-response-guide',
      },
      counts: { total: 1, degraded: 1, warning: 0 },
      alerts: [expect.objectContaining({ severity: 'degraded', code: 'KIE_BALANCE_LOW' })],
    });
    expect(String((body.delivery as Record<string, unknown>).summary)).toContain('1900');
    expect(headers.get('x-magicbooklet-alert-status')).toBe('degraded');
    expect(headers.get('x-magicbooklet-alert-dedupe-key')).toBe(`kie-account-balance:${iso(minutes(10))}`);
    expect(headers.get('authorization')).toBe(RECEIVER_AUTH);

    providers.state.balance = 1700;
    expect(await check(minutes(20))).toMatchObject({
      transition: 'none',
      episodeLevel: 'low',
      delivery: null,
      lastObservation: { credits: 1700, observedAt: iso(minutes(20)) },
    });
    providers.state.balance = 1650;
    await check(minutes(30));
    expect(providers.posts).toHaveLength(1);
  });

  it('records recovery once the balance is back above the recovery level, then alerts on the next crossing', async () => {
    const notifyOk = env({ BACKEND_ALERT_DELIVERY_NOTIFY_OK: 'true' });
    providers.state.balance = 1900;
    await check(minutes(0), { environment: notifyOk });

    // Inside the band between the threshold and the recovery level: a Kie
    // refund of a few credits must not flap the alert.
    providers.state.balance = 2100;
    expect(await check(minutes(10), { environment: notifyOk })).toMatchObject({ transition: 'none', episodeLevel: 'low' });

    providers.state.balance = 9000;
    expect(await check(minutes(20), { environment: notifyOk })).toMatchObject({
      transition: 'resolved',
      episodeLevel: 'ok',
      episodeStartedAt: null,
      delivery: { delivered: true, severity: 'ok' },
    });
    expect(providers.posts).toHaveLength(2);
    expect(providers.posts[1].body).toMatchObject({
      status: 'ok',
      delivery: { severity: 'ok', dedupeKey: `kie-account-balance:${iso(minutes(0))}` },
      counts: { total: 0 },
      alerts: [],
    });

    providers.state.balance = 1500;
    expect(await check(minutes(30), { environment: notifyOk })).toMatchObject({
      transition: 'raised',
      episodeStartedAt: iso(minutes(30)),
    });
    expect(providers.posts).toHaveLength(3);
    expect(providers.posts[2].body).toMatchObject({
      delivery: { dedupeKey: `kie-account-balance:${iso(minutes(30))}` },
    });
  });

  it('records a recovery without posting it unless notify-ok is set', async () => {
    providers.state.balance = 1900;
    await check(minutes(0));
    providers.state.balance = 9000;

    expect(await check(minutes(10))).toMatchObject({
      transition: 'resolved',
      episodeLevel: 'ok',
      delivery: { delivered: false, reason: 'notify_ok_disabled', severity: 'ok' },
    });
    expect(providers.posts).toHaveLength(1);
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'kie_balance_alert_resolved', credits: 9000 }));
  });

  it('raises the alert at a provider refusal, and the next poll does not raise it again', async () => {
    providers.state.balance = 12;

    expect(await check(minutes(3), { trigger: 'provider-refusal' })).toMatchObject({
      trigger: 'provider-refusal',
      transition: 'raised',
      episodeLevel: 'exhausted',
      delivery: { delivered: true, severity: 'degraded' },
    });
    expect(providers.posts).toHaveLength(1);
    expect(providers.posts[0].body).toMatchObject({
      status: 'degraded',
      delivery: { severity: 'degraded', dedupeKey: `kie-account-balance:${iso(minutes(3))}` },
      alerts: [expect.objectContaining({ severity: 'degraded', code: 'KIE_BALANCE_EXHAUSTED' })],
    });

    expect(await check(minutes(10))).toMatchObject({ transition: 'none', episodeLevel: 'exhausted' });
    expect(await check(minutes(20), { trigger: 'provider-refusal' })).toMatchObject({ transition: 'none' });
    expect(providers.posts).toHaveLength(1);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'error',
      msg: 'kie_balance_alert_raised',
      episodeLevel: 'exhausted',
    }));
  });

  it('escalates the poll\'s episode once when a refusal follows it, under the same dedupe key', async () => {
    providers.state.balance = 1500;
    await check(minutes(0));
    providers.state.balance = 3;

    expect(await check(minutes(4), { trigger: 'provider-refusal' })).toMatchObject({
      transition: 'escalated',
      episodeLevel: 'exhausted',
      episodeStartedAt: iso(minutes(0)),
    });
    await check(minutes(9), { trigger: 'provider-refusal' });
    await check(minutes(10));

    expect(providers.posts.map((post) => [
      (post.body.delivery as Record<string, unknown>).severity,
      (post.body.delivery as Record<string, unknown>).dedupeKey,
    ])).toEqual([
      ['degraded', `kie-account-balance:${iso(minutes(0))}`],
      ['degraded', `kie-account-balance:${iso(minutes(0))}`],
    ]);
  });

  it('raises at a refusal even when the balance cannot be read', async () => {
    providers.state.balance = 'network_error';

    const summary = await check(minutes(0), { trigger: 'provider-refusal' });

    expect(summary).toMatchObject({
      transition: 'raised',
      episodeLevel: 'exhausted',
      read: { ok: false, reason: 'network_error' },
      consecutiveFailures: 1,
    });
    expect(String((providers.posts[0].body.delivery as Record<string, unknown>).summary))
      .toMatch(/could not be read/i);
  });

  it('keeps a raise whose delivery failed pending, and retries it under the same dedupe key', async () => {
    providers.state.balance = 1900;
    providers.state.receiverStatus = 503;

    // The episode is open (the alerts endpoint reports it) while the push stays behind.
    expect(await check(minutes(0))).toMatchObject({
      transition: 'raised',
      episodeLevel: 'low',
      notifiedLevel: 'ok',
      episodeStartedAt: iso(minutes(0)),
      delivery: { delivered: false, reason: 'failed' },
      consecutiveFailures: 1,
    });

    providers.state.receiverStatus = 202;
    expect(await check(minutes(10))).toMatchObject({
      transition: 'raised',
      episodeLevel: 'low',
      notifiedLevel: 'low',
      delivery: { delivered: true },
      consecutiveFailures: 0,
    });
    expect(providers.posts.map((post) => post.headers.get('x-magicbooklet-alert-dedupe-key'))).toEqual([
      `kie-account-balance:${iso(minutes(0))}`,
      `kie-account-balance:${iso(minutes(0))}`,
    ]);
    await check(minutes(20));
    expect(providers.posts).toHaveLength(2);
  });

  it('rides out failed reads without ever failing the run, counting them for the alert', async () => {
    providers.state.balance = 1900;
    await check(minutes(0));

    providers.state.balance = 'http_500';
    expect(await check(minutes(10))).toMatchObject({
      read: { ok: false, reason: 'http_error', httpStatus: 500 },
      episodeLevel: 'low',
      transition: 'none',
      consecutiveFailures: 1,
      lastObservation: { credits: 1900, observedAt: iso(minutes(0)) },
    });
    expect(await check(minutes(20))).toMatchObject({ consecutiveFailures: 2 });

    // The third in a row is reported on /api/ops/backend-alerts (kieBalanceAlertFromStatus),
    // never as a failed run: backend health would report that and hold every release.
    const third = await check(minutes(30));
    expect(third).toMatchObject({ consecutiveFailures: 3, episodeLevel: 'low' });
    expect(JSON.stringify(third)).not.toContain(KIE_KEY);

    providers.state.balance = 1800;
    expect(await check(minutes(40))).toMatchObject({
      read: { ok: true, credits: 1800 },
      consecutiveFailures: 0,
      transition: 'none',
    });
    expect(providers.posts).toHaveLength(1);
  });

  it('records the raise when no alert destination is configured, without raising it again', async () => {
    const unconfigured = env({ BACKEND_ALERT_DELIVERY_URL: '' });
    providers.state.balance = 845.32;

    expect(await check(minutes(0), { environment: unconfigured })).toMatchObject({
      transition: 'raised',
      episodeLevel: 'low',
      delivery: { configured: false, delivered: false, reason: 'not_configured', severity: 'degraded' },
    });
    expect(await check(minutes(10), { environment: unconfigured })).toMatchObject({ transition: 'none' });
    expect(providers.posts).toHaveLength(0);
    expect(logs.filter((record) => record.msg === 'kie_balance_alert_raised')).toEqual([
      expect.objectContaining({ level: 'error', credits: 845.32, thresholdCredits: 2000, delivered: false }),
    ]);
  });

  it('reads its state only from its own summaries', async () => {
    providers.state.balance = 1900;
    await check(minutes(0));
    db.runs.push(
      {
        id: 'skip-1',
        job_name: KIE_ACCOUNT_BALANCE_JOB_NAME,
        lock_owner: 'other',
        status: 'skipped',
        started_at: iso(minutes(5)),
        summary: { configured: false },
      },
      {
        id: 'other-job',
        job_name: 'backend-alert-delivery',
        lock_owner: 'other-2',
        status: 'succeeded',
        started_at: iso(minutes(6)),
        summary: {
          kind: 'kie-account-balance',
          version: 1,
          checkedAt: iso(minutes(6)),
          read: { ok: true, credits: 50_000 },
          episodeLevel: 'ok',
          notifiedLevel: 'ok',
        },
      },
    );

    expect(await check(minutes(10))).toMatchObject({ transition: 'none', episodeLevel: 'low' });
    expect(providers.posts).toHaveLength(1);
  });

  it('fails the check, without reading Kie, when its previous state cannot be read', async () => {
    db.failReads(true);

    await expect(check(minutes(0))).rejects.toThrow('database unavailable');
    expect(providers.state.kieCalls).toBe(0);
  });

  it('never writes the Kie key to a summary, an alert, a log line or the console', async () => {
    providers.state.balance = 1900;
    const summaries: unknown[] = [await check(minutes(0))];
    providers.state.balance = 'network_error';
    summaries.push(await check(minutes(10)));
    providers.state.balance = 3;
    summaries.push(await check(minutes(12), { trigger: 'provider-refusal' }));
    providers.state.receiverStatus = 500;
    providers.state.balance = 9000;
    summaries.push(await check(minutes(20), { environment: env({ BACKEND_ALERT_DELIVERY_NOTIFY_OK: 'true' }) }));

    const stored = [
      JSON.stringify(summaries),
      JSON.stringify(db.runs),
      JSON.stringify(logs),
      ...consoleOutput,
    ].join('\n');
    const sent = JSON.stringify(providers.posts.map((post) => ({
      body: post.body,
      headers: [...post.headers.entries()],
    })));
    expect(`${stored}\n${sent}`).not.toContain(KIE_KEY);
    // The receiver's own credential goes only to the receiver.
    expect(stored).not.toContain(RECEIVER_AUTH);
    expect(providers.posts.length).toBeGreaterThan(0);
  });
});

describe('collectKieBalanceStatus', () => {
  it('reports the last observed balance and the open alert for the ops dashboard', async () => {
    const clock = { nowMs: T0 };
    const db = createFakeBackendJobRunsDatabase(clock);
    const providers = createFakeKieAndAlertReceiver(RECEIVER_URL);
    providers.state.balance = 845.32;
    db.runs.push({
      id: 'started-1',
      job_name: KIE_ACCOUNT_BALANCE_JOB_NAME,
      lock_owner: 'owner-1',
      status: 'started',
      started_at: iso(T0),
      summary: null,
    });
    await checkKieAccountBalance(db.client as never, {
      trigger: 'schedule',
      lockOwner: 'owner-1',
      now: new Date(T0),
      environment: env({ BACKEND_ALERT_DELIVERY_URL: '' }),
      fetcher: providers.fetcher,
    });

    expect(await collectKieBalanceStatus(db.client as never, { environment: env() })).toEqual({
      available: true,
      error: null,
      thresholdCredits: 2000,
      recoveryCredits: 2200,
      episodeLevel: 'low',
      credits: 845.32,
      observedAt: iso(T0),
      lastCheckedAt: iso(T0),
      lastCheckError: null,
      consecutiveFailures: 0,
      episodeStartedAt: iso(T0),
    });
  });

  it('reports nothing observed before the first check', async () => {
    const db = createFakeBackendJobRunsDatabase({ nowMs: T0 });

    expect(await collectKieBalanceStatus(db.client as never, { environment: env() })).toMatchObject({
      available: true,
      episodeLevel: 'ok',
      credits: null,
      lastCheckedAt: null,
    });
  });

  it('degrades to unavailable instead of failing the dashboard', async () => {
    const db = createFakeBackendJobRunsDatabase({ nowMs: T0 });
    db.failReads(true);

    expect(await collectKieBalanceStatus(db.client as never, { environment: env() })).toMatchObject({
      available: false,
      error: 'database unavailable',
      credits: null,
    });
  });
});

describe('kieBalanceAlertFromStatus', () => {
  const status = {
    available: true,
    error: null,
    thresholdCredits: 2000,
    recoveryCredits: 2200,
    episodeLevel: 'ok' as const,
    credits: 25_000,
    observedAt: '2026-10-20T09:00:00.000Z',
    lastCheckedAt: '2026-10-20T09:30:00.000Z',
    lastCheckError: 'timeout' as const,
    consecutiveFailures: 0,
    episodeStartedAt: null,
  };

  it('reports a check failing three times in a row, so the watchdog mails the owner', () => {
    expect(kieBalanceAlertFromStatus({ ...status, consecutiveFailures: 2 })).toBeNull();
    expect(kieBalanceAlertFromStatus({ ...status, consecutiveFailures: 3 })).toMatchObject({
      code: 'KIE_BALANCE_CHECK_FAILING',
      message: expect.stringContaining('failed 3 times in a row (timeout)'),
    });
  });

  it('reports the open episode first, whatever the failure count', () => {
    expect(kieBalanceAlertFromStatus({ ...status, episodeLevel: 'low', credits: 845.32, consecutiveFailures: 4 }))
      .toMatchObject({ code: 'KIE_BALANCE_LOW' });
    expect(kieBalanceAlertFromStatus({ ...status, available: false, consecutiveFailures: 9 })).toBeNull();
  });
});

describe('Kie balance alert documentation', () => {
  it('documents the threshold variable and the two alert codes', () => {
    const template = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
    const runbook = fs.readFileSync(path.resolve(process.cwd(), 'docs/production-deployment-runbook.md'), 'utf8');

    // Booleans, so a failure names the missing text instead of printing the files.
    expect(template.includes('KIE_BALANCE_ALERT_CREDITS=')).toBe(true);
    expect({
      threshold: runbook.includes('`KIE_BALANCE_ALERT_CREDITS`'),
      low: runbook.includes('`KIE_BALANCE_LOW`'),
      exhausted: runbook.includes('`KIE_BALANCE_EXHAUSTED`'),
    }).toEqual({ threshold: true, low: true, exhausted: true });
  });
});
