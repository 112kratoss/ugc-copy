import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
import {
  NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
  SEMANTIC_CLUSTER_ITERATIONS,
  SEMANTIC_CLUSTER_MAX_EMBEDDINGS,
  SEMANTIC_CLUSTER_MIN_EMBEDDINGS,
  SEMANTIC_CLUSTER_SEED,
  assignToNearestCluster,
  clusterEmbeddings,
  pairNearDuplicates,
  staleNearDuplicateMarks,
  type NearDuplicatePost,
  type NearDuplicateQuery,
  type SemanticCluster,
} from '@/lib/feed-semantic-clusters';

/**
 * v4 content understanding: every public post's title, description, body,
 * prompt, tool and category embedded with `gte-small` (384 dimensions) by the
 * `embed-post` Supabase Edge Function, then clustered and checked for
 * near-duplicates by the `feed-embeddings` job
 * (docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md §3).
 */

export const FEED_EMBEDDING_MODEL = 'gte-small';
export const FEED_EMBEDDING_DIMENSIONS = 384;
/** Posts sent to the edge function per job run, never-embedded first, then newest. */
export const FEED_EMBEDDING_PENDING_LIMIT = 200;
/**
 * Posts per edge-function request (the function accepts 1–25). gte-small runs
 * on the function's per-request CPU budget: it starts no post 1.2 s after its
 * first and hands the rest back as deferred, so a request is sized to finish.
 */
export const FEED_EMBEDDING_BATCH_SIZE = 8;
export const FEED_EMBEDDING_REQUEST_TIMEOUT_MS = 20_000;
/** The publish hook's request: fire-and-forget, so short. */
export const FEED_EMBEDDING_PUBLISH_TIMEOUT_MS = 3_000;
/** Re-cluster at most this often; new posts join the nearest cluster in between. */
export const FEED_EMBEDDING_RECLUSTER_MINUTES = 60;
/** `match_post_content_embeddings` neighbours checked per freshly embedded post. */
export const FEED_NEAR_DUPLICATE_MATCH_LIMIT = 5;
/** Freshly embedded posts checked for near-duplicates per run. */
export const FEED_NEAR_DUPLICATE_CHECK_LIMIT = 400;
/**
 * No new embedding request starts after this much of a run: eight requests at
 * their 20 s timeout would outlast the job's 120 s, and what is left waits for
 * the next run ten minutes later.
 */
export const FEED_EMBEDDING_REQUEST_BUDGET_MS = 60_000;

const FEED_EMBEDDINGS_JOB_NAME = 'feed-embeddings';
/** With no succeeded run on record, "embedded since the last run" looks back this far. */
const FEED_EMBEDDING_WATERMARK_FALLBACK_HOURS = 24;
/** However long ago the last success was, never look back further than this. */
const FEED_EMBEDDING_WATERMARK_MAX_LOOKBACK_HOURS = 7 * 24;
/** Overlap between runs, for clock skew between the job and the edge function. */
const FEED_EMBEDDING_WATERMARK_OVERLAP_MS = 2 * 60_000;
/** PostgREST answers at most 1,000 rows a request (`max_rows`). */
const FEED_EMBEDDING_READ_PAGE = 1_000;
const FEED_EMBEDDING_IN_FILTER_CHUNK = 100;
const FEED_EMBEDDING_WRITE_CHUNK = 1_000;
const FEED_NEAR_DUPLICATE_CONCURRENCY = 4;
/** Marks cleared per run when their canonical left the feed (the RPC allows 1–10,000). */
const FEED_ORPHANED_MARK_CLEAR_LIMIT = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EmbedPostFunctionConfig = { url: string; serviceRoleKey: string };

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export type EmbedPostBatchResult =
  | {
    ok: true;
    embedded: number;
    skipped: number;
    /** Posts with no title, description, body or prompt, recorded without a vector. */
    skippedEmpty: string[];
    /** Posts the function did not start within its time budget: still pending. */
    deferred: string[];
    failed: Array<{ postId: string; error: string }>;
  }
  | { ok: false; error: string };

