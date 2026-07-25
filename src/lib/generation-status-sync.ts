import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { resolveGenerationAppModelId } from '@/lib/generation-model-attribution';
import { normalizeVeoGenerationTiming } from '@/lib/generation-timing';
import {
  GenerationServiceError,
  isRecord,
  KIE_API_KEY,
  requireApiKey,
} from '@/lib/generation-service-core';
import {
  settleGenerationFailed,
  settleGenerationSucceeded,
} from '@/lib/generation-settlement';
import { extractKieWebhookTaskId } from '@/lib/kie-webhook';
import { getGenerationKind, normalizeMarketGenerationTiming, toIsoTimestamp } from '@/lib/generation-timing';
import {
  getFirstResultUrl,
  getGenerationResultUrls,
  getStoredWorkflowModel,
  persistGeneratedOutput,
  persistGeneratedOutputList,
  type GenerationStatusSyncResult,
  type GenerationSyncStatus,
  type SyncableGenerationRecord,
} from '@/lib/generation-services';
import {
  fetchWithProviderRetry,
  PROVIDER_STATUS_POLL_RETRY_POLICY,
  PROVIDER_STATUS_POLL_TIMEOUT_MS,
  withProviderModel,
} from '@/lib/provider-fetch';

/**
 * Reconciling a generation's status with the provider.
 *
 * This is the reconciliation seam: given a provider task id, ask the provider
 * what happened and drive the generation to a terminal state exactly once. It
 * depends on the settlement and output-persistence seams and is depended on by
 * nobody inside `generation-services`, which is why it extracts cleanly in this
 * direction — the import runs one way, from here into the modules it consumes.
 *
 * Behaviour is unchanged by the extraction.
 */

async function markGenerationFailed(
  creditSupabase: SupabaseClient,
  generation: SyncableGenerationRecord,
  completedAt?: string | null
): Promise<'failed' | 'succeeded'> {
  if (!generation.prediction_id) {
    throw new GenerationServiceError('Generation does not have a provider task id.', 500);
  }

  return settleGenerationFailed(
    creditSupabase,
    generation.prediction_id,
    completedAt ?? new Date().toISOString(),
  );
}

function isVeoGeneration(generation: SyncableGenerationRecord): boolean {
  const workflowModel = getStoredWorkflowModel(generation.workflow_settings, generation.model);
  return workflowModel === 'veo-3.1' || generation.model === 'veo3' || generation.model === 'veo3_fast';
}

function getProviderPayloadTaskData(
  providerPayload: Record<string, unknown> | null | undefined,
  predictionId: string,
): Record<string, unknown> | null {
  if (!providerPayload) return null;

  const taskId = extractKieWebhookTaskId(providerPayload);
  if (taskId && taskId !== predictionId) return null;

  const data = isRecord(providerPayload.data) ? providerPayload.data : providerPayload;
  return isRecord(data) ? data : null;
}

