import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';

/**
 * The media sweeps upload a derivative beside its source before the row update
 * that names it. When that update matches no row (the post was deleted or made
 * private, its row repointed, or the sweep's lease taken over while it
 * worked), nothing names the upload again.
 *
 * What landed in a creation's public folder goes to the revocation queue
 * rather than straight to a delete: the showcase-media-revocations job keeps
 * an object that something still names (a creation published again at once
 * gets the same content-addressed names), waits while another sweep holds a
 * live lease on a serving post's row, and verifies and retries its removals.
 * A post's own prefix is not the queue's.
 *
 * Never throws: the sweep has already lost its row, and a failed hand-off is
 * logged for the operator instead.
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
  try {
    ({ error } = await supabase.rpc('queue_unrecorded_showcase_media', { p_paths: showcasePaths }));
  } catch (thrown) {
    error = thrown;
  }
  if (error) {
    logBackendError('failed_to_queue_unrecorded_showcase_media', { paths: showcasePaths, error });
  }
}
