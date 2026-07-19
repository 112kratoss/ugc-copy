import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getBackendJobRequestId,
  runBackendAlertDeliveryJob,
  runFeedMaintenanceBackendJob,
  runGenerationCompletionsBackendJob,
  runGenerationModelVerificationBackendJob,
  runMediaPreviewRepairBackendJob,
  runMobilePushReceiptsBackendJob,
  runReferralRewardReconciliationBackendJob,
  type BackendJobExecutionResult,
} from '@/lib/backend-job-executions';
import {
  BACKEND_JOB_SCHEDULER,
  getDueBackendJobs,
  type BackendJobDefinition,
} from '@/lib/backend-jobs';
import { createServiceClient } from '@/lib/server-helpers';

type BackendJobsRouteDependencies = {
  now?: () => number;
  createServiceClient?: () => SupabaseClient;
  getBackendJobRequestId?: (request: Request) => string;
  getDueBackendJobs?: (timestampMs: number) => BackendJobDefinition[];
  runBackendAlertDeliveryJob?: typeof runBackendAlertDeliveryJob;
  runFeedMaintenanceBackendJob?: typeof runFeedMaintenanceBackendJob;
  runGenerationCompletionsBackendJob?: typeof runGenerationCompletionsBackendJob;
  runGenerationModelVerificationBackendJob?: typeof runGenerationModelVerificationBackendJob;
  runMediaPreviewRepairBackendJob?: typeof runMediaPreviewRepairBackendJob;
  runMobilePushReceiptsBackendJob?: typeof runMobilePushReceiptsBackendJob;
  runReferralRewardReconciliationBackendJob?: typeof runReferralRewardReconciliationBackendJob;
};

export type BackendJobsSchedulerRouteResult =
  | {
      status: 202;
      body: {
        success: true;
        skipped: true;
        reason: 'no_due_backend_jobs';
        scheduler: typeof BACKEND_JOB_SCHEDULER.route;
      };
    }
  | {
      status: 200 | 202 | 500;
      body: {
        success: boolean;
        scheduler: typeof BACKEND_JOB_SCHEDULER.route;
        dueJobs: BackendJobDefinition['name'][];
        results: BackendJobExecutionResult[];
      };
    };

function resolveDependencies(dependencies: BackendJobsRouteDependencies | undefined) {
  return {
    now: dependencies?.now ?? Date.now,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    getBackendJobRequestId: dependencies?.getBackendJobRequestId ?? getBackendJobRequestId,
    getDueBackendJobs: dependencies?.getDueBackendJobs ?? getDueBackendJobs,
    runBackendAlertDeliveryJob: dependencies?.runBackendAlertDeliveryJob
      ?? runBackendAlertDeliveryJob,
    runFeedMaintenanceBackendJob: dependencies?.runFeedMaintenanceBackendJob
      ?? runFeedMaintenanceBackendJob,
    runGenerationCompletionsBackendJob: dependencies?.runGenerationCompletionsBackendJob
      ?? runGenerationCompletionsBackendJob,
    runGenerationModelVerificationBackendJob: dependencies?.runGenerationModelVerificationBackendJob
      ?? runGenerationModelVerificationBackendJob,
    runMediaPreviewRepairBackendJob: dependencies?.runMediaPreviewRepairBackendJob
      ?? runMediaPreviewRepairBackendJob,
    runMobilePushReceiptsBackendJob: dependencies?.runMobilePushReceiptsBackendJob
      ?? runMobilePushReceiptsBackendJob,
    runReferralRewardReconciliationBackendJob:
      dependencies?.runReferralRewardReconciliationBackendJob
      ?? runReferralRewardReconciliationBackendJob,
  };
}

async function runDueBackendJob(
  job: BackendJobDefinition,
  options: {
    requestId: string;
    startedAtMs: number;
    serviceClient: SupabaseClient;
    dependencies: ReturnType<typeof resolveDependencies>;
  },
): Promise<BackendJobExecutionResult> {
  const runOptions = {
    requestId: `${options.requestId}:${job.name}`,
    startedAtMs: options.startedAtMs,
    serviceClient: options.serviceClient,
    triggerRoute: BACKEND_JOB_SCHEDULER.route,
  };

  switch (job.name) {
    case 'backend-alert-delivery':
      return options.dependencies.runBackendAlertDeliveryJob(runOptions);
    case 'feed-maintenance':
      return options.dependencies.runFeedMaintenanceBackendJob(runOptions);
    case 'generation-completions':
      return options.dependencies.runGenerationCompletionsBackendJob(runOptions);
    case 'generation-model-verification':
      return options.dependencies.runGenerationModelVerificationBackendJob(runOptions);
    case 'media-preview-repair':
      return options.dependencies.runMediaPreviewRepairBackendJob(runOptions);
    case 'mobile-push-receipts':
      return options.dependencies.runMobilePushReceiptsBackendJob(runOptions);
    case 'referral-reward-reconciliation':
      return options.dependencies.runReferralRewardReconciliationBackendJob(runOptions);
    default: {
      const exhaustiveJobName: never = job.name;
      throw new Error(`Unsupported backend job: ${exhaustiveJobName}`);
    }
  }
}

export async function runBackendJobsSchedulerForRoute({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: BackendJobsRouteDependencies;
}): Promise<BackendJobsSchedulerRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const startedAtMs = resolvedDependencies.now();
  const requestId = resolvedDependencies.getBackendJobRequestId(request);
  const dueJobs = resolvedDependencies.getDueBackendJobs(startedAtMs);

  if (dueJobs.length === 0) {
    return {
      status: 202,
      body: {
        success: true,
        skipped: true,
        reason: 'no_due_backend_jobs',
        scheduler: BACKEND_JOB_SCHEDULER.route,
      },
    };
  }

  const serviceClient = resolvedDependencies.createServiceClient();
  const results = await Promise.all(
    dueJobs.map((job) => runDueBackendJob(job, {
      requestId,
      startedAtMs,
      serviceClient,
      dependencies: resolvedDependencies,
    })),
  );
  const hasFailure = results.some((result) => !result.success);
  const hasSuccess = results.some((result) => result.success && result.status === 'succeeded');

  return {
    status: hasFailure ? 500 : hasSuccess ? 200 : 202,
    body: {
      success: !hasFailure,
      scheduler: BACKEND_JOB_SCHEDULER.route,
      dueJobs: dueJobs.map((job) => job.name),
      results,
    },
  };
}
