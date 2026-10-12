import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const loggerMocks = vi.hoisted(() => ({ logBackendWarning: vi.fn() }));

vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend-logger')>()),
  logBackendWarning: loggerMocks.logBackendWarning,
}));

import { mulberry32 } from '@/lib/feed-thompson';
import {
  FEED_EMBEDDING_BATCH_SIZE,
  FEED_EMBEDDING_PENDING_LIMIT,
  getEmbedPostFunctionConfig,
  hasFeedEmbeddingWork,
  parseEmbeddingVector,
  requestPostEmbedding,
  requestPostEmbeddings,
  runFeedEmbeddingJob,
} from '@/lib/feed-embeddings';

type Row = Record<string, unknown>;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const ENV = { NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' };
const random = mulberry32(42);

function vector(axis: number, noise = 0.01) {
  return Array.from({ length: 384 }, (_, index) => (index === axis ? 1 : 0) + (random() - 0.5) * noise);
}

const postId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/**
 * An in-memory stand-in for the tables and RPCs the job uses. Reads honour the
 * filters, orderings, limits and ranges the code sends; the RPCs behave like
 * the migration's: matching is real cosine similarity over the stored vectors.
 */
function fakeDb({
  embeddings = [] as Row[],
  clusters = [] as Row[],
  runs = [] as Row[],
  posts = [] as Row[],
  pending = [] as string[],
} = {}) {
  const tables: Record<string, Row[]> = {
    post_content_embeddings: embeddings,
    feed_semantic_clusters: clusters,
    backend_job_runs: runs,
    posts,
  };
  const rpcCalls: Array<[string, Row]> = [];

  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const orderings: Array<{ column: string; ascending: boolean }> = [];
    let limit = Number.POSITIVE_INFINITY;
    let range: [number, number] | null = null;
    const rows = () => {
      const matched = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
      matched.sort((left, right) => {
        for (const { column, ascending } of orderings) {
          const order = String(left[column]).localeCompare(String(right[column]));
          if (order !== 0) return ascending ? order : -order;
        }
        return 0;
      });
      const limited = matched.slice(0, limit);
      return range ? limited.slice(range[0], range[1] + 1) : limited;
    };
    const query = {
      select: () => query,
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return query;
      },
      gt(column: string, value: string) {
        filters.push((row) => String(row[column]) > value);
        return query;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      not(column: string, operator: string, value: unknown) {
        if (operator !== 'is' || value !== null) throw new Error(`Unexpected filter not.${operator}`);
        filters.push((row) => row[column] !== null && row[column] !== undefined);
        return query;
      },
      order(column: string, { ascending }: { ascending: boolean }) {
        orderings.push({ column, ascending });
        return query;
      },
      limit(value: number) {
        limit = value;
        return query;
      },
      range(start: number, end: number) {
        range = [start, end];
        return query;
      },
      async maybeSingle() {
        return { data: rows()[0] ?? null, error: null };
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
      },
    };
    return query;
  }

  const rpc = vi.fn(async (name: string, args: Row) => {
    rpcCalls.push([name, args]);
    switch (name) {
      case 'list_posts_pending_embedding':
        return {
          data: pending.slice(0, Number(args.p_limit)).map((id) => ({ post_id: id, updated_at: '2026-10-01T11:00:00.000Z' })),
          error: null,
        };
      case 'replace_feed_semantic_clusters':
        tables.feed_semantic_clusters = (args.p_clusters as Row[]).map((cluster) => ({
          cluster_id: cluster.cluster_id,
          embedding_model: args.p_embedding_model,
          centroid: JSON.stringify(cluster.centroid),
          member_count: cluster.member_count,
          updated_at: NOW.toISOString(),
        }));
        return { data: (args.p_clusters as Row[]).length, error: null };
      case 'assign_post_semantic_clusters':
      case 'mark_post_near_duplicates':
        return { data: null, error: null };
      case 'clear_orphaned_near_duplicate_marks': {
        // As the migration's: a canonical still in the feed is public,
        // unarchived and visible (a fixture post without those fields is).
        const inFeed = (id: unknown) => tables.posts.some((post) => (
          post.id === id
          && (post.visibility ?? 'public') === 'public'
          && !post.archived_at
          && (post.review_status ?? 'visible') === 'visible'
        ));
        const orphaned = tables.post_content_embeddings
          .filter((row) => row.canonical_post_id && !inFeed(row.canonical_post_id))
          .slice(0, Number(args.p_limit));
        for (const row of orphaned) Object.assign(row, { canonical_post_id: null });
        return { data: orphaned.length, error: null };
      }
      case 'match_post_content_embeddings': {
        const query = args.p_query_embedding as number[];
        const norm = (values: number[]) => Math.hypot(...values);
        const matches = tables.post_content_embeddings
          // As the migration's: a row without a vector is never a match.
          .filter((row) => row.embedding !== null)
          .map((row) => {
            const stored = JSON.parse(String(row.embedding)) as number[];
            const similarity = stored.reduce((sum, value, index) => sum + value * query[index], 0) / (norm(stored) * norm(query));
            return { post_id: row.post_id, semantic_similarity: similarity };
          })
          .filter((row) => row.semantic_similarity >= Number(args.p_match_threshold))
          .sort((left, right) => right.semantic_similarity - left.semantic_similarity)
          .slice(0, Number(args.p_limit));
        return { data: matches, error: null };
      }
      default:
        throw new Error(`Unexpected RPC ${name}`);
    }
  });

  return { client: { from, rpc } as unknown as SupabaseClient, tables, rpc, rpcCalls };
}