async function syncSingleGenerationStatusFromProviderPayload(
  supabase: SupabaseClient,
  creditSupabase: SupabaseClient,
  generation: SyncableGenerationRecord,
  providerPayload: Record<string, unknown> | null | undefined,
): Promise<Exclude<GenerationSyncStatus, 'missing'> | null> {
  if (!generation.prediction_id || !['processing', 'waiting'].includes(generation.status)) {
    return null;
  }

  const taskData = getProviderPayloadTaskData(providerPayload, generation.prediction_id);
  if (!taskData) return null;

  const kind = getGenerationKind({
    category: generation.category,
    model: generation.model,
  });
  const fallbackStartedAtMs = Number.isNaN(Date.parse(generation.created_at))
    ? null
    : Date.parse(generation.created_at);

  if (isVeoGeneration(generation)) {
    const successFlag = taskData.successFlag;
    const responseData = isRecord(taskData.response) ? taskData.response : null;
    const timing = normalizeVeoGenerationTiming({
      kind,
      task: taskData,
      fallbackStartedAtMs,
    });

    if (successFlag === 1) {
      const tempUrl = getFirstResultUrl(responseData?.resultUrls) || getFirstResultUrl(responseData?.originUrls);
      if (tempUrl) {
        return persistGeneratedOutput(creditSupabase, creditSupabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      } else {
        return settleGenerationSucceeded(creditSupabase, {
          predictionId: generation.prediction_id,
          completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
        });
      }
    }

    if (successFlag === 2 || successFlag === 3) {
      return markGenerationFailed(creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
    }

    return null;
  }

  const state = taskData.state;
  const timing = normalizeMarketGenerationTiming({
    kind,
    task: taskData,
    fallbackStartedAtMs,
  });

  if (state === 'success') {
    let tempUrl: string | null = null;
    let result: unknown = null;

    try {
      result = typeof taskData.resultJson === 'string'
        ? JSON.parse(taskData.resultJson)
        : taskData.resultJson;
      tempUrl = getFirstResultUrl(result);
    } catch (error) {
      logBackendError('generation_result_parse_failed', { error });
    }

    if (tempUrl) {
      if (generation.model === 'grok-imagine-image') {
        return (await persistGeneratedOutputList(
          creditSupabase,
          creditSupabase,
          generation,
          getGenerationResultUrls(result),
          toIsoTimestamp(timing.completedAtMs)
        )).status;
      } else {
        return persistGeneratedOutput(creditSupabase, creditSupabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      }
    } else {
      return settleGenerationSucceeded(creditSupabase, {
        predictionId: generation.prediction_id,
        completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
      });
    }
  }

  if (state === 'fail') {
    return markGenerationFailed(creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
  }

  return null;
}

async function syncSingleGenerationStatus(
  supabase: SupabaseClient,
  creditSupabase: SupabaseClient,
  generation: SyncableGenerationRecord
): Promise<Exclude<GenerationSyncStatus, 'missing'>> {
  if (!generation.prediction_id || !['processing', 'waiting'].includes(generation.status)) {
    if (generation.status === 'succeeded' || generation.status === 'failed') {
      return generation.status;
    }
    return 'skipped';
  }

  const kind = getGenerationKind({
    category: generation.category,
    model: generation.model,
  });
  const fallbackStartedAtMs = Number.isNaN(Date.parse(generation.created_at))
    ? null
    : Date.parse(generation.created_at);

  if (isVeoGeneration(generation)) {
    const response = await withProviderModel(resolveGenerationAppModelId(generation), () => fetchWithProviderRetry(`https://api.kie.ai/api/v1/veo/record-info?taskId=${generation.prediction_id}`, {
      headers: { Authorization: `Bearer ${KIE_API_KEY}` },
    }, PROVIDER_STATUS_POLL_TIMEOUT_MS, PROVIDER_STATUS_POLL_RETRY_POLICY, fetch, 'KIE Veo status'));
    const data = await response.json();

    if (!response.ok || data.code !== 200) {
      throw new Error(data.msg || 'Failed to check Veo status');
    }

    const successFlag = data.data?.successFlag;
    const responseData = data.data?.response;
    const timing = normalizeVeoGenerationTiming({
      kind,
      task: data.data,
      fallbackStartedAtMs,
    });

    if (successFlag === 1) {
      const tempUrl = getFirstResultUrl(responseData?.resultUrls) || getFirstResultUrl(responseData?.originUrls);
      if (tempUrl) {
        return persistGeneratedOutput(creditSupabase, creditSupabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      } else {
        return settleGenerationSucceeded(creditSupabase, {
          predictionId: generation.prediction_id,
          completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
        });
      }
    }

    if (successFlag === 2 || successFlag === 3) {
      return markGenerationFailed(creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
    }

    const nextStatus = timing.appStatus === 'waiting' ? 'waiting' : 'processing';
    if (generation.status !== nextStatus) {
      await creditSupabase.from('generations').update({ status: nextStatus }).eq('id', generation.id);
    }

    return nextStatus;
  }

  const response = await withProviderModel(resolveGenerationAppModelId(generation), () => fetchWithProviderRetry(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${generation.prediction_id}`, {
    headers: { Authorization: `Bearer ${KIE_API_KEY}` },
  }, PROVIDER_STATUS_POLL_TIMEOUT_MS, PROVIDER_STATUS_POLL_RETRY_POLICY, fetch, 'KIE task status'));
  const data = await response.json();

  if (!response.ok || data.code !== 200) {
    throw new Error(data.msg || 'Failed to check generation status');
  }

  const state = data.data?.state;
  const timing = normalizeMarketGenerationTiming({
    kind,
    task: data.data,
    fallbackStartedAtMs,
  });

  if (state === 'success') {
    let tempUrl: string | null = null;
    let result: unknown = null;

    try {
      result = typeof data.data?.resultJson === 'string'
        ? JSON.parse(data.data.resultJson)
        : data.data?.resultJson;
      tempUrl = getFirstResultUrl(result);
    } catch (error) {
      logBackendError('generation_result_parse_failed', { error });
    }

    if (tempUrl) {
      if (generation.model === 'grok-imagine-image') {
        return (await persistGeneratedOutputList(
          creditSupabase,
          creditSupabase,
          generation,
          getGenerationResultUrls(result),
          toIsoTimestamp(timing.completedAtMs)
        )).status;
      } else {
        return persistGeneratedOutput(creditSupabase, creditSupabase, generation, tempUrl, toIsoTimestamp(timing.completedAtMs));
      }
    } else {
      return settleGenerationSucceeded(creditSupabase, {
        predictionId: generation.prediction_id,
        completedAt: toIsoTimestamp(timing.completedAtMs) ?? new Date().toISOString(),
      });
    }
  }

  if (state === 'fail') {
    return markGenerationFailed(creditSupabase, generation, toIsoTimestamp(timing.completedAtMs));
  }

  const nextStatus = timing.appStatus === 'waiting' ? 'waiting' : 'processing';
  if (generation.status !== nextStatus) {
    await creditSupabase.from('generations').update({ status: nextStatus }).eq('id', generation.id);
  }
  return nextStatus;
}

async function loadGenerationByPredictionId(
  supabase: SupabaseClient,
  predictionId: string,
): Promise<SyncableGenerationRecord | null> {
  const { data, error } = await supabase
    .from('generations')
    .select('id, user_id, prediction_id, status, output_url, model, category, workflow_settings, created_at, completed_at')
    .eq('prediction_id', predictionId)
    .single();

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === 'PGRST116') return null;
    throw error;
  }

  return (data ?? null) as SyncableGenerationRecord | null;
}

export async function syncGenerationStatusByPredictionId(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  predictionId: string;
  providerPayload?: Record<string, unknown> | null;
}): Promise<GenerationStatusSyncResult> {
  requireApiKey();

  const generation = await loadGenerationByPredictionId(params.supabase, params.predictionId);
  if (!generation) {
    return { found: false, status: 'missing', generation: null };
  }

  const status = await syncSingleGenerationStatusFromProviderPayload(
    params.supabase,
    params.creditSupabase,
    generation,
    params.providerPayload,
  ) ?? await syncSingleGenerationStatus(params.supabase, params.creditSupabase, generation);
  const updatedGeneration = await loadGenerationByPredictionId(params.supabase, params.predictionId);

  return {
    found: true,
    status,
    generation: updatedGeneration ?? { ...generation, status },
  };
}

export async function syncGenerationStatuses(params: {
  supabase: SupabaseClient;
  creditSupabase: SupabaseClient;
  generationIds: string[];
}) {
  requireApiKey();

  const generationIds = Array.from(new Set(params.generationIds.filter(Boolean)));
  if (generationIds.length === 0) {
    return;
  }

  const { data: generations } = await params.supabase
    .from('generations')
    .select('id, user_id, prediction_id, status, output_url, model, category, workflow_settings, created_at, completed_at')
    .in('id', generationIds);

  for (const generation of (generations || []) as SyncableGenerationRecord[]) {
    try {
      await syncSingleGenerationStatus(params.supabase, params.creditSupabase, generation);
    } catch (error) {
      logBackendError('generation_status_sync_failed', { generationId: generation.id, error });
    }
  }
}
