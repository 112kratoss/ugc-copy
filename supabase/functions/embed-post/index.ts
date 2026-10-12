// embed-post: gte-small text embeddings of posts for the feed's semantic
// retrieval (docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md §2.11).
//
//   POST { "postIds": ["<uuid>", ...] }            1 to 25 ids
//   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//   200 { "embedded": n, "skipped": n, "skipped_empty": ["<uuid>", ...],
//         "deferred": ["<uuid>", ...], "failed": [{ "postId": "<uuid>", "error": "..." }] }
//
// verify_jwt is off for this function (supabase/config.toml), so the bearer
// check below, in constant time, is the only gate. Each post's title,
// description, body, prompt, tool and category become one text of at most
// 2,000 characters; a post whose stored content_hash (sha256 of that text)
// already matches is skipped, and the rest are embedded here with Supabase.ai's
// gte-small (384 dimensions, mean-pooled, normalised) and upserted into
// post_content_embeddings. The upsert names only its own columns, so a stored
// cluster or near-duplicate mark survives a re-embed. post_content_embeddings
// .updated_at is set to the posts.updated_at of the text that was read: the
// feed-embeddings job re-embeds a post whose posts.updated_at is newer, so an
// edit made while this function runs is never mistaken for embedded, and a
// skip (text unchanged, counters or flags edited) stamps it too, or the post
// would be listed again on every run.
//
// A post with no title, description, body or prompt is not embedded: its text
// would be only the tool and category lines, the same for every untitled post
// of a kind, and those would all pair as near-duplicates of the oldest. Its
// row is written with text_empty and no vector, which the readers skip and
// the job's pending list counts as checked; it is reported under
// skipped_empty. gte-small runs on this isolate's CPU, which Supabase bounds
// per request, so no post is started once 1.2 s have passed since the first
// one was: the rest come back untouched under deferred, still pending, for
// the next run.
//
// No imports: posts and embeddings go through PostgREST with the service-role
// key, so src/__tests__/embed-post-function.test.ts can load this module under
// Node with stand-ins for Deno, Supabase.ai and fetch. The key and the post
// text are never logged or echoed.

export const EMBEDDING_MODEL = 'gte-small';
export const EMBEDDING_DIMENSIONS = 384;
export const MAX_POST_IDS = 25;
export const MAX_EMBEDDING_TEXT_CHARS = 2_000;
/** No post is started once this much time has passed since the first one was. */
export const EMBEDDING_TIME_BUDGET_MS = 1_200;

const MAX_REQUEST_BYTES = 16 * 1024;
const POSTGREST_TIMEOUT_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POST_COLUMNS = 'id,title,description,prompt,body,category,source_tool_slug,post_format,updated_at';

export type EmbedPostRow = {
  id: string;
  title: string | null;
  description: string | null;
  prompt: string | null;
  body: string | null;
  category: string | null;
  source_tool_slug: string | null;
  post_format: string | null;
  updated_at: string;
};

export type StoredEmbedding = {
  post_id: string;
  embedding_model: string;
  content_hash: string;
  text_empty: boolean;
};

/** Every row carries the same keys: PostgREST's bulk upsert requires it. */
export type EmbeddingUpsertRow = {
  post_id: string;
  embedding_model: string;
  embedding_dimensions: number;
  content_hash: string;
  /** pgvector text, or null for a post with nothing to embed. */
  embedding: string | null;
  text_empty: boolean;
  embedded_at: string;
  updated_at: string;
};

export type EmbedPostStore = {
  loadPosts(postIds: string[]): Promise<EmbedPostRow[]>;
  loadStoredEmbeddings(postIds: string[]): Promise<StoredEmbedding[]>;
  upsertEmbeddings(rows: EmbeddingUpsertRow[]): Promise<void>;
  markChecked(postId: string, updatedAt: string): Promise<void>;
};

export type EmbedPostFailure = { postId: string; error: string };

export type EmbedPostResult = {
  embedded: number;
  skipped: number;
  /** Posts with no title, description, body or prompt: recorded without a vector. */
  skipped_empty: string[];
  /** Posts not started within the time budget: untouched, still pending. */
  deferred: string[];
  failed: EmbedPostFailure[];
};

export type EmbedPostDependencies = {
  serviceRoleKey: string | null;
  store: EmbedPostStore | null;
  embed: (text: string) => Promise<ArrayLike<number>>;
  now?: () => Date;
  /** Milliseconds, for the time budget; performance.now by default. */
  clock?: () => number;
};

type AiSession = {
  run(input: string, options: { mean_pool: boolean; normalize: boolean }): Promise<unknown>;
};

type SupabaseRuntime = {
  ai: { Session: new (model: string) => AiSession };
};

