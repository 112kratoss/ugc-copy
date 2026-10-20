import 'server-only';

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';

import { withBackendJobLock } from '@/lib/backend-job-lock';
import { finishBackendJobRun, startBackendJobRun } from '@/lib/backend-job-runs';
import { BACKEND_JOBS_BY_NAME } from '@/lib/backend-jobs';
import { logBackendEvent } from '@/lib/backend-logger';
import {
  KIE_ACCOUNT_BALANCE_JOB_NAME,
  KieAccountBalanceCheckError,
  checkKieAccountBalance,
  type KieBalanceCheckSummary,
} from '@/lib/kie-account-balance-alert';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * Kie refusing a generation for insufficient credits, told to the operator now
 * rather than at the next ten-minute balance poll: the balance can run out
 * between two polls, and from then on every start is refunded and reads as an
 * outage.
 *
 * A refusal schedules one balance check behind the creator's answer. That
 * check is the job's own (same lock, same state, same alert), run with the
 * refusal as evidence, so it raises the episode the poll would have raised,
 * escalates one the poll already raised, and stays quiet when either has
 * already been told. Once the account is dry every start is refused, so two
 * gates keep the checks to one per ten minutes: a timestamp per instance, and
 * a database latch shared by all of them that is left to expire.
 */

export const KIE_REFUSAL_CHECK_COOLDOWN_SECONDS = 600;
const REFUSAL_LATCH_NAME = `${KIE_ACCOUNT_BALANCE_JOB_NAME}:provider-refusal`;

type ScheduleTask = (task: () => Promise<unknown>) => void;

export type KieRefusalBalanceCheckResult =
  | { status: 'skipped'; reason: 'recently_checked' | 'already_running' }
  | { status: 'succeeded'; summary: KieBalanceCheckSummary }
  | { status: 'failed'; error: string; summary?: KieBalanceCheckSummary };

let lastReportedAtMs: number | null = null;

/** Tests only: forget this instance's last report. */
export function resetKieRefusalReportThrottle(): void {
  lastReportedAtMs = null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/** Runs the task once the response is sent; outside a request it runs at once, unawaited. */
function scheduleAfterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/**
 * Called where a start's refusal is classified as the provider's account being
 * out of credits. Synchronous and never throws: nothing here may change the
 * creator's answer.
 */
export function reportKieInsufficientCreditsRefusal(options: {
  nowMs?: number;
  schedule?: ScheduleTask;
  runCheck?: () => Promise<unknown>;
} = {}): void {
  const previousReportAtMs = lastReportedAtMs;
  try {
    const nowMs = options.nowMs ?? Date.now();
    if (
      previousReportAtMs !== null
      && nowMs - previousReportAtMs < KIE_REFUSAL_CHECK_COOLDOWN_SECONDS * 1000
    ) {
      return;
    }
    lastReportedAtMs = nowMs;

    const runCheck = options.runCheck ?? (() => runKieRefusalBalanceCheck());
    (options.schedule ?? scheduleAfterResponse)(async () => {
      try {
        await runCheck();
      } catch (error) {
        logBackendEvent('warn', 'kie_balance_refusal_check_failed', { error });
      }
    });
  } catch (error) {
    // Nothing was scheduled, so let the next refusal try again.
    lastReportedAtMs = previousReportAtMs;
    logBackendEvent('warn', 'kie_balance_refusal_report_failed', { error });
  }
}

/**
 * One balance check for a refusal, recorded as a run of the
 * `kie-account-balance` job (`metadata.trigger = 'provider-refusal'`).
 */
export async function runKieRefusalBalanceCheck(options: {
  client?: SupabaseClient;
  nowMs?: number;
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
} = {}): Promise<KieRefusalBalanceCheckResult> {
  const job = BACKEND_JOBS_BY_NAME[KIE_ACCOUNT_BALANCE_JOB_NAME];
  const client = options.client ?? createServiceClient();
  const startedAtMs = options.nowMs ?? Date.now();
  const requestId = `provider-refusal:${randomUUID()}`;
  const lockOwner = `${job.name}:${requestId}:${startedAtMs}`;

  const latch = await client.rpc('try_acquire_backend_job_lock', {
    p_name: REFUSAL_LATCH_NAME,
    p_ttl_seconds: KIE_REFUSAL_CHECK_COOLDOWN_SECONDS,
    p_locked_by: lockOwner,
  });
  if (latch.error) throw new Error(errorMessage(latch.error));
  if (latch.data !== true) return { status: 'skipped', reason: 'recently_checked' };

  const run = await startBackendJobRun(client, {
    name: job.name,
    route: job.route,
    requestId,
    lockOwner,
    startedAtMs,
    metadata: { trigger: 'provider-refusal' },
  });

  try {
    const result = await withBackendJobLock(client, {
      name: job.name,
      ttlSeconds: job.lockTtlSeconds,
      owner: lockOwner,
    }, () => checkKieAccountBalance(client, {
      trigger: 'provider-refusal',
      lockOwner,
      now: new Date(startedAtMs),
      environment: options.environment,
      fetcher: options.fetcher,
    }));

    if (!result.acquired) {
      // The scheduled check is running now; it reads the same balance.
      await finishBackendJobRun(client, run, {
        status: 'skipped',
        finishedAtMs: Date.now(),
        skipReason: result.reason,
      });
      return { status: 'skipped', reason: 'already_running' };
    }

    await finishBackendJobRun(client, run, {
      status: 'succeeded',
      finishedAtMs: Date.now(),
      summary: result.value,
    });
    return { status: 'succeeded', summary: result.value };
  } catch (error) {
    const message = errorMessage(error);
    const summary = error instanceof KieAccountBalanceCheckError ? error.summary : undefined;
    await finishBackendJobRun(client, run, {
      status: 'failed',
      finishedAtMs: Date.now(),
      errorMessage: message,
      ...(summary ? { summary } : {}),
    });
    // The same event the scheduled run logs when it fails.
    logBackendEvent('error', 'kie_account_balance_check_failed', {
      route: job.route,
      job: job.name,
      trigger: 'provider-refusal',
      requestId,
      error: message,
    });
    return { status: 'failed', error: message, ...(summary ? { summary } : {}) };
  }
}
