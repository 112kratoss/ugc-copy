import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  createEmbedPostHandler,
  createPostgrestSearchStore,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_TIME_BUDGET_MS,
  MAX_POST_IDS,
  MAX_QUERY_TEXT_CHARS,
  parseEmbedMode,
  parseQueryText,
  toEmbeddingArray,
  type EmbedPostStore,
  type SearchEmbeddingStore,
  type SearchEmbeddingStoreRow,
  type SearchEmbeddingText,
} from '../../supabase/functions/embed-post/index';

// embed-post's two search modes (20261112215420_search_semantic_related_posts.sql).
// The feed's request, with no "mode" key, is held byte for byte by
// embed-post-function.test.ts, which this change leaves untouched; this file
// holds what was added beside it: the mode switch, the search mode (public
// search text only, read through the database's own function) and the query
// mode (one vector, nothing read, stored or logged).

const functionSource = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/functions/embed-post/index.ts'),
  'utf8',
);

const SERVICE_ROLE_KEY = 'service-role-key-for-tests';
const AUTHORIZATION = `Bearer ${SERVICE_ROLE_KEY}`;

function postId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function unitVector(first = 1): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === 0 ? first : 0));
}

function searchText(index: number, overrides: Partial<SearchEmbeddingText> = {}): SearchEmbeddingText {
  const text = `public text of post ${index}`;
  return { post_id: postId(index), embedding_text: text, content_hash: sha256(text), unchanged: false, ...overrides };
}

/** The feed's store: any call to it from a search mode is a failure of this file. */
class UntouchedFeedStore implements EmbedPostStore {
  calls: string[] = [];
  async loadPosts() { this.calls.push('loadPosts'); return []; }
  async loadStoredEmbeddings() { this.calls.push('loadStoredEmbeddings'); return []; }
  async upsertEmbeddings() { this.calls.push('upsertEmbeddings'); }
  async markChecked() { this.calls.push('markChecked'); }
}

class MemorySearchStore implements SearchEmbeddingStore {
  loads: string[][] = [];
  stores: SearchEmbeddingStoreRow[][] = [];
  failReads = false;
  failStore = false;
  /** Posts whose text changed while they were embedded: the database keeps no vector for them. */
  changedMeanwhile = new Set<string>();

  constructor(public texts: SearchEmbeddingText[]) {}

  async loadSearchTexts(postIds: string[]) {
    this.loads.push(postIds);
    if (this.failReads) throw new Error('read failed with a detail that must not leak');
    return this.texts.filter((row) => postIds.includes(row.post_id));
  }

  async storeSearchEmbeddings(rows: SearchEmbeddingStoreRow[]) {
    if (this.failStore) throw new Error('store failed with a detail that must not leak');
    this.stores.push(rows);
    return rows.map((row) => row.post_id).filter((id) => !this.changedMeanwhile.has(id));
  }
}