type DenoRuntime = {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Compares two secrets in constant time: both are hashed to fixed-length
 * SHA-256 digests, and every byte of the digests is compared, so neither the
 * length nor any prefix of the configured value leaks through timing.
 */
export async function safeEqual(left: string | null, right: string | null): Promise<boolean> {
  if (!left || !right) return false;

  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);

  let result = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    result |= leftBytes[index] ^ rightBytes[index];
  }
  return result === 0;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function presentText(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

/**
 * Whether the post has words of its own to embed: a title, description, body
 * or prompt. The tool and category lines alone describe a kind of post, not
 * this one.
 */
export function hasEmbeddableText(post: EmbedPostRow): boolean {
  return [post.title, post.description, post.body, post.prompt].some((value) => presentText(value) !== null);
}

/**
 * title, description, body, prompt, "tool: <slug>", "category: <category>",
 * empty parts dropped, joined by newlines, cut to 2,000 characters (code
 * points, so a surrogate pair is never split).
 */
export function buildEmbeddingText(post: EmbedPostRow): string {
  const tool = presentText(post.source_tool_slug);
  const category = presentText(post.category);
  const text = [
    presentText(post.title),
    presentText(post.description),
    presentText(post.body),
    presentText(post.prompt),
    tool ? `tool: ${tool}` : null,
    category ? `category: ${category}` : null,
  ].filter(Boolean).join('\n');
  const characters = Array.from(text);
  return characters.length > MAX_EMBEDDING_TEXT_CHARS
    ? characters.slice(0, MAX_EMBEDDING_TEXT_CHARS).join('')
    : text;
}

/** The request's ids, de-duplicated in order, or why they were refused. */
export function parsePostIds(payload: unknown): { ok: true; postIds: string[] } | { ok: false; error: string } {
  const postIds = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { postIds?: unknown }).postIds
    : undefined;
  if (!Array.isArray(postIds) || postIds.length < 1 || postIds.length > MAX_POST_IDS) {
    return { ok: false, error: `postIds must be an array of 1 to ${MAX_POST_IDS} post ids` };
  }
  if (!postIds.every((postId) => typeof postId === 'string' && UUID_PATTERN.test(postId))) {
    return { ok: false, error: 'postIds must be post UUIDs' };
  }
  return { ok: true, postIds: Array.from(new Set(postIds.map((postId: string) => postId.toLowerCase()))) };
}

/** pgvector's text form, which PostgREST hands to the vector column as is. */
export function toVectorLiteral(values: ArrayLike<number>): string | null {
  const numbers = Array.from(values, Number);
  if (numbers.length !== EMBEDDING_DIMENSIONS || !numbers.every(Number.isFinite)) return null;
  return `[${numbers.join(',')}]`;
}

async function readBoundedBody(request: Request): Promise<string | null> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return null;
  const body = await request.text();
  return new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES ? null : body;
}

export function createEmbedPostHandler(dependencies: EmbedPostDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const clock = dependencies.clock ?? (() => performance.now());

  return async function handleEmbedPost(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const serviceRoleKey = dependencies.serviceRoleKey?.trim() || null;
    if (!serviceRoleKey) {
      return jsonResponse({ error: 'Service role key is not configured' }, 500);
    }

    if (!await safeEqual(request.headers.get('authorization'), `Bearer ${serviceRoleKey}`)) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const store = dependencies.store;
    if (!store) {
      return jsonResponse({ error: 'Supabase URL is not configured' }, 500);
    }

    const body = await readBoundedBody(request);
    if (body === null) {
      return jsonResponse({ error: 'Request body is too large' }, 413);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse({ error: 'Invalid JSON payload' }, 400);
    }

    const parsed = parsePostIds(payload);
    if (!parsed.ok) {
      return jsonResponse({ error: parsed.error }, 400);
    }

    let posts: EmbedPostRow[];
    let stored: StoredEmbedding[];
    try {
      [posts, stored] = await Promise.all([
        store.loadPosts(parsed.postIds),
        store.loadStoredEmbeddings(parsed.postIds),
      ]);
    } catch {
      return jsonResponse({ error: 'Failed to read posts' }, 502);
    }

    const postsById = new Map(posts.map((post) => [post.id.toLowerCase(), post]));
    const storedById = new Map(stored.map((row) => [row.post_id.toLowerCase(), row]));
    const result: EmbedPostResult = { embedded: 0, skipped: 0, skipped_empty: [], deferred: [], failed: [] };
    const upserts: EmbeddingUpsertRow[] = [];
    const textEmptyIds = new Set<string>();

    // One at a time: gte-small runs on this isolate's CPU, so parallel runs
    // would only contend for it. That CPU is bounded per request, so past the
    // budget no further post is started (the first always is, so every
    // request makes progress).
    const startedAt = clock();
    for (let index = 0; index < parsed.postIds.length; index += 1) {
      const postId = parsed.postIds[index];
      if (index > 0 && clock() - startedAt > EMBEDDING_TIME_BUDGET_MS) {
        result.deferred = parsed.postIds.slice(index);
        break;
      }

      const post = postsById.get(postId);
      if (!post) {
        result.failed.push({ postId, error: 'Post not found' });
        continue;
      }

      const text = buildEmbeddingText(post);
      const textEmpty = !hasEmbeddableText(post);
      const contentHash = await sha256Hex(text);
      const existing = storedById.get(postId);
      if (
        existing
        && existing.embedding_model === EMBEDDING_MODEL
        && existing.content_hash === contentHash
        && (existing.text_empty === true) === textEmpty
      ) {
        try {
          await store.markChecked(postId, post.updated_at);
          if (textEmpty) textEmptyIds.add(postId);
          else result.skipped += 1;
        } catch {
          result.failed.push({ postId, error: 'Failed to record the unchanged text' });
        }
        continue;
      }

      // Nothing of its own to embed: a row without a vector records the
      // check, so the post is not listed again until it changes.
      if (textEmpty) {
        upserts.push({
          post_id: postId,
          embedding_model: EMBEDDING_MODEL,
          embedding_dimensions: EMBEDDING_DIMENSIONS,
          content_hash: contentHash,
          embedding: null,
          text_empty: true,
          embedded_at: now().toISOString(),
          updated_at: post.updated_at,
        });
        continue;
      }

      let embedding: string | null = null;
      try {
        embedding = toVectorLiteral(await dependencies.embed(text));
      } catch {
        embedding = null;
      }
      if (!embedding) {
        result.failed.push({ postId, error: 'Embedding failed' });
        continue;
      }

      upserts.push({
        post_id: postId,
        embedding_model: EMBEDDING_MODEL,
        embedding_dimensions: EMBEDDING_DIMENSIONS,
        content_hash: contentHash,
        embedding,
        text_empty: false,
        embedded_at: now().toISOString(),
        updated_at: post.updated_at,
      });
    }

    if (upserts.length > 0) {
      try {
        await store.upsertEmbeddings(upserts);
        for (const row of upserts) {
          if (row.text_empty) textEmptyIds.add(row.post_id);
          else result.embedded += 1;
        }
      } catch {
        for (const row of upserts) {
          result.failed.push({ postId: row.post_id, error: 'Failed to store the embedding' });
        }
      }
    }
    result.skipped_empty = parsed.postIds.filter((postId) => textEmptyIds.has(postId));

    return jsonResponse(result, 200);
  };
}

