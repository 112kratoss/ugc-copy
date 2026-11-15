import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchClient from '@/app/search/SearchClient';
import { AppShellSearch } from '@/components/AppShellSearch';
import { markSearchFieldHandoff } from '@/components/search/search-field-handoff';
import type { PublicSearchResponse } from '@/lib/public-search';
import type { ShowcaseFeedItem } from '@/lib/showcase';

import { SEARCH_RELATED_SEARCHES_MAX, SEARCH_RELATED_THIN_POSTS } from '../../ugc-mobile/lib/public-search-policy/public-search-policy';
import { searchStarterHeading, type SearchStarterResponse } from '../../ugc-mobile/lib/public-search-policy/search-starter';
import { SEARCH_TYPEAHEAD_DEBOUNCE_MS, type SearchSuggestResponse } from '../../ugc-mobile/lib/public-search-policy/search-typeahead';
import { SEARCH_FOLLOW_FAILED, SEARCH_RELATED_SEARCHES_HEADING } from '../../ugc-mobile/lib/public-search-policy/search-ui-words';

// The web half of the search benchmark's fixes (2026-11-15), drawn by the real
// search page and the real top bar over stubbed requests: the start screen's
// pictures and "this week" headings, Follow on a creator row, the related
// searches over an answer, the blended order once a search is settled on, and
// the typeahead's catalog rows. A browser's view of them, at a desktop's and
// a phone's width: tests/e2e/search-ui-web.spec.ts.

const { pushMock, routerMock, pushToastMock } = vi.hoisted(() => {
  const push = vi.fn();
  return { pushMock: push, routerMock: { push, replace: vi.fn() }, pushToastMock: vi.fn() };
});
const getSessionMock = vi.fn();
const searchFetchMock = vi.fn();
const starterFetchMock = vi.fn();
const suggestFetchMock = vi.fn();
const followFetchMock = vi.fn();
const openedFetchMock = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));
vi.mock('next/form', () => ({
  default: ({ action, children, ...props }: React.ComponentProps<'form'> & { action: string }) => (
    <form {...props} action={action}>{children}</form>
  ),
}));
vi.mock('@/lib/use-leave-guard', () => ({ holdForLeaveGuard: () => false }));
vi.mock('@/components/feedback-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/feedback-state')>()),
  pushToast: (toast: unknown) => pushToastMock(toast),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}));

const VIEWER = { access_token: 'token-1', user: { id: 'viewer-1', is_anonymous: false } };
const GUEST = { access_token: 'guest-token', user: { id: 'guest-1', is_anonymous: true } };
const signedIn = (session: unknown) => getSessionMock.mockResolvedValue({ data: { session } });

function thumbnail(postId: string, thumbhash: string | null = null) {
  return { postId, url: `https://cdn.example.com/${postId}.webp`, thumbhash, width: 720, height: 960, mediaKind: 'image' as const };
}

const STARTER: SearchStarterResponse = {
  entities: [
    {
      kind: 'model', key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 200, postCountCapped: true, query: 'nano banana pro',
      // A thumbhash from the format's own examples: the blur under the picture while it loads.
      thumbnail: thumbnail('p-nano', '1QcSHQRnh493V4dIh4eXh1h4kJUI'),
    },
    { kind: 'tool', key: 'midjourney', label: 'Midjourney', postCount: 14, postCountCapped: false, query: 'midjourney', thumbnail: null },
  ],
  creators: [
    { id: 'c1', username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 42, isFollowing: false },
    { id: 'viewer-1', username: 'me', displayName: 'Me', bio: null, avatarUrl: null, publicPostCount: 3, isFollowing: false },
  ],
  searches: [{ text: 'portrait', thumbnail: thumbnail('p-portrait') }, { text: 'anime', thumbnail: null }],
  periods: { entities: 'week', creators: 'all', searches: 'week' },
};

function post(id: string): ShowcaseFeedItem {
  return { id, title: `Post ${id}`, saveCount: 0, commentCount: 0, creator: { name: 'Luna' }, mediaItems: [], mediaKind: null, mediaUrl: null } as unknown as ShowcaseFeedItem;
}
const posts = (count: number, from = 0) => Array.from({ length: count }, (_, index) => post(`p${from + index}`));

