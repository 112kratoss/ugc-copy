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
 * Within one server instance they do not even ask at once: a pass wanted while
 * one is running joins it, and one wanted straight after a pass found the
 * account full is skipped (`QUEUED_SUBMISSION_PASS_SPACING_MS`). A burst that
 * queues two hundred runs would otherwise have each of their requests asking
 * the gate about the same head every two seconds, behind one lock.
 *
 * Every exit of a queued run is one of three: sent once; refunded once (the
 * provider refused it, or it waited past `queueMaxAgeMs`) with its creator
 * told; or still queued. A request that was claimed and never attached (the
 * process died between the claim and the provider's answer, or the attach
 * failed after the provider accepted) is left as every crashed start is: held,
 * recovered by the provider's callback or refunded by the reaper, and never
 * sent again.
 */

export type QueuedSubmissionDrive =
  /** Sent to the provider, by this pass. */
  | 'sent'
  /** Still waiting for its turn. */
  | 'queued'
  /** Not in the queue any more: something else claimed it, or its generation was settled while it waited. */
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

/**
 * How many of the oldest queued runs a pass reads. It asks the gate for far
 * fewer: it stops at the first the account has no place for, and asks once
 * for a model whose share is full, however many of that model's runs follow.
 */
export const QUEUED_SUBMISSION_PASS_LIMIT = 25;

/** A pass wanted this soon after one found the account full is skipped: nothing can have changed. */
export const QUEUED_SUBMISSION_PASS_SPACING_MS = 1_000;

/**
 * How long a single pass (a status check's, the callback's, the cron's) goes
 * on starting new sends. One already begun is finished.
 */
export const QUEUED_SUBMISSION_PASS_BUDGET_MS = 20_000;

/** A gate that could not be asked this many times running is down: the pass ends. */
const GATE_UNAVAILABLE_LIMIT = 2;

type DriveDependencies = {
  admit: typeof admitProviderSubmission;
  post: typeof postKieTask;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

function resolveDependencies(dependencies: Partial<DriveDependencies> | undefined): DriveDependencies {
  return {
    admit: dependencies?.admit ?? admitProviderSubmission,
    post: dependencies?.post ?? postKieTask,
    now: dependencies?.now ?? Date.now,
    sleep: dependencies?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: dependencies?.random ?? Math.random,
  };
}

function emptySummary(): QueuedSubmissionDriveSummary {
  return { sent: 0, queued: 0, gone: 0, expired: 0, failed: 0 };
}

type ClaimedRefund =
  /** This call returned the hold. */
  | 'refunded'
  /** Something else had already returned it. */
  | 'already_refunded'
  /** The hold is no longer the queue's to return: the run was attached, delivered or is gone. */
  | 'not_refundable'
  /** The settlement could not be reached: the hold stands, for the reaper. */
  | 'unsettled';

/**
 * Returns a claimed run's credits. The settlement locks the generation and
 * refunds only while the row still holds them, so asking twice refunds once.
 */
async function refundClaimedSubmission(
  client: SupabaseClient,
  generationId: string,
  message: string,
): Promise<ClaimedRefund> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { data, error } = await client.rpc('settle_generation_start_failed', {
        p_generation_id: generationId,
        p_error_message: message,
      });
      if (error) throw error;
      const status = data && typeof data === 'object' ? (data as { status?: unknown }).status : null;
      if (status === 'failed') return 'refunded';
      if (status === 'already_failed') return 'already_refunded';
      if (typeof status === 'string') return 'not_refundable';
    } catch (error) {
      if (attempt === 3) {
        logBackendError('generation_queued_submission_refund_failed', { generationId, error });
      }
    }
  }
  return 'unsettled';
}

/**
 * Ends a run that waited too long: out of the queue, refunded, and its
 * creator told. Nothing happens unless this call takes the request itself.
 */
async function expireQueuedSubmission(client: SupabaseClient, generationId: string): Promise<QueuedSubmissionDrive> {
  const claimed = await claimQueuedProviderSubmission(client, generationId);
  if (!claimed) return 'gone';

  const refund = await refundClaimedSubmission(client, generationId, QUEUED_SUBMISSION_EXPIRED_MESSAGE);
  logBackendWarning('generation_queued_submission_expired', {
    generationId,
    queuedForMs: Date.now() - claimed.queuedAtMs,
    refund,
  });
  // Told once, by the call that returned the credits: a run something else
  // had already ended was told then.
  if (refund === 'refunded') {
    await notifyRunStepGenerationFailed({ client, generationId, userId: claimed.userId });
  }
  return 'expired';
}

export type QueuedSubmissionCancel =
  /** Nothing to end: it is not queued, and it holds no credits for a run that was never sent. */
  | 'not_queued'
  /** Out of the queue, and its hold is settled: returned, or no longer the queue's. */
  | 'cancelled'
  /** Out of the queue, but its credits could not be returned just now. The generation must stay, for the reaper to settle. */
  | 'refund_failed';

