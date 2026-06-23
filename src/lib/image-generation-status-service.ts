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
  toIsoTimestamp,
  withGenerationTimingEstimate,
} from '@/lib/generation-timing';
import {
  getGenerationResultUrls,
  persistGeneratedOutputList,
  settleGenerationFailed,
} from '@/lib/generation-services';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';
import {
  fetchWithProviderTimeout,
  PROVIDER_STATUS_POLL_TIMEOUT_MS,
} from '@/lib/provider-fetch';
import { resolveStoredMediaUrl } from '@/lib/server-helpers';

const IMAGE_STATUS_GENERATION_SELECT = 'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, workflow_settings';

type ImageStatusGenerationRow = {
  id: string;
  user_id: string;
  prediction_id: string;
  status: string;
  output_url: string | null;
  created_at: string | null;
  completed_at?: string | null;
  model: string | null;
  category: string | null;
  workflow_settings?: unknown;
};

export type ImageGenerationStatusDependencies = {
  resolveStoredMediaUrl: typeof resolveStoredMediaUrl;
  fetchWithProviderTimeout: typeof fetchWithProviderTimeout;
  persistGeneratedOutputList: typeof persistGeneratedOutputList;
  settleGenerationFailed: typeof settleGenerationFailed;
  notifyGenerationStatus: typeof notifyGenerationStatus;
  withBackendJobLock: typeof withBackendJobLock;
  tryAcquireGenerationProviderStatusThrottle: typeof tryAcquireGenerationProviderStatusThrottle;
};

type ImageGenerationStatusBody = Record<string, unknown>;

