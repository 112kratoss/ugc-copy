import type { SupabaseClient } from '@supabase/supabase-js';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export type GenerationOutputImportJob = {
  id: string;
  generation_id: string;
  prediction_id: string;
  output_urls: string[];
  provider_completed_at: string | null;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  attempt_count: number;
};

export async function enqueueGenerationOutputImportJob(params: {
  client: RpcClient;
  generationId: string;
  outputUrls: string[];
  providerCompletedAt?: string | null;
}): Promise<string> {
  const outputUrls = params.outputUrls.map((url) => url.trim()).filter(Boolean);
  if (outputUrls.length === 0 || outputUrls.length > 8) {
    throw new Error('Output import requires between one and eight URLs.');
  }
  const { data, error } = await params.client.rpc('enqueue_generation_output_import_job', {
    p_generation_id: params.generationId,
    p_output_urls: outputUrls,
    p_provider_completed_at: params.providerCompletedAt ?? null,
  });
  if (error) throw error;
  if (typeof data !== 'string') throw new Error('Output import enqueue did not return a job id.');
  return data;
}

export async function claimGenerationOutputImportJobs(params: {
  client: RpcClient;
  limit: number;
  lockedBy: string;
}): Promise<GenerationOutputImportJob[]> {
  const { data, error } = await params.client.rpc('claim_generation_output_import_jobs', {
    p_limit: params.limit,
    p_locked_by: params.lockedBy,
    p_lock_ttl_seconds: 300,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as GenerationOutputImportJob[];
}

export async function finishGenerationOutputImportJob(params: {
  client: RpcClient;
  id: string;
  lockedBy: string;
  succeeded: boolean;
  error?: string | null;
  retryDelaySeconds?: number;
}): Promise<string | null> {
  const { data, error } = await params.client.rpc('finish_generation_output_import_job', {
    p_id: params.id,
    p_locked_by: params.lockedBy,
    p_succeeded: params.succeeded,
    p_error: params.error ?? null,
    p_retry_delay_seconds: params.retryDelaySeconds ?? 60,
    p_max_attempts: 10,
  });
  if (error) throw error;
  return typeof data === 'string' ? data : null;
}

export async function hasDueGenerationOutputImportJobs(client: RpcClient): Promise<boolean> {
  const { data, error } = await client.rpc('has_due_generation_output_import_jobs', {
    p_lock_ttl_seconds: 300,
  });
  if (error) throw error;
  return data === true;
}
