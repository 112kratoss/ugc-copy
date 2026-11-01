import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';

/**
 * Pauses between hand-off attempts. The call is idempotent, and once a sweep
 * has lost its row nothing can work the paths out again, so a transient
 * failure is worth a second and third try.
 */
export const UNRECORDED_SHOWCASE_MEDIA_RETRY_DELAYS_MS = [250, 1_000] as const;

/**
 * The media sweeps upload a derivative beside its source before the row update
 * that names it. When no update records the upload (the update matched no row
 * because the post was deleted or made private, its row repointed, or the
 * sweep's lease taken over; or the attempt failed after the upload), nothing
 * names it again.
 *
 * What landed in a creation's public folder goes to the revocation queue
 * rather than straight to a delete: the showcase-media-revocations job keeps
 * an object that something still names (a creation published again at once
 * gets the same content-addressed names), waits while another sweep holds a
 * live lease on a serving post's row, and verifies and retries its removals.
 * A post's own prefixes (posts/, private-posts/) have no such queue.
 *
 * Never throws: the sweep has already lost its row or its attempt, and a
 * hand-off that fails every try is logged for the operator instead.
 */
export async function queueUnrecordedShowcaseMedia(
  supabase: SupabaseClient,
  paths: Array<string | null | undefined>,
): Promise<void> {
  const showcasePaths = [...new Set(paths.filter(
    (path): path is string => typeof path === 'string' && path.startsWith('showcase/'),
  ))];
  if (showcasePaths.length === 0) return;

  let error: unknown;
  for (let attempt = 0; attempt <= UNRECORDED_SHOWCASE_MEDIA_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, UNRECORDED_SHOWCASE_MEDIA_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      ({ error } = await supabase.rpc('queue_unrecorded_showcase_media', { p_paths: showcasePaths }));
    } catch (thrown) {
      error = thrown;
    }
    if (!error) return;
  }
  logBackendError('failed_to_queue_unrecorded_showcase_media', { paths: showcasePaths, error });
}