/**
 * Takes a queued run out of the queue because its creator deleted it, and
 * returns its credits.
 */
export async function cancelQueuedSubmission(client: SupabaseClient, generationId: string): Promise<QueuedSubmissionCancel> {
  const claimed = await claimQueuedProviderSubmission(client, generationId);
  if (!claimed && !await holdsCreditsUnsent(client, generationId)) return 'not_queued';

  const refund = await refundClaimedSubmission(client, generationId, QUEUED_SUBMISSION_CANCELLED_MESSAGE);
  return refund === 'unsettled' ? 'refund_failed' : 'cancelled';
}

/**
 * Whether a generation that is not in the queue still holds its credits with
 * nothing on its way to the provider: pending, never admitted by the gate, no
 * task, not marked unknown. That is a run an earlier delete took out of the
 * queue and could not refund (`refund_failed`), or a start that died before
 * the gate. Deleting it without returning the hold would lose it: the reaper
 * settles rows, and the row would be gone. One the gate admitted is left
 * alone: it may be being sent this moment.
 */
async function holdsCreditsUnsent(client: SupabaseClient, generationId: string): Promise<boolean> {
  const { data, error } = await client
    .from('generations')
    .select('status, prediction_id, provider_submission_reserved_at, submission_unknown_at')
    .eq('id', generationId)
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    status: string | null;
    prediction_id: string | null;
    provider_submission_reserved_at: string | null;
    submission_unknown_at: string | null;
  } | null;
  return Boolean(row)
    && row!.status === 'pending'
    && !row!.prediction_id
    && !row!.provider_submission_reserved_at
    && !row!.submission_unknown_at;
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
      // Never failing open: a start sent because the gate could not be asked
      // is one a creator is waiting on. This run is waiting anyway, and a gate
      // that cannot answer may be saying the generation is no longer one to send.
      verdict = await admit({ generationId, model: queued.model, mayQueue: true, failOpen: false });
    } catch {
      // The breaker is open. Every run behind this one would hear the same.
      return { outcome: 'queued', reason: 'refused' };
    }
    if (!verdict.allowed) return { outcome: 'queued', reason: verdict.reason };

    // The run has its turn. Only the caller that takes the request sends it.
    const claimed = await claimQueuedProviderSubmission(client, generationId);
    if (!claimed) return { outcome: 'gone' };

    if (!claimed.sendable) {
      // Settled, attached or marked unknown while its row waited: its hold is
      // gone or spoken for. The request is dropped with the row.
      logBackendWarning('generation_queued_submission_dropped', { generationId });
      return { outcome: 'gone' };
    }

    let predictionId: string;
    try {
      predictionId = await post(claimed.task);
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

    try {
      await markGenerationProviderStarted(client, generationId, predictionId);
    } catch (error) {
      // The provider has the task and is running it. Its credits are not
      // returned for a row we could not write: the callback attaches the task
      // when it reports, as it does for a start that died at this point.
      logBackendError('generation_queued_submission_attach_failed', { generationId, predictionId, error });
    }
    logBackendInfo('generation_queued_submission_sent', {
      generationId,
      queuedForMs: now() - claimed.queuedAtMs,
    });
    return { outcome: 'sent' };
  } catch (error) {
    logBackendError('generation_queued_submission_drive_failed', { generationId, error });
    return { outcome: 'queued', reason: 'error' };
  }
}

/** Refusals that are the account's, not one run's: every run queued behind would hear the same. */
const ACCOUNT_REFUSALS: ReadonlySet<string> = new Set(['rate_limited', 'max_in_flight', 'refused']);

/**
 * One pass over the head of the queue: the runs that have waited longest,
 * oldest first. True when it ended on a full account.
 *
 * It stops at the first run the account has no place for. Every run behind it
 * was queued later and would be refused for the same place, so asking for them
 * is only load. A run its own model has no place for is passed over, and so is
 * every later run of that model: the next may be another model's, with a share
 * of its own.
 */
async function passOverQueue(
  client: SupabaseClient,
  limit: number,
  deadlineMs: number,
  dependencies: DriveDependencies,
  summary: QueuedSubmissionDriveSummary,
): Promise<boolean> {
  const head = await listOldestQueuedProviderSubmissions(client, limit);
  const fullModels = new Set<string>();
  let unavailable = 0;

  for (const queued of head) {
    if (dependencies.now() >= deadlineMs) return false;
    if (queued.model && fullModels.has(queued.model)) {
      summary.queued += 1;
      continue;
    }

    const attempt = await attemptQueuedSubmission(client, queued, dependencies);
    summary[attempt.outcome] += 1;
    if (attempt.outcome !== 'queued') {
      unavailable = 0;
      continue;
    }

    if (attempt.reason === 'model_rate_limited') {
      if (queued.model) fullModels.add(queued.model);
    } else if (attempt.reason && ACCOUNT_REFUSALS.has(attempt.reason)) {
      return true;
    } else {
      // The gate could not be asked about this run, or asking failed. The
      // next run may be answered; a gate that is down ends the pass.
      unavailable += 1;
      if (unavailable >= GATE_UNAVAILABLE_LIMIT) return false;
    }
  }
  return false;
}