export type FeedEmbeddingJobSummary = {
  asOf: string;
  /** Posts `list_posts_pending_embedding` returned. */
  pending: number;
  /**
   * Pending posts left for the next run: those not sent once the run's request
   * budget was spent, and those the function deferred to stay inside its own.
   * Never a failure.
   */
  deferred: number;
  /** Posts the edge function embedded, skipped (content hash unchanged) and failed. */
  embedded: number;
  skipped: number;
  /** Posts with no text of their own to embed, recorded as text-empty. */
  skippedEmpty: number;
  failed: number;
  batches: number;
  batchesFailed: number;
  /** Embeddings written since the last succeeded run, by this run or the publish hook. */
  freshEmbeddings: number;
  clustering: {
    status: 'reclustered' | 'assigned_to_existing' | 'not_enough_embeddings' | 'no_fresh_embeddings';
    embeddings: number;
    clusters: number;
    assigned: number;
  };
  /**
   * Posts checked, newly marked duplicates, marks cleared (a re-embedded
   * duplicate that no longer matches), and match calls that failed.
   */
  nearDuplicates: { checked: number; marked: number; cleared: number; matchFailures: number };
  /** Marks cleared because their canonical post left the feed (one RPC a run). */
  orphanedMarksCleared: number;
};

/**
 * Where the `embed-post` function lives and the key it requires, read the way
 * `createServiceClient` reads them. Null when either is missing.
 */