function request(body: unknown, authorization: string | null = AUTHORIZATION): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (authorization !== null) headers.set('Authorization', authorization);
  return new Request('https://project.supabase.co/functions/v1/embed-post', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

type Embed = (text: string) => Promise<ArrayLike<number>>;

function handlerFor(
  searchStore: MemorySearchStore | null,
  embed: Mock<Embed> = vi.fn<Embed>(async () => unitVector()),
  clock: () => number = () => 0,
) {
  const store = new UntouchedFeedStore();
  return {
    handle: createEmbedPostHandler({ serviceRoleKey: SERVICE_ROLE_KEY, store, searchStore, embed, clock }),
    embed,
    store,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('embed-post mode switch', () => {
  it('reads a request with no mode key as the feed’s, and names the two others', () => {
    expect(parseEmbedMode({ postIds: [postId(1)] })).toBe('feed');
    expect(parseEmbedMode({ mode: 'search', postIds: [postId(1)] })).toBe('search');
    expect(parseEmbedMode({ mode: 'query', query: 'sea' })).toBe('query');
    // Whatever is not an object goes on to the feed's own refusals, as before.
    for (const payload of [null, 'text', 7, [postId(1)]]) expect(parseEmbedMode(payload)).toBe('feed');
  });

  it.each([
    ['another word', 'feed'],
    ['a different case', 'Search'],
    ['null', null],
    ['an empty string', ''],
    ['a number', 1],
    ['a list', ['search']],
  ])('refuses %s as a mode with a 400, before anything is read or embedded', async (_label, mode) => {
    expect(parseEmbedMode({ mode, postIds: [postId(1)] })).toBeNull();
    const searchStore = new MemorySearchStore([searchText(1)]);
    const { handle, embed, store } = handlerFor(searchStore);
    const response = await handle(request({ mode, postIds: [postId(1)], query: 'sea' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'mode must be search or query' });
    expect(embed).not.toHaveBeenCalled();
    expect(searchStore.loads).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it.each([
    ['search', { mode: 'search', postIds: [postId(1)] }],
    ['query', { mode: 'query', query: 'sea after sunset' }],
  ])('holds the %s mode to the same bearer check', async (_label, body) => {
    const searchStore = new MemorySearchStore([searchText(1)]);
    for (const authorization of [null, 'Bearer not-the-service-role-key', SERVICE_ROLE_KEY]) {
      const { handle, embed } = handlerFor(searchStore);
      const response = await handle(request(body, authorization));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
      expect(embed).not.toHaveBeenCalled();
    }
    expect(searchStore.loads).toEqual([]);
  });

  it('takes a credential that can do what the service role can, as the feed’s mode does', async () => {
    const authorize = vi.fn(async (bearer: string) => bearer === 'another-spelling-of-the-key');
    const handle = createEmbedPostHandler({
      serviceRoleKey: SERVICE_ROLE_KEY,
      authorize,
      store: new UntouchedFeedStore(),
      searchStore: new MemorySearchStore([]),
      embed: async () => unitVector(),
    });
    expect((await handle(request({ mode: 'query', query: 'sea' }, 'Bearer another-spelling-of-the-key'))).status).toBe(200);
    expect((await handle(request({ mode: 'query', query: 'sea' }, 'Bearer a-client-key'))).status).toBe(401);
  });
});

describe('embed-post query mode', () => {
  it('returns the query’s vector and reads or stores nothing', async () => {
    const searchStore = new MemorySearchStore([]);
    const embed = vi.fn<Embed>(async () => unitVector(0.1234567891));
    const { handle, store } = handlerFor(searchStore, embed);
    const response = await handle(request({ mode: 'query', query: '  Sea after   sunset ' }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['dimensions', 'embedding', 'mode', 'model']);
    expect(body).toMatchObject({ mode: 'query', model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS });
    expect(body.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    // Six decimals: half the bytes, and nothing a float4 column would have kept.
    expect((body.embedding as number[])[0]).toBe(0.123457);
    // Trimmed; what is between the words is the caller's.
    expect(embed).toHaveBeenCalledExactlyOnceWith('Sea after   sunset');
    expect(searchStore.loads).toEqual([]);
    expect(searchStore.stores).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it('cuts a long query to 200 characters, never through the middle of one', () => {
    expect(MAX_QUERY_TEXT_CHARS).toBe(200);
    const long = `${'a'.repeat(199)}😀😀 tail`;
    const cut = parseQueryText({ query: long });
    expect(Array.from(cut ?? '')).toHaveLength(200);
    expect(cut?.endsWith('😀')).toBe(true);
    expect(parseQueryText({ query: 'short' })).toBe('short');
  });

  it.each([
    ['no query', { mode: 'query' }],
    ['an empty one', { mode: 'query', query: '' }],
    ['only spaces', { mode: 'query', query: '   \n ' }],
    ['a number', { mode: 'query', query: 7 }],
    ['a list', { mode: 'query', query: ['sea'] }],
    ['post ids in its place', { mode: 'query', postIds: [postId(1)] }],
  ])('refuses %s with a 400', async (_label, body) => {
    const { handle, embed } = handlerFor(new MemorySearchStore([]));
    const response = await handle(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'query must be a non-empty string' });
    expect(embed).not.toHaveBeenCalled();
  });

  it.each([
    ['the embedder throws', async () => { throw new Error('model detail that must not leak'); }],
    ['the vector has another width', async () => [1, 0, 0]],
    ['the vector holds a NaN', async () => unitVector(Number.NaN)],
  ])('answers 502 when %s, with no detail', async (_label, failing) => {
    const { handle } = handlerFor(new MemorySearchStore([]), vi.fn<Embed>(failing as Embed));
    const response = await handle(request({ mode: 'query', query: 'sea' }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Embedding failed' });
  });

  it('never echoes or logs the query', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
    const secret = 'a query nobody else should read';
    const { handle } = handlerFor(new MemorySearchStore([]), vi.fn<Embed>(async () => { throw new Error(secret); }));
    const failed = await handle(request({ mode: 'query', query: secret }));
    expect(await failed.text()).not.toContain(secret);
    const { handle: handleOk } = handlerFor(new MemorySearchStore([]));
    const ok = await handleOk(request({ mode: 'query', query: secret }));
    expect(await ok.text()).not.toContain(secret);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(functionSource).not.toMatch(/console\./);
  });

  it('rounds a vector to six decimals and refuses one of another width', () => {
    expect(toEmbeddingArray(unitVector(0.0000004))?.[0]).toBe(0);
    expect(toEmbeddingArray(unitVector(-0.9999996))?.[0]).toBe(-1);
    expect(toEmbeddingArray([1, 2, 3])).toBeNull();
    expect(toEmbeddingArray(unitVector(Number.POSITIVE_INFINITY))).toBeNull();
  });
});

describe('embed-post search mode', () => {
  it('embeds the text the database hands it for each post, under the hash the database worked out', async () => {
    const texts = [searchText(1), searchText(2)];
    const searchStore = new MemorySearchStore(texts);
    const { handle, embed, store } = handlerFor(searchStore);
    const response = await handle(request({ mode: 'search', postIds: [postId(1), postId(2)] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: 'search', embedded: 2, skipped: 0, skipped_unsearchable: [], deferred: [], failed: [],
    });
    expect(searchStore.loads).toEqual([[postId(1), postId(2)]]);
    expect(embed.mock.calls.map(([text]) => text)).toEqual(texts.map((row) => row.embedding_text));
    expect(searchStore.stores).toEqual([[
      { post_id: postId(1), content_hash: texts[0].content_hash, embedding: `[${unitVector().join(',')}]` },
      { post_id: postId(2), content_hash: texts[1].content_hash, embedding: `[${unitVector().join(',')}]` },
    ]]);
    // Nothing of the feed's: no column of posts is read, no feed embedding written.
    expect(store.calls).toEqual([]);
  });

  it('reads no post itself: the only texts it can embed are the ones post_search_embedding_texts returns', () => {
    const searchMode = functionSource.slice(
      functionSource.indexOf('async function handleSearchEmbeddings('),
      functionSource.indexOf('export function createEmbedPostHandler('),
    );
    expect(searchMode.length).toBeGreaterThan(0);
    expect(searchMode).toContain('searchStore.loadSearchTexts(parsed.postIds)');
    expect(searchMode).toContain('dependencies.embed(text.embedding_text)');
    expect(searchMode).not.toMatch(/store\.loadPosts|buildEmbeddingText|\.prompt|\.body|\.title|\.description/);
    const searchStore = functionSource.slice(
      functionSource.indexOf('export function createPostgrestSearchStore('),
      functionSource.indexOf('/** gte-small through Supabase.ai'),
    );
    expect(searchStore).toContain("rpc('post_search_embedding_texts'");
    expect(searchStore).toContain("rpc('store_post_search_embeddings'");
    expect(searchStore).not.toMatch(/\/posts\?|post_content_embeddings|post_search_documents/);
  });

  it('skips a post whose vector is already of its text, and reports one search cannot return without failing it', async () => {
    const searchStore = new MemorySearchStore([searchText(1, { unchanged: true }), searchText(3)]);
    const { handle, embed } = handlerFor(searchStore);
    const response = await handle(request({ mode: 'search', postIds: [postId(1), postId(2), postId(3)] }));
    expect(await response.json()).toEqual({
      mode: 'search', embedded: 1, skipped: 1, skipped_unsearchable: [postId(2)], deferred: [], failed: [],
    });
    expect(embed).toHaveBeenCalledExactlyOnceWith(searchText(3).embedding_text);
    expect(searchStore.stores[0].map((row) => row.post_id)).toEqual([postId(3)]);
  });

  it('defers a post whose text changed while it was embedded: the database kept no vector for it', async () => {
    const searchStore = new MemorySearchStore([searchText(1), searchText(2)]);
    searchStore.changedMeanwhile.add(postId(2));
    const { handle } = handlerFor(searchStore);
    const response = await handle(request({ mode: 'search', postIds: [postId(1), postId(2)] }));
    expect(await response.json()).toEqual({
      mode: 'search', embedded: 1, skipped: 0, skipped_unsearchable: [], deferred: [postId(2)], failed: [],
    });
  });

  it('starts no post past the time budget and hands the rest back', async () => {
    const ids = [1, 2, 3, 4].map(postId);
    const searchStore = new MemorySearchStore([1, 2, 3, 4].map((index) => searchText(index)));
    let elapsed = 0;
    const embed = vi.fn<Embed>(async () => {
      elapsed += EMBEDDING_TIME_BUDGET_MS / 2 + 1;
      return unitVector();
    });
    const { handle } = handlerFor(searchStore, embed, () => elapsed);
    const response = await handle(request({ mode: 'search', postIds: ids }));
    expect(await response.json()).toEqual({
      mode: 'search', embedded: 2, skipped: 0, skipped_unsearchable: [], deferred: [ids[2], ids[3]], failed: [],
    });
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('fails one post without failing the batch, and says nothing of why', async () => {
    const searchStore = new MemorySearchStore([searchText(1), searchText(2), searchText(3)]);
    const embed = vi.fn<Embed>(async (text) => {
      if (text === searchText(2).embedding_text) throw new Error('model detail that must not leak');
      if (text === searchText(3).embedding_text) return [1, 0];
      return unitVector();
    });
    const { handle } = handlerFor(searchStore, embed);
    const response = await handle(request({ mode: 'search', postIds: [postId(1), postId(2), postId(3)] }));
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      mode: 'search',
      embedded: 1,
      skipped: 0,
      skipped_unsearchable: [],
      deferred: [],
      failed: [
        { postId: postId(2), error: 'Embedding failed' },
        { postId: postId(3), error: 'Embedding failed' },
      ],
    });
    expect(text).not.toContain('must not leak');
  });

  it('answers 502 when the texts cannot be read, and fails every embedded post when they cannot be stored', async () => {
    const unreadable = new MemorySearchStore([searchText(1)]);
    unreadable.failReads = true;
    const read = await handlerFor(unreadable).handle(request({ mode: 'search', postIds: [postId(1)] }));
    expect(read.status).toBe(502);
    expect(await read.json()).toEqual({ error: 'Failed to read posts' });

    const unstorable = new MemorySearchStore([searchText(1), searchText(2)]);
    unstorable.failStore = true;
    const stored = await handlerFor(unstorable).handle(request({ mode: 'search', postIds: [postId(1), postId(2)] }));
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({
      mode: 'search',
      embedded: 0,
      skipped: 0,
      skipped_unsearchable: [],
      deferred: [],
      failed: [
        { postId: postId(1), error: 'Failed to store the embedding' },
        { postId: postId(2), error: 'Failed to store the embedding' },
      ],
    });
  });

  it.each([
    ['no ids', { mode: 'search', postIds: [] }, `postIds must be an array of 1 to ${MAX_POST_IDS} post ids`],
    ['26 ids', { mode: 'search', postIds: Array.from({ length: MAX_POST_IDS + 1 }, (_, index) => postId(index + 1)) },
      `postIds must be an array of 1 to ${MAX_POST_IDS} post ids`],
    ['an id that is not one', { mode: 'search', postIds: ['not-a-uuid'] }, 'postIds must be post UUIDs'],
    ['a query in their place', { mode: 'search', query: 'sea' }, `postIds must be an array of 1 to ${MAX_POST_IDS} post ids`],
  ])('holds the batch to the feed’s bounds: %s', async (_label, body, error) => {
    const searchStore = new MemorySearchStore([]);
    const { handle, embed } = handlerFor(searchStore);
    const response = await handle(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(searchStore.loads).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('answers 500 without its store, as the feed’s mode does without its own', async () => {
    const { handle } = handlerFor(null);
    const response = await handle(request({ mode: 'search', postIds: [postId(1)] }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Supabase URL is not configured' });
  });
});

describe('embed-post search store', () => {
  it('calls the two database functions with the service key and nothing else', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/rpc/post_search_embedding_texts')) {
        return Response.json([
          { post_id: postId(1), embedding_text: 'public text', content_hash: sha256('public text'), unchanged: false },
          // A row that is not one is dropped, never embedded.
          { post_id: postId(2), embedding_text: null, content_hash: 'x', unchanged: false },
        ]);
      }
      if (target.endsWith('/rpc/store_post_search_embeddings')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          p_rows: [{ post_id: postId(1), content_hash: sha256('public text'), embedding: '[1,0]' }],
          p_embedding_model: EMBEDDING_MODEL,
        });
        return Response.json([{ stored_post_id: postId(1) }]);
      }
      return new Response('not found', { status: 404 });
    });
    const store = createPostgrestSearchStore({
      supabaseUrl: 'https://project.supabase.co/',
      serviceRoleKey: SERVICE_ROLE_KEY,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(await store.loadSearchTexts([postId(1), postId(2)])).toEqual([
      { post_id: postId(1), embedding_text: 'public text', content_hash: sha256('public text'), unchanged: false },
    ]);
    expect(await store.storeSearchEmbeddings([
      { post_id: postId(1), content_hash: sha256('public text'), embedding: '[1,0]' },
    ])).toEqual([postId(1)]);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://project.supabase.co/rest/v1/rpc/post_search_embedding_texts',
      'https://project.supabase.co/rest/v1/rpc/store_post_search_embeddings',
    ]);
    const [, firstInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(firstInit?.body))).toEqual({
      p_post_ids: [postId(1), postId(2)],
      p_embedding_model: EMBEDDING_MODEL,
    });
    expect(firstInit?.method).toBe('POST');
    expect(firstInit?.headers).toMatchObject({ apikey: SERVICE_ROLE_KEY, Authorization: AUTHORIZATION });
  });

  it('throws on a refusal, which the handler turns into its own words', async () => {
    const store = createPostgrestSearchStore({
      supabaseUrl: 'https://project.supabase.co',
      serviceRoleKey: SERVICE_ROLE_KEY,
      // A database from before the migration has neither function.
      fetch: (async () => new Response('{"code":"PGRST202"}', { status: 404 })) as unknown as typeof fetch,
    });
    await expect(store.loadSearchTexts([postId(1)])).rejects.toThrow('PostgREST responded 404');
    await expect(store.storeSearchEmbeddings([])).rejects.toThrow('PostgREST responded 404');
  });

  it('is wired beside the feed’s store under the edge runtime', () => {
    expect(functionSource).toContain(
      'searchStore: serviceRoleKey && supabaseUrl\n      ? createPostgrestSearchStore({ supabaseUrl, serviceRoleKey, fetch })\n      : null,',
    );
  });
});
