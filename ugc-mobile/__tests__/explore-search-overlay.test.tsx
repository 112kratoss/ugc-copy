import { readFileSync } from 'node:fs';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExploreSearchOverlay } from '../components/explore-search-overlay';
import { ApiError, type MagicbookletApiClient } from '../lib/api-client';
import type {
  CreatorSearchResult,
  PublicSearchResponse,
  PublicSearchType,
  RecipeSearchResult,
  ShowcaseFeedItem,
} from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const mocks = vi.hoisted(() => {
  // Models React Native's BackHandler: listeners are consulted newest-first
  // and the first to return true ends the press.
  const listeners: Array<() => boolean> = [];
  return {
    listeners,
    focused: { value: true },
    keyboardDismiss: vi.fn(),
    addEventListener: vi.fn((_event: string, listener: () => boolean) => {
      listeners.push(listener);
      return {
        remove: () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    }),
    // One router object for the whole file, so every render pushes through the same spy.
    router: { push: vi.fn() },
    readSearchHistory: vi.fn(async () => [] as string[]),
    rememberSearchQuery: vi.fn(async (_query: string) => [] as string[]),
  };
});

function pressBack() {
  for (const listener of [...mocks.listeners].reverse()) {
    if (listener()) return true;
  }
  return false;
}

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => mocks.focused.value,
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  BackHandler: { addEventListener: mocks.addEventListener },
  Keyboard: { dismiss: mocks.keyboardDismiss },
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: resolvePressableStyle(style),
  }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: React.forwardRef((props: MockProps, ref: React.ForwardedRef<{ focus: () => void }>) => {
    React.useImperativeHandle(ref, () => ({ focus: () => {} }));
    return React.createElement('text-input', props);
  }),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-router', () => ({
  router: mocks.router,
}));

vi.mock('lucide-react-native', () => ({
  BookOpen: (props: MockProps) => React.createElement('icon', props),
  Clock3: (props: MockProps) => React.createElement('icon', props),
  MessageCircle: (props: MockProps) => React.createElement('icon', props),
  Search: (props: MockProps) => React.createElement('icon', props),
  X: (props: MockProps) => React.createElement('icon', props),
}));

vi.mock('@/components/keyboard-aware', () => ({
  KeyboardAvoidingArea: ({ children, ...props }: MockProps) =>
    React.createElement('keyboard-avoiding-area', props, children),
}));

vi.mock('@/components/ui', () => ({
  CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => ({ mounted: visible, animatedStyle: {} }),
}));

vi.mock('@/lib/platform-glyphs', () => ({
  BackGlyph: (props: MockProps) => React.createElement('icon', props),
}));

vi.mock('@/lib/search-history', async (importOriginal) => ({
  // The real normalisers: the length gates count what they return.
  ...(await importOriginal<typeof import('../lib/search-history')>()),
  readSearchHistory: mocks.readSearchHistory,
  rememberSearchQuery: mocks.rememberSearchQuery,
  forgetSearchQuery: async () => [],
  clearSearchHistory: async () => {},
}));

const searchPublicContent = vi.fn<MagicbookletApiClient['searchPublicContent']>();
const api = { searchPublicContent } as unknown as MagicbookletApiClient;

async function render(props: { visible: boolean; onClose: () => void }) {
  let tree: renderer.ReactTestRenderer | null = null;
  await act(async () => {
    tree = renderer.create(React.createElement(ExploreSearchOverlay, { api, ...props }));
  });
  return tree!;
}

async function update(tree: renderer.ReactTestRenderer, props: { visible: boolean; onClose: () => void }) {
  await act(async () => {
    tree.update(React.createElement(ExploreSearchOverlay, { api, ...props }));
  });
}

