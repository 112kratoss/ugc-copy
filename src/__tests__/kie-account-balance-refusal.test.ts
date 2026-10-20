// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  KIE_ACCOUNT_BALANCE_JOB_NAME,
  checkKieAccountBalance,
} from '@/lib/kie-account-balance-alert';
import {
  KIE_REFUSAL_CHECK_COOLDOWN_SECONDS,
  reportKieInsufficientCreditsRefusal,
  resetKieRefusalReportThrottle,
  runKieRefusalBalanceCheck,
} from '@/lib/kie-account-balance-refusal';

import {
  createFakeBackendJobRunsDatabase,
  createFakeKieAndAlertReceiver,
} from './fixtures/fake-backend-job-runs-database';

const KIE_KEY = 'kie-live-key-7f3a9c41-never-print-me';
const RECEIVER_URL = 'https://alerts.example.com/hooks/backend';
const T0 = Date.parse('2026-10-20T06:03:00.000Z');

function env(): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', KIE_AI_API_KEY: KIE_KEY, BACKEND_ALERT_DELIVERY_URL: RECEIVER_URL };
}

describe('reportKieInsufficientCreditsRefusal', () => {
  let logs: BackendLogRecord[];
  let restoreSink: () => void;

  beforeEach(() => {
    resetKieRefusalReportThrottle();
    logs = [];
    restoreSink = setBackendLogSink((record) => logs.push(record));
  });

  afterEach(() => {
    restoreSink();
  });

  it('schedules one balance check per instance per cooldown, behind the response', async () => {
    const scheduled: Array<() => Promise<unknown>> = [];
    const runCheck = vi.fn(async () => ({ status: 'skipped' as const, reason: 'recently_checked' as const }));
    const schedule = (task: () => Promise<unknown>) => {
      scheduled.push(task);
    };

    reportKieInsufficientCreditsRefusal({ nowMs: T0, schedule, runCheck });
    reportKieInsufficientCreditsRefusal({ nowMs: T0 + 1_000, schedule, runCheck });

    expect(KIE_REFUSAL_CHECK_COOLDOWN_SECONDS).toBe(600);
    expect(scheduled).toHaveLength(1);
    // Nothing runs in front of the creator's answer.
    expect(runCheck).not.toHaveBeenCalled();
    await scheduled[0]();
    expect(runCheck).toHaveBeenCalledTimes(1);

    reportKieInsufficientCreditsRefusal({ nowMs: T0 + KIE_REFUSAL_CHECK_COOLDOWN_SECONDS * 1_000, schedule, runCheck });
    expect(scheduled).toHaveLength(2);
  });

  it('never throws into the refusal it reports', async () => {
    expect(() => reportKieInsufficientCreditsRefusal({
      nowMs: T0,
      schedule: () => {
        throw new Error('after() is unavailable');
      },
    })).not.toThrow();
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'kie_balance_refusal_report_failed' }));

    resetKieRefusalReportThrottle();
    const scheduled: Array<() => Promise<unknown>> = [];
    reportKieInsufficientCreditsRefusal({
      nowMs: T0,
      schedule: (task) => {
        scheduled.push(task);
      },
      runCheck: async () => {
        throw new Error('database unavailable');
      },
    });
    await expect(scheduled[0]()).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      msg: 'kie_balance_refusal_check_failed',
      errorMessage: 'database unavailable',
    }));
  });
});

