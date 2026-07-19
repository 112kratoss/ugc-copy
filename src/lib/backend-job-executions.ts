import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { getApiRequestId } from '@/lib/api-cache';
import {
  deliverBackendAlerts,
  getBackendAlertDeliveryNotConfiguredSummary,
  hasConfiguredBackendAlertDelivery,
} from '@/lib/backend-alert-delivery';
import { withBackendJobLock } from '@/lib/backend-job-lock';
import {
  finishBackendJobRun,
  maybePruneBackendJobRuns,
  startBackendJobRun,
  type BackendJobRunHandle,
} from '@/lib/backend-job-runs';
import { BACKEND_JOBS_BY_NAME, type BackendJobDefinition } from '@/lib/backend-jobs';
import { maintainFeedPersonalization } from '@/lib/feed-maintenance';
import {
  hasDueGenerationCompletionJobs,
  maybePruneGenerationCompletionJobs,
  processGenerationCompletionJobs,
} from '@/lib/generation-completion-jobs';
import { verifyPublishedGenerationModels } from '@/lib/generation-model-provider-verification';
import { hasRepairableMediaPreviews, repairMediaPreviews } from '@/lib/media-preview-repair';
import { hasMobilePushMaintenanceWork, processMobilePushMaintenance } from '@/lib/mobile-notifications';
import {
  hasUnsettledReferralPurchaseTransactions,
  reconcileReferralPurchaseRewards,
  REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT,
} from '@/lib/referral-reward-reconciliation';
import { withRequestTrace } from '@/lib/request-trace';
import { createServiceClient } from '@/lib/server-helpers';

const GENERATION_COMPLETION_BATCH_LIMIT = 25;

export type BackendJobExecutionResult =
  | {
      success: true;
      job: string;
      route: string;
      status: 'succeeded';
      summary: unknown;
    }
  | {
      success: true;
      job: string;
      route: string;
      status: 'skipped';
      skipped: true;
      reason: string;
      summary?: unknown;
    }
  | {
      success: false;
      job: string;
      route: string;
      status: 'failed';
      error: string;
    };

type BackendJobContext = {
  startedAtMs: number;
  requestId: string;
  lockOwner: string;
};

