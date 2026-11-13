import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchClient from '@/app/search/SearchClient';
import { PUBLIC_SEARCH_RELATED_PARAM, type PublicSearchResponse } from '@/lib/public-search';
import { SEARCH_RELATED_THIN_POST_COUNT } from '@/lib/search-embeddings';
import type { ShowcaseFeedItem } from '@/lib/showcase';

import {
  SEARCH_RELATED_HEADING,
  SEARCH_RELATED_PARAM,
  SEARCH_RELATED_SETTLE_MS,
  SEARCH_RELATED_THIN_POSTS,
  isSearchAnswerThin,
  searchRelatedApplies,
  searchRelatedFollowUpDelay,
  searchRelatedPosts,
  searchRelatedStatus,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

// Related posts on the search page: when the page asks for them (`related=1`
// costs the viewer one of forty new queries a day, so never at a step of the
// typing), and what it draws. The rule is the app's too
// (ugc-mobile/lib/public-search-policy/public-search-policy.ts, "Related posts").

const getSessionMock = vi.fn();
const fetchMock = vi.fn();
const suggestFetchMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

function post(id: string, title: string) {
  return {
    id,
    title,
    saveCount: 0,
    commentCount: 0,
    creator: { name: 'Luna Studio' },
    mediaItems: [],
    mediaKind: null,
    mediaUrl: null,
  } as unknown as ShowcaseFeedItem;
}

function answer(overrides: Partial<PublicSearchResponse> = {}): PublicSearchResponse {
  return {
    query: 'ocean at dusk',
    normalizedQuery: 'ocean at dusk',
    type: 'top',
    sort: 'top',
    entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null },
    exact: false,
    creators: { items: [], nextCursor: null },
    posts: { items: [], nextCursor: null },
    recipes: { items: [], nextCursor: null },
    ...overrides,
  };
}

const ok = (body: PublicSearchResponse) => ({ ok: true, status: 200, json: async () => body });
const RELATED = { posts: [post('r1', 'Sea after sunset'), post('r2', 'Cliffs in mist')] };
const posts = (count: number) => Array.from({ length: count }, (_, index) => post(`p${index}`, `Own post ${index}`));

const asked = () => fetchMock.mock.calls.map(([url]) => url as string);
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const type = (value: string) => fireEvent.change(screen.getByRole('combobox'), { target: { value } });
const enter = () => fireEvent.submit(screen.getByRole('search'));
const said = () => document.querySelector('p.sr-only[role="status"]')?.textContent;
const relatedGroup = () => screen.queryByRole('region', { name: SEARCH_RELATED_HEADING });
/** The search's own pause after a letter. */
const PAUSE = 300;

