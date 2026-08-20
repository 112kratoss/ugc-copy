import { resolveLinkedAccountIds } from '@/lib/account-identity';
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
import {
  getGenerationResultUrls,
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
  resolveStoredMediaUrl: typeof resolveOwnedStoredMediaUrl;
  fetchWithProviderTimeout: typeof fetchWithProviderTimeout;
  enqueueGenerationOutputImportJob: typeof enqueueGenerationOutputImportJob;
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
    resolveStoredMediaUrl: dependencies?.resolveStoredMediaUrl ?? resolveOwnedStoredMediaUrl,
    fetchWithProviderTimeout: dependencies?.fetchWithProviderTimeout ?? fetchStatusPollWithRetry,
    enqueueGenerationOutputImportJob:
      dependencies?.enqueueGenerationOutputImportJob ?? enqueueGenerationOutputImportJob,
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
  ownerUserId: string,
  dependencies: ImageGenerationStatusDependencies,
): Promise<string[]> {
  const resolved = await Promise.all(outputPaths.map((outputPath) =>
    dependencies.resolveStoredMediaUrl(adminSupabase, outputPath, ownerUserId)));
  return resolved.filter((value): value is string => Boolean(value));
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
  createAdminSupabase,
  kieApiKey,
  dependencies,
}: {
  request: Request;
  predictionId: string;
  userId: string;
  // No user client: every read and write here is service-role by necessity (see
  // the lookup and persist calls below). Taking one would only invite a caller
  // to reach for it and reintroduce the RLS failures this service had.
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

  // Service-role read: `authenticated` has no SELECT on output_url, model,
  // completed_at or workflow_settings, so running this as the user denies the
  // whole row and the miss surfaces as a phantom "Generation not found". The
  // user_id filter plus the ownership check below are the access boundary here.
  const ownerUserIds = await resolveLinkedAccountIds(getAdminSupabase(), userId);
  const { data: generationData, error: generationLookupError } = await getAdminSupabase()
    .from('generations')
    .select(IMAGE_STATUS_GENERATION_SELECT)
    .eq('prediction_id', predictionId)
    .in('user_id', ownerUserIds)
    .single();
  if (generationLookupError && generationLookupError.code !== 'PGRST116') {
    logBackendError('generation_status_lookup_failed', {
      error: generationLookupError,
      kind: 'image',
    });
  }
  const localGeneration = generationData as ImageStatusGenerationRow | null;

  if (!localGeneration || !ownerUserIds.includes(localGeneration.user_id)) {
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
      ? await resolveOutputPaths(admin, outputPaths, localGeneration.user_id, resolvedDependencies)
      : [];

    return {
      ok: true,
      body: {
        status: 'succeeded',
        output: await resolvedDependencies.resolveStoredMediaUrl(
          admin,
          localGeneration.output_url,
          localGeneration.user_id,
        ),
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

    const response = await withProviderModel(resolveGenerationAppModelId(localGeneration), () => resolvedDependencies.fetchWithProviderTimeout(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${predictionId}`, {
      headers: { Authorization: `Bearer ${kieApiKey}` },
    }, PROVIDER_STATUS_POLL_TIMEOUT_MS, fetch, 'KIE image status'));

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

          await resolvedDependencies.enqueueGenerationOutputImportJob({
            client: admin,
            generationId: localGeneration.id,
            outputUrls: localGeneration.model === 'grok-imagine-image' ? resultUrls : [tempUrl],
            providerCompletedAt: toIsoTimestamp(timing.completedAtMs),
          });
          // Persistence is now owned by the durable media worker. A status GET
          // records provider completion and returns quickly; it never downloads,
          // uploads or transcodes hundreds of megabytes inline.
          status = 'processing';
          output = null;
          return {
            status,
            output,
            error,
            timing: timingWithEstimate,
          };
        }
      } catch (handledError) {
        logBackendError('error_handling_success_status', { error: handledError });
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