export function getEmbedPostFunctionConfig(
  env: Record<string, string | undefined> = process.env,
): EmbedPostFunctionConfig | null {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim() || env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return null;
  try {
    return {
      url: new URL('/functions/v1/embed-post', `${supabaseUrl.replace(/\/$/, '')}/`).toString(),
      serviceRoleKey,
    };
  } catch {
    return null;
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function nonNegativeCount(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The post ids of an answer's id list; absent (an older function) reads as none. */
function postIdList(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** One POST of 1–25 post ids to `embed-post`. Never throws. */
export async function requestPostEmbeddings(
  postIds: readonly string[],
  {
    config,
    fetchImpl = fetch,
    timeoutMs = FEED_EMBEDDING_REQUEST_TIMEOUT_MS,
  }: { config: EmbedPostFunctionConfig; fetchImpl?: FetchImpl; timeoutMs?: number },
): Promise<EmbedPostBatchResult> {
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ postIds }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: `embed-post answered ${response.status}` };
    const body = await response.json() as Record<string, unknown> | null;
    const embedded = nonNegativeCount(body?.embedded);
    const skipped = nonNegativeCount(body?.skipped);
    if (!body || embedded === null || skipped === null || !Array.isArray(body.failed)) {
      return { ok: false, error: 'embed-post answered an unreadable body' };
    }
    const failed = (body.failed as unknown[]).map((entry) => {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      return {
        postId: typeof record.postId === 'string' ? record.postId : '',
        error: typeof record.error === 'string' ? record.error : 'unknown',
      };
    });
    return {
      ok: true,
      embedded,
      skipped,
      skippedEmpty: postIdList(body.skipped_empty),
      deferred: postIdList(body.deferred),
      failed,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * The publish hook: ask for one new post's embedding straight away, so it is
 * clustered and matched on the job's next run instead of waiting to be listed.
 * Fire-and-forget — it never throws, gives up after a few seconds, does
 * nothing without the function's configuration, and the job embeds the post
 * anyway if this is lost.
 */
export async function requestPostEmbedding(
  postId: string,
  {
    env = process.env,
    fetchImpl = fetch,
    timeoutMs = FEED_EMBEDDING_PUBLISH_TIMEOUT_MS,
  }: { env?: Record<string, string | undefined>; fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<void> {
  try {
    const config = getEmbedPostFunctionConfig(env);
    if (!config || !UUID_PATTERN.test(postId)) return;
    const result = await requestPostEmbeddings([postId], { config, fetchImpl, timeoutMs });
    if (!result.ok || result.failed.length > 0) {
      logBackendWarning('post_embedding_request_failed', {
        postId,
        error: result.ok ? result.failed[0]?.error : result.error,
      });
    }
  } catch (error) {
    logBackendWarning('post_embedding_request_failed', { postId, error: errorMessage(error) });
  }
}

/** Embeddings since the last succeeded run start (less an overlap), else the last day. */
async function loadFreshEmbeddingWatermark(client: SupabaseClient, now: Date) {
  const { data, error } = await client
    .from('backend_job_runs')
    .select('started_at')
    .eq('job_name', FEED_EMBEDDINGS_JOB_NAME)
    .eq('status', 'succeeded')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Feed embeddings could not read its last run: ${errorMessage(error)}`);
  const lastStartedMs = data ? Date.parse(String(data.started_at)) : Number.NaN;
  const earliestMs = now.getTime() - FEED_EMBEDDING_WATERMARK_MAX_LOOKBACK_HOURS * 3_600_000;
  return new Date(Number.isFinite(lastStartedMs)
    ? Math.max(earliestMs, lastStartedMs - FEED_EMBEDDING_WATERMARK_OVERLAP_MS)
    : now.getTime() - FEED_EMBEDDING_WATERMARK_FALLBACK_HOURS * 3_600_000).toISOString();
}

async function listPendingPostIds(client: SupabaseClient, limit: number) {
  const { data, error } = await client.rpc('list_posts_pending_embedding', { p_limit: limit });
  if (error) throw new Error(`Feed embeddings RPC list_posts_pending_embedding failed: ${errorMessage(error)}`);
  const ids: string[] = [];
  for (const row of (Array.isArray(data) ? data : []) as Array<{ post_id?: unknown }>) {
    if (typeof row?.post_id === 'string' && UUID_PATTERN.test(row.post_id) && !ids.includes(row.post_id)) {
      ids.push(row.post_id);
    }
  }
  return ids;
}

/** A pgvector value as PostgREST returns it (`"[0.1,…]"`) or as an array; null if not 384 finite numbers. */
export function parseEmbeddingVector(value: unknown): number[] | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== FEED_EMBEDDING_DIMENSIONS) return null;
  return parsed.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) ? parsed as number[] : null;
}

type FreshEmbedding = { postId: string; embedding: number[]; canonicalPostId: string | null };

/**
 * Every read of vectors skips a text-empty row (a post with no text of its
 * own, recorded without one): it is never clustered, matched or paired.
 */
async function loadFreshEmbeddings(client: SupabaseClient, since: string): Promise<FreshEmbedding[]> {
  const { data, error } = await client
    .from('post_content_embeddings')
    .select('post_id, embedding, canonical_post_id')
    .eq('embedding_model', FEED_EMBEDDING_MODEL)
    .not('embedding', 'is', null)
    .gt('embedded_at', since)
    .order('embedded_at', { ascending: false })
    .limit(FEED_NEAR_DUPLICATE_CHECK_LIMIT);
  if (error) throw new Error(`Feed embeddings could not read fresh embeddings: ${errorMessage(error)}`);
  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
    const embedding = parseEmbeddingVector(row.embedding);
    return typeof row.post_id === 'string' && embedding
      ? [{
        postId: row.post_id,
        embedding,
        canonicalPostId: typeof row.canonical_post_id === 'string' ? row.canonical_post_id : null,
      }]
      : [];
  });
}

async function loadClusters(client: SupabaseClient) {
  const { data, error } = await client
    .from('feed_semantic_clusters')
    .select('cluster_id, centroid, member_count, updated_at')
    .eq('embedding_model', FEED_EMBEDDING_MODEL)
    .order('cluster_id', { ascending: true });
  if (error) throw new Error(`Feed embeddings could not read the clusters: ${errorMessage(error)}`);
  let newestUpdateMs = Number.NEGATIVE_INFINITY;
  const clusters: SemanticCluster[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const centroid = parseEmbeddingVector(row.centroid);
    const clusterId = Number(row.cluster_id);
    if (!centroid || !Number.isInteger(clusterId)) continue;
    clusters.push({ clusterId, centroid, memberCount: nonNegativeCount(Number(row.member_count)) ?? 0 });
    const updatedMs = Date.parse(String(row.updated_at));
    if (Number.isFinite(updatedMs)) newestUpdateMs = Math.max(newestUpdateMs, updatedMs);
  }
  return { clusters, newestUpdateMs };
}

/** The newest ≤ 5,000 embeddings, a PostgREST page at a time. */
async function loadClusteringSample(client: SupabaseClient) {
  const sample: Array<{ postId: string; embedding: number[] }> = [];
  for (let offset = 0; offset < SEMANTIC_CLUSTER_MAX_EMBEDDINGS; offset += FEED_EMBEDDING_READ_PAGE) {
    const end = Math.min(SEMANTIC_CLUSTER_MAX_EMBEDDINGS, offset + FEED_EMBEDDING_READ_PAGE) - 1;
    const { data, error } = await client
      .from('post_content_embeddings')
      .select('post_id, embedding')
      .eq('embedding_model', FEED_EMBEDDING_MODEL)
      .not('embedding', 'is', null)
      .order('embedded_at', { ascending: false })
      .order('post_id', { ascending: true })
      .range(offset, end);
    if (error) throw new Error(`Feed embeddings could not read embeddings to cluster: ${errorMessage(error)}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const embedding = parseEmbeddingVector(row.embedding);
      if (typeof row.post_id === 'string' && embedding) sample.push({ postId: row.post_id, embedding });
    }
    if (rows.length < end - offset + 1) break;
  }
  return sample;
}

async function callRpcInChunks<T>(
  client: SupabaseClient,
  name: string,
  parameter: string,
  rows: T[],
  extra: Record<string, unknown> = {},
) {
  for (let offset = 0; offset < rows.length; offset += FEED_EMBEDDING_WRITE_CHUNK) {
    const { error } = await client.rpc(name, { ...extra, [parameter]: rows.slice(offset, offset + FEED_EMBEDDING_WRITE_CHUNK) });
    if (error) throw new Error(`Feed embeddings RPC ${name} failed: ${errorMessage(error)}`);
  }
}

async function refreshClusters(
  client: SupabaseClient,
  fresh: FreshEmbedding[],
  now: Date,
): Promise<FeedEmbeddingJobSummary['clustering']> {
  const existing = await loadClusters(client);
  const reclusterDue = existing.clusters.length === 0
    || existing.newestUpdateMs <= now.getTime() - FEED_EMBEDDING_RECLUSTER_MINUTES * 60_000;

  if (!reclusterDue) {
    // Between re-clusterings a new post joins the cluster it is closest to.
    const assignments = assignToNearestCluster(fresh, existing.clusters);
    await callRpcInChunks(client, 'assign_post_semantic_clusters', 'p_assignments', assignments.map((entry) => ({
      post_id: entry.postId,
      cluster_id: entry.clusterId,
    })));
    return {
      status: 'assigned_to_existing',
      embeddings: fresh.length,
      clusters: existing.clusters.length,
      assigned: assignments.length,
    };
  }

  const sample = await loadClusteringSample(client);
  if (sample.length < SEMANTIC_CLUSTER_MIN_EMBEDDINGS) {
    return { status: 'not_enough_embeddings', embeddings: sample.length, clusters: 0, assigned: 0 };
  }
  const clustering = clusterEmbeddings(sample, {
    iterations: SEMANTIC_CLUSTER_ITERATIONS,
    seed: SEMANTIC_CLUSTER_SEED,
    previous: existing.clusters,
  });
  const { error } = await client.rpc('replace_feed_semantic_clusters', {
    p_embedding_model: FEED_EMBEDDING_MODEL,
    p_clusters: clustering.clusters.map((cluster) => ({
      cluster_id: cluster.clusterId,
      centroid: cluster.centroid,
      member_count: cluster.memberCount,
    })),
  });
  if (error) throw new Error(`Feed embeddings RPC replace_feed_semantic_clusters failed: ${errorMessage(error)}`);
  await callRpcInChunks(client, 'assign_post_semantic_clusters', 'p_assignments', clustering.assignments.map((entry) => ({
    post_id: entry.postId,
    cluster_id: entry.clusterId,
  })));
  return {
    status: 'reclustered',
    embeddings: sample.length,
    clusters: clustering.clusters.length,
    assigned: clustering.assignments.length,
  };
}

async function selectInChunks(
  client: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  ids: string[],
) {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < ids.length; offset += FEED_EMBEDDING_IN_FILTER_CHUNK) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .in(column, ids.slice(offset, offset + FEED_EMBEDDING_IN_FILTER_CHUNK));
    if (error) throw new Error(`Feed embeddings could not read ${table}: ${errorMessage(error)}`);
    rows.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));
  }
  return rows;
}

