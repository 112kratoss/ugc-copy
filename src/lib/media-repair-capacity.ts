import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { StagingCapacityError } from '@/lib/staging-workspace';

/** An admission refusal must not retire valid media. */
export function mediaRepairAttemptAfterFailure(error: unknown, reserved: number) {
  return error instanceof StagingCapacityError ? Math.max(0, reserved - 1) : reserved;
}

/** The small single-item claim RPCs do not return their reserved attempt ordinal. */
export async function deferMediaRepairCapacity(params: {
  supabase: SupabaseClient;
  error: unknown;
  kind: 'teaser' | 'playback_rendition';
  id: string;
  lockedBy: string;
  source: string;
}): Promise<boolean> {
  if (!(params.error instanceof StagingCapacityError)) return false;
  const { supabase, kind, id, lockedBy, source } = params;
  const table = kind === 'teaser' ? 'post_media' : 'generations';
  const sourceColumn = kind === 'teaser' ? 'rendition_storage_path' : 'output_url';
  const attemptColumn = `${kind}_attempt_count`;
  const ownerColumn = `${kind}_locked_by`;
  const current = await supabase.from(table).select(attemptColumn)
    .eq('id', id).eq(ownerColumn, lockedBy).eq(sourceColumn, source).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return true; // A changed source/lease belongs to someone else.
  const count = (current.data as unknown as Record<string, unknown>)[attemptColumn];
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('Invalid reserved media repair attempt.');
  }
  const result = await supabase.from(table).update({
    [attemptColumn]: count - 1,
    [`${kind}_locked_at`]: null,
    [ownerColumn]: null,
    [`${kind}_error`]: 'Staging capacity unavailable; repair deferred.',
    ...(kind === 'playback_rendition' ? { playback_rendition_status: 'failed' } : {}),
  }).eq('id', id).eq(ownerColumn, lockedBy).eq(sourceColumn, source)
    .eq(attemptColumn, count);
  if (result.error) throw result.error;
  return true;
}
