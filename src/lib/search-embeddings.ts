import 'server-only';

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendEvent, logBackendWarning } from '@/lib/backend-logger';
import { BackendRateLimitError, enforceBackendRateLimit } from '@/lib/backend-rate-limit';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import {
  getEmbedPostFunctionConfig,
  parseEmbeddingVector,
  type EmbedPostFunctionConfig,
} from '@/lib/feed-embeddings';

/**
 * Search by meaning (search phase 4): the server half of "related posts".
 *
 * Every public post search could return has a `gte-small` vector of its public
 * search text and of nothing else (`post_search_embeddings`, migration
 * `20261112215420_search_semantic_related_posts.sql`; the feed's
 * `post_content_embeddings` hold a post's prompt and are never read here). The
 * `embed-post` Edge Function makes the vectors, in two modes of its own:
 * `search` for posts, `query` for a search's words.
 *
 * Two things live in this file:
 *
 * - the `search-embeddings` backend job (`runSearchEmbeddingJob`), which sends
 *   the posts whose vector is missing or out of date to the function, a
 *   bounded batch a run, and prunes what search can no longer return;
 * - the read (`findRelatedPostRows`), which `/api/search` calls when a client
 *   asked for related posts and the search's own answer is thin: the query's
 *   vector from the cache or, under the viewer's daily allowance, the day's
 *   cap and a short timeout, from the function, then `search_related_posts`.
 *
 * The read can only add to a search. Disabled, not configured, past the
 * viewer's allowance or the day's cap, slow, refused by a function from
 * before these modes, or run against a database from before the migration,
 * it answers `null` and says why in the log, never with the query's text.
 */

export const SEARCH_EMBEDDING_MODEL = 'gte-small';
export const SEARCH_EMBEDDING_DIMENSIONS = 384;

// ─── The job ────────────────────────────────────────────────────────────────

/** Posts sent to the edge function per job run, newest first. */
export const SEARCH_EMBEDDING_PENDING_LIMIT = 96;
/** Posts per edge-function request (it accepts 1 to 25 and stops starting posts 1.2 s in). */
export const SEARCH_EMBEDDING_BATCH_SIZE = 8;
export const SEARCH_EMBEDDING_REQUEST_TIMEOUT_MS = 20_000;
/** No new request starts after this much of a run; the rest waits ten minutes. */
export const SEARCH_EMBEDDING_REQUEST_BUDGET_MS = 45_000;
/** Rows of each kind the prune deletes a run. */
export const SEARCH_EMBEDDING_PRUNE_LIMIT = 1_000;

// ─── The read ───────────────────────────────────────────────────────────────

/** A search's own answer is thin, and related posts are looked for, under this many posts. */
export const SEARCH_RELATED_THIN_POST_COUNT = 6;
/** The most related posts an answer carries. */
export const SEARCH_RELATED_MAX_POSTS = 8;
/** How long a search waits for a new query's vector. */
export const SEARCH_QUERY_EMBEDDING_TIMEOUT_MS = 1_200;
/**
 * How long the request itself is given, behind the answer: a function that was
 * cold answers after the search gave up on it, and its vector is kept for the
 * next search of the same words.
 */
export const SEARCH_QUERY_EMBEDDING_BACKGROUND_TIMEOUT_MS = 10_000;
/**
 * New query embeddings asked of the edge function per UTC day by everyone,
 * counted in the database (`reserve_search_query_embedding`, which never
 * allows more than 5,000 whatever is sent). Past it searches go without
 * related posts until the next day.
 */
export const SEARCH_QUERY_EMBEDDING_DAILY_CAP = 2_000;
/**
 * New query embeddings one viewer may cause per UTC day: the account, or the
 * network of a visitor, by the key search's own rate limit counts. Checked
 * before the day's cap, so one client cannot spend it for everyone: twelve
 * guest sessions at search's own 180 requests per ten minutes would spend
 * 2,000 in ten minutes. A query already in the cache is free and uncounted.
 * Past it that viewer's searches go without related posts until the next
 * UTC day (the window is the rate limit's own, aligned to the day).
 */