function embeddingRow(id: string, values: number[] | null, embeddedAt: string, canonical: string | null = null): Row {
  return {
    post_id: id,
    embedding_model: 'gte-small',
    // A post with no text of its own is stored without a vector.
    embedding: values ? JSON.stringify(values) : null,
    text_empty: values === null,
    canonical_post_id: canonical,
    embedded_at: embeddedAt,
  };
}

/**
 * embed-post as the job sees it: upserts an embedding for every requested post
 * (the given vector, or a fresh one) — a re-embed keeps the stored cluster and
 * mark, as the function's upsert does — answering the way the function does.
 */
function embedPost(
  db: ReturnType<typeof fakeDb>,
  {
    status = 200,
    vectors = new Map<string, number[]>(),
    skippedPerBatch = 0,
    failedPerBatch = 0,
    emptyPerBatch = 0,
    deferredPerBatch = 0,
  }: {
    status?: number | ((call: number) => number);
    vectors?: Map<string, number[]>;
    skippedPerBatch?: number;
    failedPerBatch?: number;
    /** Posts after the failed and skipped ones that have no text of their own. */
    emptyPerBatch?: number;
    /** The batch's last posts, not started within the function's time budget. */
    deferredPerBatch?: number;
  } = {},
) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    const answer = typeof status === 'function' ? status(calls) : status;
    if (answer !== 200) return new Response('unavailable', { status: answer });
    const { postIds } = JSON.parse(String(init.body)) as { postIds: string[] };
    const started = postIds.slice(0, Math.max(0, postIds.length - deferredPerBatch));
    const deferred = postIds.slice(started.length);
    const failed = started.slice(0, failedPerBatch);
    const skipped = started.slice(failedPerBatch, failedPerBatch + skippedPerBatch);
    const empty = started.slice(failedPerBatch + skippedPerBatch, failedPerBatch + skippedPerBatch + emptyPerBatch);
    const embedded = started.slice(failedPerBatch + skippedPerBatch + emptyPerBatch);
    for (const id of [...empty, ...embedded]) {
      const row = embeddingRow(
        id,
        empty.includes(id) ? null : vectors.get(id) ?? vector(300),
        '2026-10-01T12:00:05.000Z',
      );
      const existing = db.tables.post_content_embeddings.find((entry) => entry.post_id === id);
      if (existing) {
        Object.assign(existing, { embedding: row.embedding, text_empty: row.text_empty, embedded_at: row.embedded_at });
      } else {
        db.tables.post_content_embeddings.push(row);
      }
    }
    return Response.json({
      embedded: embedded.length,
      skipped: skipped.length,
      skipped_empty: empty,
      deferred,
      failed: failed.map((id) => ({ postId: id, error: 'post not found' })),
    });
  });
  return { fetchImpl, maxInFlight: () => maxInFlight };
}

