import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  GenerationServiceError,
  isRecord,
  supabaseErrorMessage,
} from '@/lib/generation-service-core';

/**
 * Terminal settlement of a generation's credits.
 *
 * These two functions are the last word on whether a user keeps their credits
 * or gets them back, and both are thin wrappers over atomic RPCs that own the
 * single-effect guarantee. They are isolated here so that guarantee is
 * reviewable without reading the start paths: the money decision is 86 lines,
 * not a region of a 3,300-line file.
 *
 * Behaviour is unchanged by the extraction — same RPCs, same status mapping,
 * same errors. The 33 pgTAP assertions covering `settle_generation_failed`,
 * `settle_generation_succeeded`, and `settle_generation_start_failed` continue
 * to be the proof that the RPCs behind these are single-effect under replay.
 */

export type GenerationTerminalSettlementStatus = 'succeeded' | 'failed';

export async function settleGenerationFailed(
  creditSupabase: SupabaseClient,
  predictionId: string,
  completedAt?: string | null,
): Promise<'failed' | 'succeeded'> {
  const { data, error } = await creditSupabase.rpc('settle_generation_failed', {
    p_prediction_id: predictionId,
    p_completed_at: completedAt ?? null,
  });

  if (error || !isRecord(data)) {
    throw new GenerationServiceError(
      supabaseErrorMessage(error, 'Failed to settle failed generation.'),
      500,
    );
  }

  const status = typeof data.status === 'string' ? data.status : null;
  if (status === 'failed') return 'failed';
  if (status === 'already_succeeded') return 'succeeded';

  if (status === 'missing') {
    throw new GenerationServiceError('Generation not found for failure settlement.', 404);
  }

  if (status === 'invalid_request') {
    throw new GenerationServiceError('Invalid generation failure settlement request.', 400);
  }

  if (status === 'profile_not_found') {
    throw new GenerationServiceError('Could not find a credit profile for this account.', 500);
  }

  throw new GenerationServiceError('Failed to settle failed generation.', 500);
}

export async function settleGenerationSucceeded(
  settlementSupabase: SupabaseClient,
  params: {
    predictionId: string;
    outputUrl?: string | null;
    completedAt?: string | null;
    previewUrl?: string | null;
    previewThumbhash?: string | null;
    previewStatus?: 'pending' | 'ready' | 'failed' | string | null;
    previewAttemptCount?: number | null;
    previewError?: string | null;
    previewGeneratedAt?: string | null;
    workflowSettings?: Record<string, unknown> | null;
  },
): Promise<GenerationTerminalSettlementStatus> {
  const { data, error } = await settlementSupabase.rpc('settle_generation_succeeded', {
    p_prediction_id: params.predictionId,
    p_output_url: params.outputUrl ?? null,
    p_completed_at: params.completedAt ?? null,
    p_preview_url: params.previewUrl ?? null,
    p_preview_thumbhash: params.previewThumbhash ?? null,
    p_preview_status: params.previewStatus ?? null,
    p_preview_attempt_count: params.previewAttemptCount ?? null,
    p_preview_error: params.previewError ?? null,
    p_preview_generated_at: params.previewGeneratedAt ?? null,
    p_workflow_settings: params.workflowSettings ?? null,
  });

  if (error || !isRecord(data)) {
    throw new GenerationServiceError(
      supabaseErrorMessage(error, 'Failed to settle successful generation.'),
      500,
    );
  }

  const status = typeof data.status === 'string' ? data.status : null;
  if (status === 'succeeded' || status === 'already_succeeded') return 'succeeded';
  if (status === 'already_failed') return 'failed';

  if (status === 'missing') {
    throw new GenerationServiceError('Generation not found for success settlement.', 404);
  }

  if (status === 'invalid_request') {
    throw new GenerationServiceError('Invalid generation success settlement request.', 400);
  }

  throw new GenerationServiceError('Failed to settle successful generation.', 500);
}