export const SEARCH_QUERY_EMBEDDING_VIEWER_DAILY_LIMIT = {
  scope: 'public-search:related-embedding',
  limit: 40,
  windowSeconds: 86_400,
} as const;
/** The whole read, cache to nearest posts: past this the search answers without it. */
export const SEARCH_RELATED_TOTAL_TIMEOUT_MS = 2_500;
/** How long the work behind an answer (a late vector, its write to the cache) is kept alive. */
const SEARCH_RELATED_KEEP_ALIVE_MS = SEARCH_RELATED_TOTAL_TIMEOUT_MS + SEARCH_QUERY_EMBEDDING_BACKGROUND_TIMEOUT_MS + 2_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Environment = Record<string, string | undefined>;
type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

/** `SEARCH_SEMANTIC_DISABLED=1` (or `true`) is the kill switch, read on every use: no read, and no job run. */
export function isSearchSemanticDisabled(env: Environment = process.env): boolean {
  const value = env.SEARCH_SEMANTIC_DISABLED?.trim().toLowerCase();
  return value === '1' || value === 'true';
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

function postIdList(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

// ─── embed-post, search mode ────────────────────────────────────────────────

export type EmbedSearchBatchResult =
  | {
    ok: true;
    embedded: number;
    skipped: number;
    /** Posts search cannot return, or with no public text: nothing to embed. */
    skippedUnsearchable: string[];
    /** Not started inside the function's budget, or changed while embedded: still pending. */
    deferred: string[];
    failed: Array<{ postId: string; error: string }>;
  }
  | { ok: false; error: string; /** The function deployed does not know the search mode. */ unsupported?: boolean };

/** One POST of 1 to 25 post ids to `embed-post` in its `search` mode. Never throws. */
export async function requestSearchEmbeddings(
  postIds: readonly string[],
  {
    config,
    fetchImpl = fetch,
    timeoutMs = SEARCH_EMBEDDING_REQUEST_TIMEOUT_MS,
  }: { config: EmbedPostFunctionConfig; fetchImpl?: FetchImpl; timeoutMs?: number },
): Promise<EmbedSearchBatchResult> {
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'search', postIds }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: `embed-post answered ${response.status}` };
    const body = await response.json() as Record<string, unknown> | null;
    // A function from before the modes reads the ids as the feed's and answers
    // 200 without a mode: it embedded nothing for search.
    if (body?.mode !== 'search') {
      return { ok: false, error: 'embed-post does not know the search mode', unsupported: true };
    }
    const embedded = nonNegativeCount(body.embedded);
    const skipped = nonNegativeCount(body.skipped);
    if (embedded === null || skipped === null || !Array.isArray(body.failed)) {
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
      skippedUnsearchable: postIdList(body.skipped_unsearchable),
      deferred: postIdList(body.deferred),
      failed,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// ─── The job ────────────────────────────────────────────────────────────────

export type SearchEmbeddingJobSummary = {
  asOf: string;
  /** Posts `list_posts_pending_search_embedding` returned. */
  pending: number;
  /** Posts the edge function embedded, skipped (vector already of this text) and failed. */
  embedded: number;
  skipped: number;
  /** Posts that left search between the listing and the function's read. */
  skippedUnsearchable: number;
  /** Pending posts left for the next run: the run's or the function's budget ran out. Never a failure. */
  deferred: number;
  failed: number;
  batches: number;
  batchesFailed: number;
  /** What `prune_search_embeddings` deleted. */
  pruned: { postEmbeddings: number; queryEmbeddings: number; queryDays: number };
};

async function listPendingPostIds(client: SupabaseClient, limit: number) {
  const { data, error } = await client.rpc('list_posts_pending_search_embedding', {
    p_embedding_model: SEARCH_EMBEDDING_MODEL,
    p_limit: limit,
  });
  if (error) {
    throw new Error(`Search embeddings RPC list_posts_pending_search_embedding failed: ${errorMessage(error)}`);
  }
  const ids: string[] = [];
  for (const row of (Array.isArray(data) ? data : []) as Array<{ post_id?: unknown }>) {
    if (typeof row?.post_id === 'string' && UUID_PATTERN.test(row.post_id) && !ids.includes(row.post_id)) {
      ids.push(row.post_id);
    }
  }
  return ids;
}

async function pruneSearchEmbeddings(client: SupabaseClient): Promise<SearchEmbeddingJobSummary['pruned']> {
  const { data, error } = await client.rpc('prune_search_embeddings', { p_limit: SEARCH_EMBEDDING_PRUNE_LIMIT });
  if (error) throw new Error(`Search embeddings RPC prune_search_embeddings failed: ${errorMessage(error)}`);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  return {
    postEmbeddings: nonNegativeCount(row?.post_embeddings_deleted) ?? 0,
    queryEmbeddings: nonNegativeCount(row?.query_embeddings_deleted) ?? 0,
    queryDays: nonNegativeCount(row?.query_days_deleted) ?? 0,
  };
}

/**
 * Whether the job has anything to do: a post waiting for its vector, or rows
 * the prune would delete. Nothing while the kill switch is on.
 */
export async function hasSearchEmbeddingWork(
  client: SupabaseClient,
  { env = process.env }: { env?: Environment } = {},
): Promise<boolean> {
  if (isSearchSemanticDisabled(env)) return false;
  const { data, error } = await client.rpc('search_embedding_backlog', { p_embedding_model: SEARCH_EMBEDDING_MODEL });
  if (error) throw new Error(`Search embeddings RPC search_embedding_backlog failed: ${errorMessage(error)}`);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  return row?.pending === true || row?.prunable === true;
}

/**
 * One run of the `search-embeddings` job:
 *
 * 1. up to 96 posts whose public-text vector is missing or out of date, newest
 *    first, go to `embed-post` in its search mode 8 at a time, one request
 *    after another, each given 20 s, none started past the first 45 s. A
 *    failed request or post is logged and counted, and a run whose every
 *    request failed fails, so job health shows an unreachable function. A
 *    function from before the search mode ends the sending at once;
 * 2. the vectors of posts search can no longer return, cached query vectors
 *    older than 30 days and daily counts older than a week are deleted.
 *
 * At most 12 function requests a run, so a fresh table of a few hundred posts
 * fills within the hour and a quiet day asks for none.
 */
export async function runSearchEmbeddingJob(
  client: SupabaseClient,
  {
    now = new Date(),
    env = process.env,
    fetchImpl = fetch,
    clock = Date.now,
  }: {
    now?: Date;
    env?: Environment;
    fetchImpl?: FetchImpl;
    /** The run's elapsed-time source, for the request budget. */
    clock?: () => number;
  } = {},
): Promise<SearchEmbeddingJobSummary> {
  if (!Number.isFinite(now.getTime())) throw new Error('Search embeddings time must be a valid date');
  const startedAtMs = clock();
  const config = getEmbedPostFunctionConfig(env);
  if (!config) {
    throw new Error('Search embeddings need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to reach embed-post');
  }

  const pending = await listPendingPostIds(client, SEARCH_EMBEDDING_PENDING_LIMIT);
  let embedded = 0;
  let skipped = 0;
  let skippedUnsearchable = 0;
  let deferred = 0;
  let failed = 0;
  let batches = 0;
  let batchesFailed = 0;
  for (let offset = 0; offset < pending.length; offset += SEARCH_EMBEDDING_BATCH_SIZE) {
    if (batches > 0 && clock() - startedAtMs >= SEARCH_EMBEDDING_REQUEST_BUDGET_MS) {
      deferred += pending.length - offset;
      break;
    }
    const batch = pending.slice(offset, offset + SEARCH_EMBEDDING_BATCH_SIZE);
    batches += 1;
    const result = await requestSearchEmbeddings(batch, { config, fetchImpl });
    if (!result.ok) {
      batchesFailed += 1;
      failed += batch.length;
      logBackendWarning('search_embedding_batch_failed', { posts: batch.length, error: result.error });
      if (result.unsupported) {
        // Every further request would be read the same way.
        deferred += pending.length - offset - batch.length;
        break;
      }
      continue;
    }
    embedded += result.embedded;
    skipped += result.skipped;
    skippedUnsearchable += result.skippedUnsearchable.length;
    deferred += result.deferred.length;
    failed += result.failed.length;
    if (result.failed.length > 0) {
      logBackendWarning('search_embedding_posts_failed', {
        posts: result.failed.length,
        postIds: result.failed.slice(0, 5).map((entry) => entry.postId),
        error: result.failed[0]?.error,
      });
    }
  }
  if (batches > 0 && batchesFailed === batches) {
    throw new Error(`Search embeddings could not use embed-post: all ${batches} request(s) failed`);
  }

  const pruned = await pruneSearchEmbeddings(client);

  return {
    asOf: now.toISOString(),
    pending: pending.length,
    embedded,
    skipped,
    skippedUnsearchable,
    deferred,
    failed,
    batches,
    batchesFailed,
    pruned,
  };
}

// ─── The read ───────────────────────────────────────────────────────────────

export type RelatedPostRow = {
  post_id: string;
  creator_user_id: string;
  similarity: number;
};

/** Why a search went without related posts; goes to the log, never with the query. */
export type RelatedPostsSkipReason =
  | 'disabled'
  | 'not_configured'
  | 'no_viewer_key'
  | 'lookup_failed'
  | 'viewer_cap_reached'
  | 'daily_cap_reached'
  | 'embedding_timeout'
  | 'embedding_failed'
  | 'related_failed'
  | 'timeout';

export type RelatedPostsDependencies = {
  env?: Environment;
  fetchImpl?: FetchImpl;
  logEvent?: typeof logBackendEvent;
  /** The viewer's allowance of new query embeddings; the repo's rate limit by default. */
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  /**
   * Keeps the invocation alive behind the answer, for a vector that arrives
   * late and its write to the cache; Next's `after` at the route. It is handed
   * its task when the read starts, while the request is certainly open.
   */
  runAfterResponse?: RunAfterResponse;
  /** The timers, for tests. */
  queryEmbeddingTimeoutMs?: number;
  totalTimeoutMs?: number;
};

/**
 * The cache key of a query: sha256 of the model and the query as it is
 * embedded (lowercased, one space between words). The text is never stored.
 */
export function searchQueryEmbeddingHash(embeddedQuery: string): string {
  return createHash('sha256').update(`${SEARCH_EMBEDDING_MODEL}\n${embeddedQuery}`, 'utf8').digest('hex');
}

/** A query as it is embedded and keyed: trimmed, one space between words, lowercased. */
export function normalizeSearchQueryForEmbedding(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

type QueryEmbeddingResult = { ok: true; embedding: number[] } | { ok: false; error: string };

/** One POST to `embed-post` in its `query` mode. Never throws; the query is never logged. */
export async function requestQueryEmbedding(
  query: string,
  {
    config,
    fetchImpl = fetch,
    timeoutMs = SEARCH_QUERY_EMBEDDING_BACKGROUND_TIMEOUT_MS,
  }: { config: EmbedPostFunctionConfig; fetchImpl?: FetchImpl; timeoutMs?: number },
): Promise<QueryEmbeddingResult> {
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'query', query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A function from before the modes answers 400: it looked for post ids.
    if (!response.ok) return { ok: false, error: `embed-post answered ${response.status}` };
    const body = await response.json() as Record<string, unknown> | null;
    const embedding = body?.mode === 'query' && body.model === SEARCH_EMBEDDING_MODEL
      ? parseEmbeddingVector(body.embedding)
      : null;
    if (!embedding) return { ok: false, error: 'embed-post answered an unreadable body' };
    return { ok: true, embedding };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function toVectorLiteral(embedding: readonly number[]) {
  return `[${embedding.join(',')}]`;
}

async function storeQueryEmbedding(
  client: SupabaseClient,
  queryHash: string,
  embedding: readonly number[],
  logEvent: typeof logBackendEvent,
) {
  try {
    const { error } = await client.rpc('store_search_query_embedding', {
      p_query_hash: queryHash,
      p_embedding_model: SEARCH_EMBEDDING_MODEL,
      p_embedding: toVectorLiteral(embedding),
    });
    if (error) logEvent('warn', 'public_search_related_cache_write_failed', { error });
  } catch (error) {
    logEvent('warn', 'public_search_related_cache_write_failed', { error });
  }
}

/** Hands a task to the scheduler, or where there is none (or it refuses) runs it at once without waiting on it. */
function runBehindAnswer(runAfterResponse: RunAfterResponse | undefined, task: () => Promise<unknown>) {
  try {
    if (runAfterResponse) {
      runAfterResponse(task);
      return;
    }
  } catch {
    // The scheduler refused: run it here, in front of nothing.
  }
  void task().catch(() => undefined);
}

const TIMED_OUT = Symbol('timed out');

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type QueryEmbeddingDependencies = {
  env: Environment;
  fetchImpl: FetchImpl;
  logEvent: typeof logBackendEvent;
  enforceBackendRateLimit: typeof enforceBackendRateLimit;
  queryEmbeddingTimeoutMs: number;
  /** Work that goes on behind the answer; the caller keeps the invocation alive for it. */
  background: Promise<unknown>[];
};

/**
 * The query's vector. In order: the cache, which costs and counts nothing;
 * then, for a query not in it, the viewer's own daily allowance, the day's
 * cap for everyone, and the function, waited on for a short while.
 */
async function queryEmbedding(
  client: SupabaseClient,
  embeddedQuery: string,
  viewerKey: string,
  dependencies: QueryEmbeddingDependencies,
): Promise<{ ok: true; embedding: number[] } | { ok: false; reason: RelatedPostsSkipReason; error?: unknown }> {
  const config = getEmbedPostFunctionConfig(dependencies.env);
  if (!config) return { ok: false, reason: 'not_configured' };

  const queryHash = searchQueryEmbeddingHash(embeddedQuery);
  const cache = await client.rpc('search_query_embedding', {
    p_query_hash: queryHash,
    p_embedding_model: SEARCH_EMBEDDING_MODEL,
  });
  // A database from before the migration answers "no such function".
  if (cache.error) return { ok: false, reason: 'lookup_failed', error: cache.error };
  const cached = parseEmbeddingVector(cache.data);
  if (cached) return { ok: true, embedding: cached };

  // A new query. The viewer's allowance first: past it nothing is reserved
  // of the day everyone shares, and the function is not called.
  try {
    await dependencies.enforceBackendRateLimit(client, {
      ...SEARCH_QUERY_EMBEDDING_VIEWER_DAILY_LIMIT,
      key: viewerKey,
    });
  } catch (error) {
    return error instanceof BackendRateLimitError
      ? { ok: false, reason: 'viewer_cap_reached' }
      : { ok: false, reason: 'lookup_failed', error };
  }

  const reservation = await client.rpc('reserve_search_query_embedding', {
    p_daily_cap: SEARCH_QUERY_EMBEDDING_DAILY_CAP,
  });
  if (reservation.error) return { ok: false, reason: 'lookup_failed', error: reservation.error };
  if (reservation.data !== true) return { ok: false, reason: 'daily_cap_reached' };

  // The day's count is already one higher: this request is made whatever the
  // search does next, and its vector kept, so the place is not spent for
  // nothing. The write to the cache waits on nobody's answer.
  const request = requestQueryEmbedding(embeddedQuery, { config, fetchImpl: dependencies.fetchImpl });
  dependencies.background.push(request.then(async (answer) => {
    if (answer.ok) await storeQueryEmbedding(client, queryHash, answer.embedding, dependencies.logEvent);
  }));
  const answer = await withTimeout(request, dependencies.queryEmbeddingTimeoutMs);
  if (answer === TIMED_OUT) return { ok: false, reason: 'embedding_timeout' };
  if (!answer.ok) return { ok: false, reason: 'embedding_failed', error: answer.error };
  return { ok: true, embedding: answer.embedding };
}

/**
 * The posts nearest a query by meaning that the viewer may see and the answer
 * does not already show, nearest first (`search_related_posts`: labelled
 * posts and both sides of a block left out in SQL, before its limit), or
 * `null` when they could not be looked for. Never throws and never waits past
 * `SEARCH_RELATED_TOTAL_TIMEOUT_MS`; a skip is one line in the log, with its
 * reason and without the query.
 */
export async function findRelatedPostRows(
  client: SupabaseClient,
  options: {
    /** The query as the search read it (the corrected reading where there was one). */
    query: string;
    viewerUserId: string | null;
    /**
     * Who the new-query allowance is counted against: the key search's own
     * rate limit uses (the account, or the hashed network of a visitor).
     */
    viewerKey: string;
    excludePostIds: readonly string[];
    limit?: number;
  },
  dependencyOverrides: RelatedPostsDependencies = {},
): Promise<RelatedPostRow[] | null> {
  const logEvent = dependencyOverrides.logEvent ?? logBackendEvent;
  const skipped = (reason: RelatedPostsSkipReason, error?: unknown) => {
    // The switch is a decision and a viewer past their allowance is the
    // allowance working: neither is a fault to warn of on every search.
    if (reason === 'viewer_cap_reached') {
      logEvent('info', 'public_search_related_skipped', { reason });
    } else if (reason !== 'disabled') {
      logEvent('warn', 'public_search_related_skipped', { reason, ...(error === undefined ? {} : { error }) });
    }
    return null;
  };

  try {
    const env = dependencyOverrides.env ?? process.env;
    if (isSearchSemanticDisabled(env)) return skipped('disabled');
    const embeddedQuery = normalizeSearchQueryForEmbedding(options.query);
    if (!embeddedQuery) return null;
    const viewerKey = options.viewerKey.trim();
    if (!viewerKey) return skipped('no_viewer_key');

    // Set when the search stopped waiting: what is in flight finishes, and
    // nothing more is started for an answer nobody will read.
    let abandoned = false;
    const background: Promise<unknown>[] = [];
    const read = (async (): Promise<RelatedPostRow[] | null> => {
      const vector = await queryEmbedding(client, embeddedQuery, viewerKey, {
        env,
        fetchImpl: dependencyOverrides.fetchImpl ?? fetch,
        logEvent,
        enforceBackendRateLimit: dependencyOverrides.enforceBackendRateLimit ?? enforceBackendRateLimit,
        queryEmbeddingTimeoutMs: dependencyOverrides.queryEmbeddingTimeoutMs ?? SEARCH_QUERY_EMBEDDING_TIMEOUT_MS,
        background,
      });
      if (!vector.ok) return skipped(vector.reason, vector.error);
      if (abandoned) return null;

      const { data, error } = await client.rpc('search_related_posts', {
        p_query_embedding: toVectorLiteral(vector.embedding),
        p_viewer_user_id: options.viewerUserId,
        p_exclude_post_ids: options.excludePostIds.filter((id) => UUID_PATTERN.test(id)).slice(0, 100),
        p_limit: options.limit ?? SEARCH_RELATED_MAX_POSTS,
        p_embedding_model: SEARCH_EMBEDDING_MODEL,
      });
      if (error) return skipped('related_failed', error);
      return ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => (
        typeof row.post_id === 'string' && typeof row.creator_user_id === 'string'
          ? [{ post_id: row.post_id, creator_user_id: row.creator_user_id, similarity: Number(row.similarity) }]
          : []
      ));
    })();
    // The read itself never rejects into nothing.
    const settled = read.catch(() => null);

    // Handed over now, while the request is open: a scheduler such as Next's
    // `after` takes a task only then, and one registered once the answer had
    // gone (after the timeout below) kept nothing alive, so a vector that
    // arrived late was never written to the cache. The task waits for the
    // read and for whatever it left running behind it, no longer than their
    // own bounds.
    runBehindAnswer(dependencyOverrides.runAfterResponse, async () => {
      await withTimeout((async () => {
        await settled;
        await Promise.allSettled(background);
      })(), SEARCH_RELATED_KEEP_ALIVE_MS);
    });

    const answer = await withTimeout(read, dependencyOverrides.totalTimeoutMs ?? SEARCH_RELATED_TOTAL_TIMEOUT_MS);
    if (answer === TIMED_OUT) {
      abandoned = true;
      return skipped('timeout');
    }
    return answer;
  } catch (error) {
    return skipped('related_failed', error);
  }
}
