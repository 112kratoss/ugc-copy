import 'server-only';
import { resolveLinkedAccountIds } from '@/lib/account-identity';
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
  normalizeVeoGenerationTiming,
  toIsoTimestamp,
  withGenerationTimingEstimate,
} from '@/lib/generation-timing';
import { VIDEO_MODELS, type VideoModelId } from '@/lib/models';
import {
  settleGenerationFailed,
} from '@/lib/generation-services';
import { enqueueGenerationOutputImportJob } from '@/lib/generation-output-import-jobs';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';
import {
  fetchStatusPollWithRetry,
  fetchWithProviderTimeout,
  PROVIDER_STATUS_POLL_TIMEOUT_MS,
  withProviderModel,
} from '@/lib/provider-fetch';
import { resolveOwnedStoredMediaUrl } from '@/lib/server-helpers';
import { readProviderFailureReason, UNKNOWN_PROVIDER_FAILURE } from '@/lib/provider-failure-messages';

const VIDEO_STATUS_GENERATION_SELECT = 'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, creation_mode, workflow_settings, duration, error_message';

type VideoStatusGenerationRow = {
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

export type VideoGenerationStatusDependencies = {
  resolveStoredMediaUrl: typeof resolveOwnedStoredMediaUrl;
  fetchWithProviderTimeout: typeof fetchWithProviderTimeout;
  enqueueGenerationOutputImportJob: typeof enqueueGenerationOutputImportJob;
  settleGenerationFailed: typeof settleGenerationFailed;
  notifyGenerationStatus: typeof notifyGenerationStatus;
  withBackendJobLock: typeof withBackendJobLock;
  tryAcquireGenerationProviderStatusThrottle: typeof tryAcquireGenerationProviderStatusThrottle;
};

type VideoGenerationStatusBody = Record<string, unknown>;

export type VideoGenerationStatusRouteResult =
  | {
      ok: true;
      body: VideoGenerationStatusBody;
    }
  | {
      ok: false;
      status: 400 | 404 | 500;
      body: {
        error: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<VideoGenerationStatusDependencies> | undefined,
): VideoGenerationStatusDependencies {
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

function getWorkflowModelId(localGeneration: { workflow_settings?: unknown; model?: string | null } | null): VideoModelId {
  const workflowSettings = localGeneration?.workflow_settings as { model?: string } | null;
  const selectedModel = workflowSettings?.model;

  if (selectedModel && selectedModel in VIDEO_MODELS) {
    return selectedModel as VideoModelId;
  }

  if (localGeneration?.model === 'veo3' || localGeneration?.model === 'veo3_fast') {
    return 'veo-3.1';
  }

  if (localGeneration?.model === 'bytedance/seedance-1.5-pro') {
    return 'seedance-1.5-pro';
  }

  if (localGeneration?.model === 'bytedance/seedance-2') {
    return 'seedance-2';
  }

  if (localGeneration?.model === 'bytedance/seedance-2-fast') {
    return 'seedance-2-fast';
  }

  if (
    localGeneration?.model === 'grok-imagine/text-to-video' ||
    localGeneration?.model === 'grok-imagine/image-to-video'
  ) {
    return 'grok-imagine-video';
  }

  return 'kling-3.0-video';
}

function getFirstResultUrl(value: unknown): string | null {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : null;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
        return parsed[0];
      }
    } catch {
      return value;
    }
  }

  return null;
}

function estimateVideoTotalMs(localGeneration: VideoStatusGenerationRow, selectedModel: VideoModelId): number | null {
  const workflowSettings =
    localGeneration.workflow_settings && typeof localGeneration.workflow_settings === 'object'
      ? localGeneration.workflow_settings as Record<string, unknown>
      : null;
  const referenceCount =
    (Array.isArray(workflowSettings?.elements) ? workflowSettings.elements.length : 0) +
    (Array.isArray(workflowSettings?.referenceVideoUrls) ? workflowSettings.referenceVideoUrls.length : 0) +
    (Array.isArray(workflowSettings?.referenceAudioUrls) ? workflowSettings.referenceAudioUrls.length : 0) +
    (Array.isArray(workflowSettings?.klingVideoElements) ? workflowSettings.klingVideoElements.length : 0) +
    (workflowSettings?.startFrame ? 1 : 0) +
    (workflowSettings?.endFrame ? 1 : 0);
  const hasReferenceVideo =
    (Array.isArray(workflowSettings?.referenceVideoUrls) && workflowSettings.referenceVideoUrls.length > 0) ||
    (Array.isArray(workflowSettings?.klingVideoElements) && workflowSettings.klingVideoElements.length > 0);

  return estimateGenerationDurationMs({
    kind: 'video',
    model: selectedModel,
    mode: typeof workflowSettings?.mode === 'string' ? workflowSettings.mode : null,
    resolution: typeof workflowSettings?.resolution === 'string' ? workflowSettings.resolution : null,
    durationSeconds: typeof localGeneration.duration === 'number'
      ? localGeneration.duration
      : typeof workflowSettings?.duration === 'number'
        ? workflowSettings.duration
        : null,
    isMultiShot: typeof workflowSettings?.isMultiShot === 'boolean' ? workflowSettings.isMultiShot : null,
    shotCount: Array.isArray(workflowSettings?.multiPrompts) ? workflowSettings.multiPrompts.length : null,
    referenceCount,
    hasSound: typeof workflowSettings?.sound === 'boolean' ? workflowSettings.sound : null,
    hasReferenceVideo,
  });
}