afterEach(() => {
  loggerMocks.logBackendWarning.mockClear();
});

describe('getEmbedPostFunctionConfig', () => {
  it('builds the function URL the way the service client reads its environment', () => {
    expect(getEmbedPostFunctionConfig(ENV)).toEqual({
      url: 'https://project.supabase.co/functions/v1/embed-post',
      serviceRoleKey: 'service-role-key',
    });
    expect(getEmbedPostFunctionConfig({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: ' key ' }))
      .toEqual({ url: 'http://127.0.0.1:54321/functions/v1/embed-post', serviceRoleKey: 'key' });
    expect(getEmbedPostFunctionConfig({ NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co' })).toBeNull();
    expect(getEmbedPostFunctionConfig({ SUPABASE_SERVICE_ROLE_KEY: 'key' })).toBeNull();
  });
});

describe('requestPostEmbeddings', () => {
  const config = { url: 'https://project.supabase.co/functions/v1/embed-post', serviceRoleKey: 'service-role-key' };

  it('posts the ids with the service-role bearer and reads the answer', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ embedded: 1, skipped: 1, failed: [{ postId: 'p3', error: 'no text' }] }));

    await expect(requestPostEmbeddings(['p1', 'p2', 'p3'], { config, fetchImpl })).resolves.toEqual({
      ok: true,
      embedded: 1,
      skipped: 1,
      // An answer from a function without the two lists reads as neither.
      skippedEmpty: [],
      deferred: [],
      failed: [{ postId: 'p3', error: 'no text' }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(config.url, expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer service-role-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ postIds: ['p1', 'p2', 'p3'] }),
      signal: expect.any(AbortSignal),
    }));
  });

  it('reads the posts the function recorded as text-empty and the ones it deferred', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      embedded: 1,
      skipped: 0,
      skipped_empty: ['p2'],
      deferred: ['p3', 'p4'],
      failed: [],
    }));

    await expect(requestPostEmbeddings(['p1', 'p2', 'p3', 'p4'], { config, fetchImpl })).resolves.toEqual({
      ok: true,
      embedded: 1,
      skipped: 0,
      skippedEmpty: ['p2'],
      deferred: ['p3', 'p4'],
      failed: [],
    });
  });

  it('reports a refused, unreadable or failed request instead of throwing', async () => {
    await expect(requestPostEmbeddings(['p1'], { config, fetchImpl: async () => new Response('no', { status: 401 }) }))
      .resolves.toEqual({ ok: false, error: 'embed-post answered 401' });
    await expect(requestPostEmbeddings(['p1'], { config, fetchImpl: async () => Response.json({ embedded: 'x' }) }))
      .resolves.toEqual({ ok: false, error: 'embed-post answered an unreadable body' });
    await expect(requestPostEmbeddings(['p1'], { config, fetchImpl: async () => { throw new Error('timeout'); } }))
      .resolves.toEqual({ ok: false, error: 'timeout' });
  });
});