describe('runKieRefusalBalanceCheck', () => {
  let clock: { nowMs: number };
  let db: ReturnType<typeof createFakeBackendJobRunsDatabase>;
  let providers: ReturnType<typeof createFakeKieAndAlertReceiver>;
  let restoreSink: () => void;

  beforeEach(() => {
    clock = { nowMs: T0 };
    db = createFakeBackendJobRunsDatabase(clock);
    providers = createFakeKieAndAlertReceiver(RECEIVER_URL);
    restoreSink = setBackendLogSink(() => {});
  });

  afterEach(() => {
    restoreSink();
  });

  function refusalCheck(atMs: number) {
    clock.nowMs = atMs;
    return runKieRefusalBalanceCheck({
      client: db.client as never,
      nowMs: atMs,
      environment: env(),
      fetcher: providers.fetcher,
    });
  }

  it('reads the balance at once, records the run and raises the alert', async () => {
    providers.state.balance = 4;

    expect(await refusalCheck(T0)).toMatchObject({
      status: 'succeeded',
      summary: { trigger: 'provider-refusal', transition: 'raised', episodeLevel: 'exhausted' },
    });

    expect(providers.posts).toHaveLength(1);
    expect(providers.posts[0].body).toMatchObject({
      delivery: { severity: 'degraded' },
      alerts: [expect.objectContaining({ code: 'KIE_BALANCE_EXHAUSTED' })],
    });
    expect(db.runs).toEqual([expect.objectContaining({
      job_name: KIE_ACCOUNT_BALANCE_JOB_NAME,
      route: '/api/cron/kie-account-balance',
      status: 'succeeded',
      metadata: { trigger: 'provider-refusal' },
      summary: expect.objectContaining({ transition: 'raised', episodeLevel: 'exhausted' }),
    })]);
    // The job lock is released; the refusal latch is left to expire.
    expect(db.locks.has(KIE_ACCOUNT_BALANCE_JOB_NAME)).toBe(false);
  });

  it('checks once per cooldown however many instances see refusals', async () => {
    providers.state.balance = 4;
    await refusalCheck(T0);

    expect(await refusalCheck(T0 + 60_000)).toEqual({ status: 'skipped', reason: 'recently_checked' });
    expect(await refusalCheck(T0 + 599_000)).toEqual({ status: 'skipped', reason: 'recently_checked' });
    expect(providers.state.kieCalls).toBe(1);
    expect(db.runs).toHaveLength(1);

    expect(await refusalCheck(T0 + 601_000)).toMatchObject({
      status: 'succeeded',
      summary: { transition: 'none', episodeLevel: 'exhausted' },
    });
    expect(providers.posts).toHaveLength(1);
  });

  it('is not raised again by the next scheduled poll', async () => {
    providers.state.balance = 4;
    await refusalCheck(T0);

    const pollAt = T0 + 7 * 60_000;
    clock.nowMs = pollAt;
    db.runs.push({
      id: 'poll-1',
      job_name: KIE_ACCOUNT_BALANCE_JOB_NAME,
      lock_owner: 'kie-account-balance:poll-1',
      status: 'started',
      started_at: new Date(pollAt).toISOString(),
      summary: null,
    });
    expect(await checkKieAccountBalance(db.client as never, {
      trigger: 'schedule',
      lockOwner: 'kie-account-balance:poll-1',
      now: new Date(pollAt),
      environment: env(),
      fetcher: providers.fetcher,
    })).toMatchObject({ transition: 'none', episodeLevel: 'exhausted' });
    expect(providers.posts).toHaveLength(1);
  });

  it('leaves the check to a run that already holds the job lock', async () => {
    db.locks.set(KIE_ACCOUNT_BALANCE_JOB_NAME, { lockedUntilMs: T0 + 60_000, lockedBy: 'scheduler-run' });

    expect(await refusalCheck(T0)).toEqual({ status: 'skipped', reason: 'already_running' });
    expect(providers.state.kieCalls).toBe(0);
    expect(db.runs).toEqual([expect.objectContaining({ status: 'skipped', skip_reason: 'already_running' })]);
  });

  it('records a check that failed instead of throwing', async () => {
    db.failReads(true);

    expect(await refusalCheck(T0)).toMatchObject({ status: 'failed', error: 'database unavailable' });
    expect(db.runs).toEqual([expect.objectContaining({ status: 'failed', error_message: 'database unavailable' })]);
    expect(providers.posts).toHaveLength(0);
  });
});