function creator(id: string, displayName: string, isFollowing = false) {
  return { id, username: displayName.toLowerCase().replace(/\s+/g, '-'), displayName, avatarUrl: null, bio: null, publicPostCount: 3, isFollowing };
}

function answer(query: string, type: string, overrides: Partial<PublicSearchResponse> & { relatedSearches?: unknown; blended?: boolean } = {}): PublicSearchResponse {
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
  } as PublicSearchResponse;
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const searchUrls = () => searchFetchMock.mock.calls.map(([url]) => url as string);
const settle = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const box = () => screen.getByRole('combobox');
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const enter = () => fireEvent.submit(screen.getByRole('search'));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/search');
  getSessionMock.mockReset();
  signedIn(null);
  pushMock.mockReset();
  pushToastMock.mockReset();
  starterFetchMock.mockReset();
  starterFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
  suggestFetchMock.mockReset();
  suggestFetchMock.mockResolvedValue(ok({ query: '', normalizedQuery: '', creators: [], entities: [], completions: [] }));
  followFetchMock.mockReset();
  followFetchMock.mockResolvedValue(ok({ following: true }));
  openedFetchMock.mockReset();
  openedFetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
  searchFetchMock.mockReset();
  searchFetchMock.mockImplementation(async (url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    return ok(answer(params.get('q') ?? '', params.get('type') ?? 'top'));
  });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith('/api/search/starter')) return starterFetchMock(url, init);
    if (path.startsWith('/api/search/suggest')) return suggestFetchMock(url, init);
    if (path.startsWith('/api/search/opened')) return openedFetchMock(url, init);
    if (path.startsWith('/api/profile/follow')) return followFetchMock(url, init);
    return searchFetchMock(url, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the start screen', () => {
  beforeEach(() => {
    starterFetchMock.mockResolvedValue(ok(STARTER));
  });

  it('says "this week" over a list only when its answer says the list is the week’s', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    const starter = await screen.findByRole('region', { name: 'Ideas to start a search' });
    expect(within(starter).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      searchStarterHeading('entities', 'week'),
      searchStarterHeading('creators', 'all'),
      searchStarterHeading('searches', 'week'),
    ]);
    expect(within(starter).getByRole('heading', { name: 'Popular this week' })).toBeTruthy();
    expect(within(starter).getByRole('heading', { name: 'Creators to follow' })).toBeTruthy();
  });

  it('draws the picture a model, tool or search carries, and its glyph in the same frame where it has none', async () => {
    render(<SearchClient initialQuery="" initialType="top" />);
    const nano = await screen.findByRole('button', { name: /^Nano Banana Pro, model/ });
    const midjourney = screen.getByRole('button', { name: /^Midjourney, tool/ });
    const portrait = screen.getByRole('button', { name: 'Search for portrait' });
    const anime = screen.getByRole('button', { name: 'Search for anime' });

    const picture = (row: HTMLElement) => row.querySelector('[data-search-picture]');
    expect(picture(nano)?.getAttribute('data-search-picture')).toBe('picture');
    expect(picture(nano)?.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/p-nano.webp');
    // Decorative: the row's name says what it is.
    expect(picture(nano)?.getAttribute('aria-hidden')).toBe('true');
    expect(picture(nano)?.querySelector('img')?.getAttribute('alt')).toBe('');
    // The thumbhash's blur stands under it while it loads.
    expect((picture(nano) as HTMLElement).style.backgroundImage).toContain('data:image/png;base64,');
    expect(picture(portrait)?.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/p-portrait.webp');

    expect(picture(midjourney)?.getAttribute('data-search-picture')).toBe('placeholder');
    expect(picture(midjourney)?.querySelector('img')).toBeNull();
    expect(picture(midjourney)?.querySelector('svg')).not.toBeNull();
    expect(picture(anime)?.getAttribute('data-search-picture')).toBe('placeholder');

    // A picture that fails to load is never a broken image: the glyph comes back.
    fireEvent.error(picture(nano)!.querySelector('img')!);
    expect(picture(nano)?.getAttribute('data-search-picture')).toBe('placeholder');
    expect(picture(nano)?.querySelector('img')).toBeNull();
    // The names are unchanged: a picture adds no words.
    expect(nano.getAttribute('aria-label')).toMatch(/^Nano Banana Pro, model/);
  });

  it('follows a creator from the row without leaving the page, and never as a result opened', async () => {
    signedIn(VIEWER);
    render(<SearchClient initialQuery="" initialType="top" />);
    const follow = await screen.findByRole('button', { name: 'Follow Luna Studio' });
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    // Beside the row's link, never in it, and no row of the start screen is a result.
    expect(follow.closest('a')).toBeNull();
    expect(follow.hasAttribute('data-search-result')).toBe(false);
    const link = screen.getByRole('link', { name: /Luna Studio's profile/ });
    expect(link.hasAttribute('data-search-result')).toBe(false);
    expect(link.getAttribute('href')).toBe('/creators/luna-studio');

    const server = deferred<ReturnType<typeof ok>>();
    followFetchMock.mockReturnValueOnce(server.promise);
    fireEvent.click(follow);
    // Answered before the server has: the press is the creator page's own, put back if refused.
    expect((await screen.findByRole('button', { name: 'Following Luna Studio' })).getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      server.resolve(ok({ following: true }));
      await server.promise;
    });
    await waitFor(() => expect(followFetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = followFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/profile/follow');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    expect(JSON.parse(String(init.body))).toEqual({ followingId: 'c1', following: true });
    await settle();
    expect(screen.getByRole('button', { name: 'Following Luna Studio' })).toBeTruthy();
    expect(pushMock).not.toHaveBeenCalled();
    expect(openedFetchMock).not.toHaveBeenCalled();
  });

  it('offers no Follow on the viewer’s own row', async () => {
    signedIn(VIEWER);
    render(<SearchClient initialQuery="" initialType="top" />);
    await screen.findByRole('button', { name: 'Follow Luna Studio' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Follow Me$/ })).toBeNull());
    expect(screen.getByRole('link', { name: /Me's profile/ })).toBeTruthy();
  });

  it.each([
    ['a visitor', null],
    ['a guest session', GUEST],
  ])('sends %s to sign in and back to this search, following nobody', async (_who, session) => {
    signedIn(session);
    render(<SearchClient initialQuery="" initialType="top" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Follow Luna Studio' }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login?returnUrl=%2Fsearch'));
    expect(followFetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Follow Luna Studio' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('puts a refused follow back, and says so in the creator page’s words', async () => {
    signedIn(VIEWER);
    followFetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<SearchClient initialQuery="" initialType="top" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Follow Luna Studio' }));
    await waitFor(() => expect(pushToastMock).toHaveBeenCalledWith({ tone: 'error', message: SEARCH_FOLLOW_FAILED }));
    expect(screen.getByRole('button', { name: 'Follow Luna Studio' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Follow on a creator result', () => {
  it('follows from the card, keeps the card’s link the one result it counts, and asks nothing of the search log', async () => {
    signedIn(VIEWER);
    searchFetchMock.mockResolvedValue(ok(answer('luna', 'top', {
      creators: { items: [creator('c1', 'Luna Studio'), creator('c2', 'Luna Lake', true), creator('viewer-1', 'Me')], nextCursor: null },
    })));
    render(<SearchClient initialQuery="luna" initialType="top" />);
    const follow = await screen.findByRole('button', { name: 'Follow Luna Studio' });
    expect(screen.getByRole('button', { name: 'Following Luna Lake' }).getAttribute('aria-pressed')).toBe('true');
    // The viewer's own card opens their profile and offers nothing to follow.
    expect(screen.queryByRole('button', { name: /^Follow(ing)? Me$/ })).toBeNull();
    // The links, in rank order, are what the search log counts; the buttons are not among them.
    expect([...document.querySelectorAll('[data-search-result]')].map((node) => [node.tagName, node.getAttribute('data-search-result-id')]))
      .toEqual([['A', 'c1'], ['A', 'c2'], ['A', 'viewer-1']]);

    fireEvent.click(follow);
    await waitFor(() => expect(followFetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((followFetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ followingId: 'c1', following: true });
    await settle();
    expect(screen.getByRole('button', { name: 'Following Luna Studio' })).toBeTruthy();
    // The link's name says it too.
    expect(screen.getByRole('link', { name: /Luna Studio's profile, @luna-studio, following/ })).toBeTruthy();
    // A press on Follow opens nothing: no open told to the log, no recent search kept.
    expect(openedFetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('magicbooklet:public-search-history:v1')).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();

    // Unfollow is the same press.
    followFetchMock.mockResolvedValue(ok({ following: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Following Luna Lake' }));
    await waitFor(() => expect(followFetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((followFetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ followingId: 'c2', following: false });
    await settle();
    expect(screen.getByRole('button', { name: 'Follow Luna Lake' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('related searches', () => {
  const RELATED = ['neon harbour', 'harbour at night', 'fog lights', 'rainy pier', 'lighthouse', 'sea glass', 'one too many']
    .map((text) => ({ text }));

  it('asks for them with the first page of Top and Posts, and nowhere else', async () => {
    searchFetchMock.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      const kind = params.get('type') ?? 'top';
      return ok(answer('harbour', kind, {
        posts: { items: posts(3), nextCursor: kind === 'posts' && !params.get('cursor') ? 'page-2' : null },
        creators: { items: [creator('c1', 'Harbour Studio')], nextCursor: kind === 'creators' && !params.get('cursor') ? 'creators-2' : null },
      }));
    });
    render(<SearchClient initialQuery="harbour" initialType="top" />);
    await waitFor(() => expect(searchUrls()).toHaveLength(1));
    const asksRelated = (url: string | undefined) => new URL(url ?? '', 'http://localhost').searchParams.get('relatedSearches');
    expect(asksRelated(searchUrls()[0])).toBe('1');

    fireEvent.click(screen.getByRole('tab', { name: 'Creators' }));
    await waitFor(() => expect(searchUrls()).toHaveLength(2));
    expect(asksRelated(searchUrls()[1])).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(searchUrls()).toHaveLength(3));
    expect(asksRelated(searchUrls()[2])).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Recipes' }));
    await waitFor(() => expect(searchUrls().filter((url) => url.includes('type=recipes'))).toHaveLength(1));
    expect(asksRelated(searchUrls().find((url) => url.includes('type=recipes')))).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Posts' }));
    await waitFor(() => expect(searchUrls().filter((url) => url.includes('type=posts'))).toHaveLength(1));
    expect(asksRelated(searchUrls().find((url) => url.includes('type=posts')))).toBe('1');
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(searchUrls().filter((url) => url.includes('type=posts'))).toHaveLength(2));
    expect(asksRelated(searchUrls().filter((url) => url.includes('type=posts'))[1])).toBeNull();
  });

  it('draws six at most as chips over the results, and searches one pressed as a search settled on from them', async () => {
    searchFetchMock.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      const query = params.get('q') ?? '';
      return ok(answer(query, params.get('type') ?? 'top', {
        posts: { items: posts(SEARCH_RELATED_THIN_POSTS), nextCursor: null },
        relatedSearches: query === 'harbour' ? RELATED : [],
      }));
    });
    render(<SearchClient initialQuery="harbour" initialType="top" />);
    const section = await screen.findByRole('region', { name: SEARCH_RELATED_SEARCHES_HEADING });
    const chips = within(section).getAllByRole('button');
    expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual(
      RELATED.slice(0, SEARCH_RELATED_SEARCHES_MAX).map(({ text }) => `Search for ${text}`),
    );
    expect(chips.map((chip) => chip.textContent)).toEqual(RELATED.slice(0, SEARCH_RELATED_SEARCHES_MAX).map(({ text }) => text));
    // Near the top: before the answer's own sections.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings.indexOf(SEARCH_RELATED_SEARCHES_HEADING)).toBeLessThan(headings.indexOf('Posts'));
    // Not results: nothing on them for the search log to count.
    expect(section.querySelector('[data-search-result]')).toBeNull();
    expect(section.querySelector('a')).toBeNull();

    fireEvent.click(within(section).getByRole('button', { name: 'Search for neon harbour' }));
    expect(box()).toHaveValue('neon harbour');
    // At once, as a search settled on: related posts, the blended order (two words), entered from the chips.
    await waitFor(() => expect(searchUrls().at(-1)).toBe('/api/search?q=neon+harbour&type=top&related=1&relatedSearches=1&blend=1&entry=related'));
    // That search has none: no heading, no empty row.
    await waitFor(() => expect(screen.queryByRole('region', { name: SEARCH_RELATED_SEARCHES_HEADING })).toBeNull());
    expect(openedFetchMock).not.toHaveBeenCalled();
  });

  it('keeps the tab, the order and the filters it was pressed under', async () => {
    searchFetchMock.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      return ok(answer(params.get('q') ?? '', params.get('type') ?? 'top', {
        posts: { items: posts(SEARCH_RELATED_THIN_POSTS), nextCursor: null },
        relatedSearches: [{ text: 'rainy pier' }],
      }));
    });
    render(
      <SearchClient
        initialQuery="harbour"
        initialType="posts"
        initialFilters={{ madeWith: null, mediaKind: 'video', hasRecipe: false, following: false }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Search for rainy pier' }));
    await waitFor(() => expect(searchUrls().at(-1)).toBe('/api/search?q=rainy+pier&type=posts&kind=video&relatedSearches=1&blend=1&entry=related'));
    expect(screen.getByRole('tab', { name: 'Posts' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('the blended order', () => {
  it('is asked for once the person settles on a search the answer came for while typing, with the cards dimmed meanwhile', async () => {
    const blended = deferred<ReturnType<typeof ok>>();
    searchFetchMock.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      if (params.get('blend') === '1') return blended.promise;
      return ok(answer(params.get('q') ?? '', params.get('type') ?? 'top', {
        posts: { items: posts(SEARCH_RELATED_THIN_POSTS), nextCursor: 'word-2' },
      }));
    });
    render(<SearchClient initialQuery="" initialType="posts" />);
    type('ocean at dusk');
    await waitFor(() => expect(searchUrls()).toEqual(['/api/search?q=ocean+at+dusk&type=posts&relatedSearches=1&entry=typed']));
    await screen.findByText('Post p0');
    // Left alone while typing, it stays in the word order.
    await settle(SEARCH_TYPEAHEAD_DEBOUNCE_MS);
    expect(searchUrls()).toHaveLength(1);

    enter();
    await waitFor(() => expect(searchUrls()).toHaveLength(2));
    expect(searchUrls()[1]).toBe('/api/search?q=ocean+at+dusk&type=posts&related=1&relatedSearches=1&blend=1&entry=typed');
    // The cards stay, dimmed, and the field says it is busy: an answer on its way, not cards moving under the pointer.
    const results = document.querySelector('[aria-busy]');
    expect(results?.getAttribute('aria-busy')).toBe('true');
    expect(results?.querySelector('.opacity-60')).not.toBeNull();
    expect(document.querySelector('[data-search-field-busy]')).not.toBeNull();

    await act(async () => {
      blended.resolve(ok(answer('ocean at dusk', 'posts', {
        posts: { items: posts(SEARCH_RELATED_THIN_POSTS, 100), nextCursor: 'blend-2' },
        blended: true,
      })));
      await blended.promise;
    });
    await screen.findByText('Post p100');
    expect(document.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('false');
    expect(document.querySelector('[data-search-field-busy]')).toBeNull();
    // Asked for once.
    await settle(SEARCH_TYPEAHEAD_DEBOUNCE_MS);
    expect(searchUrls()).toHaveLength(2);

    // Every later page of it in the same order.
    searchFetchMock.mockResolvedValue(ok(answer('ocean at dusk', 'posts', { posts: { items: posts(3, 200), nextCursor: null } })));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(searchUrls()).toHaveLength(3));
    expect(searchUrls()[2]).toBe('/api/search?q=ocean+at+dusk&type=posts&cursor=blend-2&blend=1&entry=typed');
  });

  it.each([
    ['one word', 'ocean', {}],
    ['Latest', 'ocean at dusk', { initialSort: 'latest' as const }],
    ['a handle', '@ocean at dusk', {}],
  ])('is never asked for %s', async (_case, query, props) => {
    searchFetchMock.mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      return ok(answer(params.get('q') ?? '', params.get('type') ?? 'top', { posts: { items: posts(SEARCH_RELATED_THIN_POSTS), nextCursor: null } }));
    });
    render(<SearchClient initialQuery="" initialType="posts" {...props} />);
    type(query);
    await waitFor(() => expect(searchUrls()).toHaveLength(1));
    enter();
    await settle(SEARCH_TYPEAHEAD_DEBOUNCE_MS);
    expect(searchUrls().some((url) => url.includes('blend='))).toBe(false);
  });

  it('comes with the first request of a search the top bar handed over, which was settled there', async () => {
    markSearchFieldHandoff(Date.now(), 'suggestion');
    render(<SearchClient initialQuery="ocean at dusk" initialType="top" />);
    await waitFor(() => expect(searchUrls()).toHaveLength(1));
    expect(searchUrls()[0]).toBe('/api/search?q=ocean+at+dusk&type=top&related=1&relatedSearches=1&blend=1&entry=suggestion');
  });

  it('waits, for an address opened as it was and a model’s row from the top bar, until the person settles on it', async () => {
    const { unmount } = render(<SearchClient initialQuery="ocean at dusk" initialType="top" />);
    await waitFor(() => expect(searchUrls()).toHaveLength(1));
    expect(searchUrls()[0]).toBe('/api/search?q=ocean+at+dusk&type=top&relatedSearches=1&entry=link');
    unmount();

    searchFetchMock.mockClear();
    markSearchFieldHandoff(Date.now(), 'entity');
    render(
      <SearchClient
        initialQuery="ocean at dusk"
        initialType="posts"
        initialFilters={{ madeWith: 'model:kling-2.6', mediaKind: null, hasRecipe: false, following: false }}
      />,
    );
    await waitFor(() => expect(searchUrls()).toHaveLength(1));
    expect(searchUrls()[0]).toBe('/api/search?q=ocean+at+dusk&type=posts&madeWith=model%3Akling-2.6&relatedSearches=1&entry=entity');
  });
});

describe('the typeahead’s catalog rows', () => {
  const SEEDANCE = {
    kind: 'model', key: 'seedance-1.5-pro', label: 'Seedance 1.5 Pro', postCount: 0, postCountCapped: false, thumbnail: null,
    inCatalog: true, catalogModel: { id: 'seedance-1.5-pro', kind: 'video', web: true, mobile: true }, query: null,
  };
  const APP_ONLY = {
    kind: 'model', key: 'app-only-model', label: 'App Only Model', postCount: 0, postCountCapped: false, thumbnail: null,
    inCatalog: true, catalogModel: { id: 'app-only-model', kind: 'image', web: false, mobile: true }, query: null,
  };
  const STABILITY = {
    kind: 'tool', key: 'stability-ai', label: 'Stability AI', postCount: 5, postCountCapped: false,
    thumbnail: thumbnail('p-stability'), inCatalog: false, catalogModel: null, query: 'stability ai',
  };
  const ANSWER: SearchSuggestResponse = {
    query: 'sdx', normalizedQuery: 'sdx', creators: [],
    entities: [SEEDANCE, APP_ONLY, STABILITY] as SearchSuggestResponse['entities'],
    completions: [{ text: 'stability ai' }, { text: 'Seedance 1.5 Pro' }, { text: 'sdxl portraits' }],
  };
  /** The list has stood still long enough for a row to take a press. */
  const settledList = () => waitFor(() => expect(screen.getByRole('listbox').hasAttribute('aria-busy')).toBe(false));
  const options = () => screen.getAllByRole('option').map((option) => option.getAttribute('aria-label'));

  beforeEach(() => {
    suggestFetchMock.mockResolvedValue(ok(ANSWER));
  });

  it('asks for every known name, draws what the web can open, and does not suggest a row’s name again as a search', async () => {
    render(<AppShellSearch />);
    fireEvent.focus(box());
    type('sdx');
    await screen.findByRole('listbox', { name: 'Search suggestions' });
    expect(suggestFetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/search/suggest?q=sdx&catalog=1']);
    expect(options()).toEqual([
      'Seedance 1.5 Pro, video model, no posts yet. Open the video creator with it',
      expect.stringMatching(/^Stability AI, tool/),
      'Search for sdxl portraits',
    ]);
    // Never "0 posts": what pressing it does.
    const seedance = screen.getByRole('option', { name: /^Seedance 1\.5 Pro/ });
    expect(seedance.textContent).toContain('Video model · Generate with it');
    expect(seedance.textContent).not.toContain('0 posts');
    // The row's own picture, or its glyph; the name drawn whole, whatever was typed.
    const stability = screen.getByRole('option', { name: /^Stability AI/ });
    expect(stability.querySelector('[data-search-picture="picture"] img')?.getAttribute('src')).toBe('https://cdn.example.com/p-stability.webp');
    expect(seedance.querySelector('[data-search-picture="placeholder"]')).not.toBeNull();
    expect(stability.textContent).toContain('Stability AI');
  });

  it('offers a catalog row from two characters, as the server answers a box that asks with the catalog', async () => {
    render(<AppShellSearch />);
    fireEvent.focus(box());
    // One character: a suggested search at most, never a model or tool.
    type('s');
    await waitFor(() => expect(suggestFetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/search/suggest?q=s&catalog=1']));
    await settle(SEARCH_TYPEAHEAD_DEBOUNCE_MS);
    expect(screen.queryByRole('option', { name: /^Seedance 1\.5 Pro/ })).toBeNull();

    type('se');
    await waitFor(() => expect(suggestFetchMock.mock.calls.map(([url]) => url).at(-1)).toBe('/api/search/suggest?q=se&catalog=1'));
    await settle(SEARCH_TYPEAHEAD_DEBOUNCE_MS);
    expect(await screen.findByRole('option', {
      name: 'Seedance 1.5 Pro, video model, no posts yet. Open the video creator with it',
    })).toBeTruthy();
    // The app-only model is left out at two characters too.
    expect(screen.queryByRole('option', { name: /App Only Model/ })).toBeNull();
  });

  it('opens the creator with the model chosen for a catalog model nobody has posted with, from either box', async () => {
    render(<AppShellSearch />);
    fireEvent.focus(box());
    type('sdx');
    await screen.findByRole('listbox', { name: 'Search suggestions' });
    await settledList();
    fireEvent.click(screen.getByRole('option', { name: /^Seedance 1\.5 Pro/ }));
    expect(pushMock).toHaveBeenCalledWith('/create-video?model=seedance-1.5-pro');
  });

  it('opens it from the search page’s box too, never an empty Posts page', async () => {
    render(<SearchClient initialQuery="" initialType="posts" />);
    fireEvent.focus(box());
    type('sdx');
    await screen.findByRole('listbox', { name: 'Search suggestions' });
    await settledList();
    fireEvent.click(screen.getByRole('option', { name: /^Seedance 1\.5 Pro/ }));
    expect(pushMock).toHaveBeenCalledWith('/create-video?model=seedance-1.5-pro');
    await settle(SEARCH_TYPEAHEAD_DEBOUNCE_MS + 60);
    expect(searchUrls().some((url) => url.includes('madeWith=model%3Aseedance'))).toBe(false);
  });

  it('searches the query a row carries, narrowed to it, in the box and from the top bar', async () => {
    const { unmount } = render(<SearchClient initialQuery="" initialType="posts" />);
    fireEvent.focus(box());
    type('sdx');
    await screen.findByRole('listbox', { name: 'Search suggestions' });
    await settledList();
    fireEvent.click(screen.getByRole('option', { name: /^Stability AI/ }));
    expect(box()).toHaveValue('stability ai');
    await waitFor(() => expect(searchUrls().at(-1)).toBe('/api/search?q=stability+ai&type=posts&madeWith=tool%3Astability-ai&relatedSearches=1&entry=entity'));
    unmount();

    render(<AppShellSearch />);
    fireEvent.focus(box());
    type('sdx');
    await screen.findByRole('listbox', { name: 'Search suggestions' });
    await settledList();
    fireEvent.click(screen.getByRole('option', { name: /^Stability AI/ }));
    expect(pushMock).toHaveBeenLastCalledWith('/search?q=stability+ai&type=posts&madeWith=tool%3Astability-ai');
  });
});
