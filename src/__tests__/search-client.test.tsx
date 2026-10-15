import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchClient from '@/app/search/SearchClient';
import type { CreatorSearchResult, PublicSearchResponse, RecipeSearchResult } from '@/lib/public-search';
import type { ShowcaseFeedItem } from '@/lib/showcase';

// One stable router object, like Next's real one. SearchClient keeps the URL in
// step through history.replaceState; the mock catches a return to
// router.replace, which re-rendered this dynamic page on every keystroke.
const { replaceMock, routerMock } = vi.hoisted(() => {
  const replace = vi.fn();
  return { replaceMock: replace, routerMock: { replace } };
});
const getSessionMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
    },
  },
}));

function searchResponse(overrides: Partial<PublicSearchResponse> = {}): PublicSearchResponse {
  return {
    query: 'luna',
    normalizedQuery: 'luna',
    type: 'top',
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
  fireEvent.change(screen.getByRole('searchbox'), { target: { value } });
}

describe('SearchClient', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    getSessionMock.mockReset();
    fetchMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue(jsonResponse(searchResponse()));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('renders the initial guidance state until two characters are typed', () => {
    render(<SearchClient initialQuery="" initialType="top" />);

    expect(screen.getByText('Start with a creator or idea')).toBeInTheDocument();
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

  it('forces a two-character query onto the creators tab and disables content tabs', async () => {
    render(<SearchClient initialQuery="ab" initialType="posts" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/search?q=ab&type=creators');
    expect(screen.getByRole('tab', { name: 'Posts' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Recipes' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Creators' })).toHaveAttribute('aria-selected', 'true');
  });

  it('clears the query with Escape and returns to the initial state', async () => {
    render(<SearchClient initialQuery="luna" initialType="top" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });

    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });

    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect(await screen.findByText('Start with a creator or idea')).toBeInTheDocument();
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
      expect(screen.getAllByText('Searching…')).toHaveLength(2);

      answer.resolve(jsonResponse(searchResponse({
        type: 'posts',
        posts: { items: [post('post-1', 'Moonlit portrait', 4)], nextCursor: null },
      })));
      await settle();
      expect(screen.getByText('Moonlit portrait')).toBeInTheDocument();
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
      expect(screen.getByText('Start with a creator or idea')).toBeInTheDocument();

      typeQuery('@jo');
      await settle(300);
      expect(requestedUrls()).toEqual(['/api/search?q=%40jo&type=top']);
    });

    it('keeps posts and recipes closed until three characters follow the @', async () => {
      render(<SearchClient initialQuery="" initialType="posts" />);

      typeQuery('@ab');
      await settle(300);
      expect(requestedUrls()).toEqual(['/api/search?q=%40ab&type=creators']);
      expect(screen.getByRole('tab', { name: 'Posts' })).toBeDisabled();
      expect(screen.getByRole('tab', { name: 'Recipes' })).toBeDisabled();

      typeQuery('@abc');
      await settle(300);
      expect(requestedUrls()[1]).toBe('/api/search?q=%40abc&type=posts');
    });

    it('returns to the chosen tab once a query passes through two characters', async () => {
      render(<SearchClient initialQuery="" initialType="posts" />);

      typeQuery('ab');
      await settle(300);
      expect(requestedUrls()).toEqual(['/api/search?q=ab&type=creators']);
      expect(screen.getByRole('tab', { name: 'Creators' })).toHaveAttribute('aria-selected', 'true');

      typeQuery('abc');
      await settle(300);
      expect(requestedUrls()[1]).toBe('/api/search?q=abc&type=posts');
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

      expect(screen.getByText('Search is busy. Try again in 9 s.')).toBeInTheDocument();
      const retry = screen.getByRole('button', { name: 'Retry' });
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
      expect(screen.getByRole('alert')).toHaveTextContent('Search is busy. Try again in 5 s.');
      expect(screen.getByText('Luna Studio')).toBeInTheDocument();
      const showMore = screen.getByRole('button', { name: 'Show more' });
      expect(showMore).toBeDisabled();
      await settle(5_000);
      expect(showMore).toBeEnabled();
    });

    it.each([
      ['a server error', () => Promise.resolve(failedResponse(500)), 'Search could not be loaded.'],
      [
        'a lost connection',
        () => Promise.reject(new TypeError('Failed to fetch')),
        'Search could not be loaded. Check your connection and try again.',
      ],
    ])('reads %s as its own message with Retry open', async (_label, reply, message) => {
      fetchMock.mockImplementationOnce(reply);
      render(<SearchClient initialQuery="luna" initialType="top" />);
      await settle();

      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
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

    // The row printed the cash quote, which priced a credits-only recipe in a
    // currency no checkout takes.
    it('prices a paid recipe in one figure, and a credits-only one in credits', async () => {
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

      expect(screen.getByRole('link', { name: /Moonlit lighting/ })).toHaveTextContent('₹750');
      const creditsOnly = screen.getByRole('link', { name: /Moonlit grade/ });
      expect(creditsOnly).toHaveTextContent('50 credits');
      expect(creditsOnly).not.toHaveTextContent('₹42');
    });
  });
});