describe('ExploreSearchOverlay hardware back', () => {
  beforeEach(() => {
    mocks.listeners.length = 0;
    mocks.focused.value = true;
    mocks.addEventListener.mockClear();
    mocks.keyboardDismiss.mockClear();
  });

  it('closes the open search on Android back while its screen is focused', async () => {
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });

    expect(mocks.listeners).toHaveLength(1);
    expect(pressBack()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.keyboardDismiss).toHaveBeenCalledTimes(1);

    await act(async () => tree.unmount());
  });

  it('claims nothing while hidden', async () => {
    const tree = await render({ visible: false, onClose: vi.fn() });

    expect(mocks.addEventListener).not.toHaveBeenCalled();

    await act(async () => tree.unmount());
  });

  it('releases the key under a route pushed from a result and reclaims it on return', async () => {
    // A result tap pushes the post over the tabs with the search still open
    // underneath. Back must pop the post first; only then does it close the
    // search. Holding the key here made the first press close the search out
    // of sight and left the post on screen.
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });
    expect(mocks.listeners).toHaveLength(1);

    mocks.focused.value = false;
    await update(tree, { visible: true, onClose });
    expect(mocks.listeners).toHaveLength(0);
    expect(pressBack()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    mocks.focused.value = true;
    await update(tree, { visible: true, onClose });
    expect(mocks.listeners).toHaveLength(1);
    expect(pressBack()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => tree.unmount());
  });

  it('claims the key through the focus-gated shared hook, never a raw subscription', () => {
    const source = readFileSync('components/explore-search-overlay.tsx', 'utf8');

    expect(source).toContain('useHardwareBack(visible && isFocused, requestClose)');
    expect(source).toContain('useIsFocused()');
    expect(source).not.toContain('BackHandler');
  });
});

type Tree = renderer.ReactTestRenderer;
type Instance = renderer.ReactTestInstance;

function hostNodes(tree: Tree, type: string) {
  return tree.root.findAll((node) => node.type === type);
}

