import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { getApiRequestId } from '@/lib/api-cache';
import {
  hasDueAccountDeletionCleanup,
  processAccountDeletionCleanup,
} from '@/lib/account-deletion-service';
import { logBackendEvent } from '@/lib/backend-logger';
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
import { pruneOperationalBackendData } from '@/lib/operational-data-retention';
import {
  hasDueGenerationCompletionJobs,
  maybePruneGenerationCompletionJobs,
  processGenerationCompletionJobs,
} from '@/lib/generation-completion-jobs';
import { hasDueGenerationOutputImportJobs } from '@/lib/generation-output-import-jobs';
import {
  GENERATION_OUTPUT_IMPORT_BATCH_LIMIT,
  processGenerationOutputImportJobs,
} from '@/lib/generation-output-import-jobs-processor';
import { verifyPublishedGenerationModels } from '@/lib/generation-model-provider-verification';
import { hasRepairableMediaPreviews, repairMediaPreviews } from '@/lib/media-preview-repair';
import {
  hasReclaimableMediaUploads,
  reclaimAbandonedMediaUploads,
} from '@/lib/media-upload-reclaim-service';
import { getMediaUploadReclaimPolicy } from '@/lib/media-upload-reclaim-policy';
import {
  hasRepairableLegacyGenerations,
  repairMissingGenerationInputMedia,
} from '@/lib/generation-input-media-repair';
import { hasMobilePushMaintenanceWork, processMobilePushMaintenance } from '@/lib/mobile-notifications';
import {
  hasUnsettledReferralPurchaseTransactions,
  reconcileReferralPurchaseRewards,
  REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT,
} from '@/lib/referral-reward-reconciliation';
import { withRequestTrace } from '@/lib/request-trace';
import { createServiceClient } from '@/lib/server-helpers';
import {
  hasStalledGenerationWork,
  reapStalledGenerations,
} from '@/lib/stalled-generation-reaper';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import { hasDueTemplateRunJobs, pruneTemplateRunJobs } from '@/lib/template-run-jobs';
import {
  TEMPLATE_RUN_JOB_BATCH_LIMIT,
  processTemplateRunJobs,
} from '@/lib/template-run-jobs-processor';
import {
  findStalledWorkflowRuns,
  hasDueWorkflowRunStepJobs,
  maybePruneWorkflowRunStepJobs,
} from '@/lib/workflow-run-jobs';
import {
  WORKFLOW_RUN_STEP_BATCH_LIMIT,
  processWorkflowRunStepJobs,
} from '@/lib/workflow-run-jobs-processor';

const GENERATION_COMPLETION_BATCH_LIMIT = 25;

export function runAccountDeletionResweepsBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['account-deletion-resweeps'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'account_deletion_cleanup_started',
      skippedNoWork: 'account_deletion_cleanup_skipped_no_work',
      skippedLocked: 'account_deletion_cleanup_skipped',
      completed: 'account_deletion_cleanup_completed',
      failed: 'account_deletion_cleanup_failed',
    },
    hasWork: (client, context) => (
      hasDueAccountDeletionCleanup(client, new Date(context.startedAtMs))
    ),
    run: async (client, context) => {
      try {
        return await processAccountDeletionCleanup({
          admin: client,
          workerId: `${job.name}:${context.requestId.slice(0, 64)}:${context.startedAtMs}`,
        });
      } finally {
        // A resumed initial deletion can cascade posts after the request that
        // originally primed the cache is gone. Invalidating on every attempted
        // cleanup also covers partial batches that successfully deleted one
        // account before another item was durably rescheduled.
        try {
          invalidateShowcaseFeedCache();
        } catch (error) {
          logBackendEvent('error', 'account_deletion_showcase_cache_invalidation_failed', {
            route: job.route,
            job: job.name,
            error: errorMessage(error),
          });
        }
      }
    },
  });
}

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
  logBackendEvent(level, msg, {
    route: job.route,
    job: job.name,
    ...fields,
  });
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
    hasWork: async (client, context) => (
      await hasDueGenerationCompletionJobs(client, { nowMs: context.startedAtMs })
      || await hasDueGenerationOutputImportJobs(client)
      || await hasStalledGenerationWork(client, { nowMs: context.startedAtMs })
    ),
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
      // Webhook-less safety net: reconcile stalled generations that the
      // durable completion queue never heard about (missed webhook, closed
      // app) so credit holds cannot linger forever. Bounded and idempotent.
      const stalled = await reapStalledGenerations({
        supabase: client,
        creditSupabase: client,
        nowMs: context.startedAtMs,
      });
      const outputImports = await processGenerationOutputImportJobs({
        client,
        lockedBy: `${context.lockOwner}:output-import`,
        limit: GENERATION_OUTPUT_IMPORT_BATCH_LIMIT,
      });
      const terminalTransitions = completionSummary.completed
        + stalled.providerSync.reconciled
        + stalled.startFailures.settled
        + outputImports.completed;
      const workflowWake = terminalTransitions > 0
        ? await processWorkflowRunStepJobs({
            supabase: client,
            lockedBy: `${context.lockOwner}:workflow`,
            limit: Math.min(WORKFLOW_RUN_STEP_BATCH_LIMIT, terminalTransitions),
            nowMs: context.startedAtMs,
          })
        : null;
      const templateWake = terminalTransitions > 0
        ? await processTemplateRunJobs({
            client,
            lockedBy: `${context.lockOwner}:template`,
            limit: Math.min(TEMPLATE_RUN_JOB_BATCH_LIMIT, terminalTransitions),
          })
        : null;
      const pruned = await maybePruneGenerationCompletionJobs(client, { nowMs: context.startedAtMs });
      return {
        ...completionSummary,
        stalled,
        outputImports,
        workflowWake,
        templateWake,
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

export function runOperationalDataRetentionBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['operational-data-retention'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'operational_data_retention_started',
      skippedNoWork: 'operational_data_retention_skipped_no_work',
      skippedLocked: 'operational_data_retention_skipped',
      completed: 'operational_data_retention_completed',
      failed: 'operational_data_retention_failed',
    },
    hasWork: async () => true,
    run: (client, context) => pruneOperationalBackendData(client, {
      now: new Date(context.startedAtMs),
    }),
  });
}

