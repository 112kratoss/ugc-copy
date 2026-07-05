import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { withBackendJobLock } from '@/lib/backend-job-lock';
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
  settleGenerationSucceeded,
} from '@/lib/generation-services';
import { createGenerationOutputPreview } from '@/lib/generation-output-preview';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';
import {
  fetchWithProviderTimeout,
  PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS,
  PROVIDER_STATUS_POLL_TIMEOUT_MS,
} from '@/lib/provider-fetch';
import { resolveStoredMediaUrl } from '@/lib/server-helpers';

const VIDEO_STATUS_GENERATION_SELECT = 'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, creation_mode, workflow_settings, duration';

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
};

export type VideoGenerationStatusDependencies = {
  resolveStoredMediaUrl: typeof resolveStoredMediaUrl;
  fetchWithProviderTimeout: typeof fetchWithProviderTimeout;
  settleGenerationSucceeded: typeof settleGenerationSucceeded;
  settleGenerationFailed: typeof settleGenerationFailed;
  createGenerationOutputPreview: typeof createGenerationOutputPreview;
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
    resolveStoredMediaUrl: dependencies?.resolveStoredMediaUrl ?? resolveStoredMediaUrl,
    fetchWithProviderTimeout: dependencies?.fetchWithProviderTimeout ?? fetchWithProviderTimeout,
    settleGenerationSucceeded: dependencies?.settleGenerationSucceeded ?? settleGenerationSucceeded,
    settleGenerationFailed: dependencies?.settleGenerationFailed ?? settleGenerationFailed,
    createGenerationOutputPreview: dependencies?.createGenerationOutputPreview ?? createGenerationOutputPreview,
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

async function persistVideoOutput({
  supabase,
  settlementSupabase,
  predictionId,
  userId,
  tempUrl,
  completedAt,
  dependencies,
}: {
  supabase: SupabaseClient;
  settlementSupabase: SupabaseClient;
  predictionId: string;
  userId: string | undefined;
  tempUrl: string;
  completedAt?: string | null;
  dependencies: VideoGenerationStatusDependencies;
}): Promise<{ status: 'succeeded' | 'failed'; output: string | null }> {
  const settledAt = completedAt ?? new Date().toISOString();

  try {
    const videoRes = await dependencies.fetchWithProviderTimeout(
      tempUrl,
      {},
      PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS,
      fetch,
      'KIE video media download',
    );
    if (!videoRes.ok) {
      throw new Error('Failed to download video from Kie');
    }

    const videoBlob = await videoRes.blob();
    const fileName = `${userId}/generated_${predictionId}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from('generated_videos')
      .upload(fileName, videoBlob, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload to Supabase Storage failed:', uploadError);
      const status = await dependencies.settleGenerationSucceeded(settlementSupabase, {
        predictionId,
        outputUrl: tempUrl,
        completedAt: settledAt,
      });
      return {
        status,
        output: status === 'succeeded' ? tempUrl : null,
      };
    }

    const storagePath = `generated_videos/${fileName}`;
    let preview: Awaited<ReturnType<typeof createGenerationOutputPreview>> = null;
    let previewError: string | null = null;
    try {
      preview = await dependencies.createGenerationOutputPreview({
        body: videoBlob,
        category: 'video',
        contentType: videoBlob.type || 'video/mp4',
        storagePath,
        supabase,
      });
    } catch (posterError) {
      console.error('Failed to create video generation preview poster:', posterError);
      previewError = posterError instanceof Error ? posterError.message.slice(0, 500) : 'Preview generation failed.';
    }
    const { data: signedData } = await supabase.storage
      .from('generated_videos')
      .createSignedUrl(fileName, 3600);

    const status = await dependencies.settleGenerationSucceeded(settlementSupabase, {
      predictionId,
      outputUrl: storagePath,
      previewUrl: preview?.previewStoragePath ?? null,
      previewThumbhash: preview?.previewThumbhash ?? null,
      previewStatus: preview ? 'ready' : 'failed',
      previewAttemptCount: 1,
      previewError,
      previewGeneratedAt: preview ? new Date().toISOString() : null,
      completedAt: settledAt,
    });

    return {
      status,
      output: status === 'succeeded' ? signedData?.signedUrl || tempUrl : null,
    };
  } catch (error) {
    console.error('Error persisting video to storage:', error);
    const status = await dependencies.settleGenerationSucceeded(settlementSupabase, {
      predictionId,
      outputUrl: tempUrl,
      completedAt: settledAt,
    });
    return {
      status,
      output: status === 'succeeded' ? tempUrl : null,
    };
  }
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
  supabase,
  createAdminSupabase,
  kieApiKey,
  dependencies,
}: {
  request: Request;
  predictionId: string;
  userId: string;
  supabase: SupabaseClient;
  createAdminSupabase: () => SupabaseClient;
  kieApiKey: string | undefined;
  dependencies?: Partial<VideoGenerationStatusDependencies>;
}): Promise<VideoGenerationStatusRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const startedAt = Date.now();
  let adminSupabase: SupabaseClient | null = null;
  const getAdminSupabase = () => {
    adminSupabase ??= createAdminSupabase();
    return adminSupabase;
  };

  const { data: generationData } = await supabase
    .from('generations')
    .select(VIDEO_STATUS_GENERATION_SELECT)
    .eq('prediction_id', predictionId)
    .eq('user_id', userId)
    .single();
  const localGeneration = generationData as VideoStatusGenerationRow | null;

  if (!localGeneration || localGeneration.user_id !== userId) {
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
        output: await resolvedDependencies.resolveStoredMediaUrl(getAdminSupabase(), localGeneration.output_url),
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
  let output: string | null = null;
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
      const response = await resolvedDependencies.fetchWithProviderTimeout(`https://api.kie.ai/api/v1/veo/record-info?taskId=${predictionId}`, {
        headers: { Authorization: `Bearer ${kieApiKey}` },
      }, PROVIDER_STATUS_POLL_TIMEOUT_MS, fetch, 'KIE Veo status');

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
          const persisted = await persistVideoOutput({
            supabase,
            settlementSupabase: admin,
            predictionId,
            userId: userId || localGeneration.user_id,
            tempUrl,
            completedAt: toIsoTimestamp(timing.completedAtMs),
            dependencies: resolvedDependencies,
          });
          status = persisted.status;
          output = persisted.output;
          if (status === 'failed') {
            error = 'Generation was already settled as failed.';
          }
        } else {
          status = await resolvedDependencies.settleGenerationSucceeded(admin, {
            predictionId,
            completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
          });
          if (status === 'failed') {
            error = 'Generation was already settled as failed.';
          }
        }
      } else if (successFlag === 2 || successFlag === 3) {
        error = data.data?.errorMessage || data.msg || 'Unknown error';
        status = await resolvedDependencies.settleGenerationFailed(
          admin,
          predictionId,
          toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
        );
      }
    } else {
      const response = await resolvedDependencies.fetchWithProviderTimeout(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
        headers: { Authorization: `Bearer ${kieApiKey}` },
      }, PROVIDER_STATUS_POLL_TIMEOUT_MS, fetch, 'KIE video status');

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
            const persisted = await persistVideoOutput({
              supabase,
              settlementSupabase: admin,
              predictionId,
              userId: userId || localGeneration.user_id,
              tempUrl,
              completedAt: toIsoTimestamp(timing.completedAtMs),
              dependencies: resolvedDependencies,
            });
            status = persisted.status;
            output = persisted.output;
            if (status === 'failed') {
              error = 'Generation was already settled as failed.';
            }
          } else {
            status = await resolvedDependencies.settleGenerationSucceeded(admin, {
              predictionId,
              completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
            });
            if (status === 'failed') {
              error = 'Generation was already settled as failed.';
            }
          }
        } catch (parseError) {
          console.error('Error handling success status:', parseError);
        }
      } else if (status === 'failed') {
        error = data.data.failMsg || 'Unknown error';
        status = await resolvedDependencies.settleGenerationFailed(
          admin,
          predictionId,
          toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
        );
      }
    }

    if (localGeneration.id && localGeneration.user_id) {
      if (status === 'succeeded' && output) {
        await resolvedDependencies.notifyGenerationStatus(admin, {
          id: localGeneration.id,
          user_id: localGeneration.user_id,
          category: localGeneration.category,
          model: localGeneration.model,
        }, 'succeeded');
      } else if (status === 'failed') {
        await resolvedDependencies.notifyGenerationStatus(admin, {
          id: localGeneration.id,
          user_id: localGeneration.user_id,
          category: localGeneration.category,
          model: localGeneration.model,
        }, 'failed');
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
