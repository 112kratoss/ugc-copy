import { createClient } from '@supabase/supabase-js';

import {
  countPostsMissingPublicCopies,
  listPostsMissingPublicCopies,
  syncPostMediaPublicCopies,
  type PostMissingPublicCopies,
} from '../../src/lib/post-media-public-copies';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Public copies for posts published before
 * 20261123153250_post_media_public_copies.sql.
 *
 * Lists every post anyone signed out may read that has copy sources (its own
 * uploaded objects under private-posts/<post>/ that its rows name, Storage
 * holds and no row records as copied; a feed rendition once it is ready), with
 * how many objects and bytes each would add to the public bucket. With
 * `--execute --project-ref=<ref>` it makes and records them through the path
 * publish takes (begin → Storage copy → commit, each decided by the database
 * under the post's lock), so a post that goes private meanwhile gets nothing,
 * and any copy the database refuses is removed under a claim or left queued
 * for the revocation job.
 *
 * Pages newest first by (created_at, id), so posts whose copies fail never
 * hold back older ones, and ends with what is still left (read only). Dry run
 * by default, and the dry run writes nothing: no copy, no queue row.
 * Re-running is safe; a post already copied is not listed. Its pages name the
 * copies at their next revalidation (post pages: 300 s; the feeds refresh on
 * the next post change), and the URLs they hold until then keep working.
 *
 * Run against production only on the owner's word (the release record).
 */

const PAGE_SIZE = 100;

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const mode = parseBackfillExecutionMode({ supabaseUrl });
logBackfillExecutionMode(mode);

const megabytes = (bytes: number) => Number((bytes / (1024 * 1024)).toFixed(1));

async function run() {
  const totals = { posts: 0, objects: 0, bytes: 0, committed: 0, refused: 0, failed: 0 };
  let before: PostMissingPublicCopies | null = null;

  for (;;) {
    const page: PostMissingPublicCopies[] = await listPostsMissingPublicCopies(
      client,
      { limit: PAGE_SIZE, includeUnserved: true, before },
    );
    for (const post of page) {
      totals.posts += 1;
      totals.objects += post.missingObjects;
      totals.bytes += post.missingBytes;
      if (!mode.execute) {
        console.info(JSON.stringify({
          postId: post.postId, wouldCopy: post.missingObjects, wouldAddMegabytes: megabytes(post.missingBytes),
        }));
        continue;
      }
      const result = await syncPostMediaPublicCopies(client, post.postId);
      totals.committed += result.committed;
      totals.refused += result.refused;
      totals.failed += result.failed;
      console.info(JSON.stringify({ postId: post.postId, ...result }));
    }
    if (page.length < PAGE_SIZE) break;
    before = page[page.length - 1];
  }

  const remaining = await countPostsMissingPublicCopies(client, { includeUnserved: true });
  console.info(JSON.stringify({
    dryRun: mode.dryRun,
    posts: totals.posts,
    objects: totals.objects,
    addedMegabytes: megabytes(totals.bytes),
    committed: totals.committed,
    refused: totals.refused,
    failed: totals.failed,
    // After a dry run this is what an execute would do; after one, what it could not.
    remaining: { posts: remaining.posts, objects: remaining.objects, megabytes: megabytes(remaining.bytes) },
  }));
  if (mode.execute && remaining.posts > 0) {
    console.info('Copies not made stay listed: a refused one is removed under a claim or by the revocation job, and a re-run tries again.');
  }
}

run().catch((error: unknown) => {
  console.error('Post media public copy backfill failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