describe('requestPostEmbedding (the publish hook)', () => {
  it('asks for one post, and does nothing without the function configuration', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ embedded: 1, skipped: 0, failed: [] }));

    await requestPostEmbedding(postId(1), { env: {}, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();

    await requestPostEmbedding(postId(1), { env: ENV, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://project.supabase.co/functions/v1/embed-post');
    expect(JSON.parse(String(init.body))).toEqual({ postIds: [postId(1)] });
  });

  it('never throws, and logs what failed', async () => {
    await expect(requestPostEmbedding(postId(2), {
      env: ENV,
      fetchImpl: async () => { throw new Error('connection reset'); },
    })).resolves.toBeUndefined();
    expect(loggerMocks.logBackendWarning).toHaveBeenCalledWith('post_embedding_request_failed', {
      postId: postId(2),
      error: 'connection reset',
    });
    await expect(requestPostEmbedding('not-a-post', { env: ENV, fetchImpl: vi.fn() })).resolves.toBeUndefined();
  });

  it('gives up after its timeout', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const startedAt = Date.now();

    await requestPostEmbedding(postId(3), { env: ENV, fetchImpl, timeoutMs: 20 });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(loggerMocks.logBackendWarning).toHaveBeenCalledWith('post_embedding_request_failed', expect.objectContaining({
      postId: postId(3),
    }));
  });
});

describe('parseEmbeddingVector', () => {
  it('reads a pgvector as PostgREST returns it, and only a 384-dimension one', () => {
    const values = vector(1);
    expect(parseEmbeddingVector(JSON.stringify(values))).toEqual(values);
    expect(parseEmbeddingVector(values)).toEqual(values);
    expect(parseEmbeddingVector('[1,2,3]')).toBeNull();
    expect(parseEmbeddingVector('not json')).toBeNull();
    expect(parseEmbeddingVector([...values.slice(0, 383), Number.NaN])).toBeNull();
  });
});

