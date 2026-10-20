// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { BACKEND_JOBS_BY_NAME } from '@/lib/backend-jobs';

import {
  createFakeBackendJobRunsDatabase,
  createFakeKieAndAlertReceiver,
} from './fixtures/fake-backend-job-runs-database';

const KIE_KEY = 'kie-live-key-7f3a9c41-never-print-me';
const RECEIVER_URL = 'https://alerts.example.com/hooks/backend';
// Minute 0 of the hour: the managed runner also prunes old job runs then.
const T0 = Date.parse('2026-10-20T06:00:00.000Z');

describe('the kie-account-balance backend job', () => {
  let clock: { nowMs: number };
  let db: ReturnType<typeof createFakeBackendJobRunsDatabase>;
  let providers: ReturnType<typeof createFakeKieAndAlertReceiver>;
  let logs: BackendLogRecord[];
  let restoreSink: () => void;
  let runs: number;

  beforeEach(() => {
    clock = { nowMs: T0 };
    db = createFakeBackendJobRunsDatabase(clock);
    providers = createFakeKieAndAlertReceiver(RECEIVER_URL);
    logs = [];
    restoreSink = setBackendLogSink((record) => logs.push(record));
    vi.stubEnv('KIE_AI_API_KEY', KIE_KEY);
    vi.stubEnv('BACKEND_ALERT_DELIVERY_URL', RECEIVER_URL);
    vi.stubEnv('KIE_BALANCE_ALERT_CREDITS', '');
    vi.stubGlobal('fetch', providers.fetcher);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    runs = 0;
  });

  afterEach(() => {
    restoreSink();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function runJob(atMs: number) {
    clock.nowMs = atMs;
    runs += 1;
    const { runKieAccountBalanceBackendJob } = await import('@/lib/backend-job-executions');
    return runKieAccountBalanceBackendJob({
      serviceClient: db.client as never,
      requestId: `scheduler-${runs}:kie-account-balance`,
      startedAtMs: atMs,
      triggerRoute: '/api/cron/backend-jobs',
    });
  }

  it('is a light ten-minute job on the shared scheduler', () => {
    expect(BACKEND_JOBS_BY_NAME['kie-account-balance']).toMatchObject({
      route: '/api/cron/kie-account-balance',
      schedule: '*/10 * * * *',
      dispatch: 'scheduler',
      noWorkSkipReason: 'kie_api_key_not_configured',
    });
  });

  it('alerts once per crossing and keeps its state on its own run rows', async () => {
    providers.state.balance = 845.32;

    expect(await runJob(T0)).toMatchObject({
      success: true,
      status: 'succeeded',
      summary: { transition: 'raised', episodeLevel: 'low', read: { ok: true, credits: 845.32 } },
    });
    expect(await runJob(T0 + 10 * 60_000)).toMatchObject({
      status: 'succeeded',
      summary: { transition: 'none', episodeLevel: 'low' },
    });

    expect(providers.posts).toHaveLength(1);
    expect(providers.state.kieCalls).toBe(2);
    expect(db.runs.map((row) => [row.status, (row.summary as { transition?: string } | null)?.transition])).toEqual([
      ['succeeded', 'raised'],
      ['succeeded', 'none'],
    ]);
    expect(db.runs[0]).toMatchObject({ metadata: { triggerRoute: '/api/cron/backend-jobs' } });
    expect(db.locks.size).toBe(0);
    expect(JSON.stringify(logs)).not.toContain(KIE_KEY);
  });

  it('skips as healthy no-work when no Kie key is configured', async () => {
    vi.stubEnv('KIE_AI_API_KEY', '');

    expect(await runJob(T0)).toMatchObject({
      success: true,
      status: 'skipped',
      reason: 'kie_api_key_not_configured',
    });
    expect(providers.state.kieCalls).toBe(0);
  });

  it('never fails the run for failed reads, so backend health and the release gate stay clean', async () => {
    providers.state.balance = 'http_500';

    expect(await runJob(T0)).toMatchObject({ status: 'succeeded', summary: { consecutiveFailures: 1 } });
    expect(await runJob(T0 + 10 * 60_000)).toMatchObject({ status: 'succeeded', summary: { consecutiveFailures: 2 } });
    // The third in a row is reported on /api/ops/backend-alerts as KIE_BALANCE_CHECK_FAILING.
    const third = await runJob(T0 + 20 * 60_000);
    expect(third).toMatchObject({ status: 'succeeded', summary: { consecutiveFailures: 3 } });
    expect(JSON.stringify(third)).not.toContain(KIE_KEY);
    expect(db.runs[2]).toMatchObject({
      status: 'succeeded',
      summary: expect.objectContaining({ consecutiveFailures: 3 }),
    });

    providers.state.balance = 9000;
    expect(await runJob(T0 + 30 * 60_000)).toMatchObject({
      status: 'succeeded',
      summary: { consecutiveFailures: 0, read: { ok: true, credits: 9000 } },
    });
  });
});
