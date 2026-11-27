/**
 * The retry window of an exhausted output import, and how its error reads.
 *
 * Kept free of server-only and settlement imports: backend health and the
 * backend-alerts collector read it, and neither should pull the import or
 * notification code into their bundles. The behaviour that uses it is
 * generation-output-import-retries.ts.
 *
 * 24 hours from when the provider finished (or, if that is unknown or later,
 * from when the import was queued). Kie's retention of output files is not
 * recorded in docs/model-api-references/, so the owner's 24-hour ceiling is
 * the binding one; a shorter documented retention should shorten this.
 */

export const GENERATION_OUTPUT_IMPORT_GIVE_UP_AFTER_HOURS = 24;
export const GENERATION_OUTPUT_IMPORT_RETRY_EVERY_MINUTES = 60;

const HOUR_MS = 60 * 60 * 1000;
const RETRYING_IMPORT_STATUSES = new Set(['pending', 'processing', 'failed']);

export type GenerationOutputImportErrorClass =
  | 'host_not_allowed'
  | 'file_too_large'
  | 'provider_fetch_failed'
  | 'storage_failed'
  | 'other';

export type GenerationOutputImportWindowFields = {
  status?: string | null;
  provider_completed_at?: string | null;
  created_at?: string | null;
};

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The earlier of when the provider finished and when the import was queued. */
export function generationOutputImportWindowStartMs(job: GenerationOutputImportWindowFields): number | null {
  const times = [parseMs(job.provider_completed_at), parseMs(job.created_at)]
    .filter((ms): ms is number => ms !== null);
  return times.length > 0 ? Math.min(...times) : null;
}

/** Whether the window has ended. No usable clock at all ends it: credits are not held for ever. */
export function generationOutputImportWindowEnded(job: GenerationOutputImportWindowFields, nowMs: number): boolean {
  const start = generationOutputImportWindowStartMs(job);
  if (start === null) return true;
  return nowMs - start >= GENERATION_OUTPUT_IMPORT_GIVE_UP_AFTER_HOURS * HOUR_MS;
}

/**
 * Whether a generation is waiting on its output import inside the retry
 * window: its provider finished and the file is still being retried. Takes the
 * import job as PostgREST embeds a one-to-one relation (object, array or null).
 */
export function isGenerationOutputImportRetrying(
  embed: GenerationOutputImportWindowFields | GenerationOutputImportWindowFields[] | null | undefined,
  now: Date,
): boolean {
  const job = Array.isArray(embed) ? embed[0] : embed;
  if (!job || !RETRYING_IMPORT_STATUSES.has(job.status ?? '')) return false;
  if (generationOutputImportWindowStartMs(job) === null) return false;
  return !generationOutputImportWindowEnded(job, now.getTime());
}

/** The class of a stored import error, worded for the owner's next step. */
export function classifyGenerationOutputImportError(
  lastError: string | null | undefined,
): GenerationOutputImportErrorClass {
  const text = (lastError ?? '').toLowerCase();
  if (!text) return 'other';
  if (/exceeds the allowed size|maximum allowed size|too large|payload too large/.test(text)) return 'file_too_large';
  if (/not allowlisted/.test(text)) return 'host_not_allowed';
  if (/remote media|remote response|fetch failed|timed out|timeout|econn|enotfound|socket|aborted|network/.test(text)) {
    return 'provider_fetch_failed';
  }
  if (/storage|bucket|upload|object/.test(text)) return 'storage_failed';
  return 'other';
}
