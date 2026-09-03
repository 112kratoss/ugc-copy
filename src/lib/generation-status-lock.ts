import { randomUUID } from 'node:crypto';

import {
  getGenerationKind,
  normalizeStoredGenerationTiming,
  withGenerationTimingEstimate,
} from '@/lib/generation-timing';

export const GENERATION_STATUS_LOCK_TTL_SECONDS = 120;
export const GENERATION_STATUS_RETRY_AFTER_MS = 2000;
export const GENERATION_PROVIDER_STATUS_THROTTLE_SECONDS = 15;
export const GENERATION_PROVIDER_STATUS_RETRY_AFTER_MS =
  GENERATION_PROVIDER_STATUS_THROTTLE_SECONDS * 1000;

type SupabaseRpcResult = {
  data: unknown;
  error: { message?: string } | Error | null;
};

type SupabaseRpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<SupabaseRpcResult>;
};

type StoredGenerationStatusRow = {
  status?: string | null;
  category?: string | null;
  model?: string | null;
  created_at?: unknown;
  completed_at?: unknown;
  error_message?: unknown;
};

/**
 * The reason a terminal generation failed, for the status payloads built from a
 * stored row rather than a live provider response.
 *
 * Both payloads below used to hardcode `error: null`, so a generation settled by
 * the webhook -- which is the normal case, and lands seconds before the client
 * polls -- reported its failure with no reason attached even when the provider
 * had given one. Only a failed row surfaces this: nothing else should carry a
 * reason, and a stale one on a live row would be worse than silence.
 */
function readStoredFailureReason(
  localGeneration: StoredGenerationStatusRow | null | undefined,
  appStatus: string,
): string | null {
  if (appStatus !== 'failed') {
    return null;
  }

  const stored = localGeneration?.error_message;
  return typeof stored === 'string' && stored.trim() ? stored.trim() : null;
}

export function getGenerationStatusLockName(predictionId: string) {
  return `generation-status:${predictionId}`;
}

export function getGenerationProviderStatusThrottleLockName(predictionId: string) {
  return `generation-provider-status:${predictionId}`;
}

export function getGenerationStatusLockOwner(request: Request, startedAt: number) {
  return `${request.headers.get('x-vercel-id') ?? randomUUID()}:${startedAt}`;
}

export async function tryAcquireGenerationProviderStatusThrottle(
  client: SupabaseRpcClient,
  params: {
    predictionId: string;
    owner: string;
  },
): Promise<boolean> {
  const acquire = await client.rpc('try_acquire_backend_job_lock', {
    p_name: getGenerationProviderStatusThrottleLockName(params.predictionId),
    p_ttl_seconds: GENERATION_PROVIDER_STATUS_THROTTLE_SECONDS,
    p_locked_by: params.owner,
  });

  if (acquire.error) {
    throw acquire.error;
  }

  return acquire.data === true;
}

export function buildLockedGenerationStatusPayload(
  localGeneration: StoredGenerationStatusRow | null | undefined,
  estimatedTotalMs: number | null | undefined,
  retryAfterMs = GENERATION_STATUS_RETRY_AFTER_MS,
) {
  const timing = withGenerationTimingEstimate(
    normalizeStoredGenerationTiming({
      kind: getGenerationKind({
        category: localGeneration?.category,
        model: localGeneration?.model,
      }),
      status: localGeneration?.status,
      createdAt: localGeneration?.created_at,
      completedAt: localGeneration?.completed_at,
    }),
    estimatedTotalMs,
  );

  return {
    status: timing.appStatus,
    output: null,
    error: readStoredFailureReason(localGeneration, timing.appStatus),
    timing,
    retryAfterMs,
  };
}

export function buildFailedGenerationStatusPayload(
  localGeneration: StoredGenerationStatusRow | null | undefined,
) {
  const timing = normalizeStoredGenerationTiming({
    kind: getGenerationKind({
      category: localGeneration?.category,
      model: localGeneration?.model,
    }),
    status: localGeneration?.status,
    createdAt: localGeneration?.created_at,
    completedAt: localGeneration?.completed_at,
  });

  return {
    status: timing.appStatus,
    output: null,
    error: readStoredFailureReason(localGeneration, timing.appStatus),
    timing,
  };
}
