import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchClient from '@/app/search/SearchClient';
import { SearchEntryLink } from '@/components/search/SearchEntryLink';
import type { PublicSearchResponse } from '@/lib/public-search';
import type { ShowcaseFeedItem } from '@/lib/showcase';

import {
  SEARCH_IDLE_TITLE,
  searchEmptyTabPointer,
  searchEmptyTabPointerLine,
  searchEmptyTabTitle,
  searchSeeTabLabel,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';
import {
  SEARCH_STARTER_HEADINGS,
  SEARCH_STARTER_LABEL,
  SEARCH_STARTER_NO_RESULTS_HEADING,
  type SearchStarterResponse,
} from '../../ugc-mobile/lib/public-search-policy/search-starter';

// The search page's starting and ending screens (search UX audit 2026-11-13,
// findings 2, 8): the starter from /api/search/starter before a search and
// under one that found nothing, an empty tab that says what another tab holds,
// and Explore's way into search at a phone's width. A browser's view of it:
// tests/e2e/search-starter-screens.spec.ts.

const getSessionMock = vi.fn();
const searchFetchMock = vi.fn();
const starterFetchMock = vi.fn();
const pushMock = vi.fn();
type AuthListener = (event: string, session?: { user?: { id: string } } | null) => void;
const authListeners: AuthListener[] = [];
const sessionSays = (event: string, session: { user?: { id: string } } | null) => act(() => {
  for (const listener of [...authListeners]) listener(event, session);
});

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: pushMock }) }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: (listener: AuthListener) => {
        authListeners.push(listener);
        return { data: { subscription: { unsubscribe: () => { authListeners.splice(authListeners.indexOf(listener), 1); } } } };
      },
    },
  },
}));

const STARTER: SearchStarterResponse = {
  entities: [
    { kind: 'model', key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 200, postCountCapped: true, query: 'nano banana pro' },
    { kind: 'tool', key: 'midjourney', label: 'Midjourney', postCount: 14, postCountCapped: false, query: 'midjourney' },
  ],
  creators: [{
    id: 'c1', username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 42, isFollowing: false,
  }],
  searches: [{ text: 'portrait' }, { text: 'anime' }],
};

function post(id: string): ShowcaseFeedItem {
  return { id, title: `Post ${id}`, saveCount: 0, commentCount: 0, creator: { name: 'Luna' }, mediaItems: [], mediaKind: null, mediaUrl: null } as unknown as ShowcaseFeedItem;
}

