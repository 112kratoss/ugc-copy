import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchClient from '@/app/search/SearchClient';
import type { PublicSearchResponse } from '@/lib/public-search';
import type { ShowcaseFeedItem } from '@/lib/showcase';

import { SEARCH_SHOW_MORE_LABEL } from '../../ugc-mobile/lib/public-search-policy/public-search-policy';
import {
  appendSearchPosts,
  isSearchPageAllRepeats,
  withoutShownSearchPosts,
} from '../../ugc-mobile/lib/public-search-policy/search-blend';

// A later page of posts may hold a post an earlier page showed (the server
// repeats a post rather than skip one: contracts/mobile-api-v1.json,
// searchPublicContent.laterPages). The search page leaves those out by id,
// and a page made of nothing else is not the end of the list: the end is the
// cursor being null. The app's half is
// ugc-mobile/__tests__/search-page-repeats.test.tsx.

const getSessionMock = vi.fn();
const fetchMock = vi.fn();

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

function post(id: string) {
  return {
    id,
    title: `Post ${id}`,
    saveCount: 0,
    commentCount: 0,
    creator: { name: 'Luna Studio' },
    mediaItems: [],
    mediaKind: null,
    mediaUrl: null,
  } as unknown as ShowcaseFeedItem;
}

function page(ids: string[], nextCursor: string | null): PublicSearchResponse {
  return {
    query: 'ocean at dusk',
    normalizedQuery: 'ocean at dusk',
    type: 'posts',
    sort: 'top',
    entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null },
    exact: false,
    creators: { items: [], nextCursor: null },
    posts: { items: ids.map(post), nextCursor },
    recipes: { items: [], nextCursor: null },
  };
}

const ok = (body: PublicSearchResponse) => ({ ok: true, status: 200, json: async () => body });
// Every request of a search carries how its query was entered (`entry`, the
// last parameter the page sets); these cases are about paging, so it is left
// out of what they compare, as the page's other tests do.
const asked = () => fetchMock.mock.calls.map(([url]) => (url as string).replace(/&entry=[a-z]+$/u, ''));
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** The posts on show, by the id their link opens, in the order drawn. */
const drawn = () => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/showcase/"]'))
  .map((link) => link.getAttribute('href')?.split('/showcase/')[1]?.split(/[?#]/)[0]);
const showMore = () => screen.queryByRole('button', { name: SEARCH_SHOW_MORE_LABEL });
const PAGE = '/api/search?q=ocean+at+dusk&type=posts';
// A search the person settled on asks for related posts with its first page; a later page never does.
const FIRST = `${PAGE}&related=1`;

async function openFirstPage(first: PublicSearchResponse) {
  fetchMock.mockResolvedValueOnce(ok(first));
  render(<SearchClient initialQuery="" initialType="posts" />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ocean at dusk' } });
  fireEvent.submit(screen.getByRole('search'));
  await tick(400);
  expect(asked()).toEqual([FIRST]);
}

describe('a later page of posts on the search page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/search');
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (
      String(url).startsWith('/api/search/starter') || String(url).startsWith('/api/search/suggest')
        ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
        : fetchMock(url, init)
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('draws once a post the second page holds again', async () => {
    await openFirstPage(page(['p1', 'p2', 'p3'], 'cursor-2'));
    expect(drawn()).toEqual(['p1', 'p2', 'p3']);

    fetchMock.mockResolvedValueOnce(ok(page(['p3', 'p4', 'p1', 'p5'], null)));
    fireEvent.click(showMore()!);
    await tick(50);

    expect(asked()).toEqual([FIRST, `${PAGE}&cursor=cursor-2`]);
    expect(drawn()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(showMore()).toBeNull();
  });

  it('asks for the page after one made only of posts already shown, once, and draws what that brings', async () => {
    await openFirstPage(page(['p1', 'p2', 'p3'], 'cursor-2'));

    fetchMock
      .mockResolvedValueOnce(ok(page(['p2', 'p1'], 'cursor-3')))
      .mockResolvedValueOnce(ok(page(['p4', 'p2'], null)));
    fireEvent.click(showMore()!);
    await tick(50);

    // One press: the page of repeats, then the page after it. Not an empty-looking press.
    expect(asked()).toEqual([FIRST, `${PAGE}&cursor=cursor-2`, `${PAGE}&cursor=cursor-3`]);
    expect(drawn()).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(showMore()).toBeNull();
  });

  it('does not go on asking when the page after it is repeats as well: the list is not over, and the next press asks', async () => {
    await openFirstPage(page(['p1', 'p2', 'p3'], 'cursor-2'));

    fetchMock
      .mockResolvedValueOnce(ok(page(['p1'], 'cursor-3')))
      .mockResolvedValueOnce(ok(page(['p2'], 'cursor-4')))
      .mockResolvedValue(ok(page(['p9'], null)));
    fireEvent.click(showMore()!);
    await tick(500);

    // Two requests for the press, and no more: no loop.
    expect(asked()).toEqual([FIRST, `${PAGE}&cursor=cursor-2`, `${PAGE}&cursor=cursor-3`]);
    expect(drawn()).toEqual(['p1', 'p2', 'p3']);
    // The list has not ended: its cursor is not null.
    expect(showMore()).not.toBeNull();

    fireEvent.click(showMore()!);
    await tick(50);
    expect(asked().at(-1)).toBe(`${PAGE}&cursor=cursor-4`);
    expect(drawn()).toEqual(['p1', 'p2', 'p3', 'p9']);
    expect(showMore()).toBeNull();
  });

  it('ends the list on a page of repeats with no cursor', async () => {
    await openFirstPage(page(['p1', 'p2'], 'cursor-2'));
    fetchMock.mockResolvedValueOnce(ok(page(['p2', 'p1'], null)));
    fireEvent.click(showMore()!);
    await tick(50);
    expect(asked()).toHaveLength(2);
    expect(drawn()).toEqual(['p1', 'p2']);
    expect(showMore()).toBeNull();
  });
});

describe('the rule both clients append a page of posts by', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };

  it('appends what is not on show yet, in the page\'s order', () => {
    expect(appendSearchPosts([a, b], [b, c, a, c])).toEqual([a, b, c]);
    expect(appendSearchPosts([], [a, b])).toEqual([a, b]);
    expect(appendSearchPosts([a], [])).toEqual([a]);
    expect(withoutShownSearchPosts([a, b], [b, c])).toEqual([c]);
  });

  it('calls a page all repeats only when it holds posts, none of them new, and the list goes on', () => {
    expect(isSearchPageAllRepeats([a, b], { items: [b, a], nextCursor: 'more' })).toBe(true);
    // A new post among them: an ordinary page.
    expect(isSearchPageAllRepeats([a, b], { items: [b, c], nextCursor: 'more' })).toBe(false);
    // No cursor: the end of the list, nothing to ask for.
    expect(isSearchPageAllRepeats([a, b], { items: [b, a], nextCursor: null })).toBe(false);
    // An empty page with a cursor is the server's to explain, not a page of repeats.
    expect(isSearchPageAllRepeats([a, b], { items: [], nextCursor: 'more' })).toBe(false);
  });
});