describe('runFeedEmbeddingJob', () => {
  it('sends pending posts to embed-post 8 at a time, one after another, and passes its counts through', async () => {
    const pending = Array.from({ length: 20 }, (_, index) => postId(index + 1));
    const db = fakeDb({ pending });
    const embed = embedPost(db, { skippedPerBatch: 1 });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embed.fetchImpl });

    // Eight inferences fit the function's 1.2 s budget; 25 would not.
    expect(FEED_EMBEDDING_BATCH_SIZE).toBe(8);
    expect(embed.fetchImpl.mock.calls.map(([, init]) => (JSON.parse(String(init.body)) as { postIds: string[] }).postIds))
      .toEqual([pending.slice(0, 8), pending.slice(8, 16), pending.slice(16)]);
    expect(embed.maxInFlight()).toBe(1);
    expect(db.rpcCalls[0]).toEqual(['list_posts_pending_embedding', { p_limit: FEED_EMBEDDING_PENDING_LIMIT }]);
    // A content hash the function already has is a skip, passed straight through.
    expect(summary).toMatchObject({
      pending: 20,
      deferred: 0,
      embedded: 17,
      skipped: 3,
      skippedEmpty: 0,
      failed: 0,
      batches: 3,
      batchesFailed: 0,
      freshEmbeddings: 17,
    });
  });

  it('counts posts the function deferred apart from failures, and never fails a run for them', async () => {
    const pending = Array.from({ length: 16 }, (_, index) => postId(index + 1));
    const db = fakeDb({ pending });
    // Every request runs out of time with three posts unstarted.
    const embed = embedPost(db, { deferredPerBatch: 3 });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embed.fetchImpl });

    expect(summary).toMatchObject({ pending: 16, embedded: 10, deferred: 6, failed: 0, batches: 2, batchesFailed: 0 });
    // They stay pending for the next run: nothing is written for them.
    expect(db.tables.post_content_embeddings.map((row) => row.post_id))
      .toEqual([...pending.slice(0, 5), ...pending.slice(8, 13)]);
    expect(loggerMocks.logBackendWarning).not.toHaveBeenCalled();

    const allDeferred = fakeDb({ pending: [postId(1), postId(2)] });
    await expect(runFeedEmbeddingJob(allDeferred.client, {
      now: NOW,
      env: ENV,
      fetchImpl: embedPost(allDeferred, { deferredPerBatch: 2 }).fetchImpl,
    })).resolves.toMatchObject({ embedded: 0, deferred: 2, failed: 0 });
  });

  it('counts a post with no text of its own, and never clusters or matches it', async () => {
    const db = fakeDb({ pending: [postId(1), postId(2), postId(3)] });
    const embed = embedPost(db, { emptyPerBatch: 2 });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embed.fetchImpl });

    expect(summary).toMatchObject({ embedded: 1, skippedEmpty: 2, failed: 0, freshEmbeddings: 1 });
    expect(summary.nearDuplicates.checked).toBe(1);
    const matched = db.rpcCalls.filter(([name]) => name === 'match_post_content_embeddings');
    expect(matched).toHaveLength(1);
    expect(db.tables.post_content_embeddings.filter((row) => row.text_empty).map((row) => row.post_id))
      .toEqual([postId(1), postId(2)]);
  });

  it('counts a failed request and a failed post, logs both, and carries on', async () => {
    const pending = Array.from({ length: 60 }, (_, index) => postId(index + 1));
    const db = fakeDb({ pending });
    const embed = embedPost(db, { status: (call) => (call === 1 ? 503 : 200), failedPerBatch: 1 });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embed.fetchImpl });

    // Eight requests: the first refused (8 posts), each of the other seven
    // with one failed post.
    expect(summary).toMatchObject({ embedded: 45, skipped: 0, failed: 8 + 7, batches: 8, batchesFailed: 1 });
    expect(loggerMocks.logBackendWarning).toHaveBeenCalledWith('feed_embedding_batch_failed', {
      posts: 8,
      error: 'embed-post answered 503',
    });
    expect(loggerMocks.logBackendWarning).toHaveBeenCalledWith('feed_embedding_posts_failed', expect.objectContaining({
      posts: 1,
      error: 'post not found',
    }));
  });

  it('fails the run when embed-post cannot be reached at all', async () => {
    const db = fakeDb({ pending: [postId(1), postId(2)] });
    const embed = embedPost(db, { status: 500 });

    await expect(runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embed.fetchImpl }))
      .rejects.toThrow('Feed embeddings could not reach embed-post: all 1 request(s) failed');
  });

  it('starts no request past its budget and leaves the rest for the next run', async () => {
    const pending = Array.from({ length: 100 }, (_, index) => postId(index + 1));
    const db = fakeDb({ pending });
    const embed = embedPost(db);
    let elapsed = 0;

    const summary = await runFeedEmbeddingJob(db.client, {
      now: NOW,
      env: ENV,
      fetchImpl: async (url, init) => {
        elapsed += 30_000;
        return embed.fetchImpl(url, init);
      },
      clock: () => elapsed,
    });

    expect(summary).toMatchObject({ batches: 2, embedded: 16, deferred: 84 });
  });

  it('refuses to run without the function configuration', async () => {
    await expect(runFeedEmbeddingJob(fakeDb().client, { now: NOW, env: {} }))
      .rejects.toThrow('Feed embeddings need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  });

  it('does no clustering or matching when nothing was embedded since the last run', async () => {
    const db = fakeDb({
      embeddings: [embeddingRow(postId(1), vector(0), '2026-09-01T00:00:00.000Z')],
      runs: [{ job_name: 'feed-embeddings', status: 'succeeded', started_at: '2026-10-01T11:50:00.000Z' }],
    });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: vi.fn() });

    expect(summary).toMatchObject({
      pending: 0,
      batches: 0,
      freshEmbeddings: 0,
      clustering: { status: 'no_fresh_embeddings' },
      nearDuplicates: { checked: 0, marked: 0 },
      orphanedMarksCleared: 0,
    });
    // The orphaned-mark pass runs every run, as one call.
    expect(db.rpcCalls).toEqual([
      ['list_posts_pending_embedding', { p_limit: FEED_EMBEDDING_PENDING_LIMIT }],
      ['clear_orphaned_near_duplicate_marks', { p_limit: 1_000 }],
    ]);
  });

  it('clusters once 20 embeddings exist and assigns every post', async () => {
    const old = '2026-09-01T00:00:00.000Z';
    const existing = Array.from({ length: 24 }, (_, index) => embeddingRow(postId(index + 1), vector(Math.floor(index / 8) * 100), old));
    const db = fakeDb({ embeddings: existing, pending: [postId(99)] });
    const embed = embedPost(db, { vectors: new Map([[postId(99), vector(0)]]) });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embed.fetchImpl });

    expect(summary.clustering).toEqual({ status: 'reclustered', embeddings: 25, clusters: 3, assigned: 25 });
    const replace = db.rpcCalls.find(([name]) => name === 'replace_feed_semantic_clusters')?.[1];
    expect(replace?.p_embedding_model).toBe('gte-small');
    expect(replace?.p_clusters).toHaveLength(3);
    for (const cluster of replace?.p_clusters as Array<{ cluster_id: number; centroid: number[]; member_count: number }>) {
      expect(cluster.centroid).toHaveLength(384);
      expect(Number.isInteger(cluster.cluster_id)).toBe(true);
    }
    expect((replace?.p_clusters as Array<{ member_count: number }>).map((cluster) => cluster.member_count).sort())
      .toEqual([8, 8, 9]);
    const assigned = db.rpcCalls.find(([name]) => name === 'assign_post_semantic_clusters')?.[1].p_assignments as Row[];
    expect(assigned).toHaveLength(25);
    // The new post landed with the blob it was written into.
    const clusterOf = new Map(assigned.map((row) => [row.post_id, row.cluster_id]));
    expect(clusterOf.get(postId(99))).toBe(clusterOf.get(postId(1)));
  });

  it('puts a new post in its nearest cluster between hourly re-clusterings', async () => {
    const db = fakeDb({
      clusters: [
        { cluster_id: 4, embedding_model: 'gte-small', centroid: JSON.stringify(vector(0, 0)), member_count: 10, updated_at: '2026-10-01T11:40:00.000Z' },
        { cluster_id: 9, embedding_model: 'gte-small', centroid: JSON.stringify(vector(100, 0)), member_count: 10, updated_at: '2026-10-01T11:40:00.000Z' },
      ],
      pending: [postId(7)],
    });
    const embed = embedPost(db, { vectors: new Map([[postId(7), vector(100)]]) });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embed.fetchImpl });

    expect(summary.clustering).toEqual({ status: 'assigned_to_existing', embeddings: 1, clusters: 2, assigned: 1 });
    expect(db.rpcCalls.map(([name]) => name)).not.toContain('replace_feed_semantic_clusters');
    expect(db.rpcCalls.find(([name]) => name === 'assign_post_semantic_clusters')?.[1]).toEqual({
      p_assignments: [{ post_id: postId(7), cluster_id: 9 }],
    });
  });

  it('waits for 20 embeddings before clustering anything', async () => {
    const db = fakeDb({ pending: [postId(1), postId(2)] });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embedPost(db).fetchImpl });

    expect(summary.clustering).toEqual({ status: 'not_enough_embeddings', embeddings: 2, clusters: 0, assigned: 0 });
    expect(db.rpcCalls.map(([name]) => name)).not.toContain('replace_feed_semantic_clusters');
  });

  it('marks the newer post of a near-duplicate pair a duplicate of the older', async () => {
    const original = vector(5, 0);
    const db = fakeDb({
      embeddings: [embeddingRow(postId(1), original, '2026-09-01T00:00:00.000Z')],
      posts: [
        { id: postId(1), created_at: '2026-09-01T00:00:00.000Z' },
        { id: postId(2), created_at: '2026-10-01T11:00:00.000Z' },
        { id: postId(3), created_at: '2026-10-01T11:00:00.000Z' },
      ],
      pending: [postId(2), postId(3)],
    });
    const embed = embedPost(db, {
      vectors: new Map([
        [postId(2), original.map((value, index) => value + (index === 7 ? 0.05 : 0))],
        [postId(3), vector(200, 0)],
      ]),
    });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embed.fetchImpl });

    expect(summary.nearDuplicates).toEqual({ checked: 2, marked: 1, cleared: 0, matchFailures: 0 });
    const matchCall = db.rpcCalls.find(([name]) => name === 'match_post_content_embeddings')?.[1];
    expect(matchCall).toMatchObject({ p_embedding_model: 'gte-small', p_match_threshold: 0.95, p_limit: 5 });
    expect(matchCall?.p_query_embedding).toHaveLength(384);
    const marked = db.rpcCalls.find(([name]) => name === 'mark_post_near_duplicates')?.[1];
    expect(marked).toEqual({
      p_duplicates: [{ post_id: postId(2), canonical_post_id: postId(1), similarity: expect.any(Number) }],
    });
    expect((marked?.p_duplicates as Array<{ similarity: number }>)[0].similarity).toBeGreaterThanOrEqual(0.95);
  });
});

