import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  claimGenerationOutputImportJobs,
  finishGenerationOutputImportJob,
  type GenerationOutputImportJob,
} from '@/lib/generation-output-import-jobs';
import {
  persistGeneratedOutput,
  persistGeneratedOutputList,
  type SyncableGenerationRecord,
} from '@/lib/generation-services';

export const GENERATION_OUTPUT_IMPORT_BATCH_LIMIT = 4;
// Admission deadline, not an interruption of an import already persisting.
export const GENERATION_OUTPUT_IMPORT_TIME_BUDGET_MS = 60_000;

type GenerationRow = SyncableGenerationRecord & { workflow_settings?: Record<string, unknown> | null };

function retryDelay(attempt: number) {
  return Math.min(15 * 60, 60 * (2 ** Math.max(0, attempt)));
}

async function loadGeneration(client: SupabaseClient, id: string): Promise<GenerationRow> {
  const { data, error } = await client
    .from('generations')
    .select('id, user_id, prediction_id, status, output_url, model, category, workflow_settings, created_at, completed_at')
    .eq('id', id)
    .single();
  if (error) throw error;
  if (!data) throw new Error(`Generation ${id} no longer exists.`);
  return data as GenerationRow;
}

async function importOne(client: SupabaseClient, job: GenerationOutputImportJob) {
  const generation = await loadGeneration(client, job.generation_id);
  if (generation.status === 'succeeded' && generation.output_url) return;
  if (generation.status === 'failed') {
    throw new Error('Generation settled as failed before its provider output could be imported.');
  }

  if (job.output_urls.length > 1 || generation.model === 'grok-imagine-image') {
    const result = await persistGeneratedOutputList(
      client,
      client,
      generation,
      job.output_urls,
      job.provider_completed_at,
    );
    if (result.outputs.length === 0 || result.status !== 'succeeded') {
      throw new Error('No provider output was persisted.');
    }
    return;
  }

  const status = await persistGeneratedOutput(
    client,
    client,
    generation,
    job.output_urls[0]!,
    job.provider_completed_at,
  );
  if (status !== 'succeeded') {
    throw new Error(`Output persistence settled as ${status}.`);
  }
}

export async function processGenerationOutputImportJobs(params: {
  client: SupabaseClient;
  lockedBy: string;
  limit?: number;
}) {
  const startedAt = Date.now();
  const limit = Math.max(0, Math.min(params.limit ?? GENERATION_OUTPUT_IMPORT_BATCH_LIMIT, GENERATION_OUTPUT_IMPORT_BATCH_LIMIT));
  const summary = { claimed: 0, completed: 0, retried: 0, exhausted: 0 };

  // Strictly sequential: one job may stage a 250 MB video and invoke ffmpeg.
  // Bounded parallelism belongs in separate image/video worker pools, not one
  // serverless process whose temporary disk is shared by every promise.
  while (summary.claimed < limit && Date.now() - startedAt < GENERATION_OUTPUT_IMPORT_TIME_BUDGET_MS) {
    // Do not hold leases on jobs this invocation may never start. Their next
    // worker can claim them immediately rather than waiting for a stale lease.
    const [job] = await claimGenerationOutputImportJobs({
      client: params.client,
      limit: 1,
      lockedBy: params.lockedBy,
    });
    if (!job) break;
    summary.claimed += 1;
    try {
      await importOne(params.client, job);
      await finishGenerationOutputImportJob({
        client: params.client,
        id: job.id,
        lockedBy: params.lockedBy,
        succeeded: true,
      });
      summary.completed += 1;
    } catch (error) {
      const outcome = await finishGenerationOutputImportJob({
        client: params.client,
        id: job.id,
        lockedBy: params.lockedBy,
        succeeded: false,
        error: error instanceof Error ? error.message : String(error),
        retryDelaySeconds: retryDelay(job.attempt_count),
      });
      if (outcome === 'exhausted') summary.exhausted += 1;
      else summary.retried += 1;
    }
  }
  return summary;
}
