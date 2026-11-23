/**
 * Public copies of a post's own uploaded media (migration
 * 20261123153250_post_media_public_copies.sql).
 *
 * Uploaded originals and their derivatives stay in the private `post_media`
 * bucket under `private-posts/<post>/`, where `/api/media` authorizes and
 * signs every read. While a post may be read by anyone signed out, each of
 * those objects also gets a copy at `public-posts/<post>/<same rest>` in the
 * public `showcase_media` bucket, and readers are handed that copy's CDN URL
 * instead: no function call, RPC or signing per view.
 *
 * The database decides everything that matters for privacy. A copy is served
 * only while its `post_media` row records it, a row may record one only while
 * the post is readable by anyone (a deferred constraint), and every write that
 * ends that (private, archive, moderation, tombstone, NSFW, delete, a replaced
 * gallery, the owner leaving) clears the records and queues the objects in its
 * own transaction. This module makes copies (begin → Storage copy → commit)
 * and removes queued ones (claim → remove → verify → finish); callers run the
 * removal inline after such a write, and the showcase-media-revocations job
 * retries whatever is left.
 *
 * No `server-only` import: the moderation CLI and the backfill load this
 * under tsx.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { PRIVATE_POST_MEDIA_BUCKET, PRIVATE_POST_MEDIA_PREFIX } from '@/lib/post-media-storage';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';

export const PUBLIC_POST_MEDIA_COPY_PREFIX = 'public-posts/';
export const PUBLIC_POST_MEDIA_COPY_BUCKET = 'showcase_media';

/** Copies made at once for one post; a post names 25 objects at most (5 rows × 5 paths). */
const COPY_CONCURRENCY = 4;
/** Queue rows read per page by the removal loop. */
export const POST_MEDIA_PUBLIC_COPY_QUEUE_PAGE_SIZE = 50;
/** The job's share of its function's 300 s, after the showcase revocations. */
export const POST_MEDIA_PUBLIC_COPY_TIME_BUDGET_MS = 60_000;
/**
 * A queued copy still there a day later fails the job's run (JOB_LATEST_RUN_FAILED):
 * by then it is not a transient storage error, and the object may still be fetchable.
 */
export const POST_MEDIA_PUBLIC_COPY_STUCK_AFTER_MS = 24 * 60 * 60 * 1000;
/**
 * Inline removal takes rows due up to this far ahead, so a clock behind the
 * database's still sees the rows the write it follows just queued.
 */
const INLINE_DUE_MARGIN_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The copy's path for one of the post's own private paths; null for any other path. */
export function publicCopyPathOf(postId: string, privatePath: string | null | undefined): string | null {
  if (!privatePath || !UUID.test(postId)) return null;
  const folder = `${PRIVATE_POST_MEDIA_PREFIX}${postId}/`;
  if (!privatePath.startsWith(folder) || privatePath.length <= folder.length) return null;
  return `${PUBLIC_POST_MEDIA_COPY_PREFIX}${privatePath.slice(PRIVATE_POST_MEDIA_PREFIX.length)}`;
}

/** Whether a path is a canonical copy inside one post's own public folder. */
export function isPublicPostMediaCopyPath(path: string, postId: string): boolean {
  const folder = `${PUBLIC_POST_MEDIA_COPY_PREFIX}${postId}/`;
  return UUID.test(postId)
    && path.startsWith(folder)
    && path.length > folder.length
    && parseCanonicalStorageObjectPath(path, { minimumSegments: 3 }) === path;
}

export function publicPostMediaCopyUrl(client: SupabaseClient, copyPath: string): string {
  return client.storage.from(PUBLIC_POST_MEDIA_COPY_BUCKET).getPublicUrl(copyPath).data.publicUrl;
}

/**
 * The URL a reader of this row is handed for one of its paths: the recorded
 * public copy when there is one, else `fallback` (the authorized route or the
 * public URL `postMediaReadUrl` builds).
 */
