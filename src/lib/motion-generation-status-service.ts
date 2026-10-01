import { resolveLinkedAccountIds } from '@/lib/account-identity';
import 'server-only';
import { resolveGenerationAppModelId } from '@/lib/generation-model-attribution';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { withBackendJobLock } from '@/lib/backend-job-lock';
import { sendDeferrableNotification, type RunAfterResponse } from '@/lib/deferrable-notification';
import {
  buildFailedGenerationStatusPayload,
  buildLockedGenerationStatusPayload,
  GENERATION_PROVIDER_STATUS_RETRY_AFTER_MS,
  GENERATION_STATUS_LOCK_TTL_SECONDS,
  getGenerationStatusLockName,
  getGenerationStatusLockOwner,
  tryAcquireGenerationProviderStatusThrottle,
} from '@/lib/generation-status-lock';
import {
  estimateGenerationDurationMs,
  getGenerationKind,
  normalizeMarketGenerationTiming,
  normalizeStoredGenerationTiming,
  toIsoTimestamp,
  withGenerationTimingEstimate,
} from '@/lib/generation-timing';
import { enqueueGenerationOutputImportJob } from '@/lib/generation-output-import-jobs';
import {
  settleGenerationFailed,
} from '@/lib/generation-services';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';
import {
  fetchStatusPollWithRetry,
  fetchWithProviderTimeout,
  PROVIDER_STATUS_POLL_TIMEOUT_MS,
  withProviderModel,
} from '@/lib/provider-fetch';
import { resolveOwnedStoredMediaUrl } from '@/lib/server-helpers';
import { readProviderFailureReason, UNKNOWN_PROVIDER_FAILURE } from '@/lib/provider-failure-messages';

const MOTION_STATUS_GENERATION_SELECT = 'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, creation_mode, workflow_settings, duration, error_message';

type MotionStatusGenerationRow = {
  id: string;
  user_id: string;
  prediction_id: string;
  status: string;
  output_url: string | null;
  created_at: string | null;
  completed_at?: string | null;
  model: string | null;
  category: string | null;
  creation_mode?: string | null;
  workflow_settings?: unknown;
  duration?: number | null;
  error_message?: string | null;
};

export type MotionGenerationStatusDependencies = {
  resolveStoredMediaUrl: typeof resolveOwnedStoredMediaUrl;
  fetchWithProviderTimeout: typeof fetchWithProviderTimeout;
  enqueueGenerationOutputImportJob: typeof enqueueGenerationOutputImportJob;
  settleGenerationFailed: typeof settleGenerationFailed;
  notifyGenerationStatus: typeof notifyGenerationStatus;
  withBackendJobLock: typeof withBackendJobLock;
  tryAcquireGenerationProviderStatusThrottle: typeof tryAcquireGenerationProviderStatusThrottle;
};

type MotionGenerationStatusBody = Record<string, unknown>;

