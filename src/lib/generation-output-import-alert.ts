import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { GENERATION_OUTPUT_IMPORT_MAX_ATTEMPTS } from '@/lib/generation-output-import-jobs';
import {
  classifyGenerationOutputImportError,
  GENERATION_OUTPUT_IMPORT_GIVE_UP_AFTER_HOURS,
  type GenerationOutputImportErrorClass,
} from '@/lib/generation-output-import-window';

/**
 * The operator alert for finished renders whose file could not be stored.
 *
 * An import job that has used its ten tries (`attempt_count` at the maximum),
 * has not succeeded since and was touched in the last 24 hours, whose
 * generation is still waiting on it: retrying hourly inside its window. Once
 * the generation is failed and refunded (or was already, when a status poll
 * raced the give-up and enqueued a job for it) it is no longer counted. Shown on
 * /api/ops/backend-alerts as GENERATION_OUTPUT_IMPORT_FAILING (degraded, so the
 * hourly watchdog mails the owner), with the count and the error classes the
 * owner can act on. Like the Kie balance alert, deliberately not a backend
 * health issue: the release gate requires health to be strictly ok, and the
 * release that fixes the cause must not be held by it.
 */

export const GENERATION_OUTPUT_IMPORT_ALERT_LOOKBACK_HOURS = 24;
const SAMPLE_LIMIT = 200;

export type GenerationOutputImportFailureStatus = {
  available: boolean;
  error: string | null;
  count: number;
  /** The sample hit its cap: the count is a lower bound. */
  truncated: boolean;
  byClass: Partial<Record<GenerationOutputImportErrorClass, number>>;
};

const NEXT_STEP: Record<GenerationOutputImportErrorClass, string> = {
  host_not_allowed: 'add the provider host to MEDIA_IMPORT_HOST_ALLOWLIST',
  file_too_large: 'check the media size cap against the model\'s output',
  provider_fetch_failed: 'check the provider\'s file URLs and status',
  storage_failed: 'check Supabase Storage',
  other: 'read last_error on generation_output_import_jobs',
};

export async function collectGenerationOutputImportFailures(
  client: SupabaseClient,
  now: Date,
): Promise<GenerationOutputImportFailureStatus> {
  const empty: GenerationOutputImportFailureStatus = {
    available: true, error: null, count: 0, truncated: false, byClass: {},
  };
  try {
    const since = new Date(now.getTime() - GENERATION_OUTPUT_IMPORT_ALERT_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    // Two plain bounded reads rather than an embedded filter: the jobs, then
    // which of their generations are still waiting on them.
    const { data, error } = await client
      .from('generation_output_import_jobs')
      .select('status,last_error,generation_id')
      .gte('attempt_count', GENERATION_OUTPUT_IMPORT_MAX_ATTEMPTS)
      .in('status', ['pending', 'processing', 'failed'])
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(SAMPLE_LIMIT);
    if (error) throw error;
    const jobs = (Array.isArray(data) ? data : []) as Array<{ last_error: string | null; generation_id: string }>;
    const truncated = jobs.length >= SAMPLE_LIMIT;
    let rows: typeof jobs = [];
    if (jobs.length > 0) {
      const generationIds = [...new Set(jobs.map((job) => job.generation_id))];
      const active = await client
        .from('generations')
        .select('id')
        .in('id', generationIds)
        .in('status', ['waiting', 'processing'])
        .limit(generationIds.length);
      if (active.error) throw active.error;
      const activeIds = new Set(((active.data ?? []) as Array<{ id: string }>).map((row) => row.id));
      rows = jobs.filter((job) => activeIds.has(job.generation_id));
    }
    const byClass: GenerationOutputImportFailureStatus['byClass'] = {};
    for (const row of rows) {
      const errorClass = classifyGenerationOutputImportError(row.last_error);
      byClass[errorClass] = (byClass[errorClass] ?? 0) + 1;
    }
    return { ...empty, count: rows.length, truncated, byClass };
  } catch (error) {
    // Unreadable is reported in the log, not as an alert, as the Kie balance
    // collector does; backend health still counts a generation past its window.
    logBackendError('generation_output_import_alert_unreadable', { error });
    return { ...empty, available: false, error: error instanceof Error ? error.message : 'unreadable' };
  }
}

export function generationOutputImportAlertFromStatus(
  status: GenerationOutputImportFailureStatus,
): { code: 'GENERATION_OUTPUT_IMPORT_FAILING'; message: string } | null {
  if (!status.available || status.count === 0) return null;
  const classes = (Object.entries(status.byClass) as Array<[GenerationOutputImportErrorClass, number]>)
    .sort((a, b) => b[1] - a[1]);
  const detail = classes.map(([errorClass, count]) => `${errorClass}: ${count}`).join(', ');
  const steps = classes.map(([errorClass]) => `${errorClass}: ${NEXT_STEP[errorClass]}`).join('; ');
  return {
    code: 'GENERATION_OUTPUT_IMPORT_FAILING',
    message: `${status.count}${status.truncated ? '+' : ''} generation output import(s) used all their tries in the last ${GENERATION_OUTPUT_IMPORT_ALERT_LOOKBACK_HOURS} hours (${detail}). `
      + `Each is retried hourly until ${GENERATION_OUTPUT_IMPORT_GIVE_UP_AFTER_HOURS} hours after its provider finished, then failed and refunded. Next: ${steps}.`,
  };
}