export function servedPostMediaPathUrl({
  client,
  postId,
  path,
  recordedCopies,
  fallback,
}: {
  client: SupabaseClient;
  postId: string;
  path: string;
  recordedCopies: readonly string[] | null | undefined;
  fallback: (path: string) => string;
}): string {
  const copy = publicCopyPathOf(postId, path);
  return copy && recordedCopies?.includes(copy) ? publicPostMediaCopyUrl(client, copy) : fallback(path);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function isExistingObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { statusCode, status, message } = error as { statusCode?: unknown; status?: unknown; message?: unknown };
  return statusCode === '409' || statusCode === 409 || status === 409
    || (typeof message === 'string' && /already exists|duplicate/i.test(message));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export type PostMediaPublicCopySync = {
  /** Copies begun: the post's private objects with no recorded copy. */
  begun: number;
  /** Recorded on their rows, now served. */
  committed: number;
  /** Copied but not recorded (the post stopped being readable meanwhile, or sizes differed). */
  refused: number;
  /** Storage refused the copy; it stays queued and the worker removes whatever exists. */
  failed: number;
};

/**
 * Makes and records the public copies a post is missing. A post nobody signed
 * out may read gets none (the database answers with nothing to copy). Safe to
 * run any number of times and beside any other write: every step is decided
 * under the post's row lock, and an object made here is queued before it
 * exists.
 */
export async function syncPostMediaPublicCopies(
  client: SupabaseClient,
  postId: string,
): Promise<PostMediaPublicCopySync> {
  const result: PostMediaPublicCopySync = { begun: 0, committed: 0, refused: 0, failed: 0 };
  if (!UUID.test(postId)) throw new Error('A post id is required for public media copies.');

  const begun = await client.rpc('begin_post_media_public_copies', { p_post_id: postId });
  if (begun.error) throw begun.error;
  const pairs = (Array.isArray(begun.data) ? begun.data : []) as Array<{ source_path?: unknown; copy_path?: unknown }>;
  result.begun = pairs.length;
  if (pairs.length === 0) return result;

  for (const pair of pairs) {
    const sourcePath = typeof pair.source_path === 'string' ? pair.source_path : null;
    const copyPath = typeof pair.copy_path === 'string' ? pair.copy_path : null;
    // The database derived both; anything else is refused before Storage sees it.
    if (
      !sourcePath
      || !copyPath
      || parseCanonicalStorageObjectPath(sourcePath, { minimumSegments: 3 }) !== sourcePath
      || publicCopyPathOf(postId, sourcePath) !== copyPath
      || !isPublicPostMediaCopyPath(copyPath, postId)
    ) {
      throw new Error('Refusing a public media copy outside the post\'s own folder.');
    }
  }

  const copied = await mapWithConcurrency(pairs, COPY_CONCURRENCY, async (pair) => {
    const sourcePath = pair.source_path as string;
    const copyPath = pair.copy_path as string;
    try {
      const copy = await client.storage
        .from(PRIVATE_POST_MEDIA_BUCKET)
        .copy(sourcePath, copyPath, { destinationBucket: PUBLIC_POST_MEDIA_COPY_BUCKET });
      // An object already there is one an earlier run made from the same
      // write-once source; the commit checks its size against the source.
      return !copy.error || isExistingObjectError(copy.error) ? copyPath : null;
    } catch {
      return null;
    }
  });
  const madePaths = copied.filter((path): path is string => path !== null);
  result.failed = pairs.length - madePaths.length;
  if (madePaths.length === 0) return result;

  const commit = await client.rpc('commit_post_media_public_copies', {
    p_post_id: postId,
    p_copy_paths: madePaths,
  });
  if (commit.error) throw commit.error;
  const committed = new Set((Array.isArray(commit.data) ? commit.data : []).filter(
    (path): path is string => typeof path === 'string',
  ));
  result.committed = madePaths.filter((path) => committed.has(path)).length;

  result.refused = madePaths.filter((path) => !committed.has(path)).length;
  if (result.refused > 0) {
    // Queued, due now, by the commit. Removed only under a claim, which
    // re-reads the rows under the post's lock: another sync of the post may
    // have recorded the same object meanwhile, and it is never removed then.
    try {
      await removeQueuedPostMediaPublicCopies(client, { postId });
    } catch {
      // The rows stay queued; the job removes them.
    }
  }
  return result;
}

export type PostMediaPublicCopyRemovalSummary = {
  due: number;
  /** Objects removed and verified gone, their rows settled. */
  removed: number;
  /**
   * Objects removed and verified gone whose rows stay a while: a copy of the
   * path began under 15 minutes ago and may still land.
   */
  held: number;
  /** Objects removed whose rows a commit took back meanwhile: removed again next run. */
  released: number;
  /** Rows that turned out to be recorded copies again: left served. */
  served: number;
  /** Rows already handled by another run. */
  gone: number;
  rescheduled: number;
  /** Rows older than a day (counted by the job's run only). */
  stuck: number;
};

export class PostMediaPublicCopiesStuckError extends Error {
  summary: PostMediaPublicCopyRemovalSummary;

  constructor(summary: PostMediaPublicCopyRemovalSummary) {
    super(
      `${summary.stuck} public post media ${summary.stuck === 1 ? 'copy is' : 'copies are'} still queued for removal a day after their post stopped serving them.`,
    );
    this.name = 'PostMediaPublicCopiesStuckError';
    this.summary = summary;
  }
}

type QueueRow = { public_path: string; post_id: string };

async function removeQueuedCopy(
  client: SupabaseClient,
  row: QueueRow,
  summary: PostMediaPublicCopyRemovalSummary,
): Promise<void> {
  const claim = await client.rpc('claim_post_media_public_copy_removal', { p_copy_path: row.public_path });
  if (claim.error) throw claim.error;
  const answer = (claim.data ?? {}) as { outcome?: unknown; token?: unknown };
  if (answer.outcome === 'served') {
    summary.served += 1;
    return;
  }
  if (answer.outcome !== 'claimed' || typeof answer.token !== 'string') {
    summary.gone += 1;
    return;
  }
  const token = answer.token;

  let failure: string | null = null;
  if (!isPublicPostMediaCopyPath(row.public_path, row.post_id)) {
    // The table's own check makes this unreachable; never remove outside the folder.
    failure = 'Refusing to remove a path outside the post\'s public copy folder.';
  } else {
    try {
      const removal = await client.storage.from(PUBLIC_POST_MEDIA_COPY_BUCKET).remove([row.public_path]);
      if (removal.error) {
        failure = errorText(removal.error);
      } else {
        const exists = await client.storage.from(PUBLIC_POST_MEDIA_COPY_BUCKET).exists(row.public_path);
        if (exists.data !== false) failure = 'The public copy still exists after removal.';
      }
    } catch (error) {
      failure = errorText(error);
    }
  }

  if (failure) {
    const reschedule = await client.rpc('reschedule_post_media_public_copy_removal', {
      p_copy_path: row.public_path,
      p_claim_token: token,
      p_error: failure,
    });
    if (reschedule.error) throw reschedule.error;
    summary.rescheduled += 1;
    return;
  }

  const finish = await client.rpc('finish_post_media_public_copy_removal', {
    p_copy_path: row.public_path,
    p_claim_token: token,
  });
  if (finish.error) throw finish.error;
  // 'held': a copy of the path may still land, so the row stays until its
  // window ends and the next run checks again. 'released': a commit took the
  // row back meanwhile; the object is gone, and the next run removes it again.
  if (finish.data === 'held') summary.held += 1;
  else if (finish.data === 'released') summary.released += 1;
  else summary.removed += 1;
}

/**
 * Removes queued copies that no row records, each verified gone before its
 * queue row leaves. With `postId`, only that post's rows: the inline step
 * after a write that stopped a post's public reading. Without, the job's pass
 * over every due row, which also counts rows a day old and fails the run on
 * any (`failOnStuck`).
 */
export async function removeQueuedPostMediaPublicCopies(
  client: SupabaseClient,
  {
    postId,
    now = new Date(),
    limit = POST_MEDIA_PUBLIC_COPY_QUEUE_PAGE_SIZE,
    timeBudgetMs = POST_MEDIA_PUBLIC_COPY_TIME_BUDGET_MS,
    clock = Date.now,
    failOnStuck = false,
  }: {
    postId?: string;
    now?: Date;
    limit?: number;
    timeBudgetMs?: number;
    clock?: () => number;
    failOnStuck?: boolean;
  } = {},
): Promise<PostMediaPublicCopyRemovalSummary> {
  const summary: PostMediaPublicCopyRemovalSummary = {
    due: 0, removed: 0, held: 0, released: 0, served: 0, gone: 0, rescheduled: 0, stuck: 0,
  };
  if (postId !== undefined && !UUID.test(postId)) {
    throw new Error('A post id is required for public media copy removal.');
  }
  const dueBy = new Date(now.getTime() + (postId ? INLINE_DUE_MARGIN_MS : 0)).toISOString();
  const startedAt = clock();
  // Each row taken is removed, settled or rescheduled past `dueBy`, so a page
  // never repeats one; the ids are kept to make sure of it.
  const taken = new Set<string>();
  for (let page = 0; page === 0 || clock() - startedAt < timeBudgetMs; page += 1) {
    let query = client
      .from('post_media_public_copy_queue')
      .select('public_path, post_id')
      .lte('next_attempt_at', dueBy);
    if (postId) query = query.eq('post_id', postId);
    const { data, error } = await query
      .order('next_attempt_at', { ascending: true })
      .order('public_path', { ascending: true })
      .limit(limit);
    if (error) throw error;

    const rows = ((data ?? []) as QueueRow[]).filter((row) => !taken.has(row.public_path));
    if (rows.length === 0) break;
    for (const row of rows) {
      taken.add(row.public_path);
      summary.due += 1;
      await removeQueuedCopy(client, row, summary);
    }
    if ((data ?? []).length < limit) break;
  }

  if (failOnStuck) {
    const { count, error } = await client
      .from('post_media_public_copy_queue')
      .select('public_path', { count: 'exact', head: true })
      .lt('created_at', new Date(now.getTime() - POST_MEDIA_PUBLIC_COPY_STUCK_AFTER_MS).toISOString());
    if (error) throw error;
    summary.stuck = count ?? 0;
    if (summary.stuck > 0) throw new PostMediaPublicCopiesStuckError(summary);
  }
  return summary;
}

/**
 * Posts anyone may read with copy sources (an own private object Storage holds,
 * not yet recorded as copied; a feed rendition once it is ready), newest first,
 * a page at a time: pass the last one as `before` for the next page, so posts
 * whose copies keep failing never hold back older ones. `includeUnserved:
 * false` (the job) asks only for posts already served at least one copy, so a
 * deploy copies nothing on its own: existing posts wait for the backfill
 * (`scripts/backfills/backfill-post-media-public-copies.ts`).
 */
export type PostMissingPublicCopies = {
  postId: string;
  ownerUserId: string;
  createdAt: string;
  missingObjects: number;
  missingBytes: number;
};

export async function listPostsMissingPublicCopies(
  client: SupabaseClient,
  {
    limit,
    includeUnserved,
    before,
  }: {
    limit: number;
    includeUnserved: boolean;
    before?: Pick<PostMissingPublicCopies, 'createdAt' | 'postId'> | null;
  },
): Promise<PostMissingPublicCopies[]> {
  const { data, error } = await client.rpc('list_post_media_public_copy_candidates', {
    p_limit: limit,
    p_include_unserved: includeUnserved,
    p_before_created_at: before?.createdAt ?? null,
    p_before_post_id: before?.postId ?? null,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    const value = (row ?? {}) as Record<string, unknown>;
    const { post_id: postId, owner_user_id: ownerUserId, post_created_at: createdAt } = value;
    return typeof postId === 'string' && UUID.test(postId)
      && typeof ownerUserId === 'string' && UUID.test(ownerUserId)
      && typeof createdAt === 'string'
      ? [{
          postId,
          ownerUserId,
          createdAt,
          missingObjects: Number(value.missing_objects ?? 0),
          missingBytes: Number(value.missing_bytes ?? 0),
        }]
      : [];
  });
}

/** Every post `listPostsMissingPublicCopies` would list, page after page; read only. */
export async function countPostsMissingPublicCopies(
  client: SupabaseClient,
  { includeUnserved, pageSize = 500 }: { includeUnserved: boolean; pageSize?: number },
): Promise<{ posts: number; objects: number; bytes: number }> {
  const total = { posts: 0, objects: 0, bytes: 0 };
  let before: PostMissingPublicCopies | null = null;
  for (;;) {
    const page: PostMissingPublicCopies[] = await listPostsMissingPublicCopies(client, { limit: pageSize, includeUnserved, before });
    for (const post of page) {
      total.posts += 1;
      total.objects += post.missingObjects;
      total.bytes += post.missingBytes;
    }
    if (page.length < pageSize) return total;
    before = page[page.length - 1];
  }
}

export async function hasPendingPostMediaPublicCopyWork(client: SupabaseClient): Promise<boolean> {
  const [queued, missing] = await Promise.all([
    client.from('post_media_public_copy_queue').select('public_path').limit(1),
    listPostsMissingPublicCopies(client, { limit: 1, includeUnserved: false }),
  ]);
  if (queued.error) throw queued.error;
  return (queued.data ?? []).length > 0 || missing.length > 0;
}

export type PostMediaPublicCopyMaintenance = {
  removal: PostMediaPublicCopyRemovalSummary;
  synced: { posts: number; committed: number; refused: number; failed: number };
  /** Posts that gained a served copy: their pages are refreshed so they name it. */
  copiedPosts: PostMissingPublicCopies[];
};

/**
 * The job's pass: removes every due queued copy, then copies what posts
 * already served are missing (a preview, rendition or teaser a sweep built
 * after the post was copied). Removal runs first and to completion; a stuck
 * row fails the run after the copies are made.
 */
export async function maintainPostMediaPublicCopies(
  client: SupabaseClient,
  {
    now = new Date(),
    clock = Date.now,
    timeBudgetMs = POST_MEDIA_PUBLIC_COPY_TIME_BUDGET_MS,
    syncPageSize = 25,
  }: { now?: Date; clock?: () => number; timeBudgetMs?: number; syncPageSize?: number } = {},
): Promise<PostMediaPublicCopyMaintenance> {
  let stuck: PostMediaPublicCopiesStuckError | null = null;
  let removal: PostMediaPublicCopyRemovalSummary;
  try {
    removal = await removeQueuedPostMediaPublicCopies(client, { now, clock, timeBudgetMs, failOnStuck: true });
  } catch (error) {
    if (!(error instanceof PostMediaPublicCopiesStuckError)) throw error;
    stuck = error;
    removal = error.summary;
  }

  const synced = { posts: 0, committed: 0, refused: 0, failed: 0 };
  const copiedPosts: PostMissingPublicCopies[] = [];
  const startedAt = clock();
  // Page after page, oldest last, until the time is spent: a post whose copy
  // keeps failing costs one attempt a run and never holds back the others.
  let before: PostMissingPublicCopies | null = null;
  pages: for (;;) {
    const page: PostMissingPublicCopies[] = await listPostsMissingPublicCopies(
      client,
      { limit: syncPageSize, includeUnserved: false, before },
    );
    for (const candidate of page) {
      if (clock() - startedAt >= timeBudgetMs) break pages;
      const result = await syncPostMediaPublicCopies(client, candidate.postId);
      synced.posts += 1;
      synced.committed += result.committed;
      synced.refused += result.refused;
      synced.failed += result.failed;
      if (result.committed > 0) copiedPosts.push(candidate);
    }
    if (page.length < syncPageSize) break;
    before = page[page.length - 1];
  }

  if (stuck) throw stuck;
  return { removal, synced, copiedPosts };
}
