import { MobilePushMaintenanceError } from '@/lib/mobile-push-maintenance-error';
import { ReferralRewardReconciliationError } from '@/lib/referral-reward-reconciliation';
import { hasPendingUploadedMediaMaintenance, processUploadedMediaMaintenance } from '@/lib/uploaded-media-maintenance';
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
import { driveQueuedSubmissions } from '@/lib/generation-submission-queue';
import { hasQueuedProviderSubmissions } from '@/lib/generation-submission-queue-store';
import { hasFeedEmbeddingWork, runFeedEmbeddingJob } from '@/lib/feed-embeddings';
import { maintainFeedPersonalization } from '@/lib/feed-maintenance';
import { pruneOperationalBackendData } from '@/lib/operational-data-retention';
import { rollupPostViews } from '@/lib/post-view-counts';
import { sweepRecipeFileCopies } from '@/lib/recipe-copy-sweep';
import { rebuildSearchDictionary } from '@/lib/search-dictionary';
import { hasSearchEmbeddingWork, runSearchEmbeddingJob } from '@/lib/search-embeddings';
import {
  GenerationCompletionBatchError,
  hasDueGenerationCompletionJobs,
  maybePruneGenerationCompletionJobs,
  processGenerationCompletionJobs,
  type GenerationCompletionProcessSummary,
} from '@/lib/generation-completion-jobs';
import { hasDueGenerationOutputImportJobs } from '@/lib/generation-output-import-jobs';
import {
  hasDueGenerationOutputImportRetries,
  retryOrAbandonExhaustedGenerationOutputImports,
} from '@/lib/generation-output-import-retries';
import { hasStaleAiUsageCharges, refundStaleAiUsageCharges } from '@/lib/stale-ai-usage-refunds';
import {
  GENERATION_OUTPUT_IMPORT_BATCH_LIMIT,
  processGenerationOutputImportJobs,
} from '@/lib/generation-output-import-jobs-processor';
import { verifyPublishedGenerationModels } from '@/lib/generation-model-provider-verification';
import { hasConfiguredKieAccountBalanceCheck } from '@/lib/kie-account-balance';
import { checkKieAccountBalance } from '@/lib/kie-account-balance-alert';
import { hasRepairableMediaPreviews, repairMediaPreviews } from '@/lib/media-preview-repair';
import {
  hasReclaimableMediaUploads,
  reclaimMediaUploadsWithinBudget,
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
import {
  invalidateShowcaseFeedAndRefreshPostPages,
  invalidateShowcaseFeedCache,
} from '@/lib/showcase-feed-cache';
import {
  hasPendingShowcaseMediaRevocations,
  processShowcaseMediaRevocations,
  ShowcaseMediaRevocationsStuckError,
  type ShowcaseMediaRevocationSummary,
} from '@/lib/showcase-media-revocations';
import {
  hasPendingPostMediaPublicCopyWork,
  maintainPostMediaPublicCopies,
} from '@/lib/post-media-public-copies';
import {
  findStrandedTemplateRuns,
  hasDueTemplateRunJobs,
  pruneTemplateRunJobs,
} from '@/lib/template-run-jobs';
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

/**
 * Admission deadlines of the generation-completions run, measured from its
 * start, inside the route's 300-second maxDuration. Each stage starts no new
 * item after its deadline; an item already started runs to its end, so each
 * leaves room for the slowest single item (a provider status poll is three
 * ten-second tries; an output import has its own 60-second admission budget)
 * and for the queue pass and the wake-ups after the imports. Work not started
 * stays queued or eligible for the next ten-minute tick.
 *
 * The cheap, money-settling sweeps (exhausted imports, stale AI charges) run
 * right after the drain, so a slow provider in the reaper cannot starve them.
 */
export const GENERATION_COMPLETIONS_RUN_DEADLINES_MS = {
  completionDrain: 90_000,
  stalledReaper: 150_000,
  outputImports: 210_000,
} as const;

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
      const partialSummary = error instanceof MobilePushMaintenanceError || error instanceof ReferralRewardReconciliationError ? error.summary : undefined;
      if (currentServiceClient) {
        await finishBackendJobRun(currentServiceClient, jobRun, {
          status: 'failed',
          finishedAtMs,
          errorMessage: errorMessage(error),
          ...(partialSummary ? { summary: partialSummary } : {}),
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

/** The queue holds 200 runs at most; a cron pass asks for the oldest of them. */
const QUEUED_SUBMISSION_CRON_BATCH_LIMIT = 25;

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
      || await hasQueuedProviderSubmissions(client)
      || await hasDueGenerationOutputImportRetries(client, { nowMs: context.startedAtMs })
      || await hasStaleAiUsageCharges(client, { nowMs: context.startedAtMs })
    ),
    onNoWork: async (client, context) => ({
      pruned: await maybePruneGenerationCompletionJobs(client, { nowMs: context.startedAtMs }),
    }),
    run: async (client, context) => {
      // A job the drain could not finish fails this run, but only at the end.
      // Everything below is owed to other generations: the reaper is their
      // safety net and must not be switched off by one job that keeps throwing.
      const deadline = (stage: keyof typeof GENERATION_COMPLETIONS_RUN_DEADLINES_MS) => (
        context.startedAtMs + GENERATION_COMPLETIONS_RUN_DEADLINES_MS[stage]
      );
      let completionFailure: GenerationCompletionBatchError | null = null;
      let completionSummary: GenerationCompletionProcessSummary;
      try {
        completionSummary = await processGenerationCompletionJobs({
          supabase: client,
          creditSupabase: client,
          lockedBy: context.lockOwner,
          limit: GENERATION_COMPLETION_BATCH_LIMIT,
          deadlineMs: deadline('completionDrain'),
        });
      } catch (error) {
        if (!(error instanceof GenerationCompletionBatchError)) throw error;
        completionFailure = error;
        completionSummary = error.summary;
      }
      // A provider-finished generation whose file could not be stored: its
      // exhausted import is reopened hourly, then failed and refunded once the
      // provider's file can no longer be there.
      const outputImportRetries = await retryOrAbandonExhaustedGenerationOutputImports({
        client,
        nowMs: context.startedAtMs,
        deadlineMs: deadline('outputImports'),
      });
      // A prompt-enhancement or assistant charge whose request died unsettled.
      const aiUsageRefunds = await refundStaleAiUsageCharges({
        client,
        nowMs: context.startedAtMs,
        deadlineMs: deadline('outputImports'),
      });
      // Webhook-less safety net: reconcile stalled generations that the
      // durable completion queue never heard about (missed webhook, closed
      // app) so credit holds cannot linger forever. Bounded and idempotent.
      const stalled = await reapStalledGenerations({
        supabase: client,
        creditSupabase: client,
        nowMs: context.startedAtMs,
        deadlineMs: deadline('stalledReaper'),
      });
      const outputImports = await processGenerationOutputImportJobs({
        client,
        lockedBy: `${context.lockOwner}:output-import`,
        limit: GENERATION_OUTPUT_IMPORT_BATCH_LIMIT,
        deadlineMs: deadline('outputImports'),
      });
      // The backstop for queued starts: one whose request stopped asking and
      // whose creator left is sent, or expired and refunded, from here.
      const queuedStarts = await driveQueuedSubmissions({
        client,
        limit: QUEUED_SUBMISSION_CRON_BATCH_LIMIT,
      });
      const terminalTransitions = completionSummary.completed
        + stalled.providerSync.reconciled
        + stalled.providerSync.abandoned
        + stalled.startFailures.settled
        + outputImports.completed
        + outputImportRetries.abandoned;
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
      if (completionFailure) throw completionFailure;
      return {
        ...completionSummary,
        stalled,
        outputImports,
        outputImportRetries,
        aiUsageRefunds,
        queuedStarts,
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

export function runKieAccountBalanceBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['kie-account-balance'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'kie_account_balance_check_started',
      skippedNoWork: 'kie_account_balance_check_skipped_not_configured',
      skippedLocked: 'kie_account_balance_check_skipped',
      completed: 'kie_account_balance_check_completed',
      failed: 'kie_account_balance_check_failed',
    },
    hasWork: async () => hasConfiguredKieAccountBalanceCheck(),
    onNoWork: async () => ({ configured: false }),
    run: (client, context) => checkKieAccountBalance(client, {
      trigger: 'schedule',
      lockOwner: context.lockOwner,
      now: new Date(context.startedAtMs),
    }),
  });
}

export function runFeedEmbeddingsBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['feed-embeddings'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'feed_embeddings_started',
      skippedNoWork: 'feed_embeddings_skipped_no_work',
      skippedLocked: 'feed_embeddings_skipped',
      completed: 'feed_embeddings_completed',
      failed: 'feed_embeddings_failed',
    },
    hasWork: (client, context) => hasFeedEmbeddingWork(client, { now: new Date(context.startedAtMs) }),
    run: (client, context) => runFeedEmbeddingJob(client, { now: new Date(context.startedAtMs) }),
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

export function runRecipeCopySweepBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['recipe-copy-sweep'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'recipe_copy_sweep_started',
      skippedNoWork: 'recipe_copy_sweep_skipped_no_work',
      skippedLocked: 'recipe_copy_sweep_skipped',
      completed: 'recipe_copy_sweep_finished',
      failed: 'recipe_copy_sweep_failed',
    },
    // The candidates are the run's own read; a run that finds none reports zeros.
    hasWork: async () => true,
    run: (client, context) => sweepRecipeFileCopies(client, { now: new Date(context.startedAtMs) }),
  });
}

