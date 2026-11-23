import { createClient } from '@supabase/supabase-js';

import {
  listPostsMissingPublicCopies,
  publicCopyPathOf,
  syncPostMediaPublicCopies,
} from '../../src/lib/post-media-public-copies';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Public copies for posts published before
 * 20261123153250_post_media_public_copies.sql.
 *
 * Lists every post anyone signed out may read whose own uploaded media (the
 * objects under private-posts/<post>/ its rows name) has no recorded public
 * copy, and how many objects each would copy. With `--execute
 * --project-ref=<ref>` it makes and records them through the path publish
 * takes (begin → Storage copy → commit, each decided by the database under the
 * post's lock), so a post that goes private meanwhile gets nothing, and any
 * copy the database refuses stays queued for the revocation job to remove.
 *
 * Dry run by default, and the dry run writes nothing: no copy, no queue row.
 * Re-running is safe; a post already copied is not listed. Its pages name the
 * copies at their next revalidation (post pages: 300 s; the feeds refresh on
 * the next post change), and the URLs they hold until then keep working.
 *
 * Run against production only on the owner's word (the release record).
 */

const PAGE_SIZE = 100;
/** The candidates RPC's own cap: a dry run reads one page this size. */
const DRY_RUN_PAGE_SIZE = 500;

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const mode = parseBackfillExecutionMode({ supabaseUrl });
logBackfillExecutionMode(mode);

type MediaRow = Record<
  'storage_path' | 'preview_storage_path' | 'display_storage_path' | 'rendition_storage_path' | 'teaser_storage_path',
  string | null
> & { public_copy_paths: string[] | null };

/** The copies a post is missing, read only: what begin would name. */
async function missingCopies(postId: string): Promise<string[]> {
  const { data, error } = await client
    .from('post_media')
    .select('storage_path, preview_storage_path, display_storage_path, rendition_storage_path, teaser_storage_path, public_copy_paths')
    .eq('post_id', postId);
  if (error) throw error;
  const missing = new Set<string>();
  for (const row of (data ?? []) as MediaRow[]) {
    const recorded = new Set(row.public_copy_paths ?? []);
    for (const path of [
      row.storage_path, row.preview_storage_path, row.display_storage_path,
      row.rendition_storage_path, row.teaser_storage_path,
    ]) {
      const copy = publicCopyPathOf(postId, path);
      if (copy && !recorded.has(copy)) missing.add(copy);
    }
  }
  return [...missing];
}

async function run() {
  const totals = { posts: 0, objects: 0, committed: 0, refused: 0, failed: 0 };
  const attempted = new Set<string>();

  for (;;) {
    const limit = mode.execute ? PAGE_SIZE : DRY_RUN_PAGE_SIZE;
    const listed = await listPostsMissingPublicCopies(client, { limit, includeUnserved: true });
    if (!mode.execute && listed.length === limit) {
      console.info(`More than ${limit} posts may need copies; the execute run pages through all of them.`);
    }
    const page = listed.filter((candidate) => !attempted.has(candidate.postId));
    if (page.length === 0) break;

    for (const { postId } of page) {
      attempted.add(postId);
      totals.posts += 1;
      if (!mode.execute) {
        const missing = await missingCopies(postId);
        totals.objects += missing.length;
        console.info(JSON.stringify({ postId, wouldCopy: missing.length }));
        continue;
      }
      const result = await syncPostMediaPublicCopies(client, postId);
      totals.objects += result.begun;
      totals.committed += result.committed;
      totals.refused += result.refused;
      totals.failed += result.failed;
      console.info(JSON.stringify({ postId, ...result }));
    }
    // A dry run changes nothing, so the next page would repeat this one.
    if (!mode.execute) break;
  }

  console.info(JSON.stringify({ dryRun: mode.dryRun, ...totals }));
  if (mode.execute && (totals.refused > 0 || totals.failed > 0)) {
    console.info('Copies not recorded stay queued; the showcase-media-revocations job removes them, and a re-run retries them.');
  }
}

run().catch((error: unknown) => {
  console.error('Post media public copy backfill failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
