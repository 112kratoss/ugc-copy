import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchClient from '@/app/search/SearchClient';
import {
  clearSearchFieldHandoff,
  markSearchFieldHandoff,
  searchFieldHandoffPending,
} from '@/components/search/search-field-handoff';
import type { CreatorSearchResult, PublicSearchResponse, RecipeSearchResult } from '@/lib/public-search';
import type { ShowcaseFeedItem } from '@/lib/showcase';

import {
  SEARCH_FAILED_BODY,
  SEARCH_IDLE_BODY,
  SEARCH_IDLE_TITLE,
  SEARCH_OFFLINE_BODY,
  SEARCH_PLACEHOLDER,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

// One stable router object, like Next's real one. SearchClient writes its
// address itself (history.replaceState, search-address.ts); the mock catches a
// return to router.replace, which re-rendered this dynamic page on every keystroke.
const { replaceMock, routerMock } = vi.hoisted(() => {
  const replace = vi.fn();
  return { replaceMock: replace, routerMock: { replace } };
});
const getSessionMock = vi.fn();
const fetchMock = vi.fn();
// The typeahead asks /api/search/suggest as the person types
// (search-typeahead-client.test.tsx holds it). Here it is answered apart, with
// nothing to offer, so `fetchMock` sees the searches and only the searches.
const suggestFetchMock = vi.fn();
function fetchBySurface(url: string, init?: RequestInit) {
  return String(url).startsWith('/api/search/suggest') ? suggestFetchMock(url, init) : fetchMock(url, init);
}
// The page's auth listener, kept so a test can say "signed out" as Supabase does.
const authListeners: Array<(event: string) => void> = [];

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: (listener: (event: string) => void) => {
        authListeners.push(listener);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                const index = authListeners.indexOf(listener);
                if (index >= 0) authListeners.splice(index, 1);
              },
            },
          },
        };
      },
    },
  },
}));

