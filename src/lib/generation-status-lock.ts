import { randomUUID } from 'node:crypto';

import {
  getGenerationKind,
  normalizeStoredGenerationTiming,
  withGenerationTimingEstimate,
} from '@/lib/generation-timing';

export const GENERATION_STATUS_LOCK_TTL_SECONDS = 120;
export const GENERATION_STATUS_RETRY_AFTER_MS = 2000;

type StoredGenerationStatusRow = {
  status?: string | null;
  category?: string | null;
  model?: string | null;
  created_at?: unknown;
  completed_at?: unknown;
};

export function getGenerationStatusLockName(predictionId: string) {
  return `generation-status:${predictionId}`;
}

export function getGenerationStatusLockOwner(request: Request, startedAt: number) {
  return `${request.headers.get('x-vercel-id') ?? randomUUID()}:${startedAt}`;
}

export function buildLockedGenerationStatusPayload(
  localGeneration: StoredGenerationStatusRow | null | undefined,
  estimatedTotalMs: number | null | undefined,
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
    error: null,
    timing,
    retryAfterMs: GENERATION_STATUS_RETRY_AFTER_MS,
  };
}