function textOf(node: Instance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

function shownTexts(tree: Tree) {
  return hostNodes(tree, 'text').map(textOf);
}

function statusTitles(tree: Tree) {
  return hostNodes(tree, 'status-block').map((node) => node.props.title as string);
}

function statusBodies(tree: Tree) {
  return hostNodes(tree, 'status-block').map((node) => node.props.body as string);
}

function isSearching(tree: Tree) {
  return shownTexts(tree).includes('Searching…');
}

function saysNoResults(tree: Tree) {
  return statusTitles(tree).some((title) => title.startsWith('No results'));
}

function searchInput(tree: Tree) {
  return hostNodes(tree, 'text-input')[0];
}

function tab(tree: Tree, label: string) {
  const match = hostNodes(tree, 'pressable').find(
    (node) => node.props.accessibilityRole === 'tab' && textOf(node) === label,
  );
  if (!match) throw new Error(`No ${label} tab`);
  return match;
}

function pressableLabelled(tree: Tree, label: string) {
  const match = hostNodes(tree, 'pressable').find((node) => node.props.accessibilityLabel === label);
  if (!match) throw new Error(`Nothing labelled ${label}`);
  return match;
}

function showMoreButton(tree: Tree) {
  const match = hostNodes(tree, 'secondary-button').find(
    (node) => node.props.label === 'Show more' || node.props.label === 'Loading…',
  );
  if (!match) throw new Error('No Show more button');
  return match;
}

function retryButton(tree: Tree) {
  const match = hostNodes(tree, 'secondary-button').find((node) => node.props.label === 'Retry search');
  if (!match) throw new Error('No Retry search button');
  return match;
}

async function typeQuery(tree: Tree, value: string) {
  await act(async () => {
    searchInput(tree).props.onChangeText(value);
  });
}

async function press(node: Instance) {
  await act(async () => {
    node.props.onPress();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function creator(
  username: string,
  publicPostCount = 3,
  extra: Partial<Pick<CreatorSearchResult, 'bio' | 'isFollowing'>> = {},
): CreatorSearchResult {
  return {
    id: `id-${username}`,
    username,
    displayName: `Creator ${username}`,
    bio: null,
    avatarUrl: null,
    publicPostCount,
    isFollowing: false,
    ...extra,
  };
}

function post(id: string, counts: { saveCount?: number; commentCount?: number } = {}): ShowcaseFeedItem {
  // Only what a result card reads.
  return {
    id,
    title: `Post ${id}`,
    creator: { name: 'Ana' },
    mediaItems: [],
    mediaKind: 'image',
    mediaUrl: null,
    saveCount: counts.saveCount ?? 0,
    commentCount: counts.commentCount ?? 0,
  } as unknown as ShowcaseFeedItem;
}

function recipe(id: string, access: { accessMode: 'free' | 'paid'; priceUsdCents: number }, sellerName: string): RecipeSearchResult {
  return {
    id,
    postId: `post-${id}`,
    title: `Recipe ${id}`,
    summary: 'Lighting, lens and grade',
    previewText: '',
    ...access,
    salesCount: 0,
    freeUnlockCount: 0,
    allowRemix: true,
    resourceKinds: ['prompt'],
    createdAt: '2026-10-01T00:00:00.000Z',
    seller: { id: `seller-${id}`, username: null, name: sellerName, avatar: null },
    post: null,
    priceQuote: { formatted: '$9.00', currency: 'USD', amountSubunits: 900 },
  };
}

function searchAnswer(
  query: string,
  type: PublicSearchType = 'top',
  kinds: { creators?: CreatorSearchResult[]; posts?: ShowcaseFeedItem[]; recipes?: RecipeSearchResult[]; creatorsCursor?: string } = {},
): PublicSearchResponse {
  return {
    query,
    normalizedQuery: query.replace(/^@+/, ''),
    type,
    creators: { items: kinds.creators ?? [], nextCursor: kinds.creatorsCursor ?? null },
    posts: { items: kinds.posts ?? [], nextCursor: null },
    recipes: { items: kinds.recipes ?? [], nextCursor: null },
  };
}

function requested() {
  return searchPublicContent.mock.calls.map(([params]) => ({ query: params.query, type: params.type }));
}

describe('ExploreSearchOverlay search', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listeners.length = 0;
    mocks.focused.value = true;
    mocks.router.push.mockClear();
    mocks.readSearchHistory.mockClear();
    mocks.rememberSearchQuery.mockClear();
    searchPublicContent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says it is searching, never that nothing matched, until the answer for the query lands', async () => {
    const pending = deferred<PublicSearchResponse>();
    searchPublicContent.mockReturnValueOnce(pending.promise);
    const tree = await render({ visible: true, onClose: vi.fn() });

    await typeQuery(tree, 'portrait');
    // Inside the debounce nothing has been asked, so nothing can have failed to match.
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(isSearching(tree)).toBe(true);
    expect(saysNoResults(tree)).toBe(false);

    await advance(300);
    expect(requested()).toEqual([{ query: 'portrait', type: 'top' }]);
    expect(isSearching(tree)).toBe(true);
    expect(saysNoResults(tree)).toBe(false);

    await act(async () => pending.resolve(searchAnswer('portrait')));
    expect(isSearching(tree)).toBe(false);
    expect(statusTitles(tree)).toContain('No results for “portrait”');

    await act(async () => tree.unmount());
  });

  it("shows the spinner, not the last query's cards or error, while a new query waits", async () => {
    searchPublicContent.mockResolvedValueOnce(searchAnswer('portrait', 'top', { creators: [creator('jane')] }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'portrait');
    await advance(300);
    expect(() => pressableLabelled(tree, "Open Creator jane's profile")).not.toThrow();

    await typeQuery(tree, 'portraits');
    expect(isSearching(tree)).toBe(true);
    expect(() => pressableLabelled(tree, "Open Creator jane's profile")).toThrow();

    searchPublicContent.mockRejectedValueOnce(new ApiError('Failed to search public content.', 500));
    await advance(300);
    expect(statusTitles(tree)).toContain('Search did not load');

    await typeQuery(tree, 'portraiture');
    expect(statusTitles(tree)).not.toContain('Search did not load');
    expect(isSearching(tree)).toBe(true);

    await act(async () => tree.unmount());
  });

  it('switches tab at once and shows loading, not a blank body, until that tab answers', async () => {
    searchPublicContent.mockResolvedValueOnce(searchAnswer('portrait', 'top', { creators: [creator('jane')] }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'portrait');
    await advance(300);

    const pending = deferred<PublicSearchResponse>();
    searchPublicContent.mockReturnValueOnce(pending.promise);
    await press(tab(tree, 'Posts'));
    // Top's answer holds creators, which the Posts tab does not draw.
    expect(isSearching(tree)).toBe(true);
    expect(saysNoResults(tree)).toBe(false);

    // The query has not changed, so the tab's request skips the debounce.
    await advance(1);
    expect(requested()).toEqual([
      { query: 'portrait', type: 'top' },
      { query: 'portrait', type: 'posts' },
    ]);

    await act(async () => pending.resolve(searchAnswer('portrait', 'posts', { posts: [post('p1')] })));
    expect(isSearching(tree)).toBe(false);
    expect(() => pressableLabelled(tree, 'Open post Post p1')).not.toThrow();

    await act(async () => tree.unmount());
  });

  it('asks nothing for "@j", which the server counts as one character, and asks for "@jo"', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { creators: [creator('jo')] }));
    const tree = await render({ visible: true, onClose: vi.fn() });

    await typeQuery(tree, '@j');
    await advance(300);
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(isSearching(tree)).toBe(false);
    expect(statusTitles(tree)).toEqual(['Find your next idea']);

    await typeQuery(tree, '@jo');
    await advance(300);
    // The query goes as typed; the server strips the @ itself.
    expect(requested()).toEqual([{ query: '@jo', type: 'top' }]);

    await act(async () => tree.unmount());
  });

  it('never asks for posts with "@ab": it searches creators until a third character', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));

    await typeQuery(tree, '@ab');
    await advance(300);
    expect(requested()).toEqual([{ query: '@ab', type: 'creators' }]);
    expect(tab(tree, 'Posts').props.accessibilityState).toEqual({ selected: false, disabled: true });
    expect(tab(tree, 'Creators').props.accessibilityState).toEqual({ selected: true, disabled: false });

    await typeQuery(tree, '@abc');
    await advance(300);
    expect(requested()).toEqual([
      { query: '@ab', type: 'creators' },
      { query: '@abc', type: 'posts' },
    ]);
    expect(tab(tree, 'Posts').props.accessibilityState).toEqual({ selected: true, disabled: false });

    await act(async () => tree.unmount());
  });

  it('keeps the picked tab through a two-character query: Posts, "ab", then "abc" asks for posts', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));

    await typeQuery(tree, 'ab');
    await advance(300);
    expect(tab(tree, 'Creators').props.accessibilityState.selected).toBe(true);

    await typeQuery(tree, 'abc');
    await advance(300);
    expect(requested()).toEqual([
      { query: 'ab', type: 'creators' },
      { query: 'abc', type: 'posts' },
    ]);
    expect(tab(tree, 'Posts').props.accessibilityState.selected).toBe(true);

    // A new word passes through two characters again and still lands on Posts.
    await typeQuery(tree, '');
    await typeQuery(tree, 'la');
    await advance(300);
    await typeQuery(tree, 'lake');
    await advance(300);
    expect(requested().at(-1)).toEqual({ query: 'lake', type: 'posts' });

    await act(async () => tree.unmount());
  });

  it('keeps only the query a result was opened from, not each pause in typing it', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { creators: [creator('jane')] }));
    const tree = await render({ visible: true, onClose: vi.fn() });

    for (const value of ['po', 'por', 'port']) {
      await typeQuery(tree, value);
      await advance(300);
    }
    expect(searchPublicContent).toHaveBeenCalledTimes(3);
    expect(mocks.rememberSearchQuery).not.toHaveBeenCalled();

    await press(pressableLabelled(tree, "Open Creator jane's profile"));
    expect(mocks.rememberSearchQuery.mock.calls).toEqual([['port']]);
    expect(mocks.router.push).toHaveBeenCalledWith('/creators/jane');

    await act(async () => tree.unmount());
  });

  it('does not keep a query that found nothing, on the Search key or on close', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type));
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });

    await typeQuery(tree, 'zzzznope');
    await advance(300);
    expect(statusTitles(tree)).toContain('No results for “zzzznope”');

    await act(async () => {
      searchInput(tree).props.onSubmitEditing();
    });
    await press(pressableLabelled(tree, 'Close search'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.rememberSearchQuery).not.toHaveBeenCalled();

    await act(async () => tree.unmount());
  });

  it('keeps a query with results from the Search key, even pressed before its answer, and on close', async () => {
    const pending = deferred<PublicSearchResponse>();
    searchPublicContent.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });

    await typeQuery(tree, 'portrait');
    await advance(300);
    await act(async () => {
      searchInput(tree).props.onSubmitEditing();
    });
    expect(mocks.rememberSearchQuery).not.toHaveBeenCalled();

    await act(async () => pending.resolve(searchAnswer('portrait', 'top', { creators: [creator('jane')] })));
    expect(mocks.rememberSearchQuery.mock.calls).toEqual([['portrait']]);

    mocks.rememberSearchQuery.mockClear();
    await press(pressableLabelled(tree, 'Close search'));
    expect(mocks.rememberSearchQuery.mock.calls).toEqual([['portrait']]);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => tree.unmount());
  });

  it('names a rate limit and holds Retry for the window the server gave', async () => {
    searchPublicContent.mockRejectedValueOnce(new ApiError('Too many requests. Please wait before trying again.', 429, {
      error: 'Too many requests. Please wait before trying again.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 30,
    }, undefined, 'RATE_LIMITED'));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'portrait');
    await advance(300);

    expect(statusBodies(tree)).toContain('Search is busy. Try again in 30 s.');
    expect(retryButton(tree).props.disabled).toBe(true);
    await advance(29_000);
    expect(retryButton(tree).props.disabled).toBe(true);
    await advance(1_000);
    expect(retryButton(tree).props.disabled).toBe(false);

    searchPublicContent.mockResolvedValueOnce(searchAnswer('portrait', 'top', { creators: [creator('jane')] }));
    await press(retryButton(tree));
    expect(requested()).toEqual([
      { query: 'portrait', type: 'top' },
      { query: 'portrait', type: 'top' },
    ]);
    expect(() => pressableLabelled(tree, "Open Creator jane's profile")).not.toThrow();

    await act(async () => tree.unmount());
  });

  it('holds Show more, the retry for a page that failed, through a rate limit window', async () => {
    searchPublicContent.mockResolvedValueOnce(
      searchAnswer('jan', 'creators', { creators: [creator('jane')], creatorsCursor: 'page-2' }),
    );
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Creators'));
    await typeQuery(tree, 'jan');
    await advance(300);

    searchPublicContent.mockRejectedValueOnce(new ApiError('Too many requests.', 429, { retryAfterSeconds: 10 }));
    await press(showMoreButton(tree));
    expect(searchPublicContent.mock.calls.at(-1)?.[0]).toEqual({ query: 'jan', type: 'creators', cursor: 'page-2' });
    // The first page stays up, with the reason under it.
    expect(() => pressableLabelled(tree, "Open Creator jane's profile")).not.toThrow();
    expect(shownTexts(tree)).toContain('Search is busy. Try again in 10 s.');
    expect(showMoreButton(tree).props.disabled).toBe(true);

    await advance(10_000);
    expect(showMoreButton(tree).props).toMatchObject({ label: 'Show more', disabled: false });

    await act(async () => tree.unmount());
  });

  it('brings a kept answer back with Show more ready after a page load was cut off by clearing the field', async () => {
    searchPublicContent.mockResolvedValueOnce(
      searchAnswer('jan', 'creators', { creators: [creator('jane')], creatorsCursor: 'page-2' }),
    );
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Creators'));
    await typeQuery(tree, 'jan');
    await advance(300);

    searchPublicContent.mockReturnValueOnce(new Promise<PublicSearchResponse>(() => undefined));
    await press(showMoreButton(tree));
    expect(showMoreButton(tree).props).toMatchObject({ label: 'Loading…', disabled: true });

    await typeQuery(tree, '');
    await typeQuery(tree, 'jan');
    expect(showMoreButton(tree).props).toMatchObject({ label: 'Show more', disabled: false });

    await act(async () => tree.unmount());
  });

  it.each([
    // A rate limit that names no window leaves Retry to the person.
    [429, 'Search is busy. Try again shortly.'],
    [400, 'Search creators from two characters, or use three characters to discover posts and recipes.'],
    [503, 'Search could not be loaded. Check your connection and try again.'],
    [0, 'Search could not be loaded. Check your connection and try again.'],
    [404, 'Search could not be loaded.'],
  ])('reads the status of a failed search: %i', async (status, body) => {
    searchPublicContent.mockRejectedValueOnce(new ApiError('Request failed', status));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'portrait');
    await advance(300);

    expect(statusTitles(tree)).toContain('Search did not load');
    expect(statusBodies(tree)).toContain(body);
    expect(retryButton(tree).props.disabled).toBe(false);

    await act(async () => tree.unmount());
  });

  it('counts a creator\'s posts in the singular and the plural', async () => {
    searchPublicContent.mockResolvedValueOnce(searchAnswer('jan', 'top', { creators: [creator('jane', 1), creator('janet', 2)] }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'jan');
    await advance(300);

    expect(shownTexts(tree)).toEqual(expect.arrayContaining(['1 post', '2 posts']));

    await act(async () => tree.unmount());
  });

  // What each result card reads, top to bottom: the web's search cards read the same.
  function cardTexts(tree: Tree, label: string) {
    return pressableLabelled(tree, label).findAll((node) => node.type === 'text').map(textOf);
  }

  it('gives a creator their bio on one line and marks one the viewer follows', async () => {
    searchPublicContent.mockResolvedValueOnce(searchAnswer('jan', 'top', {
      creators: [
        creator('jane', 3, { bio: 'Films\nand  stills', isFollowing: true }),
        creator('janet', 2),
      ],
    }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'jan');
    await advance(300);

    // A screen reader hears the mark too: the row reads as its label.
    expect(cardTexts(tree, "Open Creator jane's profile, following"))
      .toEqual(['Creator jane', 'Following', '@jane', 'Films and stills', '3 posts']);
    const bio = pressableLabelled(tree, "Open Creator jane's profile, following")
      .find((node) => node.type === 'text' && textOf(node) === 'Films and stills');
    expect(bio.props.numberOfLines).toBe(1);
    // No bio leaves no empty line, and no follow leaves no mark.
    expect(cardTexts(tree, "Open Creator janet's profile")).toEqual(['Creator janet', '@janet', '2 posts']);

    await act(async () => tree.unmount());
  });

  it("counts a post's saves, in the singular and the plural, and its comments", async () => {
    searchPublicContent.mockResolvedValueOnce(searchAnswer('portrait', 'top', {
      posts: [post('p1', { saveCount: 1, commentCount: 4 }), post('p2', { saveCount: 12 })],
    }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'portrait');
    await advance(300);

    expect(cardTexts(tree, 'Open post Post p1')).toEqual(['Post p1', 'Ana', '1 save', '4']);
    expect(cardTexts(tree, 'Open post Post p2')).toEqual(['Post p2', 'Ana', '12 saves', '0']);

    await act(async () => tree.unmount());
  });

  it('names who sells a recipe on its price line', async () => {
    searchPublicContent.mockResolvedValueOnce(searchAnswer('lighting', 'top', {
      recipes: [
        recipe('r1', { accessMode: 'free', priceUsdCents: 0 }, 'Luna Studio'),
        recipe('r2', { accessMode: 'paid', priceUsdCents: 900 }, 'Noor'),
      ],
    }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'lighting');
    await advance(300);

    expect(cardTexts(tree, 'Open recipe Recipe r1')).toEqual(['Recipe r1', 'Lighting, lens and grade', 'Luna Studio', 'Free']);
    // The app prices an unlock in credits where the web quotes cash; the seller reads the same.
    expect(cardTexts(tree, 'Open recipe Recipe r2')).toEqual(['Recipe r2', 'Lighting, lens and grade', 'Noor', '900 credits']);

    await act(async () => tree.unmount());
  });

  // Audit 02-6: the row used to open the standalone unlock screen, which had
  // no way to the post, its creator or Remix. It opens the reel a push for the
  // post opens, by the post's id, on the post's Details page, resources first.
  it("opens a recipe on its post's Details page in the reel, with the resources first", async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, {
      recipes: [recipe('r1', { accessMode: 'paid', priceUsdCents: 900 }, 'Noor')],
    }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'lighting');
    await advance(300);

    const opensRecipe = [{
      pathname: '/viewer',
      params: { source: 'showcase-feed', initialId: 'post-r1', initialPage: 'details', initialSection: 'resources' },
    }];
    await press(pressableLabelled(tree, 'Open recipe Recipe r1'));
    expect(mocks.router.push.mock.calls).toEqual([opensRecipe]);
    expect(mocks.rememberSearchQuery.mock.calls).toEqual([['lighting']]);

    // The Recipes tab draws the same row.
    await press(tab(tree, 'Recipes'));
    await advance(300);
    await press(pressableLabelled(tree, 'Open recipe Recipe r1'));
    expect(mocks.router.push.mock.calls).toEqual([opensRecipe, opensRecipe]);
    expect(JSON.stringify(mocks.router.push.mock.calls)).not.toContain('marketplace');

    await act(async () => tree.unmount());
  });
});