type ManagedBackendJobOptions<TSummary> = {
  job: BackendJobDefinition;
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
  messages: {
    started: string;
    skippedNoWork: string;
    skippedLocked: string;
    completed: string;
    failed: string;
  };
  hasWork: (client: SupabaseClient, context: BackendJobContext) => Promise<boolean>;
  run: (client: SupabaseClient, context: BackendJobContext) => Promise<TSummary>;
  onNoWork?: (client: SupabaseClient, context: BackendJobContext) => Promise<unknown>;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function logBackendJob(
  level: 'info' | 'error',
  msg: string,
  job: BackendJobDefinition,
  fields: Record<string, unknown>,
) {
  const payload = JSON.stringify({
    level,
    msg,
    route: job.route,
    job: job.name,
    ...fields,
  });

  if (level === 'error') {
    console.error(payload);
  } else {
    console.log(payload);
  }
}

export function getBackendJobRequestId(request: Request): string {
  return getApiRequestId(request);
}

export function backendJobExecutionResponse(
  result: BackendJobExecutionResult,
  failureMessage: string,
): NextResponse {
  if (!result.success) {
    return NextResponse.json({ error: failureMessage }, { status: 500 });
  }

  if (result.status === 'skipped') {
    const summary = result.summary && typeof result.summary === 'object'
      ? result.summary as Record<string, unknown>
      : null;

    return NextResponse.json({
      success: true,
      skipped: true,
      reason: result.reason,
      ...(result.summary === undefined ? {} : { summary: result.summary }),
      ...(summary && 'pruned' in summary ? { pruned: summary.pruned } : {}),
    }, { status: 202 });
  }

  return NextResponse.json({ success: true, summary: result.summary });
}

async function runManagedBackendJob<TSummary>({
  job,
  requestId = randomUUID(),
  startedAtMs = Date.now(),
  serviceClient,
  triggerRoute,
  messages,
  hasWork,
  run,
  onNoWork,
}: ManagedBackendJobOptions<TSummary>): Promise<BackendJobExecutionResult> {
  const lockOwner = `${job.name}:${requestId}:${startedAtMs}`;
  const context: BackendJobContext = { startedAtMs, requestId, lockOwner };
  return withRequestTrace({ requestId }, async () => {
    let currentServiceClient: SupabaseClient | null = null;
    let jobRun: BackendJobRunHandle | null = null;

    try {
    logBackendJob('info', messages.started, job, { requestId, triggerRoute });

    currentServiceClient = serviceClient ?? createServiceClient();
    jobRun = await startBackendJobRun(currentServiceClient, {
      name: job.name,
      route: job.route,
      requestId,
      lockOwner,
      startedAtMs,
      metadata: triggerRoute && triggerRoute !== job.route ? { triggerRoute } : undefined,
    });

    const hasDueWork = await hasWork(currentServiceClient, context);

    if (!hasDueWork) {
      const finishedAtMs = Date.now();
      const summary = await onNoWork?.(currentServiceClient, context);
      await finishBackendJobRun(currentServiceClient, jobRun, {
        status: 'skipped',
        finishedAtMs,
        skipReason: job.noWorkSkipReason,
        summary,
      });
      const prunedJobRuns = await maybePruneBackendJobRuns(currentServiceClient, { nowMs: startedAtMs });
      logBackendJob('info', messages.skippedNoWork, job, {
        requestId,
        triggerRoute,
        ms: finishedAtMs - startedAtMs,
        summary,
        prunedJobRuns,
      });
      return {
        success: true,
        job: job.name,
        route: job.route,
        status: 'skipped',
        skipped: true,
        reason: job.noWorkSkipReason,
        ...(summary === undefined ? {} : { summary }),
      };
    }

    const lockResult = await withBackendJobLock(currentServiceClient, {
      name: job.name,
      ttlSeconds: job.lockTtlSeconds,
      owner: lockOwner,
    }, () => run(currentServiceClient as SupabaseClient, context));

    if (!lockResult.acquired) {
      const finishedAtMs = Date.now();
      await finishBackendJobRun(currentServiceClient, jobRun, {
        status: 'skipped',
        finishedAtMs,
        skipReason: lockResult.reason,
      });
      const prunedJobRuns = await maybePruneBackendJobRuns(currentServiceClient, { nowMs: startedAtMs });
      logBackendJob('info', messages.skippedLocked, job, {
        requestId,
        triggerRoute,
        reason: lockResult.reason,
        ms: finishedAtMs - startedAtMs,
        prunedJobRuns,
      });
      return {
        success: true,
        job: job.name,
        route: job.route,
        status: 'skipped',
        skipped: true,
        reason: lockResult.reason,
      };
    }

    const finishedAtMs = Date.now();
    await finishBackendJobRun(currentServiceClient, jobRun, {
      status: 'succeeded',
      finishedAtMs,
      summary: lockResult.value,
    });
    const prunedJobRuns = await maybePruneBackendJobRuns(currentServiceClient, { nowMs: startedAtMs });
    logBackendJob('info', messages.completed, job, {
      requestId,
      triggerRoute,
      ms: finishedAtMs - startedAtMs,
      summary: lockResult.value,
      prunedJobRuns,
    });
    return {
      success: true,
      job: job.name,
      route: job.route,
      status: 'succeeded',
      summary: lockResult.value,
    };
    } catch (error) {
      const finishedAtMs = Date.now();
      if (currentServiceClient) {
        await finishBackendJobRun(currentServiceClient, jobRun, {
          status: 'failed',
          finishedAtMs,
          errorMessage: errorMessage(error),
        });
        await maybePruneBackendJobRuns(currentServiceClient, { nowMs: startedAtMs });
      }
      logBackendJob('error', messages.failed, job, {
        requestId,
        triggerRoute,
        ms: finishedAtMs - startedAtMs,
        error: errorMessage(error),
      });
      return {
        success: false,
        job: job.name,
        route: job.route,
        status: 'failed',
        error: errorMessage(error),
      };
    }
  });
}

export function runGenerationCompletionsBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['generation-completions'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'generation_completions_started',
      skippedNoWork: 'generation_completions_skipped_no_due_jobs',
      skippedLocked: 'generation_completions_skipped',
      completed: 'generation_completions_completed',
      failed: 'generation_completions_failed',
    },
    hasWork: (client, context) => hasDueGenerationCompletionJobs(client, { nowMs: context.startedAtMs }),
    onNoWork: async (client, context) => ({
      pruned: await maybePruneGenerationCompletionJobs(client, { nowMs: context.startedAtMs }),
    }),
    run: async (client, context) => {
      const completionSummary = await processGenerationCompletionJobs({
        supabase: client,
        creditSupabase: client,
        lockedBy: context.lockOwner,
        limit: GENERATION_COMPLETION_BATCH_LIMIT,
      });
      const pruned = await maybePruneGenerationCompletionJobs(client, { nowMs: context.startedAtMs });
      return {
        ...completionSummary,
        pruned,
      };
    },
  });
}