function searchResponse(overrides: Partial<PublicSearchResponse> = {}): PublicSearchResponse {
  return {
    query: 'luna',
    normalizedQuery: 'luna',
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

function jsonResponse(body: PublicSearchResponse) {
  return { ok: true, status: 200, json: async () => body };
}

function failedResponse(status: number, body: unknown = { error: 'Failed to search public content.' }) {
  return { ok: false, status, json: async () => body };
}

function creator(displayName: string): CreatorSearchResult {
  return {
    id: `creator-${displayName}`,
    username: displayName.toLowerCase().replace(/\s+/g, '-'),
    displayName,
    bio: null,
    avatarUrl: null,
    publicPostCount: 3,
    isFollowing: false,
  };
}

function post(id: string, title: string, saveCount: number) {
  return {
    id,
    title,
    saveCount,
    commentCount: 0,
    creator: { name: 'Luna Studio' },
    mediaItems: [],
    mediaKind: null,
    mediaUrl: null,
  } as unknown as ShowcaseFeedItem;
}

function recipe(id: string, title: string, sellerName: string): RecipeSearchResult {
  return {
    id,
    postId: `post-${id}`,
    title,
    summary: 'Lighting, lens and grade',
    previewText: '',
    accessMode: 'free',
    priceUsdCents: 0,
    salesCount: 0,
    freeUnlockCount: 0,
    allowRemix: true,
    resourceKinds: ['prompt'],
    createdAt: '2026-10-01T00:00:00.000Z',
    seller: { id: `seller-${id}`, username: null, name: sellerName, avatar: null },
    post: null,
    priceQuote: { formatted: 'Free', currency: 'USD', amountSubunits: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function requestedUrls() {
  return fetchMock.mock.calls.map(([url]) => url as string);
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value } });
}

describe('SearchClient', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    getSessionMock.mockReset();
    fetchMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue(jsonResponse(searchResponse()));
    suggestFetchMock.mockReset();
    suggestFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ query: '', normalizedQuery: '', creators: [], entities: [], completions: [] }),
    });
    vi.stubGlobal('fetch', fetchBySurface);
    window.localStorage.clear();
    window.history.replaceState(null, '', '/search');
    authListeners.length = 0;
  });

  it('renders the idle invitation, in the shared words, until two characters are typed', () => {
    render(<SearchClient initialQuery="" initialType="top" />);

    expect(screen.getByText(SEARCH_IDLE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(SEARCH_IDLE_BODY)).toBeInTheDocument();
    // No sentence explains how many characters to type.
    expect(document.body.textContent).not.toMatch(/character/i);
    expect(screen.getByRole('combobox')).toHaveAttribute('placeholder', SEARCH_PLACEHOLDER);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs a URL query with the bearer on arrival and announces the settled count', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-1' } } });
    fetchMock.mockResolvedValue(jsonResponse(searchResponse({
      creators: {
        items: [{
          id: 'creator-1',
          username: 'luna-studio',
          displayName: 'Luna Studio',
          bio: null,
          avatarUrl: null,
          publicPostCount: 3,
          isFollowing: false,
        }],
        nextCursor: null,
      },
    })));

    render(<SearchClient initialQuery="luna" initialType="top" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/search?q=luna&type=top');
    expect(init.headers).toEqual({ Authorization: 'Bearer token-1' });

    expect(await screen.findByText('Luna Studio')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 result for luna');
    // The URL follows the query through history.replaceState, not a server render.
    expect(replaceMock).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}`).toBe('/search?q=luna');
  });

  it('reads its own address when history brings it back: the search the person left, run at once', async () => {
    // Back from a page opened here. Next draws the entry from the render it
    // kept, whose props are the search the page was first opened with (luna);
    // the address is the search the person left.
    window.history.replaceState({ __NA: true }, '', '/search?q=lumi&type=posts&sort=latest&recipe=1');
    window.dispatchEvent(new PopStateEvent('popstate'));
    render(<SearchClient initialQuery="luna" initialType="top" />);

    expect(screen.getByRole('combobox')).toHaveValue('lumi');
    expect(screen.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
    // No pause: the query arrives already typed, as a shared link's does.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 250 });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/api/search?q=lumi&type=posts&sort=latest&recipe=1');
    expect(`${window.location.pathname}${window.location.search}`).toBe('/search?q=lumi&type=posts&sort=latest&recipe=1');
    // An emptied search comes back empty, not as the first load's.
    cleanup();
    fetchMock.mockClear();
    window.history.replaceState({ __NA: true }, '', '/search');
    window.dispatchEvent(new PopStateEvent('popstate'));
    render(<SearchClient initialQuery="luna" initialType="top" />);
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getByText(SEARCH_IDLE_TITLE)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens on its props at any mount that is not a return through history, its own address included', async () => {
    // A navigation to the page first renders it while the address is still the
    // page before's, and that page can be the search page: a link there to
    // another search would otherwise open the search being left.
    window.history.replaceState({ __NA: true }, '', '/search?q=cat');
    render(<SearchClient initialQuery="" initialType="top" />);
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getByText(SEARCH_IDLE_TITLE)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    // A traversal is spent by the mount it brought: the next mount at the same address is not one.
    cleanup();
    window.history.replaceState({ __NA: true }, '', '/search?q=cat');
    window.dispatchEvent(new PopStateEvent('popstate'));
    render(<SearchClient initialQuery="" initialType="top" />);
    expect(screen.getByRole('combobox')).toHaveValue('cat');
    cleanup();
    render(<SearchClient initialQuery="" initialType="top" />);
    expect(screen.getByRole('combobox')).toHaveValue('');
    // And one that landed on another address is not this mount's.
    cleanup();
    window.history.replaceState({ __NA: true }, '', '/search?q=dog');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.history.replaceState({ __NA: true }, '', '/search?q=cat');
    render(<SearchClient initialQuery="" initialType="top" />);
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('writes nothing once the address is another page’s: Back inside the pause leaves that page’s entry alone', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'luna' } });
    // Back: the browser's address is the page before's at once; Next takes this page away a moment later.
    window.history.replaceState({ __NA: true }, '', '/creators/lumen');
    const written = vi.spyOn(window.history, 'replaceState');
    // The pause's timer fires in that gap, and so does a press.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.click(document.body);
    expect(written).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}`).toBe('/creators/lumen');
    written.mockRestore();
  });

  it('writes its address at a press anywhere, ahead of the pause the search waits for, and once', async () => {
    const written = vi.spyOn(window.history, 'replaceState');
    const address = () => `${window.location.pathname}${window.location.search}`;
    render(<SearchClient initialQuery="" initialType="top" />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'luna' } });
    // Inside the pause: the address waits, as the search does.
    expect(address()).toBe('/search');
    expect(fetchMock).not.toHaveBeenCalled();
    // A press on anything, a link of the header as much as a result: the
    // entry the person may be leaving names the search they leave.
    fireEvent.click(document.body);
    expect(address()).toBe('/search?q=luna');
    // The pause's own write finds the address said, and the search is asked.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(written.mock.calls.filter(([, , url]) => url === '/search?q=luna')).toHaveLength(1);
    // None of the page's writes is a navigation to Next's router (search-address.test.ts).
    for (const [state] of written.mock.calls) expect(state).toMatchObject({ __NA: true });
    written.mockRestore();
  });

  it('keeps a two-character query on its tab: Posts waits for a third character, idle and undimmed', async () => {
    render(<SearchClient initialQuery="ab" initialType="posts" />);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(fetchMock).not.toHaveBeenCalled();
    for (const name of ['Top', 'Creators', 'Posts', 'Recipes']) {
      expect(screen.getByRole('tab', { name })).toBeEnabled();
    }
    expect(screen.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(SEARCH_IDLE_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(/No results/)).not.toBeInTheDocument();
    // The address keeps the search, so a reload opens the same tab.
    expect(`${window.location.pathname}${window.location.search}`).toBe('/search?q=ab&type=posts');

    // Top searches creators from two characters.
    fireEvent.click(screen.getByRole('tab', { name: 'Top' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/api/search?q=ab&type=top');
  });

  it('ends a full Top section with a full-width "See all", and names each card in words', async () => {
    const posts = Array.from({ length: 12 }, (_, index) => post(`post-${index}`, `Lantern ${index}`, 1));
    fetchMock.mockResolvedValue(jsonResponse(searchResponse({
      creators: { items: [creator('Luna Studio')], nextCursor: null },
      posts: { items: posts, nextCursor: null },
      recipes: { items: [{ ...recipe('recipe-1', 'Cinematic light', 'Luna Studio'), accessMode: 'free' }], nextCursor: null },
    })));
    render(<SearchClient initialQuery="luna" initialType="top" />);
    await screen.findByText('Lantern 0');

    // Twelve posts fill Top's section: it has more on Posts. One creator and one recipe do not.
    // By the heading, the short word named in full; under the last row, the full words.
    expect(screen.getAllByRole('button', { name: 'See all posts' }).map((button) => button.textContent)).toEqual(['See all', 'See all posts']);
    expect(screen.getAllByRole('button', { name: 'See all creators' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'See all recipes' })).toHaveLength(1);
    expect(screen.getByText('See all posts')).toBeInTheDocument();

    // A card's link is named in words, not its text run together.
    expect(screen.getByRole('link', { name: 'Open post Lantern 0 by Luna Studio, 1 save, 0 comments' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open recipe Cinematic light by Luna Studio, Free. Lighting, lens and grade' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Open Luna Studio's profile, @luna-studio, 3 posts" })).toBeInTheDocument();
    // And it leaves out nothing the card shows a sighted person (review of #784).
    for (const link of document.querySelectorAll('a[data-search-result]')) {
      const label = (link.getAttribute('aria-label') ?? '').toLowerCase();
      const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('[aria-hidden="true"]')) continue;
        const text = node.textContent?.trim().toLowerCase();
        if (text) expect(label, `${label} holds “${text}”`).toContain(text);
      }
    }

    fetchMock.mockResolvedValue(jsonResponse(searchResponse({ type: 'posts', posts: { items: posts, nextCursor: null } })));
    fireEvent.click(screen.getByText('See all posts'));
    expect(screen.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
  });

  it('puts the query in the page title while one is searched', async () => {
    render(<SearchClient initialQuery="nano" initialType="top" />);
    await waitFor(() => expect(document.title).toBe('nano · Search | Magic Booklet'));

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    await waitFor(() => expect(document.title).toBe('Search | Magic Booklet'));
  });

  it('never says "No results" for two characters: a creator search that finds none leaves the idle state', async () => {
    fetchMock.mockResolvedValue(jsonResponse(searchResponse()));
    render(<SearchClient initialQuery="na" initialType="top" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText(SEARCH_IDLE_TITLE)).toBeInTheDocument());
    expect(screen.queryByText(/No results/)).not.toBeInTheDocument();
    // The live region gives no verdict either: no "0 results for na" (review of #784).
    const status = Array.from(document.querySelectorAll('p[role="status"]'));
    expect(status.map((node) => node.textContent)).toEqual(['']);
  });

  it('clears the query with Escape and returns to the initial state', async () => {
    render(<SearchClient initialQuery="luna" initialType="top" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
    expect(await screen.findByText(SEARCH_IDLE_TITLE)).toBeInTheDocument();
  });

  it('server-renders a URL query as loading rather than as an empty answer', () => {
    const html = renderToString(<SearchClient initialQuery="luna" initialType="top" />);

    expect(html).toContain('Searching…');
    expect(html).not.toContain('No results');
  });

  it('leaves the main landmark and its id to the app shell', () => {
    render(<SearchClient initialQuery="" initialType="top" />);

    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(document.getElementById('main-content')).toBeNull();
  });

  describe('timing', () => {
    // Runs timers due within `ms` and the promise chain behind each request.
    async function settle(ms = 0) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows loading from the first keystroke until the answer lands, never an early zero state', async () => {
      const answer = deferred<ReturnType<typeof jsonResponse>>();
      fetchMock.mockReturnValueOnce(answer.promise);
      render(<SearchClient initialQuery="" initialType="top" />);

      typeQuery('portrait');
      expect(screen.queryByText(/No results/)).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Searching…');

      await settle(299);
      expect(fetchMock).not.toHaveBeenCalled();
      await settle(1);
      expect(requestedUrls()).toEqual(['/api/search?q=portrait&type=top']);
      expect(screen.queryByText(/No results/)).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Searching…');

      answer.resolve(jsonResponse(searchResponse({ query: 'portrait', normalizedQuery: 'portrait' })));
      await settle();
      expect(screen.getByText('No results for “portrait”')).toBeInTheDocument();
      // The zero-state block is a status region too, so read the announcement by its text.
      expect(screen.getByText('0 results for portrait')).toBeInTheDocument();
    });

    it('keeps the previous cards up, marked as loading, while a new query on the same tab loads', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
        creators: { items: [creator('Luna Studio')], nextCursor: null },
      })));
      render(<SearchClient initialQuery="luna" initialType="top" />);
      await settle();
      expect(screen.getByText('Luna Studio')).toBeInTheDocument();

      const answer = deferred<ReturnType<typeof jsonResponse>>();
      fetchMock.mockReturnValueOnce(answer.promise);
      typeQuery('lunar');

      expect(screen.getByText('Luna Studio')).toBeInTheDocument();
      // The visible indicator and the screen-reader status both say so.
      expect(screen.getAllByText('Searching…')).toHaveLength(2);
      expect(screen.queryByText(/No results/)).not.toBeInTheDocument();

      await settle(300);
      answer.resolve(jsonResponse(searchResponse({ query: 'lunar', normalizedQuery: 'lunar' })));
      await settle();
      expect(screen.getByText('No results for “lunar”')).toBeInTheDocument();
      expect(screen.queryByText('Luna Studio')).not.toBeInTheDocument();
    });

    it('switches tabs without waiting for a pause and shows loading instead of a blank body', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
        creators: { items: [creator('Luna Studio')], nextCursor: null },
      })));
      render(<SearchClient initialQuery="luna" initialType="top" />);
      // A URL query is already typed, so it is asked on arrival.
      await settle();
      expect(requestedUrls()).toEqual(['/api/search?q=luna&type=top']);

      const answer = deferred<ReturnType<typeof jsonResponse>>();
      fetchMock.mockReturnValueOnce(answer.promise);
      fireEvent.click(screen.getByRole('tab', { name: 'Posts' }));
      await settle();

      expect(requestedUrls()).toEqual(['/api/search?q=luna&type=top', '/api/search?q=luna&type=posts']);
      expect(screen.queryByText('Luna Studio')).not.toBeInTheDocument();
      // No earlier cards of this tab to keep on show: blocks in the shape of
      // Posts' results, hidden from assistive technology, and the status line
      // alone says "Searching…" (no centred card).
      expect(screen.getAllByText('Searching…')).toEqual([screen.getByRole('status')]);
      const placeholder = document.querySelector('[data-search-placeholder]');
      expect(placeholder?.getAttribute('data-search-placeholder')).toBe('posts');
      expect(placeholder?.getAttribute('aria-hidden')).toBe('true');

      answer.resolve(jsonResponse(searchResponse({
        type: 'posts',
        posts: { items: [post('post-1', 'Moonlit portrait', 4)], nextCursor: null },
      })));
      await settle();
      expect(screen.getByText('Moonlit portrait')).toBeInTheDocument();
      expect(document.querySelector('[data-search-placeholder]')).toBeNull();
    });

    it('clears a failed search as soon as the query changes', async () => {
      fetchMock.mockResolvedValueOnce(failedResponse(500));
      render(<SearchClient initialQuery="luna" initialType="top" />);
      await settle();
      expect(screen.getByText('Search did not load')).toBeInTheDocument();

      typeQuery('lunar');

      expect(screen.queryByText('Search did not load')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Searching…');
    });

    it('counts a handle query without its @, as the server does', async () => {
      render(<SearchClient initialQuery="" initialType="top" />);

      typeQuery('@j');
      await settle(300);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByText(SEARCH_IDLE_TITLE)).toBeInTheDocument();

      typeQuery('@jo');
      await settle(300);
      expect(requestedUrls()).toEqual(['/api/search?q=%40jo&type=top']);
    });

    it('counts an emoji as one character, as the server does', async () => {
      render(<SearchClient initialQuery="" initialType="posts" />);

      typeQuery('\u{1F600}');
      await settle(300);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByText(SEARCH_IDLE_TITLE)).toBeInTheDocument();

      // Two characters: Posts still waits for a third.
      typeQuery('\u{1F600}\u{1F600}');
      await settle(300);
      expect(fetchMock).not.toHaveBeenCalled();

      typeQuery('\u{1F600}\u{1F600}\u{1F600}');
      await settle(300);
      expect(requestedUrls()).toEqual([
        `/api/search?q=${encodeURIComponent('\u{1F600}\u{1F600}\u{1F600}')}&type=posts`,
      ]);
    });

    it('asks for posts only once three characters follow the @', async () => {
      render(<SearchClient initialQuery="" initialType="posts" />);

      typeQuery('@ab');
      await settle(300);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByRole('tab', { name: 'Posts' })).toBeEnabled();

      typeQuery('@abc');
      await settle(300);
      expect(requestedUrls()).toEqual(['/api/search?q=%40abc&type=posts']);
    });

    it('keeps the chosen tab while a query passes through two characters', async () => {
      render(<SearchClient initialQuery="" initialType="posts" />);

      typeQuery('ab');
      await settle(300);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');

      typeQuery('abc');
      await settle(300);
      expect(requestedUrls()[0]).toBe('/api/search?q=abc&type=posts');
      expect(screen.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
      expect(`${window.location.pathname}${window.location.search}`).toBe('/search?q=abc&type=posts');
    });

    it('holds Retry for as long as a 429 says and names the wait', async () => {
      fetchMock.mockResolvedValueOnce(failedResponse(429, {
        error: 'Too many requests. Please wait before trying again.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: 9,
      }));
      render(<SearchClient initialQuery="luna" initialType="top" />);
      await settle();

      expect(screen.getByText('Too many searches at once. Wait 9 s.')).toBeInTheDocument();
      const retry = screen.getByRole('button', { name: 'Try again' });
      expect(retry).toBeDisabled();

      await settle(8_999);
      expect(retry).toBeDisabled();
      await settle(1);
      expect(retry).toBeEnabled();

      fireEvent.click(retry);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByText('No results for “luna”')).toBeInTheDocument();
    });

    it('holds Show more for as long as a 429 on the next page says', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
        type: 'creators',
        creators: { items: [creator('Luna Studio')], nextCursor: 'cursor-2' },
      })));
      render(<SearchClient initialQuery="luna" initialType="creators" />);
      await settle();

      fetchMock.mockResolvedValueOnce(failedResponse(429, { retryAfterSeconds: 5 }));
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      await settle();

      expect(requestedUrls()[1]).toBe('/api/search?q=luna&type=creators&cursor=cursor-2');
      expect(screen.getByRole('alert')).toHaveTextContent('Search did not load. Too many searches at once. Wait 5 s.');
      expect(screen.getByText('Luna Studio')).toBeInTheDocument();
      const showMore = screen.getByRole('button', { name: 'Show more' });
      expect(showMore).toBeDisabled();
      await settle(5_000);
      expect(showMore).toBeEnabled();
    });

    it.each([
      ['a server error', () => Promise.resolve(failedResponse(500)), SEARCH_FAILED_BODY],
      ['a lost connection', () => Promise.reject(new TypeError('Failed to fetch')), SEARCH_OFFLINE_BODY],
    ])('reads %s as its own message with Try again open', async (_label, reply, message) => {
      fetchMock.mockImplementationOnce(reply);
      render(<SearchClient initialQuery="luna" initialType="top" />);
      await settle();

      // The title says what happened and the body what to do, never the same thing twice.
      expect(screen.getByText('Search did not load')).toBeInTheDocument();
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    });

    it('counts saves in the singular and the plural', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
        type: 'posts',
        posts: { items: [post('post-1', 'One save', 1), post('post-2', 'Two saves', 2)], nextCursor: null },
      })));
      render(<SearchClient initialQuery="portrait" initialType="posts" />);
      await settle();

      expect(screen.getByText('1 save')).toBeInTheDocument();
      expect(screen.getByText('2 saves')).toBeInTheDocument();
    });

    it('marks a creator the viewer follows, and only that one', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
        creators: { items: [{ ...creator('Luna Studio'), isFollowing: true }, creator('Luna Lake')], nextCursor: null },
      })));
      render(<SearchClient initialQuery="luna" initialType="top" />);
      await settle();

      expect(screen.getByRole('link', { name: /Luna Studio/ })).toHaveTextContent('Following');
      expect(screen.getByRole('link', { name: /Luna Lake/ })).not.toHaveTextContent('Following');
      expect(screen.getAllByText('Following')).toHaveLength(1);
    });

    it('names who sells a recipe beside its price', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
        type: 'recipes',
        recipes: { items: [recipe('recipe-1', 'Moonlit lighting', 'Luna Studio')], nextCursor: null },
      })));
      render(<SearchClient initialQuery="moonlit" initialType="recipes" />);
      await settle();

      const card = screen.getByRole('link', { name: /Moonlit lighting/ });
      expect(card).toHaveTextContent('Luna Studio');
      expect(card).toHaveTextContent('Free');
    });

    // The row printed the viewer's cash quote; since decision 2 (2026-10-17) a
    // recipe's price on a listing reads in credits on both clients, as the
    // app's search row does, cash-eligible or not.
    it('prices every paid recipe in credits, never the cash quote', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
        type: 'recipes',
        recipes: {
          items: [
            {
              ...recipe('recipe-1', 'Moonlit lighting', 'Luna Studio'),
              accessMode: 'paid',
              priceUsdCents: 900,
              priceQuote: { formatted: '₹750', currency: 'INR', amountSubunits: 75000 },
            },
            {
              ...recipe('recipe-2', 'Moonlit grade', 'Luna Studio'),
              accessMode: 'paid',
              priceUsdCents: 50,
              priceQuote: { formatted: '₹42', currency: 'INR', amountSubunits: 4200 },
            },
          ],
          nextCursor: null,
        },
      })));
      render(<SearchClient initialQuery="moonlit" initialType="recipes" />);
      await settle();

      const cashEligible = screen.getByRole('link', { name: /Moonlit lighting/ });
      expect(cashEligible).toHaveTextContent('900 credits');
      expect(cashEligible).not.toHaveTextContent('₹750');
      const creditsOnly = screen.getByRole('link', { name: /Moonlit grade/ });
      expect(creditsOnly).toHaveTextContent('50 credits');
      expect(creditsOnly).not.toHaveTextContent('₹42');
    });

    describe('Top and Latest', () => {
      const postsAnswer = (sort: 'top' | 'latest', titles: string[], nextCursor: string | null = null) => jsonResponse(
        searchResponse({
          type: 'posts',
          sort,
          // One id per title: a card drawn in both orders is the same post.
          posts: { items: titles.map((title, index) => post(`post-${title}`, title, index)), nextCursor },
        }),
      );
      const address = () => `${window.location.pathname}${window.location.search}`;

      it('offers the two orders on Posts, Top chosen, and asks for Latest when it is picked', async () => {
        fetchMock.mockResolvedValueOnce(postsAnswer('top', ['Most saved portrait', 'Older portrait']));
        render(<SearchClient initialQuery="portrait" initialType="posts" />);
        await settle();

        const sorts = screen.getByRole('radiogroup', { name: 'Sort posts' });
        expect(Array.from(sorts.querySelectorAll('[role="radio"]')).map((radio) => radio.textContent)).toEqual(['Best match', 'Latest']);
        expect(screen.getByRole('radio', { name: 'Best match' })).toBeChecked();
        // The ranked order is the address's default and the request's.
        expect(requestedUrls()).toEqual(['/api/search?q=portrait&type=posts']);
        expect(address()).toBe('/search?q=portrait&type=posts');

        const answer = deferred<ReturnType<typeof jsonResponse>>();
        fetchMock.mockReturnValueOnce(answer.promise);
        fireEvent.click(screen.getByRole('radio', { name: 'Latest' }));
        // No pause: the query has not changed.
        await settle();

        expect(requestedUrls()[1]).toBe('/api/search?q=portrait&type=posts&sort=latest');
        expect(address()).toBe('/search?q=portrait&type=posts&sort=latest');
        expect(screen.getByRole('radio', { name: 'Latest' })).toBeChecked();
        // The other order's cards stay up, marked as loading: the same results, reordered.
        expect(screen.getByText('Most saved portrait')).toBeInTheDocument();
        // Once for a screen reader, once on the page.
        expect(screen.getAllByText('Searching…')).toHaveLength(2);

        answer.resolve(postsAnswer('latest', ['Newest portrait', 'Most saved portrait']));
        await settle();
        expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
          expect.stringContaining('Newest portrait'),
          expect.stringContaining('Most saved portrait'),
        ]);
        expect(screen.queryByText('Searching…')).not.toBeInTheDocument();
      });

      it('opens a shared Latest link on Latest, and a post opened from it comes back to it', async () => {
        fetchMock.mockResolvedValueOnce(postsAnswer('latest', ['Newest portrait']));
        render(<SearchClient initialQuery="portrait" initialType="posts" initialSort="latest" />);
        await settle();

        expect(requestedUrls()).toEqual(['/api/search?q=portrait&type=posts&sort=latest']);
        expect(screen.getByRole('radio', { name: 'Latest' })).toBeChecked();
        const href = screen.getByRole('link', { name: /Newest portrait/ }).getAttribute('href') ?? '';
        expect(new URL(href, 'http://localhost').searchParams.get('returnTo'))
          .toBe('/search?q=portrait&type=posts&sort=latest');
      });

      it('pages Latest with its own cursor and never draws an answer for the other order', async () => {
        fetchMock.mockResolvedValueOnce(postsAnswer('latest', ['Newest portrait'], 'latest-cursor-2'));
        render(<SearchClient initialQuery="portrait" initialType="posts" initialSort="latest" />);
        await settle();

        fetchMock.mockResolvedValueOnce(postsAnswer('latest', ['Older portrait'], 'latest-cursor-3'));
        fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
        await settle();
        expect(requestedUrls()[1]).toBe('/api/search?q=portrait&type=posts&sort=latest&cursor=latest-cursor-2');
        expect(screen.getByText('Newest portrait')).toBeInTheDocument();
        expect(screen.getByText('Older portrait')).toBeInTheDocument();

        // A next page still on its way when the order changes is dropped, not appended.
        const late = deferred<ReturnType<typeof jsonResponse>>();
        fetchMock.mockReturnValueOnce(late.promise);
        fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
        fetchMock.mockResolvedValueOnce(postsAnswer('top', ['Most saved portrait']));
        fireEvent.click(screen.getByRole('radio', { name: 'Best match' }));
        await settle();
        late.resolve(postsAnswer('latest', ['Stray portrait']));
        await settle();
        expect(requestedUrls()[3]).toBe('/api/search?q=portrait&type=posts');
        expect(screen.getByText('Most saved portrait')).toBeInTheDocument();
        expect(screen.queryByText('Stray portrait')).not.toBeInTheDocument();
        expect(screen.queryByText('Newest portrait')).not.toBeInTheDocument();
      });

      it('gives Recipes the same two orders and keeps the choice across the two tabs', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
          type: 'recipes',
          recipes: { items: [recipe('recipe-1', 'Moonlit lighting', 'Luna Studio')], nextCursor: null },
        })));
        render(<SearchClient initialQuery="moonlit" initialType="recipes" />);
        await settle();

        fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
          type: 'recipes',
          sort: 'latest',
          recipes: { items: [recipe('recipe-1', 'Moonlit lighting', 'Luna Studio')], nextCursor: null },
        })));
        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sort recipes' })).getByRole('radio', { name: 'Latest' }));
        await settle();
        expect(requestedUrls()[1]).toBe('/api/search?q=moonlit&type=recipes&sort=latest');

        fetchMock.mockResolvedValueOnce(postsAnswer('latest', ['Moonlit portrait']));
        fireEvent.click(screen.getByRole('tab', { name: 'Posts' }));
        await settle();
        expect(requestedUrls()[2]).toBe('/api/search?q=moonlit&type=posts&sort=latest');
        expect(within(screen.getByRole('radiogroup', { name: 'Sort posts' })).getByRole('radio', { name: 'Latest' })).toBeChecked();
      });

      it('has one order on Top and Creators: no control, and no sort in the request or the address', async () => {
        fetchMock.mockResolvedValue(jsonResponse(searchResponse({
          creators: { items: [creator('Luna Studio')], nextCursor: null },
          posts: { items: [post('post-1', 'Moonlit portrait', 4)], nextCursor: null },
          recipes: { items: [recipe('recipe-1', 'Moonlit lighting', 'Luna Studio')], nextCursor: null },
        })));
        // A link that names Latest on the Top tab: the choice waits for a tab that has it.
        render(<SearchClient initialQuery="luna" initialType="top" initialSort="latest" />);
        await settle();

        expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
        expect(requestedUrls()).toEqual(['/api/search?q=luna&type=top']);
        expect(address()).toBe('/search?q=luna');

        fireEvent.click(screen.getByRole('tab', { name: 'Creators' }));
        await settle();
        expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
        expect(requestedUrls()[1]).toBe('/api/search?q=luna&type=creators');
        expect(address()).toBe('/search?q=luna&type=creators');

        fireEvent.click(screen.getByRole('tab', { name: 'Posts' }));
        await settle();
        expect(requestedUrls()[2]).toBe('/api/search?q=luna&type=posts&sort=latest');
        expect(address()).toBe('/search?q=luna&type=posts&sort=latest');
      });
    });

    describe('entities, filters, the corrected reading and recent searches', () => {
      const HISTORY_KEY = 'magicbooklet:public-search-history:v1';
      const address = () => `${window.location.pathname}${window.location.search}`;
      const kling = { kind: 'model' as const, key: 'kling-2.6', label: 'Kling 2.6', postCount: 14, postCountCapped: false };
      const postsAnswer = (overrides: Partial<PublicSearchResponse> = {}) => jsonResponse(searchResponse({
        type: 'posts',
        posts: { items: [post('post-1', 'Kling portrait', 2)], nextCursor: null },
        ...overrides,
      }));
      const chip = (name: string) => within(screen.getByRole('group', { name: 'Filter posts' })).getByRole('button', { name });

      it('offers the models and tools a query names on Top, and opens the posts made with one', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({
          query: 'kling',
          normalizedQuery: 'kling',
          entities: [kling, { kind: 'tool', key: 'klingon-fx', label: 'Klingon FX', postCount: 1000, postCountCapped: true }],
          creators: { items: [creator('Kling Fan')], nextCursor: null },
        })));
        render(<SearchClient initialQuery="kling" initialType="top" />);
        await settle();

        const list = screen.getByRole('region', { name: 'Models and tools' });
        expect(within(list).getAllByRole('button').map((button) => button.textContent)).toEqual([
          'Kling 2.6Model · 14 posts',
          'Klingon FXTool · 1,000+ posts',
        ]);
        // Entities are results: two of them and a creator.
        expect(screen.getByRole('status')).toHaveTextContent('3 results for kling');

        fetchMock.mockResolvedValueOnce(postsAnswer({
          filters: { madeWith: { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6' }, mediaKind: null, hasRecipe: false, following: false },
        }));
        fireEvent.click(within(list).getByRole('button', { name: 'Kling 2.6, model, 14 posts. Show posts made with it' }));
        // The filter is named at once, from the result pressed, before its answer.
        expect(screen.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
        await settle();

        expect(requestedUrls()[1]).toBe('/api/search?q=kling&type=posts&madeWith=model%3Akling-2.6');
        expect(address()).toBe('/search?q=kling&type=posts&madeWith=model%3Akling-2.6');
        expect(chip('Remove filter: made with Kling 2.6')).toHaveAttribute('aria-pressed', 'true');
        expect(chip('Remove filter: made with Kling 2.6')).toHaveTextContent('Made with Kling 2.6');

        // The chip removes it: the search is asked again unfiltered, and the address follows.
        fetchMock.mockResolvedValueOnce(postsAnswer());
        fireEvent.click(chip('Remove filter: made with Kling 2.6'));
        await settle();
        expect(requestedUrls()[2]).toBe('/api/search?q=kling&type=posts');
        expect(address()).toBe('/search?q=kling&type=posts');
        expect(within(screen.getByRole('group', { name: 'Filter posts' })).queryByRole('button', { name: /made with/i })).not.toBeInTheDocument();
      });

      it('opens exactly the posts an entity’s row counted: a switch left on from an earlier look at Posts is cleared', async () => {
        getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-1', user: { id: 'viewer-1', is_anonymous: false } } } });
        fetchMock.mockImplementation(async (url: string) => jsonResponse(
          url.includes('type=posts')
            ? searchResponse({ type: 'posts', posts: { items: [post('post-1', 'Kling portrait', 2)], nextCursor: null } })
            : searchResponse({ query: 'kling', normalizedQuery: 'kling', entities: [kling] }),
        ));
        render(
          <SearchClient
            initialQuery="kling"
            initialType="top"
            initialFilters={{ madeWith: 'tool:midjourney', mediaKind: 'video', hasRecipe: true, following: true }}
          />,
        );
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Kling 2.6, model, 14 posts. Show posts made with it' }));
        await settle();
        expect(requestedUrls().at(-1)).toBe('/api/search?q=kling&type=posts&madeWith=model%3Akling-2.6');
        for (const name of ['Images', 'Videos', 'Has recipe', 'Following']) expect(chip(name)).toHaveAttribute('aria-pressed', 'false');
      });

      it('draws no entity for a two-character query, whatever an answer carries: there is no Posts search to open', async () => {
        fetchMock.mockResolvedValue(jsonResponse(searchResponse({
          query: 'kl',
          normalizedQuery: 'kl',
          entities: [kling],
          creators: { items: [creator('Klara')], nextCursor: null },
        })));
        render(<SearchClient initialQuery="kl" initialType="top" />);
        await settle();
        expect(screen.getByText('Klara')).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Models and tools' })).not.toBeInTheDocument();
        // And it is not counted as a result.
        expect(screen.getByRole('status')).toHaveTextContent('1 result for kl');

        // With a third character the same answer's entity is drawn.
        fetchMock.mockResolvedValue(jsonResponse(searchResponse({ query: 'kli', normalizedQuery: 'kli', entities: [kling] })));
        typeQuery('kli');
        await settle(300);
        expect(screen.getByRole('region', { name: 'Models and tools' })).toBeInTheDocument();
      });

      it('draws an answer that holds nothing but an entity as a result, never as "No results"', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse({ query: 'kling', normalizedQuery: 'kling', entities: [kling] })));
        render(<SearchClient initialQuery="kling" initialType="top" />);
        await settle();
        expect(within(screen.getByRole('region', { name: 'Models and tools' })).getAllByRole('button')).toHaveLength(1);
        expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('1 result for kling');
      });

      it('draws no entity section for an answer that carries none, as an older server sends', async () => {
        const answer = searchResponse({ creators: { items: [creator('Luna Studio')], nextCursor: null } });
        const older: Partial<PublicSearchResponse> = { ...answer };
        delete older.entities;
        delete older.filters;
        delete older.correctedQuery;
        delete older.exact;
        fetchMock.mockResolvedValueOnce(jsonResponse(older as PublicSearchResponse));
        render(<SearchClient initialQuery="luna" initialType="top" />);
        await settle();
        expect(screen.getByText('Luna Studio')).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Models and tools' })).not.toBeInTheDocument();
        expect(screen.queryByText(/Showing results for/)).not.toBeInTheDocument();
      });

      it('narrows Posts with toggle buttons that say whether they are pressed, and keeps the choice in the address', async () => {
        fetchMock.mockResolvedValue(postsAnswer());
        render(<SearchClient initialQuery="portrait" initialType="posts" />);
        await settle();

        const group = screen.getByRole('group', { name: 'Filter posts' });
        // A visitor follows nobody: no "Following".
        expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(['Images', 'Videos', 'Has recipe']);
        for (const name of ['Images', 'Videos', 'Has recipe']) expect(chip(name)).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(chip('Videos'));
        await settle();
        expect(chip('Videos')).toHaveAttribute('aria-pressed', 'true');
        expect(requestedUrls().at(-1)).toBe('/api/search?q=portrait&type=posts&kind=video');
        expect(address()).toBe('/search?q=portrait&type=posts&kind=video');

        // Images and Videos are one choice.
        fireEvent.click(chip('Images'));
        await settle();
        expect(chip('Images')).toHaveAttribute('aria-pressed', 'true');
        expect(chip('Videos')).toHaveAttribute('aria-pressed', 'false');
        expect(requestedUrls().at(-1)).toBe('/api/search?q=portrait&type=posts&kind=image');

        // Filters combine with each other and with the order.
        fireEvent.click(chip('Has recipe'));
        fireEvent.click(screen.getByRole('radio', { name: 'Latest' }));
        await settle();
        expect(requestedUrls().at(-1)).toBe('/api/search?q=portrait&type=posts&sort=latest&kind=image&recipe=1');
        expect(address()).toBe('/search?q=portrait&type=posts&sort=latest&kind=image&recipe=1');

        // Pressed again a switch is off; Clear filters turns the rest off.
        fireEvent.click(chip('Has recipe'));
        await settle();
        expect(requestedUrls().at(-1)).toBe('/api/search?q=portrait&type=posts&sort=latest&kind=image');
        fireEvent.click(chip('Clear filters'));
        await settle();
        expect(requestedUrls().at(-1)).toBe('/api/search?q=portrait&type=posts&sort=latest');
        expect(within(group).queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
      });

      it('offers "Following" to an account, and never to a visitor or a guest session', async () => {
        getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-1', user: { id: 'viewer-1', is_anonymous: false } } } });
        fetchMock.mockResolvedValue(postsAnswer());
        const { unmount } = render(<SearchClient initialQuery="portrait" initialType="posts" />);
        await settle();
        fireEvent.click(chip('Following'));
        await settle();
        expect(chip('Following')).toHaveAttribute('aria-pressed', 'true');
        expect(requestedUrls().at(-1)).toBe('/api/search?q=portrait&type=posts&following=1');
        unmount();

        getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-2', user: { id: 'guest-1', is_anonymous: true } } } });
        render(<SearchClient initialQuery="portrait" initialType="posts" />);
        await settle();
        expect(within(screen.getByRole('group', { name: 'Filter posts' })).queryByRole('button', { name: 'Following' })).not.toBeInTheDocument();
      });

      it('reads a shared link’s "following" for a visitor as not there: no parameter, no address, no Clear filters', async () => {
        fetchMock.mockResolvedValue(postsAnswer({ posts: { items: [], nextCursor: null } }));
        render(
          <SearchClient
            initialQuery="portrait"
            initialType="posts"
            initialFilters={{ madeWith: null, mediaKind: null, hasRecipe: false, following: true }}
          />,
        );
        await settle();
        // Never sent: the one request names no filter.
        expect(requestedUrls()).toEqual(['/api/search?q=portrait&type=posts']);
        expect(address()).toBe('/search?q=portrait&type=posts');
        const group = screen.getByRole('group', { name: 'Filter posts' });
        expect(within(group).queryByRole('button', { name: 'Following' })).not.toBeInTheDocument();
        expect(within(group).queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
        // An unfiltered search that found nothing says so in the unfiltered words.
        expect(screen.queryByText('No post matches these filters. Remove one, or clear them all.')).not.toBeInTheDocument();
        expect(screen.getByText('Try a shorter phrase, check the spelling, or search for a creator handle.')).toBeInTheDocument();
      });

      it('keeps the other filters of a shared link when it drops a visitor’s "following", and a guest session’s too', async () => {
        getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-2', user: { id: 'guest-1', is_anonymous: true } } } });
        fetchMock.mockResolvedValue(postsAnswer());
        render(
          <SearchClient
            initialQuery="portrait"
            initialType="posts"
            initialFilters={{ madeWith: null, mediaKind: 'video', hasRecipe: false, following: true }}
          />,
        );
        await settle();
        expect(requestedUrls()).toEqual(['/api/search?q=portrait&type=posts&kind=video']);
        expect(address()).toBe('/search?q=portrait&type=posts&kind=video');
        expect(chip('Videos')).toHaveAttribute('aria-pressed', 'true');
      });

      it('opens a shared filtered link filtered, pages it with its filters, and sends a post back to it', async () => {
        fetchMock.mockResolvedValueOnce(postsAnswer({
          filters: { madeWith: { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6' }, mediaKind: 'video', hasRecipe: false, following: false },
          posts: { items: [post('post-1', 'Kling portrait', 2)], nextCursor: 'page-2' },
        }));
        render(
          <SearchClient
            initialQuery="portrait"
            initialType="posts"
            initialFilters={{ madeWith: 'model:kling-2.6', mediaKind: 'video', hasRecipe: false, following: false }}
          />,
        );
        // Before any answer the filter is named by its key: the address holds no name.
        expect(chip('Remove filter: made with kling-2.6')).toBeInTheDocument();
        await settle();
        expect(requestedUrls()[0]).toBe('/api/search?q=portrait&type=posts&madeWith=model%3Akling-2.6&kind=video');
        expect(chip('Remove filter: made with Kling 2.6')).toBeInTheDocument();
        expect(chip('Videos')).toHaveAttribute('aria-pressed', 'true');
        const opened = new URL(screen.getByRole('link', { name: /Kling portrait/ }).getAttribute('href') ?? '', 'http://localhost');
        expect(opened.searchParams.get('returnTo')).toBe('/search?q=portrait&type=posts&madeWith=model%3Akling-2.6&kind=video');

        fetchMock.mockResolvedValueOnce(postsAnswer({ posts: { items: [post('post-2', 'Older Kling portrait', 0)], nextCursor: null } }));
        fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
        await settle();
        expect(requestedUrls()[1]).toBe('/api/search?q=portrait&type=posts&madeWith=model%3Akling-2.6&kind=video&cursor=page-2');
        expect(screen.getByText('Older Kling portrait')).toBeInTheDocument();
      });

      it('keeps the filter switches up over a filtered search that found nothing, and says to remove one', async () => {
        fetchMock.mockResolvedValue(postsAnswer({ posts: { items: [], nextCursor: null } }));
        render(
          <SearchClient
            initialQuery="portrait"
            initialType="posts"
            initialFilters={{ madeWith: null, mediaKind: 'video', hasRecipe: true, following: false }}
          />,
        );
        await settle();
        expect(screen.getByText('No results for “portrait”')).toBeInTheDocument();
        expect(screen.getByText('No post matches these filters. Remove one, or clear them all.')).toBeInTheDocument();
        expect(chip('Videos')).toHaveAttribute('aria-pressed', 'true');
        expect(chip('Clear filters')).toBeInTheDocument();
      });

      it('leaves the Top tab unfiltered and its address clean, and brings the filters back on Posts', async () => {
        fetchMock.mockResolvedValue(jsonResponse(searchResponse({ creators: { items: [creator('Luna Studio')], nextCursor: null } })));
        render(
          <SearchClient
            initialQuery="luna"
            initialType="top"
            initialFilters={{ madeWith: null, mediaKind: 'image', hasRecipe: false, following: false }}
          />,
        );
        await settle();
        expect(screen.queryByRole('group', { name: 'Filter posts' })).not.toBeInTheDocument();
        expect(requestedUrls()).toEqual(['/api/search?q=luna&type=top']);
        expect(address()).toBe('/search?q=luna');

        fireEvent.click(screen.getByRole('tab', { name: 'Posts' }));
        await settle();
        expect(requestedUrls()[1]).toBe('/api/search?q=luna&type=posts&kind=image');
        expect(chip('Images')).toHaveAttribute('aria-pressed', 'true');
      });

      it('says when it read the query as something else, announces it, and searches for it as typed on request', async () => {
        fetchMock.mockResolvedValueOnce(postsAnswer({
          query: 'portriat',
          normalizedQuery: 'portriat',
          correctedQuery: { posts: 'portrait', recipes: null },
        }));
        render(<SearchClient initialQuery="portriat" initialType="posts" />);
        await settle();

        expect(screen.getByText('Showing results for “portrait”')).toBeInTheDocument();
        // One live region, the reading first.
        expect(screen.getByRole('status')).toHaveTextContent('Showing results for “portrait”. 1 result for portriat');

        fetchMock.mockResolvedValueOnce(postsAnswer({
          query: 'portriat', normalizedQuery: 'portriat', exact: true, posts: { items: [], nextCursor: null },
        }));
        fireEvent.click(screen.getByRole('button', { name: 'Search instead for “portriat”' }));
        await settle();
        expect(requestedUrls()[1]).toBe('/api/search?q=portriat&type=posts&exact=1');
        expect(address()).toBe('/search?q=portriat&type=posts&exact=1');
        expect(screen.getByText('Showing results for “portriat” as typed')).toBeInTheDocument();
        expect(screen.getByText('No results for “portriat”')).toBeInTheDocument();
        expect(screen.queryByText('Showing results for “portrait”')).not.toBeInTheDocument();

        // And back.
        fetchMock.mockResolvedValueOnce(postsAnswer({
          query: 'portriat', normalizedQuery: 'portriat', correctedQuery: { posts: 'portrait', recipes: null },
        }));
        fireEvent.click(screen.getByRole('button', { name: 'Use suggested spelling' }));
        await settle();
        expect(requestedUrls()[2]).toBe('/api/search?q=portriat&type=posts');
        expect(screen.getByText('Showing results for “portrait”')).toBeInTheDocument();
      });

      it('reads a new query corrected again: the exact reading belongs to the query it was asked for', async () => {
        fetchMock.mockResolvedValue(postsAnswer({ exact: true }));
        render(<SearchClient initialQuery="portriat" initialType="posts" initialExact />);
        await settle();
        expect(requestedUrls()[0]).toBe('/api/search?q=portriat&type=posts&exact=1');

        typeQuery('lanten');
        await settle(300);
        expect(requestedUrls().at(-1)).toBe('/api/search?q=lanten&type=posts');
        expect(address()).toBe('/search?q=lanten&type=posts');
      });

      it('names both readings on Top when posts and recipes were read differently, and none for Creators', async () => {
        const top = searchResponse({
          query: 'portriat',
          normalizedQuery: 'portriat',
          correctedQuery: { posts: 'portrait', recipes: 'portraits' },
          creators: { items: [creator('Portia')], nextCursor: null },
          posts: { items: [post('post-1', 'Portrait', 1)], nextCursor: null },
          recipes: { items: [recipe('recipe-1', 'Portraits', 'Luna Studio')], nextCursor: null },
        });
        fetchMock.mockResolvedValue(jsonResponse(top));
        render(<SearchClient initialQuery="portriat" initialType="top" />);
        await settle();
        expect(screen.getByText('Showing posts for “portrait” and recipes for “portraits”')).toBeInTheDocument();

        fetchMock.mockResolvedValue(jsonResponse({ ...top, type: 'creators' }));
        fireEvent.click(screen.getByRole('tab', { name: 'Creators' }));
        await settle();
        expect(screen.queryByText(/Showing (results|posts) for/)).not.toBeInTheDocument();
        // Creators are never corrected, so the exact reading is not asked of them either.
        expect(requestedUrls().at(-1)).toBe('/api/search?q=portriat&type=creators');
      });

      it('keeps the corrected spelling among recent searches, and the typed one only when asked for as typed', async () => {
        fetchMock.mockResolvedValue(postsAnswer({
          query: 'portriat', normalizedQuery: 'portriat', correctedQuery: { posts: 'portrait', recipes: null },
        }));
        render(<SearchClient initialQuery="portriat" initialType="posts" />);
        await settle();
        // Enter commits the search on the answer it has.
        fireEvent.submit(screen.getByRole('search'));
        expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]')).toEqual(['portrait']);

        // Asked for as typed, the typed spelling is what the person meant.
        fetchMock.mockResolvedValue(postsAnswer({ query: 'portriat', normalizedQuery: 'portriat', exact: true }));
        fireEvent.click(screen.getByRole('button', { name: 'Search instead for “portriat”' }));
        await settle();
        fireEvent.submit(screen.getByRole('search'));
        expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]')).toEqual(['portriat', 'portrait']);
      });

      it('keeps the typed query for a creator opened, the corrected one for a post opened (review of #784)', async () => {
        fetchMock.mockResolvedValue(jsonResponse(searchResponse({
          query: 'joshh',
          normalizedQuery: 'joshh',
          correctedQuery: { posts: 'josh', recipes: null },
          creators: { items: [creator('Joshh')], nextCursor: null },
          posts: { items: [post('post-1', 'Josh at dusk', 1)], nextCursor: null },
        })));
        render(<SearchClient initialQuery="joshh" initialType="top" />);
        await settle();
        const kept = () => JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]');
        const noNavigation = (event: MouseEvent) => event.preventDefault();
        document.addEventListener('click', noNavigation);
        fireEvent.click(screen.getByText('Joshh'));
        expect(kept()).toEqual(['joshh']);
        fireEvent.click(screen.getByText('Josh at dusk'));
        expect(kept()).toEqual(['josh', 'joshh']);
        document.removeEventListener('click', noNavigation);
      });

      it('keeps the corrected spelling for a search committed before its answer landed', async () => {
        const pending = deferred<ReturnType<typeof jsonResponse>>();
        fetchMock.mockImplementation(() => pending.promise);
        render(<SearchClient initialQuery="" initialType="top" />);
        typeQuery('portriat');
        fireEvent.submit(screen.getByRole('search'));
        await settle(300);
        await act(async () => pending.resolve(jsonResponse(searchResponse({
          query: 'portriat',
          normalizedQuery: 'portriat',
          correctedQuery: { posts: 'portrait', recipes: null },
          posts: { items: [post('post-1', 'Portrait', 1)], nextCursor: null },
        }))));
        await settle();
        expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]')).toEqual(['portrait']);
      });

      it('shows recent searches while the empty box has the focus, each removable, with Clear all', async () => {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(['kling portrait', 'neon harbor']));
        render(<SearchClient initialQuery="" initialType="top" />);
        await settle();
        // Not focused yet in this DOM: the guidance, and no list.
        const field = screen.getByRole('combobox');
        fireEvent.focus(field);

        const recents = screen.getByRole('list', { name: 'Recent searches' });
        expect(within(recents).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['kling portrait', 'neon harbor']);

        fireEvent.click(screen.getByRole('button', { name: 'Remove neon harbor from recent searches' }));
        expect(within(recents).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['kling portrait']);
        expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]')).toEqual(['kling portrait']);

        // A recent search runs again at once: it was typed already.
        fetchMock.mockResolvedValue(jsonResponse(searchResponse({ creators: { items: [creator('Kling Fan')], nextCursor: null } })));
        fireEvent.click(screen.getByRole('button', { name: 'Search again for kling portrait' }));
        await settle(300);
        expect(field).toHaveValue('kling portrait');
        expect(requestedUrls().at(-1)).toBe('/api/search?q=kling+portrait&type=top&related=1');
        expect(screen.queryByRole('list', { name: 'Recent searches' })).not.toBeInTheDocument();

        // Cleared, the box shows them again; Clear all empties the list and the store.
        fireEvent.keyDown(field, { key: 'Escape' });
        fireEvent.focus(field);
        fireEvent.click(screen.getByRole('button', { name: 'Clear all recent searches' }));
        expect(screen.queryByRole('list', { name: 'Recent searches' })).not.toBeInTheDocument();
        expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
      });

      it('offers recent searches on arrival when the empty box already has the focus, with no focus event to hear', async () => {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(['kling portrait']));
        // An empty search autofocuses its box, and the browser focuses it before this script runs.
        render(<SearchClient initialQuery="" initialType="top" />);
        expect(screen.getByRole('combobox')).toHaveFocus();
        await settle();
        expect(screen.getByRole('list', { name: 'Recent searches' })).toBeInTheDocument();
      });

      it('ends recent searches at sign-out, as the app does: on this page at once', async () => {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(['kling portrait']));
        render(<SearchClient initialQuery="" initialType="top" />);
        await settle();
        fireEvent.focus(screen.getByRole('combobox'));
        expect(screen.getByRole('list', { name: 'Recent searches' })).toBeInTheDocument();

        // Another auth event changes nothing.
        act(() => authListeners.forEach((listener) => listener('TOKEN_REFRESHED')));
        expect(screen.getByRole('list', { name: 'Recent searches' })).toBeInTheDocument();

        act(() => authListeners.forEach((listener) => listener('SIGNED_OUT')));
        expect(screen.queryByRole('list', { name: 'Recent searches' })).not.toBeInTheDocument();
        expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
      });

      it('hides recent searches once the focus leaves the box and the list', async () => {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(['kling portrait']));
        render(<SearchClient initialQuery="" initialType="top" />);
        await settle();
        const field = screen.getByRole('combobox');
        fireEvent.focus(field);
        expect(screen.getByRole('list', { name: 'Recent searches' })).toBeInTheDocument();
        // Into the list: still open.
        fireEvent.blur(field, { relatedTarget: screen.getByRole('button', { name: 'Search again for kling portrait' }) });
        expect(screen.getByRole('list', { name: 'Recent searches' })).toBeInTheDocument();
        // Out of both: closed.
        fireEvent.blur(field, { relatedTarget: screen.getByRole('tab', { name: 'Top' }) });
        expect(screen.queryByRole('list', { name: 'Recent searches' })).not.toBeInTheDocument();

        // From a row of the list back to the box it stays open; from a row to anywhere else it closes.
        fireEvent.focus(field);
        const row = screen.getByRole('button', { name: 'Search again for kling portrait' });
        fireEvent.blur(row, { relatedTarget: field });
        expect(screen.getByRole('list', { name: 'Recent searches' })).toBeInTheDocument();
        fireEvent.blur(row, { relatedTarget: screen.getByRole('tab', { name: 'Top' }) });
        expect(screen.queryByRole('list', { name: 'Recent searches' })).not.toBeInTheDocument();
      });

      it('keeps a search committed with Enter or opened from, never each pause in typing', async () => {
        fetchMock.mockResolvedValue(jsonResponse(searchResponse({ creators: { items: [creator('Luna Studio')], nextCursor: null } })));
        render(<SearchClient initialQuery="" initialType="top" />);
        const field = screen.getByRole('combobox');
        typeQuery('lu');
        await settle(300);
        typeQuery('luna');
        await settle(300);
        // Answered twice, nothing kept: nobody acted on either.
        expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();

        fireEvent.submit(field.closest('form') as HTMLFormElement);
        expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]')).toEqual(['luna']);

        // A longer query a result is opened from replaces the step on the way to it.
        typeQuery('luna studio');
        await settle(300);
        fireEvent.click(screen.getByRole('link', { name: /Luna Studio/ }));
        expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]')).toEqual(['luna studio']);
      });

      it('keeps a search committed before its answer only once that answer finds something', async () => {
        const answer = deferred<ReturnType<typeof jsonResponse>>();
        fetchMock.mockReturnValueOnce(answer.promise);
        render(<SearchClient initialQuery="zzzznope" initialType="top" />);
        await settle();
        fireEvent.submit(screen.getByRole('combobox').closest('form') as HTMLFormElement);
        answer.resolve(jsonResponse(searchResponse()));
        await settle();
        expect(screen.getByText('No results for “zzzznope”')).toBeInTheDocument();
        expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
      });

      it('searches the same with storage that throws, as a private window can', async () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
        fetchMock.mockResolvedValue(jsonResponse(searchResponse({ creators: { items: [creator('Luna Studio')], nextCursor: null } })));
        render(<SearchClient initialQuery="luna" initialType="top" />);
        await settle();
        fireEvent.submit(screen.getByRole('combobox').closest('form') as HTMLFormElement);
        expect(screen.getByText('Luna Studio')).toBeInTheDocument();
        getItem.mockRestore();
        setItem.mockRestore();
      });
    });
  });
});