export async function getVideoGenerationStatusForRoute({
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
   * to stop showing the video as rendering. With none, the notification for a
   * result found here is sent before this returns.
   */
  runAfterResponse?: RunAfterResponse;
  dependencies?: Partial<VideoGenerationStatusDependencies>;
}): Promise<VideoGenerationStatusRouteResult> {
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
    .select(VIDEO_STATUS_GENERATION_SELECT)
    .eq('prediction_id', predictionId)
    .in('user_id', ownerUserIds)
    .single();
  if (generationLookupError && generationLookupError.code !== 'PGRST116') {
    logBackendError('generation_status_lookup_failed', {
      error: generationLookupError,
      kind: 'video',
    });
  }
  const localGeneration = generationData as VideoStatusGenerationRow | null;

  if (!localGeneration || !ownerUserIds.includes(localGeneration.user_id)) {
    return { ok: false, status: 404, body: { error: 'Generation not found' } };
  }

  if (localGeneration.category !== 'video' || localGeneration.creation_mode !== null) {
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

  const selectedModel = getWorkflowModelId(localGeneration);
  const estimatedTotalMs = estimateVideoTotalMs(localGeneration, selectedModel);
  let status: 'processing' | 'waiting' | 'succeeded' | 'failed' = 'processing';
  const output: string | null = null;
  let error: string | null = null;
  let timing = normalizeStoredGenerationTiming({
    kind: getGenerationKind({
      category: localGeneration.category,
      model: localGeneration.model,
    }),
    status: localGeneration.status,
    createdAt: localGeneration.created_at,
    completedAt: localGeneration.completed_at,
  });

  const lockOwner = getGenerationStatusLockOwner(request, startedAt);
  const admin = getAdminSupabase();
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

    if (selectedModel === 'veo-3.1') {
      const response = await withProviderModel(resolveGenerationAppModelId(localGeneration), () => resolvedDependencies.fetchWithProviderTimeout(`https://api.kie.ai/api/v1/veo/record-info?taskId=${predictionId}`, {
        headers: { Authorization: `Bearer ${kieApiKey}` },
      }, PROVIDER_STATUS_POLL_TIMEOUT_MS, fetch, 'KIE Veo status'));

      const data = await response.json();

      if (!response.ok || data.code !== 200) {
        throw new Error(data.msg || 'Failed to check status');
      }

      const successFlag = data.data?.successFlag;
      const responseData = data.data?.response;
      timing = normalizeVeoGenerationTiming({
        kind: 'video',
        task: data.data,
        fallbackStartedAtMs: localGeneration.created_at ? Date.parse(localGeneration.created_at) : null,
      });
      status = timing.appStatus;

      if (successFlag === 1) {
        const tempUrl = getFirstResultUrl(responseData?.resultUrls) || getFirstResultUrl(responseData?.originUrls);

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
      } else if (successFlag === 2 || successFlag === 3) {
        // The reason is on the task. This body passed the code-200 check above,
        // so its top-level `msg` is "success" and must never stand in for it.
        const reason = readProviderFailureReason(data.data);
        error = reason ?? UNKNOWN_PROVIDER_FAILURE;
        status = await resolvedDependencies.settleGenerationFailed(
          admin,
          predictionId,
          toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
          reason,
        );
      }
    } else {
      const response = await withProviderModel(resolveGenerationAppModelId(localGeneration), () => resolvedDependencies.fetchWithProviderTimeout(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
        headers: { Authorization: `Bearer ${kieApiKey}` },
      }, PROVIDER_STATUS_POLL_TIMEOUT_MS, fetch, 'KIE video status'));

      const data = await response.json();

      if (!response.ok || data.code !== 200) {
        throw new Error(data.msg || 'Failed to check status');
      }

      timing = normalizeMarketGenerationTiming({
        kind: 'video',
        task: data.data,
        fallbackStartedAtMs: localGeneration.created_at ? Date.parse(localGeneration.created_at) : null,
      });
      status = timing.appStatus;

      if (status === 'succeeded') {
        try {
          const result = JSON.parse(data.data.resultJson);
          const tempUrl = getFirstResultUrl(result.resultUrls);

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
        } catch (parseError) {
          logBackendError('error_handling_success_status', { error: parseError });
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
    }

    // A result found above is settled by now. What is left is telling the
    // creator's own devices, which the route sends behind its answer and
    // outside this lock.
    if (localGeneration.id && localGeneration.user_id) {
      if (status === 'succeeded' && output) {
        await sendDeferrableNotification(runAfterResponse, () => resolvedDependencies.notifyGenerationStatus(admin, {
          id: localGeneration.id,
          user_id: localGeneration.user_id,
          category: localGeneration.category,
          model: localGeneration.model,
        }, 'succeeded'));
      } else if (status === 'failed') {
        await sendDeferrableNotification(runAfterResponse, () => resolvedDependencies.notifyGenerationStatus(admin, {
          id: localGeneration.id,
          user_id: localGeneration.user_id,
          category: localGeneration.category,
          model: localGeneration.model,
        }, 'failed'));
      }
    }

    return {
      status,
      output,
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