export type ImageGenerationStatusRouteResult =
  | {
      ok: true;
      body: ImageGenerationStatusBody;
    }
  | {
      ok: false;
      status: 400 | 404 | 500;
      body: {
        error: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<ImageGenerationStatusDependencies> | undefined,
): ImageGenerationStatusDependencies {
  return {
    resolveStoredMediaUrl: dependencies?.resolveStoredMediaUrl ?? resolveStoredMediaUrl,
    fetchWithProviderTimeout: dependencies?.fetchWithProviderTimeout ?? fetchWithProviderTimeout,
    persistGeneratedOutputList: dependencies?.persistGeneratedOutputList ?? persistGeneratedOutputList,
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

function getPersistedOutputPaths(workflowSettings: Record<string, unknown> | null): string[] {
  const outputs = workflowSettings?.outputs;
  if (!Array.isArray(outputs)) {
    return [];
  }

  return outputs
    .map((output) => {
      if (!output || typeof output !== 'object') {
        return null;
      }

      const storagePath = (output as Record<string, unknown>).storagePath;
      return typeof storagePath === 'string' && storagePath ? storagePath : null;
    })
    .filter((storagePath): storagePath is string => Boolean(storagePath));
}

async function resolveOutputPaths(
  adminSupabase: SupabaseClient,
  outputPaths: string[],
  dependencies: ImageGenerationStatusDependencies,
): Promise<string[]> {
  return Promise.all(outputPaths.map((outputPath) => dependencies.resolveStoredMediaUrl(adminSupabase, outputPath)));
}

function estimateImageTotalMs(localGeneration: ImageStatusGenerationRow, workflowSettings: Record<string, unknown> | null): number | null {
  return estimateGenerationDurationMs({
    kind: 'image',
    model: typeof localGeneration.model === 'string' ? localGeneration.model : null,
    resolution: typeof workflowSettings?.resolution === 'string' ? workflowSettings.resolution : null,
    referenceCount: Array.isArray(workflowSettings?.elements) ? workflowSettings.elements.length : 0,
  });
}

export async function getImageGenerationStatusForRoute({
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
  dependencies?: Partial<ImageGenerationStatusDependencies>;
}): Promise<ImageGenerationStatusRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const startedAt = Date.now();
  let adminSupabase: SupabaseClient | null = null;
  const getAdminSupabase = () => {
    adminSupabase ??= createAdminSupabase();
    return adminSupabase;
  };

  const { data: generationData } = await supabase
    .from('generations')
    .select(IMAGE_STATUS_GENERATION_SELECT)
    .eq('prediction_id', predictionId)
    .eq('user_id', userId)
    .single();
  const localGeneration = generationData as ImageStatusGenerationRow | null;

  if (!localGeneration || localGeneration.user_id !== userId) {
    return { ok: false, status: 404, body: { error: 'Generation not found' } };
  }

  if (localGeneration.status === 'failed') {
    return {
      ok: true,
      body: buildFailedGenerationStatusPayload(localGeneration),
    };
  }

  const workflowSettings = getWorkflowSettings(localGeneration.workflow_settings);

  if (localGeneration.status === 'succeeded' && localGeneration.output_url) {
    const admin = getAdminSupabase();
    const outputPaths = getPersistedOutputPaths(workflowSettings);
    const outputs = outputPaths.length > 0
      ? await resolveOutputPaths(admin, outputPaths, resolvedDependencies)
      : [];

    return {
      ok: true,
      body: {
        status: 'succeeded',
        output: await resolvedDependencies.resolveStoredMediaUrl(admin, localGeneration.output_url),
        ...(outputs.length > 0 ? { outputs } : {}),
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

  const estimatedTotalMs = estimateImageTotalMs(localGeneration, workflowSettings);
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

    const response = await resolvedDependencies.fetchWithProviderTimeout(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
      headers: { Authorization: `Bearer ${kieApiKey}` },
    }, PROVIDER_STATUS_POLL_TIMEOUT_MS, fetch, 'KIE image status');

    const data = await response.json();

    if (!response.ok || data.code !== 200) {
      throw new Error(data.msg || 'Failed to check status');
    }

    const timing = normalizeMarketGenerationTiming({
      kind: 'image',
      task: data.data,
      fallbackStartedAtMs: localGeneration.created_at ? Date.parse(localGeneration.created_at) : null,
    });
    const timingWithEstimate = withGenerationTimingEstimate(timing, estimatedTotalMs);
    let status = timing.appStatus;
    let output: string | null = null;
    let error: string | null = null;

    if (status === 'succeeded') {
      try {
        const result = JSON.parse(data.data.resultJson);
        const resultUrls = getGenerationResultUrls(result);
        const tempUrl = resultUrls[0] || null;

        if (tempUrl) {
          if (!localGeneration.id || !userId) {
            throw new Error('Missing local generation record for completed image run');
          }

          const persistedOutputs = await resolvedDependencies.persistGeneratedOutputList(
            supabase,
            admin,
            {
              id: localGeneration.id,
              user_id: userId,
              prediction_id: predictionId,
              category: 'image',
              model: localGeneration.model || 'nano-banana-2',
              workflow_settings: workflowSettings,
            },
            localGeneration.model === 'grok-imagine-image' ? resultUrls : [tempUrl],
            toIsoTimestamp(timing.completedAtMs),
          );

          if (persistedOutputs.status === 'failed') {
            status = 'failed';
            error = 'Generation was already settled as failed.';
            output = null;
            return {
              status,
              output,
              error,
              timing: timingWithEstimate,
            };
          }

          const resolvedOutputs = await resolveOutputPaths(
            admin,
            persistedOutputs.outputs.map((persistedOutput) => persistedOutput.storagePath),
            resolvedDependencies,
          );
          await resolvedDependencies.notifyGenerationStatus(admin, {
            id: localGeneration.id,
            user_id: userId,
            category: 'image',
            model: localGeneration.model || 'nano-banana-2',
          }, 'succeeded');
          output = resolvedOutputs[0] || tempUrl;
          return {
            status,
            output,
            ...(resolvedOutputs.length > 1 ? { outputs: resolvedOutputs } : {}),
            error,
            timing: timingWithEstimate,
          };
        }
      } catch (handledError) {
        console.error('Error handling success status:', handledError);
      }
    } else if (status === 'failed') {
      error = data.data.failMsg || 'Unknown error';
      status = await resolvedDependencies.settleGenerationFailed(
        admin,
        predictionId,
        toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
      );
      if (localGeneration.id && localGeneration.user_id) {
        await resolvedDependencies.notifyGenerationStatus(admin, {
          id: localGeneration.id,
          user_id: localGeneration.user_id,
          category: localGeneration.category,
          model: localGeneration.model,
        }, 'failed');
      }
    }

    return { status, output, error, timing: timingWithEstimate };
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