describe('SearchClient opened from the top bar', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(searchResponse({ creators: { items: [creator('Luna Studio')], nextCursor: null } })));
    suggestFetchMock.mockReset();
    suggestFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ query: 'luna', normalizedQuery: 'luna', creators: [], entities: [], completions: [{ text: 'luna portrait' }] }),
    });
    vi.stubGlobal('fetch', fetchBySurface);
    window.history.replaceState(null, '', '/search');
  });

  afterEach(() => {
    cleanup();
    clearSearchFieldHandoff();
    vi.unstubAllGlobals();
  });

  it('takes the focus into its field, with the typeahead closed over the committed search', async () => {
    markSearchFieldHandoff();
    render(<SearchClient initialQuery="luna" initialType="top" />);
    expect(screen.getByRole('combobox')).toHaveFocus();
    await screen.findByText('Luna Studio');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(searchFieldHandoffPending()).toBe(false);

    // Typing on is a new search, and the list is offered for it.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'luna p' } });
    expect(await screen.findByRole('listbox', { name: 'Search suggestions' })).toBeInTheDocument();
  });

  it('leaves the focus alone for a search opened any other way: a shared link does not pull a keyboard up', async () => {
    render(<SearchClient initialQuery="luna" initialType="top" />);
    await screen.findByText('Luna Studio');
    expect(screen.getByRole('combobox')).not.toHaveFocus();
  });
});