/** The service-role client: PostgREST over fetch, authorised with the key. */
export function createPostgrestStore(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetch: typeof fetch;
}): EmbedPostStore {
  const restUrl = `${input.supabaseUrl.replace(/\/+$/, '')}/rest/v1`;
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
  };

  async function request(path: string, init: RequestInit): Promise<Response> {
    const response = await input.fetch(`${restUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(POSTGREST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`PostgREST responded ${response.status}`);
    }
    return response;
  }

  const idList = (postIds: string[]) => `in.(${postIds.join(',')})`;

  return {
    async loadPosts(postIds) {
      const query = new URLSearchParams({ select: POST_COLUMNS, id: idList(postIds) });
      const response = await request(`/posts?${query}`, { method: 'GET', headers: { Accept: 'application/json' } });
      return await response.json() as EmbedPostRow[];
    },
    async loadStoredEmbeddings(postIds) {
      const query = new URLSearchParams({
        select: 'post_id,embedding_model,content_hash,text_empty',
        post_id: idList(postIds),
      });
      const response = await request(`/post_content_embeddings?${query}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      return await response.json() as StoredEmbedding[];
    },
    async upsertEmbeddings(rows) {
      await request('/post_content_embeddings?on_conflict=post_id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      });
    },
    async markChecked(postId, updatedAt) {
      // Only ever forward: a stamp newer than this read is left alone.
      const query = new URLSearchParams({
        post_id: `eq.${postId}`,
        embedding_model: `eq.${EMBEDDING_MODEL}`,
        updated_at: `lt.${updatedAt}`,
      });
      await request(`/post_content_embeddings?${query}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ updated_at: updatedAt }),
      });
    },
  };
}

/** gte-small through Supabase.ai, one session per isolate, created on first use. */
export function createSupabaseAiEmbedder(runtime: SupabaseRuntime) {
  let session: AiSession | null = null;
  return async (text: string): Promise<ArrayLike<number>> => {
    session ??= new runtime.ai.Session(EMBEDDING_MODEL);
    return await session.run(text, { mean_pool: true, normalize: true }) as ArrayLike<number>;
  };
}

async function embeddingRuntimeMissing(): Promise<ArrayLike<number>> {
  throw new Error('Supabase.ai is not available in this runtime');
}

// Under the edge runtime only: Node (the unit tests) has no Deno global, and a
// test that wants the real wiring installs stand-ins before importing.
const runtimeGlobals = globalThis as unknown as { Deno?: DenoRuntime; Supabase?: SupabaseRuntime };
const deno = runtimeGlobals.Deno;

if (deno && typeof deno.serve === 'function') {
  const serviceRoleKey = deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() || null;
  const supabaseUrl = deno.env.get('SUPABASE_URL')?.trim() || null;
  const supabase = runtimeGlobals.Supabase;
  deno.serve(createEmbedPostHandler({
    serviceRoleKey,
    store: serviceRoleKey && supabaseUrl
      ? createPostgrestStore({ supabaseUrl, serviceRoleKey, fetch })
      : null,
    embed: supabase ? createSupabaseAiEmbedder(supabase) : embeddingRuntimeMissing,
  }));
}