describe('related posts on the search page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(ok(answer()));
    suggestFetchMock.mockReset();
    suggestFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ query: '', normalizedQuery: '', creators: [], entities: [], completions: [] }),
    });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (
      String(url).startsWith('/api/search/suggest') ? suggestFetchMock(url, init) : fetchMock(url, init)
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('never asks at a step of the typing: only once the thin answer of a search left alone has stood', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('ocean');
    await tick(PAUSE);
    expect(asked()).toEqual(['/api/search?q=ocean&type=top']);
    // The person types on before the answer has stood: nothing was asked about "ocean".
    await tick(SEARCH_RELATED_SETTLE_MS - 1);
    type('ocean at dusk');
    await tick(PAUSE);
    expect(asked()).toEqual(['/api/search?q=ocean&type=top', '/api/search?q=ocean+at+dusk&type=top']);
    expect(relatedGroup()).toBeNull();

    // Left alone: asked once, for this search, with the parameter.
    fetchMock.mockResolvedValue(ok(answer({ related: RELATED })));
    await tick(SEARCH_RELATED_SETTLE_MS - 1);
    expect(asked()).toHaveLength(2);
    await tick(1);
    expect(asked().at(-1)).toBe('/api/search?q=ocean+at+dusk&type=top&related=1');
    expect(asked()).toHaveLength(3);

    // Drawn under the search's own outcome, and said after it.
    const group = relatedGroup()!;
    expect(within(group).getAllByRole('link').map((link) => link.textContent)).toEqual([
      expect.stringContaining('Sea after sunset'),
      expect.stringContaining('Cliffs in mist'),
    ]);
    expect(screen.getByText('No results for “ocean at dusk”')).toBeInTheDocument();
    expect(said()).toBe('0 results for ocean at dusk. 2 related posts');
    // A related card comes back to this search, as the search's own do.
    const href = within(group).getAllByRole('link')[0].getAttribute('href') ?? '';
    expect(new URL(href, 'http://localhost').searchParams.get('returnTo')).toBe('/search?q=ocean+at+dusk');

    // Once per answer: nothing more however long it stands.
    await tick(SEARCH_RELATED_SETTLE_MS * 4);
    expect(asked()).toHaveLength(3);
  });

  it('asks with the search itself when the person settled on it first: Enter inside the pause', async () => {
    fetchMock.mockResolvedValue(ok(answer({ related: RELATED })));
    render(<SearchClient initialQuery="" initialType="top" />);
    type('ocean at dusk');
    enter();
    await tick(PAUSE);
    expect(asked()).toEqual(['/api/search?q=ocean+at+dusk&type=top&related=1']);
    expect(relatedGroup()).not.toBeNull();
    // It was asked for with the search: there is no second request.
    await tick(SEARCH_RELATED_SETTLE_MS * 2);
    expect(asked()).toHaveLength(1);
  });

  it('asks at once when the person presses Enter over a thin answer already on hand, or while it is on its way', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('ocean at dusk');
    await tick(PAUSE);
    expect(asked()).toEqual(['/api/search?q=ocean+at+dusk&type=top']);
    fetchMock.mockResolvedValue(ok(answer({ related: RELATED })));
    enter();
    await tick(0);
    expect(asked()).toEqual(['/api/search?q=ocean+at+dusk&type=top', '/api/search?q=ocean+at+dusk&type=top&related=1']);
    expect(relatedGroup()).not.toBeNull();
  });

  it('does not ask again for an answer that is not thin, and never names the parameter on a later page', async () => {
    fetchMock.mockResolvedValue(ok(answer({ type: 'posts', posts: { items: posts(SEARCH_RELATED_THIN_POSTS), nextCursor: 'page-2' } })));
    render(<SearchClient initialQuery="" initialType="posts" />);
    type('ocean at dusk');
    enter();
    await tick(PAUSE);
    // Settled, so the first page asks; its answer has its own posts and a next page.
    expect(asked()).toEqual(['/api/search?q=ocean+at+dusk&type=posts&related=1']);
    await tick(SEARCH_RELATED_SETTLE_MS * 2);
    expect(asked()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await tick(0);
    expect(asked().at(-1)).toBe('/api/search?q=ocean+at+dusk&type=posts&cursor=page-2');

    // A full Top answer that came without the parameter is left as it is.
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(ok(answer({ posts: { items: posts(SEARCH_RELATED_THIN_POSTS), nextCursor: null } })));
    fireEvent.click(screen.getByRole('tab', { name: 'Top' }));
    type('harbour lights');
    await tick(PAUSE);
    await tick(SEARCH_RELATED_SETTLE_MS * 2);
    expect(asked().filter((url) => url.includes('harbour'))).toEqual(['/api/search?q=harbour+lights&type=top']);
  });

  it.each([
    ['Creators', { initialType: 'creators' as const }, '/api/search?q=ocean+at+dusk&type=creators'],
    ['Recipes', { initialType: 'recipes' as const }, '/api/search?q=ocean+at+dusk&type=recipes'],
    ['Latest', { initialType: 'posts' as const, initialSort: 'latest' as const }, '/api/search?q=ocean+at+dusk&type=posts&sort=latest'],
    [
      'a filter',
      { initialType: 'posts' as const, initialFilters: { madeWith: null, mediaKind: 'video' as const, hasRecipe: false, following: false } },
      '/api/search?q=ocean+at+dusk&type=posts&kind=video',
    ],
    ['the query as typed', { initialType: 'top' as const, initialExact: true }, '/api/search?q=ocean+at+dusk&type=top&exact=1'],
  ])('never asks on %s, settled or left alone', async (_name, props, url) => {
    render(<SearchClient initialQuery="ocean at dusk" {...props} />);
    await tick(0);
    enter();
    await tick(SEARCH_RELATED_SETTLE_MS * 2);
    expect(asked()).toEqual([url]);
  });

  it('never asks for a query too short to be searched for posts', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    type('oc');
    enter();
    await tick(PAUSE + SEARCH_RELATED_SETTLE_MS * 2);
    expect(asked()).toEqual(['/api/search?q=oc&type=top']);
  });

  it('asks with the search itself for a recent search opened', async () => {
    window.localStorage.setItem('magicbooklet:public-search-history:v1', JSON.stringify(['ocean at dusk']));
    render(<SearchClient initialQuery="" initialType="top" />);
    fireEvent.focus(screen.getByRole('combobox'));
    await tick(0);
    fireEvent.click(screen.getByRole('button', { name: 'Search again for ocean at dusk' }));
    await tick(PAUSE);
    expect(asked()).toEqual(['/api/search?q=ocean+at+dusk&type=top&related=1']);
  });

  it('asks for a search that arrived in the address after its answer has stood', async () => {
    render(<SearchClient initialQuery="ocean at dusk" initialType="top" />);
    await tick(0);
    expect(asked()).toEqual(['/api/search?q=ocean+at+dusk&type=top']);
    await tick(SEARCH_RELATED_SETTLE_MS);
    expect(asked()).toEqual(['/api/search?q=ocean+at+dusk&type=top', '/api/search?q=ocean+at+dusk&type=top&related=1']);
  });

  it('keeps the answer on hand when the request for related posts fails, says nothing, and does not ask again', async () => {
    fetchMock.mockResolvedValue(ok(answer({ creators: { items: [{ id: 'c1', username: 'luna', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 1, isFollowing: false }], nextCursor: null } })));
    render(<SearchClient initialQuery="ocean at dusk" initialType="top" />);
    await tick(0);
    expect(screen.getByText('Luna Studio')).toBeInTheDocument();
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Failed to search public content.' }) });
    await tick(SEARCH_RELATED_SETTLE_MS);
    expect(asked()).toHaveLength(2);
    expect(screen.getByText('Luna Studio')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Search did not load')).toBeNull();
    expect(said()).toBe('1 result for ocean at dusk');
    await tick(SEARCH_RELATED_SETTLE_MS * 4);
    expect(asked()).toHaveLength(2);
  });

  it('draws the group under the search’s own results, and nothing for an answer that brings none', async () => {
    fetchMock.mockResolvedValue(ok(answer({ posts: { items: posts(2), nextCursor: null }, related: RELATED })));
    render(<SearchClient initialQuery="" initialType="top" />);
    type('ocean at dusk');
    enter();
    await tick(PAUSE);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Posts', SEARCH_RELATED_HEADING]);
    expect(said()).toBe('2 results for ocean at dusk. 2 related posts');
    // None of the search's own cards is among them.
    expect(within(relatedGroup()!).queryByText(/Own post/)).toBeNull();

    // Looked for and none found, and an answer from a server that says nothing: no group, no words.
    for (const related of [{ posts: [] }, undefined]) {
      fetchMock.mockResolvedValue(ok(answer({ posts: { items: posts(2), nextCursor: null }, ...(related ? { related } : {}) })));
      type(related ? 'quiet harbour' : 'quiet harbours');
      enter();
      await tick(PAUSE);
      expect(relatedGroup()).toBeNull();
      expect(said()).toBe(`2 results for ${related ? 'quiet harbour' : 'quiet harbours'}`);
    }
  });
});