describe('runFeedEmbeddingJob near-duplicate clearing', () => {
  it('clears the mark of a re-embedded duplicate that no longer matches anything', async () => {
    const db = fakeDb({
      embeddings: [
        embeddingRow(postId(1), vector(5, 0), '2026-09-01T00:00:00.000Z'),
        // Marked a duplicate of post 1 before its edit.
        embeddingRow(postId(2), vector(5, 0), '2026-09-02T00:00:00.000Z', postId(1)),
      ],
      posts: [{ id: postId(1), created_at: '2026-09-01T00:00:00.000Z' }, { id: postId(2), created_at: '2026-09-02T00:00:00.000Z' }],
      pending: [postId(2)],
    });
    // The edited text embeds far from post 1; the re-embed keeps the stored mark.
    const embed = embedPost(db, { vectors: new Map([[postId(2), vector(250, 0)]]) });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: embed.fetchImpl });

    expect(summary.nearDuplicates).toEqual({ checked: 1, marked: 0, cleared: 1, matchFailures: 0 });
    expect(db.rpcCalls.find(([name]) => name === 'mark_post_near_duplicates')?.[1]).toEqual({
      p_duplicates: [{ post_id: postId(2), canonical_post_id: null, similarity: null }],
    });
  });
});

describe('runFeedEmbeddingJob text-empty posts', () => {
  it('pairs no post whose row turned text-empty after its vector was read', async () => {
    const original = vector(5, 0);
    // Post 2's vector was read as fresh, then an edit emptied its text: the
    // row the pairing reads says so (the stand-in keeps the vector to
    // reproduce that moment).
    const emptied = { ...embeddingRow(postId(2), original, '2026-10-01T11:59:00.000Z'), text_empty: true };
    const db = fakeDb({
      embeddings: [embeddingRow(postId(1), original, '2026-09-01T00:00:00.000Z'), emptied],
      posts: [{ id: postId(1), created_at: '2026-09-01T00:00:00.000Z' }, { id: postId(2), created_at: '2026-10-01T11:00:00.000Z' }],
    });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: vi.fn() });

    expect(summary.nearDuplicates).toEqual({ checked: 1, marked: 0, cleared: 0, matchFailures: 0 });
    expect(db.rpcCalls.map(([name]) => name)).not.toContain('mark_post_near_duplicates');
  });
});

