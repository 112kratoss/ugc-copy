import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendInfo, logBackendWarning } from '@/lib/backend-logger';
import {
  markGenerationProviderStarted,
  postKieTask,
  settleGenerationStartFailureQuietly,
} from '@/lib/generation-services';
import {
  claimQueuedProviderSubmission,
  listOldestQueuedProviderSubmissions,
  readQueuedProviderSubmission,
  type QueuedProviderSubmission,
} from '@/lib/generation-submission-queue-store';
import { admitProviderSubmission, PROVIDER_ADMISSION_POLICY } from '@/lib/provider-admission';
import {
  notifyRunStepGenerationFailed,
  notifyRunStepStartFailure,
} from '@/lib/run-step-start-failure-notification';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * What sends the queued generation starts, and what ends one that cannot be sent.
 *
 * A queued run is a held generation with its provider request stored
 * (generation-submission-queue-store.ts). The queue is served from its head:
 * a pass takes the runs that have waited longest, oldest first, asks the gate
 * for each one's turn, and for a run that has it claims the request and sends
 * it. The gate itself keeps the order (`reserve_provider_submission`: a run is
 * admitted only when there is a place for it and one for every run queued
 * before it), so a pass cannot send out of turn even when several run at once.
 *
 * Passes are made by whatever has a reason to look:
 *
 * - the request that queued a run, which keeps passing over the head of the
 *   queue until its own run has left it (under Next's `after`);
 * - a creator's status check on a queued run;
 * - the provider's callback for a finished task, which has just freed a slot;
 * - the completions cron, for when nobody else is looking.
 *
 * None of them serves "its own" run: each serves the head. That is what keeps
 * a run whose request died, and whose creator left, from holding up everyone
 * queued behind it until the cron comes round.
 *
 * They can all pass at once. The claim settles it: a run's request comes back
 * to one caller, and only that one sends. The rest find nothing to claim.
 *
 * Every exit of a queued run is one of three: sent once and attached; refunded
 * once (the provider refused it, or it waited past `queueMaxAgeMs`) with its
 * creator told; or still queued. A request that was claimed and never attached
 * (the process died between the claim and the provider's answer) is left as
 * every crashed start is: held, recovered by the provider's callback or
 * refunded by the reaper, and never sent again.
 */

export type QueuedSubmissionDrive =
  /** Sent to the provider and attached, by this pass. */
  | 'sent'
  /** Still waiting for its turn. */
  | 'queued'
  /** Not in the queue any more: something else claimed it. */
  | 'gone'
  /** Waited past the limit: refunded, and its creator told. */
  | 'expired'
  /** The provider refused it, or its answer was lost: settled as a start's own failure is. */
  | 'failed';

export type QueuedSubmissionDriveSummary = Record<QueuedSubmissionDrive, number>;

export const QUEUED_SUBMISSION_EXPIRED_MESSAGE =
  'This generation could not be started in time. Your credits were returned.';
export const QUEUED_SUBMISSION_CANCELLED_MESSAGE =
  'This generation was deleted before it started. Your credits were returned.';

/** How many of the oldest queued runs a pass looks at, unless its caller says. */
export const QUEUED_SUBMISSION_PASS_LIMIT = 5;

type DriveDependencies = {
  admit: typeof admitProviderSubmission;
  post: typeof postKieTask;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

function resolveDependencies(dependencies: Partial<DriveDependencies> | undefined): DriveDependencies {
  return {
    admit: dependencies?.admit ?? admitProviderSubmission,
    post: dependencies?.post ?? postKieTask,
    now: dependencies?.now ?? Date.now,
    sleep: dependencies?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function emptySummary(): QueuedSubmissionDriveSummary {
  return { sent: 0, queued: 0, gone: 0, expired: 0, failed: 0 };
}

/**
 * Returns a claimed run's credits. The settlement locks the generation and
 * refunds only while the row still holds them, so asking twice refunds once.
 */
async function refundClaimedSubmission(
  client: SupabaseClient,
  generationId: string,
  message: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { data, error } = await client.rpc('settle_generation_start_failed', {
        p_generation_id: generationId,
        p_error_message: message,
      });
      if (error) throw error;
      const status = data && typeof data === 'object' ? (data as { status?: unknown }).status : null;
      if (status === 'failed' || status === 'already_failed') return true;
      // Attached, delivered or gone: its hold is no longer this queue's to return.
      if (typeof status === 'string') return false;
    } catch (error) {
      if (attempt === 3) {
        logBackendError('generation_queued_submission_refund_failed', { generationId, error });
      }
    }
  }
  return false;
}

/**
 * Ends a run that waited too long: out of the queue, refunded, and its
 * creator told. Nothing happens unless this call takes the request itself.
 */
async function expireQueuedSubmission(client: SupabaseClient, generationId: string): Promise<QueuedSubmissionDrive> {
  const claimed = await claimQueuedProviderSubmission(client, generationId);
  if (!claimed) return 'gone';

  const refunded = await refundClaimedSubmission(client, generationId, QUEUED_SUBMISSION_EXPIRED_MESSAGE);
  logBackendWarning('generation_queued_submission_expired', {
    generationId,
    queuedForMs: Date.now() - claimed.queuedAtMs,
    refunded,
  });
  if (refunded) {
    await notifyRunStepGenerationFailed({ client, generationId, userId: claimed.userId });
  }
  return 'expired';
}

/**
 * Takes a queued run out of the queue because its creator deleted it, and
 * returns its credits. True when there was a queued run and this call ended it.
 */
export async function cancelQueuedSubmission(client: SupabaseClient, generationId: string): Promise<boolean> {
  const claimed = await claimQueuedProviderSubmission(client, generationId);
  if (!claimed) return false;

  await refundClaimedSubmission(client, generationId, QUEUED_SUBMISSION_CANCELLED_MESSAGE);
  return true;
}

type QueuedSubmissionAttempt = {
  outcome: QueuedSubmissionDrive;
  /** Why it is still queued, when it is: whether a younger run could go instead. */
  reason?: string;
};

/**
 * Asks once for one queued run's turn, and sends the run if it has it.
 * Never throws.
 */
async function attemptQueuedSubmission(
  client: SupabaseClient,
  queued: QueuedProviderSubmission,
  { admit, post, now }: DriveDependencies,
): Promise<QueuedSubmissionAttempt> {
  const { generationId } = queued;

  try {
    if (now() - queued.queuedAtMs >= PROVIDER_ADMISSION_POLICY.queueMaxAgeMs) {
      return { outcome: await expireQueuedSubmission(client, generationId) };
    }

    let verdict: Awaited<ReturnType<typeof admitProviderSubmission>>;
    try {
      verdict = await admit({ generationId, model: queued.model, mayQueue: true });
    } catch {
      // The breaker is open, or the generation is no longer one to send. It
      // stays where it is: sent when the provider recovers, or expired.
      return { outcome: 'queued', reason: 'refused' };
    }
    if (!verdict.allowed) return { outcome: 'queued', reason: verdict.reason };

    // The run has its turn. Only the caller that takes the request sends it.
    const claimed = await claimQueuedProviderSubmission(client, generationId);
    if (!claimed) return { outcome: 'gone' };

    try {
      const predictionId = await post(claimed.task);
      await markGenerationProviderStarted(client, generationId, predictionId);
      logBackendInfo('generation_queued_submission_sent', {
        generationId,
        queuedForMs: now() - claimed.queuedAtMs,
      });
      return { outcome: 'sent' };
    } catch (error) {
      // Exactly a start's own failure: an answer that may have been accepted
      // keeps its hold, a definite refusal is refunded. Nobody is waiting on a
      // response here, so a refund is said by notification. The cost is only
      // for the hold's log line, which the generation row answers better.
      await settleGenerationStartFailureQuietly({
        creditSupabase: client,
        error,
        generationId,
        userId: claimed.userId,
        cost: 0,
      });
      await notifyRunStepStartFailure({ client, error, userId: claimed.userId });
      logBackendError('generation_queued_submission_send_failed', { generationId, error });
      return { outcome: 'failed' };
    }
  } catch (error) {
    logBackendError('generation_queued_submission_drive_failed', { generationId, error });
    return { outcome: 'queued', reason: 'error' };
  }
}

/**
 * One pass over the head of the queue: the runs that have waited longest,
 * oldest first.
 *
 * It stops at the first run the account has no place for. Every run behind it
 * was queued later and would be refused for the same place, so asking for them
 * is only load. A run its own model has no place for is passed over: the next
 * may be another model's, with a share of its own.
 */
async function passOverQueue(
  client: SupabaseClient,
  limit: number,
  dependencies: DriveDependencies,
  summary: QueuedSubmissionDriveSummary,
): Promise<void> {
  const head = await listOldestQueuedProviderSubmissions(client, limit);
  for (const queued of head) {
    const attempt = await attemptQueuedSubmission(client, queued, dependencies);
    summary[attempt.outcome] += 1;
    if (attempt.outcome === 'queued' && attempt.reason !== 'model_rate_limited') return;
  }
}

/**
 * Serves the queue from its head. Never throws.
 *
 * With no `budgetMs`, one pass: what a status check, the provider's callback
 * and the cron make. With `untilGenerationId` and a budget it keeps passing,
 * `queuePollMs` apart, until that run has left the queue or the budget is
 * spent: what the request that queued a run does once it has answered.
 */
export async function driveQueuedSubmissions(params: {
  limit?: number;
  untilGenerationId?: string;
  budgetMs?: number;
  client?: SupabaseClient;
  dependencies?: Partial<DriveDependencies>;
} = {}): Promise<QueuedSubmissionDriveSummary> {
  const summary = emptySummary();
  const dependencies = resolveDependencies(params.dependencies);
  const limit = Math.max(1, params.limit ?? QUEUED_SUBMISSION_PASS_LIMIT);
  const startedAt = dependencies.now();
  const budgetMs = params.untilGenerationId ? Math.max(0, params.budgetMs ?? 0) : 0;

  try {
    const client = params.client ?? createServiceClient();

    for (;;) {
      await passOverQueue(client, limit, dependencies, summary);

      if (!params.untilGenerationId) break;
      if (!await readQueuedProviderSubmission(client, params.untilGenerationId)) break;
      const leftMs = budgetMs - (dependencies.now() - startedAt);
      if (leftMs <= 0) break;
      await dependencies.sleep(Math.min(PROVIDER_ADMISSION_POLICY.queuePollMs, leftMs));
    }
  } catch (error) {
    logBackendError('generation_queued_submissions_drive_failed', { error });
  }

  return summary;
}