describe('the related posts rule both clients follow', () => {
  const search = { type: 'top', sort: 'top', narrowing: '', queryLength: 5, laterPage: false };

  it('names the server’s parameter and its thin count', () => {
    expect(SEARCH_RELATED_PARAM).toBe(PUBLIC_SEARCH_RELATED_PARAM);
    expect(SEARCH_RELATED_THIN_POSTS).toBe(SEARCH_RELATED_THIN_POST_COUNT);
  });

  it('applies to the first page of a ranked, unfiltered Top or Posts search from three characters', () => {
    expect(searchRelatedApplies(search)).toBe(true);
    expect(searchRelatedApplies({ ...search, type: 'posts' })).toBe(true);
    expect(searchRelatedApplies({ ...search, type: 'creators' })).toBe(false);
    expect(searchRelatedApplies({ ...search, type: 'recipes' })).toBe(false);
    expect(searchRelatedApplies({ ...search, type: 'posts', sort: 'latest' })).toBe(false);
    expect(searchRelatedApplies({ ...search, narrowing: 'kind=video' })).toBe(false);
    expect(searchRelatedApplies({ ...search, queryLength: 2 })).toBe(false);
    expect(searchRelatedApplies({ ...search, queryLength: 3 })).toBe(true);
    expect(searchRelatedApplies({ ...search, laterPage: true })).toBe(false);
  });

  it('reads an answer as thin under the server’s count, and never a Posts answer with a next page', () => {
    const few = { items: Array.from({ length: SEARCH_RELATED_THIN_POSTS - 1 }), nextCursor: null };
    const full = { items: Array.from({ length: SEARCH_RELATED_THIN_POSTS }), nextCursor: null };
    expect(isSearchAnswerThin('top', few)).toBe(true);
    expect(isSearchAnswerThin('top', full)).toBe(false);
    expect(isSearchAnswerThin('posts', few)).toBe(true);
    expect(isSearchAnswerThin('posts', { ...few, nextCursor: 'next' })).toBe(false);
    // Top has no pages: a cursor there means nothing.
    expect(isSearchAnswerThin('top', { ...few, nextCursor: 'next' })).toBe(true);
  });

  it('asks again at once for a settled search, after the settle time otherwise, and never twice or for nothing', () => {
    const onHand = { applies: true, relatedAsked: false, thin: true, settled: false };
    expect(searchRelatedFollowUpDelay(onHand)).toBe(SEARCH_RELATED_SETTLE_MS);
    expect(searchRelatedFollowUpDelay({ ...onHand, settled: true })).toBe(0);
    expect(searchRelatedFollowUpDelay({ ...onHand, relatedAsked: true })).toBeNull();
    expect(searchRelatedFollowUpDelay({ ...onHand, thin: false, settled: true })).toBeNull();
    expect(searchRelatedFollowUpDelay({ ...onHand, applies: false, settled: true })).toBeNull();
    // Several pauses of typing long: a person between words has not settled.
    expect(SEARCH_RELATED_SETTLE_MS).toBeGreaterThanOrEqual(1000);
  });

  it('draws what an answer brings on Top and Posts, and nothing without the field', () => {
    expect(searchRelatedPosts('top', { related: { posts: ['a', 'b'] } })).toEqual(['a', 'b']);
    expect(searchRelatedPosts('posts', { related: { posts: ['a'] } })).toEqual(['a']);
    expect(searchRelatedPosts('creators', { related: { posts: ['a'] } })).toEqual([]);
    expect(searchRelatedPosts('top', {})).toEqual([]);
    expect(searchRelatedPosts('top', { related: null })).toEqual([]);
    expect(searchRelatedPosts('top', { related: { posts: null } })).toEqual([]);
    expect(searchRelatedStatus(0)).toBe('');
    expect(searchRelatedStatus(1)).toBe('1 related post');
    expect(searchRelatedStatus(3)).toBe('3 related posts');
  });
});