export type MotionGenerationStatusRouteResult =
  | {
      ok: true;
      body: MotionGenerationStatusBody;
    }
  | {
      ok: false;
      status: 404 | 500;
      body: {
        error: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<MotionGenerationStatusDependencies> | undefined,
): MotionGenerationStatusDependencies {
  return {
    resolveStoredMediaUrl: dependencies?.resolveStoredMediaUrl ?? resolveOwnedStoredMediaUrl,
    fetchWithProviderTimeout: dependencies?.fetchWithProviderTimeout ?? fetchStatusPollWithRetry,
    enqueueGenerationOutputImportJob: dependencies?.enqueueGenerationOutputImportJob ?? enqueueGenerationOutputImportJob,
    settleGenerationFailed: dependencies?.settleGenerationFailed ?? settleGenerationFailed,
    notifyGenerationStatus: dependencies?.notifyGenerationStatus ?? notifyGenerationStatus,
    withBackendJobLock: dependencies?.withBackendJobLock ?? withBackendJobLock,
    tryAcquireGenerationProviderStatusThrottle:
      dependencies?.tryAcquireGenerationProviderStatusThrottle ?? tryAcquireGenerationProviderStatusThrottle,
  };
}

function getWorkflowSettings(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function estimateMotionTotalMs(
  localGeneration: MotionStatusGenerationRow,
  workflowSettings: Record<string, unknown> | null,
): number | null {
  return estimateGenerationDurationMs({
    kind: 'motion',
    model: typeof workflowSettings?.model === 'string' ? workflowSettings.model : null,
    resolution: typeof workflowSettings?.mode === 'string' ? workflowSettings.mode : null,
    durationSeconds: typeof localGeneration.duration === 'number'
      ? localGeneration.duration
      : typeof workflowSettings?.duration === 'number'
        ? workflowSettings.duration
        : null,
  });
}

function getMotionResultUrl(resultJson: unknown): string | null {
  if (typeof resultJson !== 'string') {
    return null;
  }

  const result = JSON.parse(resultJson) as { resultUrls?: unknown };
  return Array.isArray(result.resultUrls) && typeof result.resultUrls[0] === 'string'
    ? result.resultUrls[0]
    : null;
}

/**
 * A failure the poll found is settled by the time this runs. What is left is
 * telling the creator's own devices, which the route sends behind its answer
 * and outside the status lock. A finished render is announced by the output
 * import job that stores it, never from here.
 */
async function notifyTerminalStatus({
  adminSupabase,
  localGeneration,
  status,
  runAfterResponse,
  dependencies,
}: {
  adminSupabase: SupabaseClient;
  localGeneration: MotionStatusGenerationRow;
  status: string;
  runAfterResponse: RunAfterResponse | undefined;
  dependencies: MotionGenerationStatusDependencies;
}) {
  if (!localGeneration.id || !localGeneration.user_id) {
    return;
  }

  if (status === 'failed') {
    await sendDeferrableNotification(runAfterResponse, () => dependencies.notifyGenerationStatus(adminSupabase, {
      id: localGeneration.id,
      user_id: localGeneration.user_id,
      category: localGeneration.category,
      model: localGeneration.model,
    }, 'failed'));
  }
}

export async function getMotionGenerationStatusForRoute({
  request,
  predictionId,
  userId,
  createAdminSupabase,
  kieApiKey,
  runAfterResponse,
  dependencies,
}: {
  request: Request;
  predictionId: string;
  userId: string;
  supabase: SupabaseClient;
  createAdminSupabase: () => SupabaseClient;
  kieApiKey: string | undefined;
  /**
   * The status route passes one: the app is polling, and waits on this answer
   * to stop showing the motion render as running. With none, the notification
   * for a result found here is sent before this returns.
   */
  runAfterResponse?: RunAfterResponse;
  dependencies?: Partial<MotionGenerationStatusDependencies>;
}): Promise<MotionGenerationStatusRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const startedAt = Date.now();
  let adminSupabase: SupabaseClient | null = null;
  const getAdminSupabase = () => {
    adminSupabase ??= createAdminSupabase();
    return adminSupabase;
  };

  // Service-role read: `authenticated` has no SELECT on output_url, model,
  // completed_at or workflow_settings, so running this as the user denies the
  // whole row and the miss surfaces as a phantom "Generation not found". The
  // user_id filter plus the ownership check below are the access boundary here.
  const ownerUserIds = await resolveLinkedAccountIds(getAdminSupabase(), userId);
  const { data: generationData, error: generationLookupError } = await getAdminSupabase()
    .from('generations')
    .select(MOTION_STATUS_GENERATION_SELECT)
    .eq('prediction_id', predictionId)
    .in('user_id', ownerUserIds)
    .single();
  if (generationLookupError && generationLookupError.code !== 'PGRST116') {
    logBackendError('generation_status_lookup_failed', {
      error: generationLookupError,
      kind: 'motion',
    });
  }
  const localGeneration = generationData as MotionStatusGenerationRow | null;

  if (!localGeneration || !ownerUserIds.includes(localGeneration.user_id)) {
    return { ok: false, status: 404, body: { error: 'Generation not found' } };
  }

  if (localGeneration.category !== 'video' || localGeneration.creation_mode !== 'motion') {
    return { ok: false, status: 404, body: { error: 'Generation not found' } };
  }

  if (localGeneration.status === 'failed') {
    return {
      ok: true,
      body: buildFailedGenerationStatusPayload(localGeneration),
    };
  }

  if (localGeneration.status === 'succeeded' && localGeneration.output_url) {
    return {
      ok: true,
      body: {
        status: 'succeeded',
        output: await resolvedDependencies.resolveStoredMediaUrl(
          getAdminSupabase(),
          localGeneration.output_url,
          localGeneration.user_id,
        ),
        timing: normalizeStoredGenerationTiming({
          kind: getGenerationKind({
            category: localGeneration.category,
            model: localGeneration.model,
          }),
          status: localGeneration.status,
          createdAt: localGeneration.created_at,
          completedAt: localGeneration.completed_at,
        }),
      },
    };
  }

  if (!kieApiKey) {
    return { ok: false, status: 500, body: { error: 'Server configuration error' } };
  }

  const workflowSettings = getWorkflowSettings(localGeneration.workflow_settings);
  const estimatedTotalMs = estimateMotionTotalMs(localGeneration, workflowSettings);
  const admin = getAdminSupabase();
  const lockOwner = getGenerationStatusLockOwner(request, startedAt);
  const lockResult = await resolvedDependencies.withBackendJobLock(admin, {
    name: getGenerationStatusLockName(predictionId),
    ttlSeconds: GENERATION_STATUS_LOCK_TTL_SECONDS,
    owner: lockOwner,
  }, async () => {
    const canCheckProvider = await resolvedDependencies.tryAcquireGenerationProviderStatusThrottle(admin, {
      predictionId,
      owner: lockOwner,
    });

    if (!canCheckProvider) {
      return buildLockedGenerationStatusPayload(
        localGeneration,
        estimatedTotalMs,
        GENERATION_PROVIDER_STATUS_RETRY_AFTER_MS,
      );
    }

    const response = await withProviderModel(resolveGenerationAppModelId(localGeneration), () => resolvedDependencies.fetchWithProviderTimeout(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
      headers: { Authorization: `Bearer ${kieApiKey}` },
    }, PROVIDER_STATUS_POLL_TIMEOUT_MS, fetch, 'KIE motion status'));

    const data = await response.json();

    if (!response.ok || data.code !== 200) {
      throw new Error(data.msg || 'Failed to check status');
    }

    const timing = normalizeMarketGenerationTiming({
      kind: 'motion',
      task: data.data,
      fallbackStartedAtMs: localGeneration.created_at ? Date.parse(localGeneration.created_at) : null,
    });
    let status = timing.appStatus;
    let error: string | null = null;

    if (status === 'succeeded') {
      try {
        const tempUrl = getMotionResultUrl(data.data?.resultJson);

        if (tempUrl) {
          // Keep settlement behind the durable import, including storage retries.
          await resolvedDependencies.enqueueGenerationOutputImportJob({
            client: admin,
            generationId: localGeneration.id,
            outputUrls: [tempUrl],
            providerCompletedAt: toIsoTimestamp(timing.completedAtMs),
          });
          return buildLockedGenerationStatusPayload(
            { ...localGeneration, status: 'processing', completed_at: null },
            estimatedTotalMs,
            GENERATION_PROVIDER_STATUS_RETRY_AFTER_MS,
          );
        } else {
          return buildLockedGenerationStatusPayload(
            { ...localGeneration, status: 'processing', completed_at: null },
            estimatedTotalMs,
            GENERATION_PROVIDER_STATUS_RETRY_AFTER_MS,
          );
        }
      } catch (successError) {
        logBackendError('error_handling_success_status', { error: successError });
        return buildLockedGenerationStatusPayload(
          { ...localGeneration, status: 'processing', completed_at: null },
          estimatedTotalMs,
          GENERATION_PROVIDER_STATUS_RETRY_AFTER_MS,
        );
      }
    } else if (status === 'failed') {
      const reason = readProviderFailureReason(data.data);
      error = reason ?? UNKNOWN_PROVIDER_FAILURE;
      status = await resolvedDependencies.settleGenerationFailed(
        admin,
        predictionId,
        toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
        reason,
      );
    }

    await notifyTerminalStatus({
      adminSupabase: admin,
      localGeneration,
      status,
      runAfterResponse,
      dependencies: resolvedDependencies,
    });

    return {
      status,
      // A finished render is answered from its stored row, before the lock.
      output: null,
      error,
      timing: withGenerationTimingEstimate(timing, estimatedTotalMs),
    };
  });

  if (!lockResult.acquired) {
    return {
      ok: true,
      body: buildLockedGenerationStatusPayload(localGeneration, estimatedTotalMs),
    };
  }

  return {
    ok: true,
    body: lockResult.value,
  };
}