function answer(query: string, type: string, overrides: Partial<PublicSearchResponse> = {}): PublicSearchResponse {
  return {
    query,
    normalizedQuery: query,
    type: type as PublicSearchResponse['type'],
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

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const searches = () => searchFetchMock.mock.calls.map(([url]) => url as string);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe('search starter', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/search');
    authListeners.length = 0;
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    pushMock.mockReset();
    starterFetchMock.mockReset();
    starterFetchMock.mockResolvedValue(ok(STARTER));
    searchFetchMock.mockReset();
    searchFetchMock.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      return ok(answer(params.get('q') ?? '', params.get('type') ?? 'top'));
    });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/search/starter')) return starterFetchMock(url, init);
      if (String(url).startsWith('/api/search/suggest')) return Promise.resolve(ok({ query: '', normalizedQuery: '', creators: [], entities: [], completions: [] }));
      return searchFetchMock(url, init);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws the starter before a search, in its order and words, asked once with the viewer’s token', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-1', user: { id: 'u1' } } } });
    render(<SearchClient initialQuery="" initialType="top" />);
    const region = await screen.findByRole('region', { name: SEARCH_STARTER_LABEL });
    // Under the page's h1, each list's heading is an h2.
    expect(within(region).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      SEARCH_STARTER_HEADINGS.entities, SEARCH_STARTER_HEADINGS.creators, SEARCH_STARTER_HEADINGS.searches,
    ]);
    expect(within(region).getByRole('button', { name: /^Nano Banana Pro, model, 200\+ posts/ })).toBeTruthy();
    expect(within(region).getByRole('link', { name: /Luna Studio's profile, @luna-studio/ }).getAttribute('href')).toBe('/creators/luna-studio');
    expect(within(region).getByRole('button', { name: 'Search for portrait' })).toBeTruthy();
    // It stands in for the idle invitation.
    expect(screen.queryByText(SEARCH_IDLE_TITLE)).toBeNull();
    expect(starterFetchMock).toHaveBeenCalledTimes(1);
    expect((starterFetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: 'Bearer token-1' });

    // Typing, a tab, and back to empty: never asked again.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'po' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Posts' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await settle();
    expect(starterFetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('region', { name: SEARCH_STARTER_LABEL })).toBeTruthy();
  });

  it('asks again for another account at a sign-in or a sign-out, and not for the same account coming back into view', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    render(<SearchClient initialQuery="" initialType="top" />);
    await screen.findByRole('region', { name: SEARCH_STARTER_LABEL });
    expect(starterFetchMock).toHaveBeenCalledTimes(1);
    // Signed in (here or in another tab): the visitor's answer goes, the account's is asked with its token.
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-b', user: { id: 'account-b' } } } });
    starterFetchMock.mockResolvedValue(ok({ ...STARTER, creators: [] }));
    sessionSays('SIGNED_IN', { user: { id: 'account-b' } });
    await waitFor(() => expect(starterFetchMock).toHaveBeenCalledTimes(2));
    expect((starterFetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({ Authorization: 'Bearer token-b' });
    await waitFor(() => expect(screen.queryByText('Luna Studio')).toBeNull());
    // The same account's SIGNED_IN as the tab comes back: nothing asked.
    sessionSays('SIGNED_IN', { user: { id: 'account-b' } });
    await settle();
    expect(starterFetchMock).toHaveBeenCalledTimes(2);
    // Signed out: asked again, as a visitor.
    getSessionMock.mockResolvedValue({ data: { session: null } });
    sessionSays('SIGNED_OUT', null);
    await waitFor(() => expect(starterFetchMock).toHaveBeenCalledTimes(3));
  });

  it('starts a suggested search afresh on Top, whatever the last one narrowed', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Nano Banana Pro, model/ }));
    await waitFor(() => expect(searches()).toContain('/api/search?q=nano+banana+pro&type=posts&madeWith=model%3Anano-banana-pro'));
    // Back to an empty box on Posts: the filter is hidden on the idle page, so it must not carry over.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Search for portrait' }));
    await waitFor(() => expect(searches()).toContain('/api/search?q=portrait&type=top&related=1'));
    expect(screen.getByRole('tab', { name: 'Top' }).getAttribute('aria-selected')).toBe('true');
    expect(searches().some((url) => url.includes('q=portrait') && url.includes('madeWith'))).toBe(false);
  });

  it('draws no heading for an empty list', async () => {
    starterFetchMock.mockResolvedValue(ok({ ...STARTER, creators: [] }));
    render(<SearchClient initialQuery="" initialType="top" />);
    const region = await screen.findByRole('region', { name: SEARCH_STARTER_LABEL });
    expect(within(region).queryByText(SEARCH_STARTER_HEADINGS.creators)).toBeNull();
  });

  it.each([
    ['the route not there yet', () => ({ ok: false, status: 404, json: async () => ({}) })],
    ['a failure', () => ({ ok: false, status: 500, json: async () => ({ error: 'Failed to load search starter.' }) })],
    ['the switch off (three empty lists)', () => ok({ entities: [], creators: [], searches: [] })],
    ['a body that is not an answer', () => ok({ error: 'nope' })],
  ])('keeps the idle invitation for %s', async (_name, reply) => {
    starterFetchMock.mockImplementation(async () => reply());
    render(<SearchClient initialQuery="" initialType="top" />);
    await settle();
    await settle();
    expect(screen.getByText(SEARCH_IDLE_TITLE)).toBeTruthy();
    expect(screen.queryByRole('region', { name: SEARCH_STARTER_LABEL })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the idle invitation when the request never reaches the server', async () => {
    starterFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SearchClient initialQuery="" initialType="top" />);
    await settle();
    expect(screen.getByText(SEARCH_IDLE_TITLE)).toBeTruthy();
  });

  it('opens Posts for a model’s own query narrowed to it, and searches a suggested search at once', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Nano Banana Pro, model/ }));
    await waitFor(() => expect(searches()).toContain('/api/search?q=nano+banana+pro&type=posts&madeWith=model%3Anano-banana-pro'));
    expect(screen.getByRole('combobox')).toHaveValue('nano banana pro');
    expect(screen.getByRole('tab', { name: 'Posts' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Remove filter: made with Nano Banana Pro' })).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Top' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Search for portrait' }));
    expect(screen.getByRole('combobox')).toHaveValue('portrait');
    // Committed as Enter commits: with related posts, no pause for typing.
    await waitFor(() => expect(searches()).toContain('/api/search?q=portrait&type=top&related=1'));
  });

  it('draws the starter for half a word that found no creator', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zq' } });
    await waitFor(() => expect(searches()).toEqual(['/api/search?q=zq&type=top']), { timeout: 2000 });
    expect(await screen.findByRole('region', { name: SEARCH_STARTER_LABEL })).toBeTruthy();
  });

  it('draws "No results", then the starter under its own heading, for a search that found nothing', async () => {
    render(<SearchClient initialQuery="zzzznope" initialType="top" />);
    expect(await screen.findByText('No results for “zzzznope”')).toBeTruthy();
    const region = await screen.findByRole('region', { name: SEARCH_STARTER_LABEL });
    // Its own h2 over the lists, each list's heading an h3 under it.
    expect(within(region).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([SEARCH_STARTER_NO_RESULTS_HEADING]);
    expect(within(region).getAllByRole('heading', { level: 3 })).toHaveLength(3);
    expect(starterFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('an empty tab', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/search');
    authListeners.length = 0;
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    starterFetchMock.mockReset();
    starterFetchMock.mockResolvedValue(ok(STARTER));
    searchFetchMock.mockReset();
    searchFetchMock.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      const type = params.get('type') ?? 'top';
      const q = params.get('q') ?? '';
      // "nano" has posts and no recipes; "ghost" has nothing anywhere.
      return ok(answer(q, type, type === 'top' && q === 'nano'
        ? { posts: { items: Array.from({ length: 12 }, (_, index) => post(`p${index}`)), nextCursor: null } }
        : {}));
    });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/search/starter')) return starterFetchMock(url, init);
      if (String(url).startsWith('/api/search/suggest')) return Promise.resolve(ok({ query: '', normalizedQuery: '', creators: [], entities: [], completions: [] }));
      return searchFetchMock(url, init);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says what Top already found, with a button to that tab, asking nothing more', async () => {
    render(<SearchClient initialQuery="nano" initialType="top" />);
    expect(await screen.findByText('Post p0')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Recipes' }));
    expect(await screen.findByText('No recipes for “nano”')).toBeTruthy();
    expect(screen.getByText('12+ posts match')).toBeTruthy();
    expect(searches()).toEqual(['/api/search?q=nano&type=top', '/api/search?q=nano&type=recipes']);
    fireEvent.click(screen.getByRole('button', { name: 'See posts' }));
    expect(screen.getByRole('tab', { name: 'Posts' }).getAttribute('aria-selected')).toBe('true');
  });

  it('asks Top once where no answer of it is on hand, then says what it holds', async () => {
    render(<SearchClient initialQuery="nano" initialType="recipes" />);
    expect(await screen.findByText('12+ posts match')).toBeTruthy();
    // Marked as the page's own (probe=1): left out of the search log.
    expect(searches()).toEqual(['/api/search?q=nano&type=recipes', '/api/search?q=nano&type=top&probe=1']);
    // Back and forth between the empty tab and another: never asked again.
    fireEvent.click(screen.getByRole('tab', { name: 'Creators' }));
    await screen.findByText('No creators for “nano”');
    fireEvent.click(screen.getByRole('tab', { name: 'Recipes' }));
    await screen.findByText('12+ posts match');
    expect(searches().filter((url) => url.includes('type=top'))).toHaveLength(1);
  });

  it('asks Top again under StrictMode’s re-run, and after leaving the tab while it was asked', async () => {
    // As a browser's fetch does: an aborted request rejects, its answer never comes.
    const answering = searchFetchMock.getMockImplementation()!;
    const abortable = (respond: typeof answering) => async (url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const aborted = new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      return Promise.race([respond(url, init), aborted]);
    };
    searchFetchMock.mockImplementation(abortable(answering));
    render(<StrictMode><SearchClient initialQuery="nano" initialType="recipes" /></StrictMode>);
    expect(await screen.findByText('12+ posts match')).toBeTruthy();
    cleanup();
    searchFetchMock.mockClear();
    // The person leaves the tab while Top's answer is on its way, then comes back.
    let releaseTop: () => void = () => {};
    searchFetchMock.mockImplementation(abortable(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      const type = params.get('type') ?? 'top';
      if (type === 'top') await new Promise<void>((resolve) => { releaseTop = resolve; });
      return ok(answer(params.get('q') ?? '', type, type === 'top'
        ? { posts: { items: Array.from({ length: 12 }, (_, index) => post(`p${index}`)), nextCursor: null } }
        : {}));
    }));
    render(<SearchClient initialQuery="nano" initialType="recipes" />);
    await waitFor(() => expect(searches()).toContain('/api/search?q=nano&type=top&probe=1'));
    fireEvent.click(screen.getByRole('tab', { name: 'Creators' }));
    await screen.findByText('No creators for “nano”');
    releaseTop();
    fireEvent.click(screen.getByRole('tab', { name: 'Recipes' }));
    // Asked again (the first was given up): the pointer and its count.
    await waitFor(() => expect(searches().filter((url) => url.includes('type=top'))).toHaveLength(2));
    releaseTop();
    expect(await screen.findByText('12+ posts match')).toBeTruthy();
  });

  it('opens Posts as it counted them: unfiltered', async () => {
    render(<SearchClient initialQuery="nano" initialType="posts" initialFilters={{ madeWith: null, mediaKind: 'video', hasRecipe: false, following: false }} />);
    await waitFor(() => expect(searches()).toContain('/api/search?q=nano&type=posts&kind=video'));
    fireEvent.click(screen.getByRole('tab', { name: 'Recipes' }));
    expect(await screen.findByText('12+ posts match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'See posts' }));
    await waitFor(() => expect(searches()).toContain('/api/search?q=nano&type=posts'));
    expect(screen.getByRole('button', { name: 'Videos' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('says nothing was found, and offers the starter, where Top found nothing either', async () => {
    render(<SearchClient initialQuery="ghost" initialType="recipes" />);
    expect(await screen.findByText('No recipes for “ghost”')).toBeTruthy();
    await waitFor(() => expect(searches()).toContain('/api/search?q=ghost&type=top&probe=1'));
    expect(await screen.findByRole('region', { name: SEARCH_STARTER_LABEL })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^See / })).toBeNull();
  });

  it('points nowhere for a filtered search: its words say to remove a filter', async () => {
    render(<SearchClient initialQuery="nano" initialType="posts" initialFilters={{ madeWith: null, mediaKind: 'video', hasRecipe: false, following: false }} />);
    expect(await screen.findByText('No posts for “nano”')).toBeTruthy();
    await settle();
    expect(searches()).toEqual(['/api/search?q=nano&type=posts&kind=video']);
  });
});

describe('empty tab words', () => {
  const top = { creators: { items: [1] }, posts: { items: Array.from({ length: 12 }) }, recipes: { items: [1, 2] } };
  it('points at posts, then creators, then recipes, and counts what Top holds', () => {
    expect(searchEmptyTabPointer('recipes', top)).toEqual({ tab: 'posts', count: 12, more: true });
    expect(searchEmptyTabPointer('posts', top)).toEqual({ tab: 'creators', count: 1, more: false });
    expect(searchEmptyTabPointer('posts', { ...top, creators: { items: [] } })).toEqual({ tab: 'recipes', count: 2, more: false });
    expect(searchEmptyTabPointer('posts', { creators: { items: [] }, posts: { items: [] }, recipes: { items: [] } })).toBeNull();
    expect(searchEmptyTabPointer('posts', null)).toBeNull();
  });

  it('says it in the shared words', () => {
    expect(searchEmptyTabTitle('recipes', 'nano')).toBe('No recipes for “nano”');
    expect(searchEmptyTabPointerLine({ tab: 'posts', count: 12, more: false })).toBe('12 posts match');
    expect(searchEmptyTabPointerLine({ tab: 'posts', count: 12, more: true })).toBe('12+ posts match');
    expect(searchEmptyTabPointerLine({ tab: 'recipes', count: 1, more: false })).toBe('1 recipe matches');
    expect(searchSeeTabLabel('creators')).toBe('See creators');
  });
});

describe('Explore’s way into search', () => {
  it('is a link to the search page drawn as a field that reads "Search"', () => {
    render(<SearchEntryLink />);
    const link = screen.getByRole('link', { name: 'Search' });
    expect(link.getAttribute('href')).toBe('/search');
  });
});