async function markNearDuplicates(
  client: SupabaseClient,
  fresh: FreshEmbedding[],
): Promise<FeedEmbeddingJobSummary['nearDuplicates']> {
  const queries: NearDuplicateQuery[] = [];
  let matchFailures = 0;
  for (let offset = 0; offset < fresh.length; offset += FEED_NEAR_DUPLICATE_CONCURRENCY) {
    const batch = fresh.slice(offset, offset + FEED_NEAR_DUPLICATE_CONCURRENCY);
    const results = await Promise.all(batch.map(async (entry) => {
      const { data, error } = await client.rpc('match_post_content_embeddings', {
        p_query_embedding: entry.embedding,
        p_embedding_model: FEED_EMBEDDING_MODEL,
        p_match_threshold: NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
        p_limit: FEED_NEAR_DUPLICATE_MATCH_LIMIT,
      });
      if (error) {
        matchFailures += 1;
        logBackendWarning('feed_near_duplicate_match_failed', { postId: entry.postId, error: errorMessage(error) });
        return null;
      }
      const matches = ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => (
        typeof row.post_id === 'string' && row.post_id !== entry.postId
          ? [{ postId: row.post_id, similarity: Number(row.semantic_similarity) }]
          : []
      ));
      return { postId: entry.postId, matches };
    }));
    for (const result of results) if (result) queries.push(result);
  }

  // A fresh post's stored mark is in hand already; matches need their own read.
  const freshCanonical = new Map(fresh.map((entry) => [entry.postId, entry.canonicalPostId]));
  const cleared = staleNearDuplicateMarks({
    queries,
    posts: queries.map((query) => ({
      postId: query.postId,
      createdAt: '',
      canonicalPostId: freshCanonical.get(query.postId) ?? null,
    })),
  });
  const involved = Array.from(new Set(queries.flatMap((query) => (
    query.matches.length > 0 ? [query.postId, ...query.matches.map((match) => match.postId)] : []
  ))));
  if (involved.length === 0) {
    await writeNearDuplicateMarks(client, [], cleared);
    return { checked: queries.length, marked: 0, cleared: cleared.length, matchFailures };
  }

  // Who points at whom is read whole, text-empty rows included, because
  // mark_post_near_duplicates checks for chains against every stored mark.
  const [postRows, embeddingRows, canonicalRows] = await Promise.all([
    selectInChunks(client, 'posts', 'id, created_at', 'id', involved),
    selectInChunks(client, 'post_content_embeddings', 'post_id, canonical_post_id, text_empty', 'post_id', involved),
    selectInChunks(client, 'post_content_embeddings', 'canonical_post_id', 'canonical_post_id', involved),
  ]);
  const storedEmbeddings = new Map(embeddingRows.map((row) => [String(row.post_id), {
    canonicalPostId: typeof row.canonical_post_id === 'string' ? row.canonical_post_id : null,
    // Emptied since its vector was read for this run.
    textEmpty: row.text_empty === true,
  }]));
  const posts: NearDuplicatePost[] = postRows.flatMap((row) => (
    typeof row.id === 'string' && typeof row.created_at === 'string'
      ? [{
        postId: row.id,
        createdAt: row.created_at,
        canonicalPostId: storedEmbeddings.get(row.id)?.canonicalPostId ?? null,
        textEmpty: storedEmbeddings.get(row.id)?.textEmpty ?? false,
      }]
      : []
  ));
  const marks = pairNearDuplicates({
    queries,
    posts,
    canonicalIds: new Set(canonicalRows.flatMap((row) => (
      typeof row.canonical_post_id === 'string' ? [row.canonical_post_id] : []
    ))),
  });
  await writeNearDuplicateMarks(client, marks, cleared);
  return { checked: queries.length, marked: marks.length, cleared: cleared.length, matchFailures };
}