export function runPostViewCountsBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['post-view-counts'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'post_view_counts_started',
      skippedNoWork: 'post_view_counts_skipped_no_work',
      skippedLocked: 'post_view_counts_skipped',
      completed: 'post_view_counts_completed',
      failed: 'post_view_counts_failed',
    },
    // The rollup's own call is the cheapest check: with nothing to count it
    // reads one index and reports zeros.
    hasWork: async () => true,
    run: (client, context) => rollupPostViews(client, { now: new Date(context.startedAtMs) }),
  });
}

export function runSearchDictionaryBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['search-dictionary'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'search_dictionary_started',
      skippedNoWork: 'search_dictionary_skipped_no_work',
      skippedLocked: 'search_dictionary_skipped',
      completed: 'search_dictionary_completed',
      failed: 'search_dictionary_failed',
    },
    // Two bounded SQL calls (the dictionary, then the phrases), each
    // reporting what it holds; zeros when nothing changed.
    hasWork: async () => true,
    run: (client) => rebuildSearchDictionary(client),
  });
}

export function runSearchEmbeddingsBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['search-embeddings'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'search_embeddings_started',
      skippedNoWork: 'search_embeddings_skipped_no_work',
      skippedLocked: 'search_embeddings_skipped',
      completed: 'search_embeddings_completed',
      failed: 'search_embeddings_failed',
    },
    // One read: a post waiting for its vector, or rows to prune. Nothing while
    // SEARCH_SEMANTIC_DISABLED is on.
    hasWork: (client) => hasSearchEmbeddingWork(client),
    run: (client, context) => runSearchEmbeddingJob(client, { now: new Date(context.startedAtMs) }),
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

      const reclaim = await reclaimMediaUploadsWithinBudget(client, {
        now,
        includeAbandoned: reclaimPolicy.effectiveEnabled,
      });
      return { repair, ...reclaim };
    },
  });
}