/**
 * This instance's passes: the one running, and when one last found the account
 * full. Per instance by design: it is the many requests one instance serves
 * during a burst that would otherwise each ask the gate about the same head.
 */
const passes: { running: Promise<void> | null; runningSinceMs: number; fullAtMs: number | null } = {
  running: null, runningSinceMs: 0, fullAtMs: null,
};

/**
 * A running pass older than this is taken for hung (a database call with no
 * time limit of its own) and is no longer joined: the next caller passes by itself.
 */
export const QUEUED_SUBMISSION_PASS_STALE_MS = 90_000;

/** For tests: forgets the running pass and the last full account. */
export function resetQueuedSubmissionPasses() {
  passes.running = null;
  passes.runningSinceMs = 0;
  passes.fullAtMs = null;
}

/** Waits for a pass, but no longer than `ms`: a caller has its own time limit, whatever the pass is stuck on. */
async function settledWithin(pass: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pass, new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Makes a pass, unless one is running in this instance (it is joined) or one
 * has just found the account full (nothing can have changed).
 *
 * `fresh` is for a caller that knows something has changed since any pass
 * began: the provider's callback, whose finished task has just freed a place.
 * It waits out a running pass and then makes its own, whatever was found a
 * moment ago.
 */
async function passOnce(
  client: SupabaseClient,
  limit: number,
  deadlineMs: number,
  dependencies: DriveDependencies,
  summary: QueuedSubmissionDriveSummary,
  fresh: boolean,
): Promise<void> {
  const running = passes.running;
  if (running && dependencies.now() - passes.runningSinceMs < QUEUED_SUBMISSION_PASS_STALE_MS) {
    await settledWithin(running, deadlineMs - dependencies.now());
    if (!fresh || passes.running === running) return;
  }
  if (
    !fresh
    && passes.fullAtMs !== null
    && dependencies.now() - passes.fullAtMs < QUEUED_SUBMISSION_PASS_SPACING_MS
  ) return;

  const pass = (async () => {
    try {
      const full = await passOverQueue(client, limit, deadlineMs, dependencies, summary);
      passes.fullAtMs = full ? dependencies.now() : null;
    } catch (error) {
      logBackendError('generation_queued_submissions_pass_failed', { error });
    }
  })();
  passes.running = pass;
  passes.runningSinceMs = dependencies.now();
  try {
    await pass;
  } finally {
    if (passes.running === pass) passes.running = null;
  }
}

/**
 * Serves the queue from its head. Never throws.
 *
 * With no `untilGenerationId`, one pass: what a status check, the provider's
 * callback and the cron make. With it, it keeps passing, about `queuePollMs`
 * apart, until that run has left the queue or `deadlineMs` has come: what the
 * request that queued a run does once it has answered. No send is begun after
 * the deadline, so the route's own time limit has to leave room past it for
 * one that began just before (an ask of the gate, the provider's answer, the
 * attach).
 */
export async function driveQueuedSubmissions(params: {
  limit?: number;
  untilGenerationId?: string;
  /** When to stop, on the clock. Without one, a single pass has `QUEUED_SUBMISSION_PASS_BUDGET_MS`. */
  deadlineMs?: number;
  /** Something has just changed (a place was freed): pass now, not joined to or spaced after an earlier pass. */
  fresh?: boolean;
  client?: SupabaseClient;
  dependencies?: Partial<DriveDependencies>;
} = {}): Promise<QueuedSubmissionDriveSummary> {
  const summary = emptySummary();
  const dependencies = resolveDependencies(params.dependencies);
  const limit = Math.max(1, params.limit ?? QUEUED_SUBMISSION_PASS_LIMIT);
  const deadlineMs = params.deadlineMs ?? dependencies.now() + QUEUED_SUBMISSION_PASS_BUDGET_MS;

  try {
    const client = params.client ?? createServiceClient();

    for (;;) {
      await passOnce(client, limit, deadlineMs, dependencies, summary, params.fresh === true);

      if (!params.untilGenerationId) break;
      if (!await readQueuedProviderSubmission(client, params.untilGenerationId)) break;
      const leftMs = deadlineMs - dependencies.now();
      if (leftMs <= 0) break;
      // Spread, so the requests of one burst do not all come back at once.
      const waitMs = PROVIDER_ADMISSION_POLICY.queuePollMs * (1 + dependencies.random() / 2);
      await dependencies.sleep(Math.min(waitMs, leftMs));
    }
  } catch (error) {
    logBackendError('generation_queued_submissions_drive_failed', { error });
  }

  return summary;
}