/**
 * Clears the marks whose canonical post is no longer public, unarchived and
 * visible: one statement a run. The candidate RPC already ignores such a
 * mark; this keeps the stored ones true for the next pairing, which would
 * otherwise never revisit a duplicate that is not re-embedded.
 */
async function clearOrphanedNearDuplicateMarks(client: SupabaseClient) {
  const { data, error } = await client.rpc('clear_orphaned_near_duplicate_marks', {
    p_limit: FEED_ORPHANED_MARK_CLEAR_LIMIT,
  });
  if (error) {
    throw new Error(`Feed embeddings RPC clear_orphaned_near_duplicate_marks failed: ${errorMessage(error)}`);
  }
  return nonNegativeCount(Number(data)) ?? 0;
}

/**
 * One `mark_post_near_duplicates` call per chunk: the new marks, and a null
 * canonical for every mark cleared. The two never share a post (a marked post
 * is one without a stored mark; a cleared one has one), and the RPC refuses a
 * post twice in a call.
 */
async function writeNearDuplicateMarks(
  client: SupabaseClient,
  marks: ReturnType<typeof pairNearDuplicates>,
  cleared: string[],
) {
  const rows = [
    ...marks.map((mark) => ({
      post_id: mark.postId,
      canonical_post_id: mark.canonicalPostId,
      similarity: mark.similarity,
    })),
    ...cleared.map((postId) => ({ post_id: postId, canonical_post_id: null, similarity: null })),
  ];
  if (rows.length === 0) return;
  await callRpcInChunks(client, 'mark_post_near_duplicates', 'p_duplicates', rows);
}