export function runGenerationModelVerificationBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['generation-model-verification'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'generation_model_verification_started',
      skippedNoWork: 'generation_model_verification_skipped_no_models',
      skippedLocked: 'generation_model_verification_skipped',
      completed: 'generation_model_verification_completed',
      failed: 'generation_model_verification_failed',
    },
    hasWork: async () => true,
    run: (client, context) => verifyPublishedGenerationModels(client, {
      now: new Date(context.startedAtMs),
    }),
  });
}

export function runBackendAlertDeliveryJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['backend-alert-delivery'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'backend_alert_delivery_started',
      skippedNoWork: 'backend_alert_delivery_skipped_not_configured',
      skippedLocked: 'backend_alert_delivery_skipped',
      completed: 'backend_alert_delivery_completed',
      failed: 'backend_alert_delivery_failed',
    },
    hasWork: async () => hasConfiguredBackendAlertDelivery(),
    onNoWork: async () => getBackendAlertDeliveryNotConfiguredSummary(),
    run: (client, context) => deliverBackendAlerts(client, { now: new Date(context.startedAtMs) }),
  });
}

export function runFeedMaintenanceBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['feed-maintenance'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'feed_maintenance_started',
      skippedNoWork: 'feed_maintenance_skipped_no_work',
      skippedLocked: 'feed_maintenance_skipped',
      completed: 'feed_maintenance_completed',
      failed: 'feed_maintenance_failed',
    },
    hasWork: async () => true,
    run: (client, context) => maintainFeedPersonalization(client, {
      now: new Date(context.startedAtMs),
    }),
  });
}

export function runMediaPreviewRepairBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['media-preview-repair'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'media_preview_repair_started',
      skippedNoWork: 'media_preview_repair_skipped_no_repairable_media',
      skippedLocked: 'media_preview_repair_skipped',
      completed: 'media_preview_repair_completed',
      failed: 'media_preview_repair_failed',
    },
    hasWork: (client) => hasRepairableMediaPreviews(client),
    run: (client) => repairMediaPreviews(client),
  });
}

export function runMobilePushReceiptsBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['mobile-push-receipts'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'mobile_push_receipts_started',
      skippedNoWork: 'mobile_push_receipts_skipped_no_pending_receipts',
      skippedLocked: 'mobile_push_receipts_skipped',
      completed: 'mobile_push_receipts_completed',
      failed: 'mobile_push_receipts_failed',
    },
    hasWork: (client, context) => hasMobilePushMaintenanceWork(client, { now: new Date(context.startedAtMs) }),
    run: (client, context) => processMobilePushMaintenance(client, { now: new Date(context.startedAtMs) }),
  });
}

export function runReferralRewardReconciliationBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['referral-reward-reconciliation'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'referral_reward_reconciliation_started',
      skippedNoWork: 'referral_reward_reconciliation_skipped_no_work',
      skippedLocked: 'referral_reward_reconciliation_skipped',
      completed: 'referral_reward_reconciliation_completed',
      failed: 'referral_reward_reconciliation_failed',
    },
    hasWork: (client) => hasUnsettledReferralPurchaseTransactions(client),
    onNoWork: async () => ({ processed: 0, settled: 0, failed: 0, failures: [] }),
    run: (client) => reconcileReferralPurchaseRewards(client, {
      limit: REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT,
    }),
  });
}
