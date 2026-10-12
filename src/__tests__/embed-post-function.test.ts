import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  buildEmbeddingText,
  createEmbedPostHandler,
  createPostgrestStore,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_TIME_BUDGET_MS,
  hasEmbeddableText,
  MAX_EMBEDDING_TEXT_CHARS,
  MAX_POST_IDS,
  parsePostIds,
  safeEqual,
  sha256Hex,
  toVectorLiteral,
  type EmbedPostRow,
  type EmbedPostStore,
  type EmbeddingUpsertRow,
  createPostgrestAuthorizer,
  type StoredEmbedding,} from '../../supabase/functions/embed-post/index';

// supabase/functions/embed-post (docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md
// §2.11). The module has no imports, so it loads under Node: the handler is
// exercised with an in-memory store and embedder, and the Deno wiring with
// stand-ins for Deno.serve, Supabase.ai and fetch.

const functionPath = path.resolve(process.cwd(), 'supabase/functions/embed-post/index.ts');
const functionSource = fs.readFileSync(functionPath, 'utf8');
const config = fs.readFileSync(path.resolve(process.cwd(), 'supabase/config.toml'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/production-release.yml'), 'utf8');

const SERVICE_ROLE_KEY = 'service-role-key-for-tests';
const AUTHORIZATION = `Bearer ${SERVICE_ROLE_KEY}`;
const NOW = new Date('2026-10-12T06:00:00.000Z');

function postId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function post(index: number, overrides: Partial<EmbedPostRow> = {}): EmbedPostRow {
  return {
    id: postId(index),
    title: `Title ${index}`,
    description: `Description ${index}`,
    prompt: `Prompt ${index}`,
    body: null,
    category: 'image',
    source_tool_slug: 'kling',
    post_format: 'media',
    updated_at: `2026-10-11T0${index % 10}:00:00.000+00:00`,
    ...overrides,
  };
}

function unitVector(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === 0 ? 1 : 0));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

class MemoryStore implements EmbedPostStore {
  upserts: EmbeddingUpsertRow[][] = [];
  checked: Array<{ postId: string; updatedAt: string }> = [];
  loadPostsCalls: string[][] = [];
  failReads = false;
  failUpsert = false;

  constructor(public posts: EmbedPostRow[], public stored: StoredEmbedding[] = []) {}

  async loadPosts(postIds: string[]) {
    this.loadPostsCalls.push(postIds);
    if (this.failReads) throw new Error('read failed with a detail that must not leak');
    return this.posts.filter((row) => postIds.includes(row.id));
  }

  async loadStoredEmbeddings(postIds: string[]) {
    if (this.failReads) throw new Error('read failed');
    return this.stored.filter((row) => postIds.includes(row.post_id));
  }

  async upsertEmbeddings(rows: EmbeddingUpsertRow[]) {
    if (this.failUpsert) throw new Error('upsert failed');
    this.upserts.push(rows);
  }

  async markChecked(id: string, updatedAt: string) {
    this.checked.push({ postId: id, updatedAt });
  }
}

function request(body: unknown, authorization: string | null = AUTHORIZATION, method = 'POST'): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (authorization !== null) headers.set('Authorization', authorization);
  return new Request('https://project.supabase.co/functions/v1/embed-post', {
    method,
    headers,
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

type Embed = (text: string) => Promise<ArrayLike<number>>;

function handlerFor(
  store: MemoryStore | null,
  embed: Mock<Embed> = vi.fn<Embed>(async () => unitVector()),
  serviceRoleKey: string | null = SERVICE_ROLE_KEY,
  clock: () => number = () => 0,
) {
  return { handle: createEmbedPostHandler({ serviceRoleKey, store, embed, now: () => NOW, clock }), embed };
}

/** A post with nothing of its own to embed: only its tool and category. */
function untitled(index: number, overrides: Partial<EmbedPostRow> = {}): EmbedPostRow {
  return post(index, { title: null, description: '  ', prompt: '', body: null, source_tool_slug: 'magicbooklet', ...overrides });
}

const NOTHING_ELSE = { skipped_empty: [], deferred: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('embed-post authorisation', () => {
  it('refuses a request without the bearer header', async () => {
    const store = new MemoryStore([post(1)]);
    const { handle, embed } = handlerFor(store);
    const response = await handle(request({ postIds: [postId(1)] }, null));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(store.loadPostsCalls).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it.each([
    ['another key', 'Bearer not-the-service-role-key'],
    ['the key without the scheme', SERVICE_ROLE_KEY],
    ['a lower-case scheme', `bearer ${SERVICE_ROLE_KEY}`],
    ['the key with more after it', `${AUTHORIZATION}x`],
    ['a prefix of the key', `Bearer ${SERVICE_ROLE_KEY.slice(0, -1)}`],
  ])('refuses %s', async (_label, authorization) => {
    const store = new MemoryStore([post(1)]);
    const { handle } = handlerFor(store);
    const response = await handle(request({ postIds: [postId(1)] }, authorization));
    expect(response.status).toBe(401);
    expect(store.loadPostsCalls).toEqual([]);
  });

  it('accepts exactly "Bearer <service role key>"', async () => {
    const { handle } = handlerFor(new MemoryStore([post(1)]));
    expect((await handle(request({ postIds: [postId(1)] }))).status).toBe(200);
  });

  // The Edge runtime injects one spelling of the service-role credential and
  // Vercel holds another (legacy JWT vs secret key), so a bearer that is not
  // the runtime's own key is judged by what it can do, never by its shape.
  describe('a bearer that differs from the runtime key', () => {
    function capableHandler(authorize: Mock<(bearer: string) => Promise<boolean>> | undefined, store = new MemoryStore([post(1)])) {
      const embed = vi.fn<Embed>(async () => unitVector());
      return {
        handle: createEmbedPostHandler({ serviceRoleKey: SERVICE_ROLE_KEY, authorize, store, embed, now: () => NOW, clock: () => 0 }),
        store,
        embed,
      };
    }

    it('is accepted when the capability check passes, and is passed without the scheme', async () => {
      const authorize = vi.fn(async () => true);
      const { handle, store } = capableHandler(authorize);
      const response = await handle(request({ postIds: [postId(1)] }, 'Bearer sb_secret_other_spelling'));
      expect(response.status).toBe(200);
      expect(authorize).toHaveBeenCalledWith('sb_secret_other_spelling');
      expect(store.loadPostsCalls).toEqual([[postId(1)]]);
    });

    it('is refused when the capability check fails or throws', async () => {
      for (const authorize of [vi.fn(async () => false), vi.fn(async () => { throw new Error('probe failed'); })]) {
        const { handle, store } = capableHandler(authorize);
        const response = await handle(request({ postIds: [postId(1)] }, 'Bearer sb_secret_other_spelling'));
        expect(response.status).toBe(401);
        expect(store.loadPostsCalls).toEqual([]);
      }
    });

    it('is refused when no capability check is configured', async () => {
      const { handle } = capableHandler(undefined);
      expect((await handle(request({ postIds: [postId(1)] }, 'Bearer sb_secret_other_spelling'))).status).toBe(401);
    });

    it('never runs the capability check for the runtime key itself, nor for a header without the scheme', async () => {
      const authorize = vi.fn(async () => true);
      const { handle } = capableHandler(authorize);
      expect((await handle(request({ postIds: [postId(1)] }))).status).toBe(200);
      expect((await handle(request({ postIds: [postId(1)] }, SERVICE_ROLE_KEY))).status).toBe(401);
      expect((await handle(request({ postIds: [postId(1)] }, null))).status).toBe(401);
      expect(authorize).not.toHaveBeenCalled();
    });
  });

  describe('createPostgrestAuthorizer', () => {
    const supabaseUrl = 'https://project.supabase.co/';

    function fetchAnswering(status: number) {
      return vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(status === 200 ? '[]' : '{"message":"permission denied"}', { status }));
    }

    it('probes a service-role-only table with the presented credential as apikey and bearer', async () => {
      const fetchMock = fetchAnswering(200);
      const authorize = createPostgrestAuthorizer({ supabaseUrl, fetch: fetchMock as unknown as typeof fetch });
      expect(await authorize('sb_secret_other_spelling')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://project.supabase.co/rest/v1/feed_semantic_clusters?select=cluster_id&limit=1');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ apikey: 'sb_secret_other_spelling', Authorization: 'Bearer sb_secret_other_spelling', Accept: 'application/json' });
    });

    it.each([401, 403, 404, 500])('answers false to a %s', async (status) => {
      const authorize = createPostgrestAuthorizer({ supabaseUrl, fetch: fetchAnswering(status) as unknown as typeof fetch });
      expect(await authorize('sb_secret_other_spelling')).toBe(false);
    });

    it('answers false when the probe throws, and never probes an empty or absurdly long credential', async () => {
      const throwing = vi.fn(async () => { throw new Error('network'); });
      const authorize = createPostgrestAuthorizer({ supabaseUrl, fetch: throwing as unknown as typeof fetch });
      expect(await authorize('sb_secret_other_spelling')).toBe(false);
      expect(await authorize('')).toBe(false);
      expect(await authorize('x'.repeat(5000))).toBe(false);
      expect(throwing).toHaveBeenCalledTimes(1);
    });
  });

  it('fails closed when the key is not configured', async () => {
    const { handle } = handlerFor(new MemoryStore([post(1)]), undefined, null);
    const response = await handle(request({ postIds: [postId(1)] }, 'Bearer '));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Service role key is not configured' });
  });

  it('answers only POST', async () => {
    const { handle } = handlerFor(new MemoryStore([post(1)]));
    expect((await handle(request(undefined, AUTHORIZATION, 'GET'))).status).toBe(405);
  });

  it('compares in constant time through fixed-length digests', async () => {
    expect(await safeEqual('Bearer a', 'Bearer a')).toBe(true);
    expect(await safeEqual('Bearer a', 'Bearer b')).toBe(false);
    expect(await safeEqual('Bearer a', 'Bearer a ')).toBe(false);
    expect(await safeEqual(null, 'Bearer a')).toBe(false);
    expect(await safeEqual('Bearer a', null)).toBe(false);
    expect(await safeEqual('', '')).toBe(false);

    // Both sides hashed, every digest byte compared: no length check or early
    // exit reveals the key.
    expect(functionSource).toContain("crypto.subtle.digest('SHA-256', encoder.encode(left))");
    expect(functionSource).toContain("crypto.subtle.digest('SHA-256', encoder.encode(right))");
    expect(functionSource).toContain('result |= leftBytes[index] ^ rightBytes[index];');
    expect(functionSource).not.toContain('left.length !== right.length');
    expect(functionSource).not.toContain('charCodeAt');
    expect(functionSource).toContain("await safeEqual(authorization, `Bearer ${serviceRoleKey}`)");
    expect(functionSource).toContain('authorize: supabaseUrl ? createPostgrestAuthorizer({ supabaseUrl, fetch }) : undefined');
  });

  it('is deployed without the gateway JWT check, beside kie-webhook', () => {
    expect(config).toContain('[functions.embed-post]\nverify_jwt = false');
    expect(config).toContain('[functions.kie-webhook]\nverify_jwt = false');
    expect(releaseWorkflow).toContain(
      'supabase functions deploy kie-webhook \\\n            --project-ref "${SUPABASE_PROJECT_REF}" \\\n            --use-api\n'
        + '          supabase functions deploy embed-post \\\n            --project-ref "${SUPABASE_PROJECT_REF}" \\\n            --use-api\n',
    );
  });
});

describe('embed-post batch bounds', () => {
  it.each([
    ['no ids', { postIds: [] }],
    ['26 ids', { postIds: Array.from({ length: MAX_POST_IDS + 1 }, (_, index) => postId(index + 1)) }],
    ['no postIds', { ids: [postId(1)] }],
    ['a string', { postIds: postId(1) }],
    ['a non-UUID id', { postIds: [postId(1), 'not-a-uuid'] }],
    ['a number', { postIds: [1] }],
    ['an array body', [postId(1)]],
  ])('refuses %s with 400', async (_label, body) => {
    const store = new MemoryStore([post(1)]);
    const { handle, embed } = handlerFor(store);
    const response = await handle(request(body));
    expect(response.status).toBe(400);
    expect(store.loadPostsCalls).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON', async () => {
    const { handle } = handlerFor(new MemoryStore([post(1)]));
    const response = await handle(request('{"postIds": ['));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON payload' });
  });

  it('accepts 25 ids, and embeds a repeated id once', async () => {
    const posts = Array.from({ length: MAX_POST_IDS }, (_, index) => post(index + 1));
    const store = new MemoryStore(posts);
    const { handle, embed } = handlerFor(store);
    const ids = posts.map((row) => row.id);
    const response = await handle(request({ postIds: ids }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ embedded: 25, skipped: 0, failed: [], ...NOTHING_ELSE });
    expect(embed).toHaveBeenCalledTimes(25);

    const repeated = new MemoryStore([post(1)]);
    const second = handlerFor(repeated);
    expect(parsePostIds({ postIds: [postId(1), postId(1).toUpperCase()] })).toEqual({ ok: true, postIds: [postId(1)] });
    expect(await (await second.handle(request({ postIds: [postId(1), postId(1)] }))).json())
      .toEqual({ embedded: 1, skipped: 0, failed: [], ...NOTHING_ELSE });
    expect(second.embed).toHaveBeenCalledTimes(1);
  });
});

describe('embed-post text and hash', () => {
  it('joins title, description, body, prompt, tool and category, dropping empty parts', () => {
    expect(buildEmbeddingText(post(1, { body: '  ', description: null }))).toBe(
      'Title 1\nPrompt 1\ntool: kling\ncategory: image',
    );
    expect(buildEmbeddingText(post(2, { body: 'Body 2', source_tool_slug: null }))).toBe(
      'Title 2\nDescription 2\nBody 2\nPrompt 2\ncategory: image',
    );
  });

  it('cuts the text to 2,000 characters without splitting a character', () => {
    const long = buildEmbeddingText(post(1, { title: 'a'.repeat(1999) + '😀😀', description: null, prompt: null }));
    expect(Array.from(long)).toHaveLength(MAX_EMBEDDING_TEXT_CHARS);
    expect(long.endsWith('😀')).toBe(true);
  });

  it('hashes the text with sha256', async () => {
    const text = buildEmbeddingText(post(1));
    expect(await sha256Hex(text)).toBe(sha256(text));
  });

  it('skips a post whose stored hash matches, without embedding it, and records the check', async () => {
    const unchanged = post(1);
    const store = new MemoryStore([unchanged], [
      {
        post_id: unchanged.id,
        embedding_model: EMBEDDING_MODEL,
        content_hash: sha256(buildEmbeddingText(unchanged)),
        text_empty: false,
      },
    ]);
    const { handle, embed } = handlerFor(store);
    const response = await handle(request({ postIds: [unchanged.id] }));
    expect(await response.json()).toEqual({ embedded: 0, skipped: 1, failed: [], ...NOTHING_ELSE });
    expect(embed).not.toHaveBeenCalled();
    expect(store.upserts).toEqual([]);
    // The job lists a post whose posts.updated_at is newer than its row; the
    // skip stamps the version it read, or it would be listed on every run.
    expect(store.checked).toEqual([{ postId: unchanged.id, updatedAt: unchanged.updated_at }]);
  });

  it('re-embeds a post whose text changed or whose stored row is another model', async () => {
    const edited = post(1);
    const otherModel = post(2);
    const store = new MemoryStore([edited, otherModel], [
      { post_id: edited.id, embedding_model: EMBEDDING_MODEL, content_hash: sha256('the old text'), text_empty: false },
      {
        post_id: otherModel.id,
        embedding_model: 'text-embedding-3-small',
        content_hash: sha256(buildEmbeddingText(otherModel)),
        text_empty: false,
      },
    ]);
    const { handle, embed } = handlerFor(store);
    expect(await (await handle(request({ postIds: [edited.id, otherModel.id] }))).json())
      .toEqual({ embedded: 2, skipped: 0, failed: [], ...NOTHING_ELSE });
    expect(embed).toHaveBeenCalledTimes(2);
    expect(store.checked).toEqual([]);
  });
});

describe('embed-post upsert', () => {
  it('writes only its own columns, with the vector as 384 numbers and the read version as updated_at', async () => {
    const row = post(3, { body: 'Body 3' });
    const store = new MemoryStore([row]);
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index % 7) / 10 - 0.25);
    const { handle, embed } = handlerFor(store, vi.fn<Embed>(async () => Float32Array.from(vector)));
    await handle(request({ postIds: [row.id] }));

    const text = buildEmbeddingText(row);
    expect(embed).toHaveBeenCalledWith(text);
    expect(store.upserts).toHaveLength(1);
    const [upserted] = store.upserts[0];
    expect(Object.keys(upserted).sort()).toEqual([
      'content_hash',
      'embedded_at',
      'embedding',
      'embedding_dimensions',
      'embedding_model',
      'post_id',
      'text_empty',
      'updated_at',
    ]);
    expect(upserted).toMatchObject({
      post_id: row.id,
      embedding_model: 'gte-small',
      embedding_dimensions: 384,
      content_hash: sha256(text),
      text_empty: false,
      embedded_at: NOW.toISOString(),
      updated_at: row.updated_at,
    });
    expect(upserted).not.toHaveProperty('cluster_id');
    expect(upserted).not.toHaveProperty('canonical_post_id');
    const numbers = JSON.parse(String(upserted.embedding)) as number[];
    expect(numbers).toHaveLength(384);
    expect(numbers).toEqual(Array.from(Float32Array.from(vector)));
  });

  it('turns an embedding into pgvector text only at 384 finite numbers', () => {
    expect(toVectorLiteral(unitVector())).toBe(`[1,${Array(383).fill(0).join(',')}]`);
    expect(toVectorLiteral([1, 0, 0])).toBeNull();
    expect(toVectorLiteral([...unitVector().slice(1), Number.NaN])).toBeNull();
  });
});

describe('embed-post posts with no text of their own', () => {
  it('counts only a title, description, body or prompt as text to embed', () => {
    expect(hasEmbeddableText(untitled(1))).toBe(false);
    expect(hasEmbeddableText(untitled(1, { category: 'video', source_tool_slug: 'kling' }))).toBe(false);
    expect(hasEmbeddableText(untitled(1, { title: 'A cat' }))).toBe(true);
    expect(hasEmbeddableText(untitled(1, { prompt: ' a cat on a skateboard ' }))).toBe(true);
    expect(hasEmbeddableText(untitled(1, { body: 'Body' }))).toBe(true);
    expect(hasEmbeddableText(untitled(1, { description: 'Description' }))).toBe(true);
  });

  it('never embeds the tool and category lines alone: it records the post without a vector', async () => {
    // Every untitled image from the same tool has this one text, so their
    // embeddings would be identical and pair as near-duplicates of the oldest.
    const first = untitled(1);
    const second = untitled(2);
    expect(buildEmbeddingText(first)).toBe('tool: magicbooklet\ncategory: image');
    expect(buildEmbeddingText(second)).toBe(buildEmbeddingText(first));

    const titled = post(3);
    const store = new MemoryStore([first, titled, second]);
    const { handle, embed } = handlerFor(store);
    const response = await handle(request({ postIds: [first.id, titled.id, second.id] }));

    expect(await response.json()).toEqual({
      embedded: 1,
      skipped: 0,
      skipped_empty: [first.id, second.id],
      deferred: [],
      failed: [],
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(buildEmbeddingText(titled));
    expect(store.upserts).toHaveLength(1);
    const rows = new Map(store.upserts[0].map((row) => [row.post_id, row]));
    expect(rows.get(first.id)).toEqual({
      post_id: first.id,
      embedding_model: 'gte-small',
      embedding_dimensions: 384,
      content_hash: sha256('tool: magicbooklet\ncategory: image'),
      embedding: null,
      text_empty: true,
      embedded_at: NOW.toISOString(),
      updated_at: first.updated_at,
    });
    expect(rows.get(second.id)).toMatchObject({ embedding: null, text_empty: true });
    expect(rows.get(titled.id)).toMatchObject({ text_empty: false });
    expect(rows.get(titled.id)?.embedding).toEqual(expect.any(String));
    // One upsert of rows that all carry the same keys, as PostgREST requires.
    for (const row of store.upserts[0]) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(rows.get(titled.id) as EmbeddingUpsertRow).sort());
    }
  });

  it('skips an unchanged text-empty post by its hash, and still reports it', async () => {
    const empty = untitled(1);
    const store = new MemoryStore([empty], [{
      post_id: empty.id,
      embedding_model: EMBEDDING_MODEL,
      content_hash: sha256(buildEmbeddingText(empty)),
      text_empty: true,
    }]);
    const { handle, embed } = handlerFor(store);

    expect(await (await handle(request({ postIds: [empty.id] }))).json())
      .toEqual({ embedded: 0, skipped: 0, skipped_empty: [empty.id], deferred: [], failed: [] });
    expect(embed).not.toHaveBeenCalled();
    expect(store.upserts).toEqual([]);
    expect(store.checked).toEqual([{ postId: empty.id, updatedAt: empty.updated_at }]);
  });

  it('replaces a stored vector of the same lines with a text-empty row, and embeds a post once it has words', async () => {
    const emptied = untitled(1);
    const titledSince = untitled(2, { title: 'Now it has a title' });
    const store = new MemoryStore([emptied, titledSince], [
      // Same hash, but a vector: written before the rule, it must not stay.
      { post_id: emptied.id, embedding_model: EMBEDDING_MODEL, content_hash: sha256(buildEmbeddingText(emptied)), text_empty: false },
      { post_id: titledSince.id, embedding_model: EMBEDDING_MODEL, content_hash: sha256(buildEmbeddingText(untitled(2))), text_empty: true },
    ]);
    const { handle, embed } = handlerFor(store);

    expect(await (await handle(request({ postIds: [emptied.id, titledSince.id] }))).json())
      .toEqual({ embedded: 1, skipped: 0, skipped_empty: [emptied.id], deferred: [], failed: [] });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith('Now it has a title\ntool: magicbooklet\ncategory: image');
    expect(store.upserts[0].map((row) => [row.post_id, row.text_empty, row.embedding === null])).toEqual([
      [emptied.id, true, true],
      [titledSince.id, false, false],
    ]);
    expect(store.checked).toEqual([]);
  });

  it('fails a text-empty post whose row could not be written, instead of reporting it', async () => {
    const store = new MemoryStore([untitled(1)]);
    store.failUpsert = true;
    const { handle } = handlerFor(store);

    expect(await (await handle(request({ postIds: [postId(1)] }))).json()).toEqual({
      embedded: 0,
      skipped: 0,
      skipped_empty: [],
      deferred: [],
      failed: [{ postId: postId(1), error: 'Failed to store the embedding' }],
    });
  });
});

describe('embed-post time budget', () => {
  it('starts no post once 1.2 s have passed since the first, and leaves the rest untouched', async () => {
    const posts = Array.from({ length: 6 }, (_, index) => post(index + 1));
    const unchanged = posts[1];
    const store = new MemoryStore(posts, [{
      post_id: unchanged.id,
      embedding_model: EMBEDDING_MODEL,
      content_hash: sha256(buildEmbeddingText(unchanged)),
      text_empty: false,
    }]);
    let elapsed = 0;
    // Each inference takes 500 ms; a skip takes none.
    const embed = vi.fn<Embed>(async () => {
      elapsed += 500;
      return unitVector();
    });
    const { handle } = handlerFor(store, embed, SERVICE_ROLE_KEY, () => elapsed);

    const body = await (await handle(request({ postIds: posts.map((row) => row.id) }))).json();

    // 0 ms: post 1; 500: post 2 (a skip); 500: post 3; 1,000: post 4;
    // 1,500 > 1,200: posts 5 and 6 are not started.
    expect(EMBEDDING_TIME_BUDGET_MS).toBe(1_200);
    expect(body).toEqual({
      embedded: 3,
      skipped: 1,
      skipped_empty: [],
      deferred: [postId(5), postId(6)],
      failed: [],
    });
    expect(embed).toHaveBeenCalledTimes(3);
    expect(store.upserts[0].map((row) => row.post_id)).toEqual([postId(1), postId(3), postId(4)]);
    expect(store.checked.map((entry) => entry.postId)).toEqual([postId(2)]);
  });

  it('always starts the first post, so every request makes progress', async () => {
    const store = new MemoryStore([post(1), post(2)]);
    let calls = 0;
    // Already past the budget at the first check.
    const { handle, embed } = handlerFor(store, undefined, SERVICE_ROLE_KEY, () => (calls++ === 0 ? 0 : 10_000));

    expect(await (await handle(request({ postIds: [postId(1), postId(2)] }))).json())
      .toEqual({ embedded: 1, skipped: 0, skipped_empty: [], deferred: [postId(2)], failed: [] });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('measures the budget with performance.now in the edge runtime', () => {
    expect(functionSource).toContain('const clock = dependencies.clock ?? (() => performance.now());');
  });
});

describe('embed-post response', () => {
  it('reports embedded, skipped and failed posts, each failure by id', async () => {
    const good = post(1);
    const unchanged = post(2);
    const broken = post(3);
    const wrongWidth = post(4);
    const store = new MemoryStore([good, unchanged, broken, wrongWidth], [
      {
        post_id: unchanged.id,
        embedding_model: EMBEDDING_MODEL,
        content_hash: sha256(buildEmbeddingText(unchanged)),
        text_empty: false,
      },
    ]);
    const embed = vi.fn<Embed>(async (text: string) => {
      if (text.startsWith('Title 3')) throw new Error(`model failed on ${text}`);
      if (text.startsWith('Title 4')) return [1, 0, 0];
      return unitVector();
    });
    const { handle } = handlerFor(store, embed);
    const response = await handle(request({ postIds: [good.id, unchanged.id, broken.id, wrongWidth.id, postId(9)] }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = await response.json();
    expect(body).toEqual({
      embedded: 1,
      skipped: 1,
      skipped_empty: [],
      deferred: [],
      failed: [
        { postId: broken.id, error: 'Embedding failed' },
        { postId: wrongWidth.id, error: 'Embedding failed' },
        { postId: postId(9), error: 'Post not found' },
      ],
    });
    // The model's message, which quotes the text, never reaches the response.
    expect(JSON.stringify(body)).not.toContain('Title 3');
  });

  it('fails every post it embedded when the write fails', async () => {
    const store = new MemoryStore([post(1), post(2)]);
    store.failUpsert = true;
    const { handle } = handlerFor(store);
    expect(await (await handle(request({ postIds: [postId(1), postId(2)] }))).json()).toEqual({
      embedded: 0,
      skipped: 0,
      skipped_empty: [],
      deferred: [],
      failed: [
        { postId: postId(1), error: 'Failed to store the embedding' },
        { postId: postId(2), error: 'Failed to store the embedding' },
      ],
    });
  });

  it('answers 502 when the posts cannot be read, without the cause', async () => {
    const store = new MemoryStore([post(1)]);
    store.failReads = true;
    const { handle } = handlerFor(store);
    const response = await handle(request({ postIds: [postId(1)] }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Failed to read posts' });
  });

  it('answers 500 when it cannot reach the database', async () => {
    const { handle } = handlerFor(null);
    expect((await handle(request({ postIds: [postId(1)] }))).status).toBe(500);
  });
});

describe('embed-post PostgREST store', () => {
  it('reads and writes with the service-role key and upserts on post_id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const store = createPostgrestStore({
      supabaseUrl: 'https://project.supabase.co/',
      serviceRoleKey: SERVICE_ROLE_KEY,
      fetch: fetchStub as unknown as typeof fetch,
    });

    await store.loadPosts([postId(1), postId(2)]);
    await store.loadStoredEmbeddings([postId(1)]);
    await store.upsertEmbeddings([]);
    await store.markChecked(postId(1), '2026-10-11T01:00:00.000+00:00');

    const urls = calls.map((call) => new URL(call.url));
    expect(urls[0].pathname).toBe('/rest/v1/posts');
    expect(urls[0].searchParams.get('select')).toBe(
      'id,title,description,prompt,body,category,source_tool_slug,post_format,updated_at',
    );
    expect(urls[0].searchParams.get('id')).toBe(`in.(${postId(1)},${postId(2)})`);
    expect(urls[1].pathname).toBe('/rest/v1/post_content_embeddings');
    expect(urls[1].searchParams.get('select')).toBe('post_id,embedding_model,content_hash,text_empty');
    expect(urls[2].pathname).toBe('/rest/v1/post_content_embeddings');
    expect(urls[2].searchParams.get('on_conflict')).toBe('post_id');
    expect(calls[2].init.method).toBe('POST');
    expect((calls[2].init.headers as Record<string, string>).Prefer).toBe('resolution=merge-duplicates,return=minimal');
    // A skip only ever moves the stamp forward.
    expect(calls[3].init.method).toBe('PATCH');
    expect(urls[3].searchParams.get('post_id')).toBe(`eq.${postId(1)}`);
    expect(urls[3].searchParams.get('updated_at')).toBe('lt.2026-10-11T01:00:00.000+00:00');
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ updated_at: '2026-10-11T01:00:00.000+00:00' });
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers.apikey).toBe(SERVICE_ROLE_KEY);
      expect(headers.Authorization).toBe(AUTHORIZATION);
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('turns a PostgREST error into a failure without its body', async () => {
    const store = createPostgrestStore({
      supabaseUrl: 'https://project.supabase.co',
      serviceRoleKey: SERVICE_ROLE_KEY,
      fetch: (async () => new Response('{"message":"secret detail"}', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(store.loadPosts([postId(1)])).rejects.toThrow('PostgREST responded 500');
  });
});

describe('embed-post in the edge runtime', () => {
  it('serves through Deno.serve with gte-small, mean-pooled and normalised, and logs nothing', async () => {
    const consoleCalls = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const serve = vi.fn();
    const sessions: string[] = [];
    const run = vi.fn(async () => Float32Array.from(unitVector()));
    class Session {
      constructor(model: string) {
        sessions.push(model);
      }
      run = run;
    }
    const env: Record<string, string> = {
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      SUPABASE_URL: 'https://project.supabase.co',
    };
    const row = post(5);
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === '/rest/v1/posts') return new Response(JSON.stringify([row]), { status: 200 });
      if (target.pathname === '/rest/v1/post_content_embeddings' && (init?.method ?? 'GET') === 'GET') {
        return new Response('[]', { status: 200 });
      }
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal('Deno', { env: { get: (name: string) => env[name] }, serve });
    vi.stubGlobal('Supabase', { ai: { Session } });
    vi.stubGlobal('fetch', fetchStub);
    vi.resetModules();

    await import('../../supabase/functions/embed-post/index');
    expect(serve).toHaveBeenCalledTimes(1);
    const handler = serve.mock.calls[0][0] as (request: Request) => Promise<Response>;

    const first = await handler(request({ postIds: [row.id] }));
    expect(await first.json()).toEqual({ embedded: 1, skipped: 0, failed: [], ...NOTHING_ELSE });
    await handler(request({ postIds: [row.id] }));
    expect(sessions).toEqual(['gte-small']);
    expect(run).toHaveBeenCalledWith(buildEmbeddingText(row), { mean_pool: true, normalize: true });

    const write = fetchStub.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(write).toBeDefined();
    const [written] = JSON.parse(String(write?.[1]?.body)) as EmbeddingUpsertRow[];
    expect(written.post_id).toBe(row.id);
    expect(written.updated_at).toBe(row.updated_at);

    expect((await handler(request({ postIds: [row.id] }, 'Bearer wrong'))).status).toBe(401);
    for (const spy of consoleCalls) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(functionSource).not.toMatch(/console\./);
  });

  it('starts nothing under Node', async () => {
    vi.resetModules();
    const loaded = await import('../../supabase/functions/embed-post/index');
    expect(typeof loaded.createEmbedPostHandler).toBe('function');
    expect((globalThis as { Deno?: unknown }).Deno).toBeUndefined();
  });
});