/**
 * Whether the job has anything to do: posts waiting for an embedding, or
 * embeddings written since its last succeeded run (the publish hook writes
 * them outside the job) that still need a cluster and a near-duplicate check.
 */
export async function hasFeedEmbeddingWork(client: SupabaseClient, { now = new Date() }: { now?: Date } = {}) {
  if ((await listPendingPostIds(client, 1)).length > 0) return true;
  const since = await loadFreshEmbeddingWatermark(client, now);
  const { data, error } = await client
    .from('post_content_embeddings')
    .select('post_id')
    .eq('embedding_model', FEED_EMBEDDING_MODEL)
    .not('embedding', 'is', null)
    .gt('embedded_at', since)
    .limit(1);
  if (error) throw new Error(`Feed embeddings could not read fresh embeddings: ${errorMessage(error)}`);
  return (data ?? []).length > 0;
}

/**
 * One run of the `feed-embeddings` job:
 *
 * 1. up to 200 pending posts (no embedding first, then edited since) go to
 *    `embed-post` 8 at a time, one request after another, each given 20 s,
 *    none started past the first 60 s; a failed request or post is logged and
 *    counted, and a run whose every request failed fails, so job health shows
 *    an unreachable function. A post the function deferred (its CPU budget)
 *    or recorded as text-empty is counted, never failed;
 * 2. marks whose canonical post left the feed are cleared (one RPC);
 * 3. once 20 embeddings exist, the newest ≤ 5,000 are re-clustered (at most
 *    hourly, warm-started so cluster ids stay put) and every post is assigned;
 *    in between, a new post joins its nearest cluster;
 * 4. every post embedded since the last succeeded run is matched against the
 *    rest (cosine ≥ 0.95), and the newer of each pair is marked a duplicate of
 *    the family's oldest post.
 */