export function runMediaUploadReclaimBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['media-upload-reclaim'];
  const reclaimPolicy = getMediaUploadReclaimPolicy();
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'media_upload_reclaim_started',
      skippedNoWork: 'media_upload_reclaim_skipped_no_reclaimable_uploads',
      skippedLocked: 'media_upload_reclaim_skipped',
      completed: 'media_upload_reclaim_completed',
      failed: 'media_upload_reclaim_failed',
    },
    hasWork: async (client) => (
      await hasReclaimableMediaUploads(client, {
        includeAbandoned: reclaimPolicy.effectiveEnabled,
      }) || hasRepairableLegacyGenerations(client)
    ),
    onNoWork: async () => ({
      abandonedReclaimEnabled: reclaimPolicy.effectiveEnabled,
    }),
    run: async (client, context) => {
      const now = new Date(context.startedAtMs);
      // Repair first: a generation healed this run releases its staged paths
      // from the protected set before the reclaim step recomputes it.
      const repair = await repairMissingGenerationInputMedia(client, { now });

      if (repair.rollbackFailures.length > 0) {
        // A generation is stuck holding a half-set, so it no longer appears in
        // the guard's selection -- while its staged files are the only surviving
        // copy of the inputs that failed to persist. Reclaiming now would delete
        // exactly those bytes.
        return {
          repair,
          abandonedReclaimEnabled: reclaimPolicy.effectiveEnabled,
          reclaimSkipped: 'unrolled_back_partial_repair',
        };
      }

      const reclaim = await reclaimAbandonedMediaUploads(client, {
        now,
        includeAbandoned: reclaimPolicy.effectiveEnabled,
      });
      return { repair, ...reclaim };
    },
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

export function runWorkflowRunStepsBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['workflow-run-steps'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'workflow_run_steps_started',
      skippedNoWork: 'workflow_run_steps_skipped_no_due_jobs',
      skippedLocked: 'workflow_run_steps_skipped',
      completed: 'workflow_run_steps_completed',
      failed: 'workflow_run_steps_failed',
    },
    // Two independent sources of work: queued step jobs, and runs left
    // unfinished with no live job at all. The second is the strand F12 exists
    // to fix, and it is invisible to a queue-only probe -- a stranded run has
    // no job by definition.
    hasWork: async (client, context) => (
      await hasDueWorkflowRunStepJobs(client, { nowMs: context.startedAtMs })
      || await hasDueTemplateRunJobs(client)
      || (await findStalledWorkflowRuns(client, { nowMs: context.startedAtMs, limit: 1 })).length > 0
    ),
    onNoWork: async (client, context) => ({
      pruned: await maybePruneWorkflowRunStepJobs(client, { nowMs: context.startedAtMs }),
      templatePruned: await pruneTemplateRunJobs(client),
    }),
    run: async (client, context) => {
      const summary = await processWorkflowRunStepJobs({
        supabase: client,
        lockedBy: context.lockOwner,
        limit: WORKFLOW_RUN_STEP_BATCH_LIMIT,
        nowMs: context.startedAtMs,
      });
      const templates = await processTemplateRunJobs({
        client,
        lockedBy: `${context.lockOwner}:template`,
        limit: TEMPLATE_RUN_JOB_BATCH_LIMIT,
      });
      const pruned = await maybePruneWorkflowRunStepJobs(client, { nowMs: context.startedAtMs });
      const templatePruned = await pruneTemplateRunJobs(client);
      return { ...summary, templates, pruned, templatePruned };
    },
  });
}