export function runShowcaseMediaRevocationsBackendJob(options: {
  requestId?: string;
  startedAtMs?: number;
  serviceClient?: SupabaseClient;
  triggerRoute?: string;
} = {}) {
  const job = BACKEND_JOBS_BY_NAME['showcase-media-revocations'];
  return runManagedBackendJob({
    ...options,
    job,
    messages: {
      started: 'showcase_media_revocations_started',
      skippedNoWork: 'showcase_media_revocations_skipped_no_pending_revocations',
      skippedLocked: 'showcase_media_revocations_skipped',
      completed: 'showcase_media_revocations_completed',
      failed: 'showcase_media_revocations_failed',
    },
    hasWork: async (client) => {
      const pending = await Promise.all([
        hasPendingShowcaseMediaRevocations(client),
        hasPendingUploadedMediaMaintenance(client),
        hasPendingPostMediaPublicCopyWork(client),
      ]);
      return pending.some(Boolean);
    },
    run: async (client, context) => {
      // A creation's copy stuck for a day fails the run, but only after the
      // passes below: a stuck row must never hold back another removal.
      let stuck: ShowcaseMediaRevocationsStuckError | null = null;
      let revocations: ShowcaseMediaRevocationSummary;
      try {
        revocations = await processShowcaseMediaRevocations(client, { now: new Date(context.startedAtMs) });
      } catch (error) {
        if (!(error instanceof ShowcaseMediaRevocationsStuckError)) throw error;
        stuck = error;
        revocations = error.summary;
      }
      const uploadedMedia = await processUploadedMediaMaintenance(client);
      // The public copies of posts' uploaded media: what the routes did not
      // remove, then the derivatives sweeps built for posts already copied.
      const publicCopies = await maintainPostMediaPublicCopies(client, { now: new Date(context.startedAtMs) });
      for (const post of publicCopies.copiedPosts) {
        await invalidateShowcaseFeedAndRefreshPostPages(client, {
          postId: post.postId,
          creatorId: post.ownerUserId,
          arrived: false,
        });
      }
      if (stuck) throw stuck;
      return {
        ...revocations,
        uploadedMedia,
        postMediaPublicCopies: { removal: publicCopies.removal, synced: publicCopies.synced },
      };
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
    onNoWork: async () => ({ processed: 0, settled: 0, failed: 0, failures: [], notificationDelivery: { processed: 0, delivered: 0, failed: 0 } }),
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
    // no job by definition. Template runs strand the same way, and their
    // probe keeps its own limit: it reads the runs before their tickets, so
    // a limit of one would look at the oldest run in progress and no other.
    hasWork: async (client, context) => (
      await hasDueWorkflowRunStepJobs(client, { nowMs: context.startedAtMs })
      || await hasDueTemplateRunJobs(client)
      || (await findStalledWorkflowRuns(client, { nowMs: context.startedAtMs, limit: 1 })).length > 0
      || (await findStrandedTemplateRuns(client, { nowMs: context.startedAtMs })).length > 0
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