describe('runFeedEmbeddingJob orphaned near-duplicates', () => {
  it('releases a duplicate whose canonical left the feed, re-embedded or not', async () => {
    const db = fakeDb({
      embeddings: [
        embeddingRow(postId(1), vector(5, 0), '2026-09-01T00:00:00.000Z'),
        embeddingRow(postId(2), vector(5, 0), '2026-09-02T00:00:00.000Z', postId(1)),
        embeddingRow(postId(3), vector(9, 0), '2026-09-01T00:00:00.000Z'),
        embeddingRow(postId(4), vector(9, 0), '2026-09-02T00:00:00.000Z', postId(3)),
      ],
      posts: [
        // Archived since post 2 was marked a duplicate of it.
        { id: postId(1), created_at: '2026-09-01T00:00:00.000Z', archived_at: '2026-10-01T10:00:00.000Z' },
        { id: postId(2), created_at: '2026-09-02T00:00:00.000Z' },
        { id: postId(3), created_at: '2026-09-01T00:00:00.000Z' },
        { id: postId(4), created_at: '2026-09-02T00:00:00.000Z' },
      ],
      runs: [{ job_name: 'feed-embeddings', status: 'succeeded', started_at: '2026-10-01T11:50:00.000Z' }],
    });

    const summary = await runFeedEmbeddingJob(db.client, { now: NOW, env: ENV, fetchImpl: vi.fn() });

    expect(summary.orphanedMarksCleared).toBe(1);
    expect(db.rpcCalls.filter(([name]) => name === 'clear_orphaned_near_duplicate_marks')).toHaveLength(1);
    expect(db.tables.post_content_embeddings.map((row) => [row.post_id, row.canonical_post_id])).toEqual([
      [postId(1), null],
      [postId(2), null],
      [postId(3), null],
      [postId(4), postId(3)],
    ]);
  });

  it('fails the run when the pass cannot run', async () => {
    const db = fakeDb();
    const rpc = db.client.rpc.bind(db.client);
    const client = {
      from: db.client.from,
      rpc: (name: string, args: Row) => (name === 'clear_orphaned_near_duplicate_marks'
        ? Promise.resolve({ data: null, error: { message: 'permission denied' } })
        : rpc(name, args)),
    } as unknown as SupabaseClient;

    await expect(runFeedEmbeddingJob(client, { now: NOW, env: ENV, fetchImpl: vi.fn() }))
      .rejects.toThrow('Feed embeddings RPC clear_orphaned_near_duplicate_marks failed: permission denied');
  });
});

