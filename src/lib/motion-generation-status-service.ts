import 'server-only';
import { resolveGenerationAppModelId } from '@/lib/generation-model-attribution';
import { logBackendError } from '@/lib/backend-logger';

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
  toIsoTimestamp,
  withGenerationTimingEstimate,
} from '@/lib/generation-timing';
import { createGenerationOutputPreview } from '@/lib/generation-output-preview';
import {
  settleGenerationFailed,
  settleGenerationSucceeded,
} from '@/lib/generation-services';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';
import {
  fetchStatusPollWithRetry,
  fetchWithProviderTimeout,
  PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS,
  PROVIDER_STATUS_POLL_TIMEOUT_MS,
  withProviderModel,
} from '@/lib/provider-fetch';
import { resolveStoredMediaUrl } from '@/lib/server-helpers';

const MOTION_STATUS_GENERATION_SELECT = 'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, creation_mode, workflow_settings, duration';

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
};

export type MotionGenerationStatusDependencies = {
  resolveStoredMediaUrl: typeof resolveStoredMediaUrl;
  fetchWithProviderTimeout: typeof fetchWithProviderTimeout;
  settleGenerationSucceeded: typeof settleGenerationSucceeded;
  settleGenerationFailed: typeof settleGenerationFailed;
  createGenerationOutputPreview: typeof createGenerationOutputPreview;
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
    resolveStoredMediaUrl: dependencies?.resolveStoredMediaUrl ?? resolveStoredMediaUrl,
    fetchWithProviderTimeout: dependencies?.fetchWithProviderTimeout ?? fetchStatusPollWithRetry,
    settleGenerationSucceeded: dependencies?.settleGenerationSucceeded ?? settleGenerationSucceeded,
    settleGenerationFailed: dependencies?.settleGenerationFailed ?? settleGenerationFailed,
    createGenerationOutputPreview: dependencies?.createGenerationOutputPreview ?? createGenerationOutputPreview,
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

async function persistMotionOutput({
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
  userId: string;
  tempUrl: string;
  completedAt?: string | null;
  dependencies: MotionGenerationStatusDependencies;
}): Promise<{ status: 'succeeded' | 'failed'; output: string | null; error: string | null }> {
  const settledAt = completedAt ?? new Date().toISOString();
  let output: string | null = tempUrl;
  let settlementOutputUrl: string | null = tempUrl;
  let previewUrl: string | null = null;
  let previewThumbhash: string | null = null;
  let previewStatus: 'ready' | 'failed' | null = null;
  let previewError: string | null = null;
  let previewGeneratedAt: string | null = null;

  try {
    const videoRes = await dependencies.fetchWithProviderTimeout(
      tempUrl,
      {},
      PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS,
      fetch,
      'KIE motion media download',
    );
    if (!videoRes.ok) {
      throw new Error('Failed to download video from Kie');
    }
    const videoBlob = await videoRes.blob();

    const fileName = `${userId}/generated_${predictionId}.mp4`;
    // Service-role: generated_videos grants `authenticated` SELECT only, so an
    // upload on the user client fails with "new row violates row-level security
    // policy". Reads below stay on the user client, which the SELECT policy allows.
    const { error: uploadError } = await settlementSupabase.storage
      .from('generated_videos')
      .upload(fileName, videoBlob, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) {
      logBackendError('upload_to_supabase_failed', { error: uploadError });
      output = tempUrl;
    } else {
      const storagePath = `generated_videos/${fileName}`;
      let preview: Awaited<ReturnType<typeof createGenerationOutputPreview>> = null;
      try {
        preview = await dependencies.createGenerationOutputPreview({
          body: videoBlob,
          category: 'video',
          contentType: videoBlob.type || 'video/mp4',
          storagePath,
          supabase,
        });
      } catch (posterError) {
        logBackendError('failed_to_create_motion_generation_preview_poster', { error: posterError });
        previewError = posterError instanceof Error
          ? posterError.message.slice(0, 500)
          : 'Preview generation failed.';
      }
      previewUrl = preview?.previewStoragePath ?? null;
      previewThumbhash = preview?.previewThumbhash ?? null;
      previewStatus = preview ? 'ready' : 'failed';
      previewGeneratedAt = preview ? new Date().toISOString() : null;

      const { data: signedData } = await supabase.storage
        .from('generated_videos')
        .createSignedUrl(fileName, 3600);
      output = signedData?.signedUrl || tempUrl;
      settlementOutputUrl = storagePath;
    }
  } catch (error) {
    logBackendError('error_persisting_video_to_storage', { error: error });
    output = tempUrl;
  }

  const status = await dependencies.settleGenerationSucceeded(settlementSupabase, {
    predictionId,
    outputUrl: settlementOutputUrl,
    previewUrl,
    previewThumbhash,
    previewStatus,
    previewAttemptCount: previewStatus ? 1 : null,
    previewError,
    previewGeneratedAt,
    completedAt: settledAt,
  });

  if (status === 'failed') {
    return {
      status,
      output: null,
      error: 'Generation was already settled as failed.',
    };
  }

  return { status, output, error: null };
}

async function notifyTerminalStatus({
  adminSupabase,
  localGeneration,
  status,
  output,
  dependencies,
}: {
  adminSupabase: SupabaseClient;
  localGeneration: MotionStatusGenerationRow;
  status: string;
  output: string | null;
  dependencies: MotionGenerationStatusDependencies;
}) {
  if (!localGeneration.id || !localGeneration.user_id) {
    return;
  }

  if (status === 'succeeded' && output) {
    await dependencies.notifyGenerationStatus(adminSupabase, {
      id: localGeneration.id,
      user_id: localGeneration.user_id,
      category: localGeneration.category,
      model: localGeneration.model,
    }, 'succeeded');
  } else if (status === 'failed') {
    await dependencies.notifyGenerationStatus(adminSupabase, {
      id: localGeneration.id,
      user_id: localGeneration.user_id,
      category: localGeneration.category,
      model: localGeneration.model,
    }, 'failed');
  }
}

export async function getMotionGenerationStatusForRoute({
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
  const { data: generationData, error: generationLookupError } = await getAdminSupabase()
    .from('generations')
    .select(MOTION_STATUS_GENERATION_SELECT)
    .eq('prediction_id', predictionId)
    .eq('user_id', userId)
    .single();
  if (generationLookupError && generationLookupError.code !== 'PGRST116') {
    logBackendError('generation_status_lookup_failed', {
      error: generationLookupError,
      kind: 'motion',
    });
  }
  const localGeneration = generationData as MotionStatusGenerationRow | null;

  if (!localGeneration || localGeneration.user_id !== userId) {
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
    let output: string | null = null;
    let error: string | null = null;

    if (status === 'succeeded') {
      try {
        const tempUrl = getMotionResultUrl(data.data?.resultJson);

        if (tempUrl) {
          const persisted = await persistMotionOutput({
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
          error = persisted.error;
        } else {
          status = await resolvedDependencies.settleGenerationSucceeded(admin, {
            predictionId,
            completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
          });
          if (status === 'failed') {
            error = 'Generation was already settled as failed.';
          }
        }
      } catch (successError) {
        logBackendError('error_handling_success_status', { error: successError });
      }
    } else if (status === 'failed') {
      error = data.data.failMsg || 'Unknown error';
      status = await resolvedDependencies.settleGenerationFailed(
        admin,
        predictionId,
        toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
      );
    }

    await notifyTerminalStatus({
      adminSupabase: admin,
      localGeneration,
      status,
      output,
      dependencies: resolvedDependencies,
    });

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