export async function runFeedEmbeddingJob(
  client: SupabaseClient,
  {
    now = new Date(),
    env = process.env,
    fetchImpl = fetch,
    clock = Date.now,
  }: {
    now?: Date;
    env?: Record<string, string | undefined>;
    fetchImpl?: FetchImpl;
    /** The run's elapsed-time source, for the request budget. */
    clock?: () => number;
  } = {},
): Promise<FeedEmbeddingJobSummary> {
  if (!Number.isFinite(now.getTime())) throw new Error('Feed embeddings time must be a valid date');
  const startedAtMs = clock();
  const config = getEmbedPostFunctionConfig(env);
  if (!config) {
    throw new Error('Feed embeddings need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to reach embed-post');
  }
  const since = await loadFreshEmbeddingWatermark(client, now);

  const pending = await listPendingPostIds(client, FEED_EMBEDDING_PENDING_LIMIT);
  let embedded = 0;
  let skipped = 0;
  let skippedEmpty = 0;
  let failed = 0;
  let batches = 0;
  let batchesFailed = 0;
  let deferred = 0;
  for (let offset = 0; offset < pending.length; offset += FEED_EMBEDDING_BATCH_SIZE) {
    if (batches > 0 && clock() - startedAtMs >= FEED_EMBEDDING_REQUEST_BUDGET_MS) {
      deferred += pending.length - offset;
      break;
    }
    const batch = pending.slice(offset, offset + FEED_EMBEDDING_BATCH_SIZE);
    batches += 1;
    const result = await requestPostEmbeddings(batch, { config, fetchImpl });
    if (!result.ok) {
      batchesFailed += 1;
      failed += batch.length;
      logBackendWarning('feed_embedding_batch_failed', { posts: batch.length, error: result.error });
      continue;
    }
    embedded += result.embedded;
    skipped += result.skipped;
    skippedEmpty += result.skippedEmpty.length;
    // Left pending by the function; the next run sends them again.
    deferred += result.deferred.length;
    failed += result.failed.length;
    if (result.failed.length > 0) {
      logBackendWarning('feed_embedding_posts_failed', {
        posts: result.failed.length,
        postIds: result.failed.slice(0, 5).map((entry) => entry.postId),
        error: result.failed[0]?.error,
      });
    }
  }
  if (batches > 0 && batchesFailed === batches) {
    throw new Error(`Feed embeddings could not reach embed-post: all ${batches} request(s) failed`);
  }

  const orphanedMarksCleared = await clearOrphanedNearDuplicateMarks(client);
  const fresh = await loadFreshEmbeddings(client, since);
  const clustering: FeedEmbeddingJobSummary['clustering'] = fresh.length > 0
    ? await refreshClusters(client, fresh, now)
    : { status: 'no_fresh_embeddings', embeddings: 0, clusters: 0, assigned: 0 };
  const nearDuplicates = fresh.length > 0
    ? await markNearDuplicates(client, fresh)
    : { checked: 0, marked: 0, cleared: 0, matchFailures: 0 };

  return {
    asOf: now.toISOString(),
    pending: pending.length,
    deferred,
    embedded,
    skipped,
    skippedEmpty,
    failed,
    batches,
    batchesFailed,
    freshEmbeddings: fresh.length,
    clustering,
    nearDuplicates,
    orphanedMarksCleared,
  };
}