describe('hasFeedEmbeddingWork', () => {
  it('has work while posts wait for an embedding', async () => {
    const db = fakeDb({ pending: [postId(1)] });

    await expect(hasFeedEmbeddingWork(db.client, { now: NOW })).resolves.toBe(true);
    expect(db.rpcCalls).toEqual([['list_posts_pending_embedding', { p_limit: 1 }]]);
  });

  it('has work for an embedding written since the last succeeded run, the publish hook\'s included', async () => {
    const runs = [
      { job_name: 'feed-embeddings', status: 'succeeded', started_at: '2026-10-01T11:50:00.000Z' },
      { job_name: 'feed-embeddings', status: 'failed', started_at: '2026-10-01T11:59:00.000Z' },
    ];

    await expect(hasFeedEmbeddingWork(fakeDb({
      runs,
      embeddings: [embeddingRow(postId(1), vector(0), '2026-10-01T11:55:00.000Z')],
    }).client, { now: NOW })).resolves.toBe(true);
    // Within the two-minute overlap before the last run started: still fresh.
    await expect(hasFeedEmbeddingWork(fakeDb({
      runs,
      embeddings: [embeddingRow(postId(1), vector(0), '2026-10-01T11:49:00.000Z')],
    }).client, { now: NOW })).resolves.toBe(true);
    await expect(hasFeedEmbeddingWork(fakeDb({
      runs,
      embeddings: [embeddingRow(postId(1), vector(0), '2026-10-01T11:40:00.000Z')],
    }).client, { now: NOW })).resolves.toBe(false);
  });

  it('has no work for a fresh row without a vector: a text-empty post is never clustered or matched', async () => {
    await expect(hasFeedEmbeddingWork(fakeDb({
      embeddings: [embeddingRow(postId(1), null, '2026-10-01T11:55:00.000Z')],
    }).client, { now: NOW })).resolves.toBe(false);
  });

  it('looks back a day when the job has never succeeded', async () => {
    await expect(hasFeedEmbeddingWork(fakeDb({
      embeddings: [embeddingRow(postId(1), vector(0), '2026-09-30T13:00:00.000Z')],
    }).client, { now: NOW })).resolves.toBe(true);
    await expect(hasFeedEmbeddingWork(fakeDb({
      embeddings: [embeddingRow(postId(1), vector(0), '2026-09-30T11:00:00.000Z')],
    }).client, { now: NOW })).resolves.toBe(false);
  });
});
