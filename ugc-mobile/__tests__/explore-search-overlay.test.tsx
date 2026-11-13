import { readFileSync } from 'node:fs';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExploreSearchOverlay } from '../components/explore-search-overlay';
import { ApiError, type MagicbookletApiClient } from '../lib/api-client';
import { CREATOR_PROFILE_PRESS_DELAY_MS, setCreatorProfilePreparer } from '../lib/creator-profile-opening';
import {
  SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS,
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  SEARCH_TYPEAHEAD_KEPT_ANSWER_MS,
  SEARCH_TYPEAHEAD_PRESS_SETTLE_MS,
  type SearchSuggestResponse,
} from '../lib/public-search-policy/search-typeahead';
import type {
  CreatorSearchResult,
  PublicSearchResponse,
  PublicSearchSort,
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
    // The registered account, null for a visitor and for a guest session.
    user: { value: null as { id: string } | null },
    announce: vi.fn(),
    // The results' scroll view, asked to move.
    scrollTo: vi.fn(),
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

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: mocks.user.value }),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: mocks.announce },
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  BackHandler: { addEventListener: mocks.addEventListener },
  Keyboard: { dismiss: mocks.keyboardDismiss },
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: resolvePressableStyle(style),
  }, children),
  ScrollView: React.forwardRef(({ children, ...props }: MockProps, ref: React.ForwardedRef<{ scrollTo: (to: unknown) => void }>) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: mocks.scrollTo }));
    return React.createElement('scroll-view', props, children);
  }),
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
  Box: (props: MockProps) => React.createElement('icon', props),
  Wrench: (props: MockProps) => React.createElement('icon', props),
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
  ChoiceChip: (props: MockProps) => React.createElement('choice-chip', props),
  CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SegmentedControl: (props: MockProps) => React.createElement('segmented-control', props),
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
// The typeahead's request. Nothing is asked until the field has the focus,
// which only the typeahead's own cases give it.
const suggestSearch = vi.fn<MagicbookletApiClient['suggestSearch']>();
const api = { searchPublicContent, suggestSearch } as unknown as MagicbookletApiClient;

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
  kinds: {
    creators?: CreatorSearchResult[];
    posts?: ShowcaseFeedItem[];
    recipes?: RecipeSearchResult[];
    creatorsCursor?: string;
    postsCursor?: string;
    /** The order the server says the answer is in; a server from before sorts says none. */
    sort?: PublicSearchSort;
  } = {},
  /** What a server with entities and filters adds; a server from before them adds none. */
  extra: Pick<PublicSearchResponse, 'entities' | 'filters' | 'correctedQuery' | 'exact'> = {},
): PublicSearchResponse {
  return {
    query,
    normalizedQuery: query.replace(/^@+/, ''),
    type,
    ...(kinds.sort ? { sort: kinds.sort } : {}),
    creators: { items: kinds.creators ?? [], nextCursor: kinds.creatorsCursor ?? null },
    posts: { items: kinds.posts ?? [], nextCursor: kinds.postsCursor ?? null },
    recipes: { items: kinds.recipes ?? [], nextCursor: null },
    ...extra,
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
    mocks.user.value = null;
    mocks.announce.mockClear();
    searchPublicContent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('entities, filters and the corrected reading', () => {
    const NONE = { madeWith: null, mediaKind: null, hasRecipe: false, following: false };
    const kling = { kind: 'model' as const, key: 'kling-2.6', label: 'Kling 2.6', postCount: 14, postCountCapped: false };
    // A server with filters says which it applied, on every answer.
    const answerOf = (
      query: string,
      type: PublicSearchType = 'top',
      kinds: Parameters<typeof searchAnswer>[2] = {},
      extra: Parameters<typeof searchAnswer>[3] = {},
    ) => searchAnswer(query, type, { sort: 'top', ...kinds }, { entities: [], filters: NONE, correctedQuery: { posts: null, recipes: null }, exact: false, ...extra });

    function chips(tree: Tree) {
      return hostNodes(tree, 'choice-chip');
    }
    function chip(tree: Tree, label: string) {
      const match = chips(tree).find((node) => node.props.label === label);
      if (!match) throw new Error(`No ${label} switch`);
      return match;
    }
    function asked() {
      return searchPublicContent.mock.calls.map(([params]) => ({
        type: params.type, filters: params.filters, exact: params.exact, cursor: params.cursor ?? null,
      }));
    }

    it('offers the models and tools a query names on Top, and opens the posts made with one', async () => {
      searchPublicContent.mockImplementation(async ({ query, type, filters }) => answerOf(
        query,
        type,
        type === 'posts' ? { posts: [post('clip')] } : { creators: [creator('kling-fan')] },
        type === 'top'
          ? { entities: [kling, { kind: 'tool', key: 'klingon-fx', label: 'Klingon FX', postCount: 1000, postCountCapped: true }] }
          : { filters: { ...NONE, madeWith: filters?.madeWith ? { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6' } : null } },
      ));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'kling');
      await advance(300);

      expect(shownTexts(tree)).toEqual(expect.arrayContaining(['Models and tools', 'Kling 2.6', 'Model · 14 posts', 'Klingon FX', 'Tool · 1,000+ posts']));
      const row = pressableLabelled(tree, 'Kling 2.6, model, 14 posts. Show posts made with it');
      // A row a thumb can press: the HIG's 44pt and more.
      expect(row.props.style.minHeight).toBeGreaterThanOrEqual(44);
      expect(row.props.accessibilityRole).toBe('button');

      await press(row);
      await advance(0);
      expect(tab(tree, 'Posts').props.accessibilityState).toMatchObject({ selected: true });
      expect(asked().at(-1)).toMatchObject({ type: 'posts', filters: { ...NONE, madeWith: 'model:kling-2.6' }, exact: false });
      // The filter is a chip of its own, on, named as the result was.
      const madeWith = pressableLabelled(tree, 'Remove filter: made with Kling 2.6');
      expect(madeWith.props.accessibilityState).toMatchObject({ selected: true });
      expect(textOf(madeWith)).toBe('Made with Kling 2.6');
      expect(madeWith.props.style.minHeight).toBeGreaterThanOrEqual(44);

      await press(madeWith);
      await advance(0);
      expect(asked().at(-1)).toMatchObject({ type: 'posts', filters: NONE });
      expect(hostNodes(tree, 'pressable').some((node) => String(node.props.accessibilityLabel).startsWith('Remove filter'))).toBe(false);

      await act(async () => tree.unmount());
    });

    it('opens exactly the posts an entity’s row counted: a switch left on from an earlier look at Posts is cleared', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => answerOf(
        query, type, type === 'posts' ? { posts: [post('clip')] } : { creators: [creator('kling-fan')] },
        type === 'top' ? { entities: [kling] } : {},
      ));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'kling');
      await advance(300);
      await press(chip(tree, 'Videos'));
      await press(chip(tree, 'Has recipe'));
      await advance(0);

      await press(tab(tree, 'Top'));
      await advance(0);
      await press(pressableLabelled(tree, 'Kling 2.6, model, 14 posts. Show posts made with it'));
      await advance(0);
      expect(asked().at(-1)).toMatchObject({ type: 'posts', filters: { ...NONE, madeWith: 'model:kling-2.6' } });
      expect(chips(tree).every((node) => node.props.active === false)).toBe(true);
      await act(async () => tree.unmount());
    });

    it('draws no entity for a two-character query, whatever an answer carries: there is no Posts search to open', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => answerOf(
        query, type, { creators: [creator('klara')] }, { entities: [kling] },
      ));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'kl');
      await advance(300);
      expect(shownTexts(tree)).not.toContain('Models and tools');
      expect(shownTexts(tree)).not.toContain('Kling 2.6');

      // With a third character the entity is drawn.
      await typeQuery(tree, 'kli');
      await advance(300);
      expect(shownTexts(tree)).toContain('Models and tools');
      await act(async () => tree.unmount());
    });

    it('draws an answer that holds nothing but an entity as a result, never as "No results"', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => answerOf(query, type, {}, { entities: [kling] }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'kling');
      await advance(300);
      expect(saysNoResults(tree)).toBe(false);
      expect(shownTexts(tree)).toContain('Kling 2.6');
      await act(async () => tree.unmount());
    });

    it('narrows Posts with switches that say whether they are on, Images and Videos one choice', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => answerOf(query, type, { posts: [post('clip'), post('still')] }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);

      // A visitor follows nobody: three switches, none on.
      expect(chips(tree).map((node) => [node.props.label, node.props.active])).toEqual([
        ['Images', false], ['Videos', false], ['Has recipe', false],
      ]);
      expect(asked()).toEqual([{ type: 'posts', filters: NONE, exact: false, cursor: null }]);

      await press(chip(tree, 'Videos'));
      await advance(0);
      expect(chip(tree, 'Videos').props.active).toBe(true);
      expect(asked().at(-1)?.filters).toEqual({ ...NONE, mediaKind: 'video' });

      await press(chip(tree, 'Images'));
      await press(chip(tree, 'Has recipe'));
      await advance(0);
      expect(chips(tree).map((node) => [node.props.label, node.props.active])).toEqual([
        ['Images', true], ['Videos', false], ['Has recipe', true],
      ]);
      expect(asked().at(-1)?.filters).toEqual({ ...NONE, mediaKind: 'image', hasRecipe: true });

      await press(pressableLabelled(tree, 'Clear filters'));
      await advance(0);
      expect(asked().at(-1)?.filters).toEqual(NONE);
      expect(chips(tree).every((node) => node.props.active === false)).toBe(true);

      await act(async () => tree.unmount());
    });

    it('asks a filtered search once, not again at every render, for a visitor as for an account', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => answerOf(query, type, { posts: [post('clip')] }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);
      await press(chip(tree, 'Videos'));
      await advance(0);
      const callsAfterSwitch = searchPublicContent.mock.calls.length;
      await advance(2_000);
      expect(searchPublicContent.mock.calls.length).toBe(callsAfterSwitch);
      await act(async () => tree.unmount());
    });

    it('offers "Following" to an account and asks for it; a visitor is never offered it', async () => {
      mocks.user.value = { id: 'viewer-1' };
      searchPublicContent.mockImplementation(async ({ query, type }) => answerOf(query, type, { posts: [post('clip')] }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);
      expect(chips(tree).map((node) => node.props.label)).toEqual(['Images', 'Videos', 'Has recipe', 'Following']);
      await press(chip(tree, 'Following'));
      await advance(0);
      expect(asked().at(-1)?.filters).toEqual({ ...NONE, following: true });

      // Signed out with the switch on: it is no longer offered, and no longer asked for.
      mocks.user.value = null;
      await update(tree, { visible: true, onClose: vi.fn() });
      await advance(0);
      expect(chips(tree).map((node) => node.props.label)).toEqual(['Images', 'Videos', 'Has recipe']);
      expect(asked().at(-1)?.filters).toEqual(NONE);

      await act(async () => tree.unmount());
    });

    it('keeps the switches over a filtered search that found nothing, and says to remove one', async () => {
      searchPublicContent.mockImplementation(async ({ query, type, filters }) => answerOf(
        query, type, { posts: filters?.mediaKind ? [] : [post('clip')] },
      ));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);
      await press(chip(tree, 'Videos'));
      await advance(0);
      expect(saysNoResults(tree)).toBe(true);
      expect(statusBodies(tree)).toEqual(['No post matches these filters. Remove one, or clear them all.']);
      expect(chip(tree, 'Videos').props.active).toBe(true);
      await act(async () => tree.unmount());
    });

    it('pages a filtered search with its filters', async () => {
      searchPublicContent.mockImplementation(async ({ query, type, cursor }) => answerOf(
        query, type, cursor ? { posts: [post('older')] } : { posts: [post('clip')], postsCursor: 'page-2' },
      ));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);
      await press(chip(tree, 'Videos'));
      await advance(0);
      await press(showMoreButton(tree));
      await advance(0);
      expect(asked().at(-1)).toEqual({ type: 'posts', filters: { ...NONE, mediaKind: 'video' }, exact: false, cursor: 'page-2' });
      await act(async () => tree.unmount());
    });

    it('keeps filters to Posts: Top and Creators are asked unnarrowed and draw no switches', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => answerOf(
        query, type, type === 'posts' ? { posts: [post('clip')] } : { creators: [creator('jane')] },
      ));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);
      await press(chip(tree, 'Videos'));
      await advance(0);

      await press(tab(tree, 'Top'));
      await advance(0);
      expect(chips(tree)).toHaveLength(0);
      expect(asked().at(-1)).toMatchObject({ type: 'top', filters: NONE });

      // Back on Posts the choice is still there.
      await press(tab(tree, 'Posts'));
      await advance(0);
      expect(chip(tree, 'Videos').props.active).toBe(true);
      expect(asked().at(-1)).toMatchObject({ type: 'posts', filters: { ...NONE, mediaKind: 'video' } });
      await act(async () => tree.unmount());
    });

    it('says when it read the query as something else, and searches for it as typed on request', async () => {
      searchPublicContent.mockImplementation(async ({ query, type, exact }) => answerOf(
        query,
        type,
        { posts: exact ? [] : [post('portrait')] },
        { correctedQuery: { posts: exact ? null : 'portrait', recipes: null }, exact: Boolean(exact) },
      ));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portriat');
      await advance(300);

      expect(shownTexts(tree)).toContain('Showing results for “portrait”');
      // Android reads it from a live region.
      expect(tree.root.findAll((node) => node.props.accessibilityLiveRegion === 'polite').length).toBeGreaterThan(0);
      const instead = pressableLabelled(tree, 'Search instead for “portriat”');
      expect(instead.props.style.minHeight).toBeGreaterThanOrEqual(44);

      await press(instead);
      await advance(0);
      expect(asked().at(-1)).toMatchObject({ type: 'posts', exact: true });
      expect(shownTexts(tree)).toContain('Showing results for “portriat” as typed');
      expect(shownTexts(tree)).not.toContain('Showing results for “portrait”');
      expect(saysNoResults(tree)).toBe(true);

      await press(pressableLabelled(tree, 'Use suggested spelling'));
      await advance(0);
      expect(asked().at(-1)).toMatchObject({ type: 'posts', exact: false });
      expect(shownTexts(tree)).toContain('Showing results for “portrait”');

      // Another query is a new search, corrected again where it needs to be.
      await press(pressableLabelled(tree, 'Search instead for “portriat”'));
      await advance(0);
      await typeQuery(tree, 'lanten');
      await advance(300);
      expect(asked().at(-1)).toMatchObject({ exact: false });

      await act(async () => tree.unmount());
    });

    it('names both readings on Top when posts and recipes were read differently, and none on Creators', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => answerOf(
        query,
        type,
        { creators: [creator('jane')], posts: [post('portrait')], recipes: [recipe('r1', { accessMode: 'free', priceUsdCents: 0 }, 'Jane')] },
        { correctedQuery: { posts: 'portrait', recipes: 'portraits' } },
      ));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'portriat');
      await advance(300);
      expect(shownTexts(tree)).toContain('Showing posts for “portrait” and recipes for “portraits”');

      await press(tab(tree, 'Creators'));
      await advance(0);
      expect(shownTexts(tree).some((text) => text.startsWith('Showing '))).toBe(false);
      await act(async () => tree.unmount());
    });

    it('draws none of it against a server from before entities and filters, and asks it nothing new', async () => {
      // Today's server: a sort, and none of the new fields.
      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(
        query, type, type === 'posts' ? { sort: 'top', posts: [post('clip')] } : { sort: 'top', creators: [creator('jane')] },
      ));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'kling');
      await advance(300);
      expect(shownTexts(tree)).not.toContain('Models and tools');

      await press(tab(tree, 'Posts'));
      await advance(0);
      expect(chips(tree)).toHaveLength(0);
      expect(shownTexts(tree).some((text) => text.startsWith('Showing '))).toBe(false);
      expect(asked().every((call) => call.exact === false
        && JSON.stringify(call.filters) === JSON.stringify(NONE))).toBe(true);
      await act(async () => tree.unmount());
    });
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

  it('counts an emoji as one character, as the server does', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));

    await typeQuery(tree, '\u{1F600}');
    await advance(300);
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(statusTitles(tree)).toEqual(['Find your next idea']);

    // Two characters: creators only, whatever tab was picked.
    await typeQuery(tree, '\u{1F600}\u{1F600}');
    await advance(300);
    expect(requested()).toEqual([{ query: '\u{1F600}\u{1F600}', type: 'creators' }]);

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

  // Review of #679: a scroll of the results that starts on a creator's row
  // read their page.
  it("reads a found creator's page once the finger has rested on the row", async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { creators: [creator('jane')] }));
    const prepared: string[] = [];
    const removePreparer = setCreatorProfilePreparer((username) => prepared.push(username));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'port');
    await advance(300);
    const row = pressableLabelled(tree, "Open Creator jane's profile");

    expect(row.props.unstable_pressDelay).toBe(CREATOR_PROFILE_PRESS_DELAY_MS);
    await act(async () => row.props.onPressIn());
    expect(prepared).toEqual(['jane']);
    expect(mocks.router.push).not.toHaveBeenCalled();

    removePreparer();
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
    expect(searchPublicContent.mock.calls.at(-1)?.[0]).toEqual({
      query: 'jan', type: 'creators', sort: 'top', cursor: 'page-2',
      // Creators are neither narrowed nor read as typed.
      filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false }, exact: false,
    });
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

  // 2026-11-12: a post of writing has no picture, and its card drew a magnifier
  // in the empty frame, which read as a result that had not loaded.
  it('draws a text post as its writing, where a picture post has its picture', async () => {
    const note = {
      ...post('n1'),
      title: 'Creative Idea',
      category: 'text',
      postFormat: 'text',
      mediaKind: null,
      body: 'Exploring the app\nfeatures.',
      prompt: '',
    } as unknown as ShowcaseFeedItem;
    searchPublicContent.mockResolvedValueOnce(searchAnswer('creative', 'top', { posts: [note] }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'creative');
    await advance(300);

    // The writing in the frame, on one run of lines; the title once, in the caption under it.
    expect(cardTexts(tree, 'Open post Creative Idea')).toEqual(['Exploring the app features.', 'Creative Idea', 'Ana', '0 saves', '0']);

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

  describe('Top and Latest', () => {
    function sortControls(tree: Tree) {
      return hostNodes(tree, 'segmented-control');
    }

    function postTitles(tree: Tree) {
      return hostNodes(tree, 'pressable')
        .map((node) => node.props.accessibilityLabel as string | undefined)
        .filter((label): label is string => Boolean(label?.startsWith('Open post ')))
        .map((label) => label.replace('Open post Post ', ''));
    }

    async function pickSort(tree: Tree, sort: PublicSearchSort) {
      await act(async () => {
        sortControls(tree)[0].props.onChange(sort);
      });
    }

    function asked() {
      return searchPublicContent.mock.calls.map(([params]) => ({
        type: params.type, sort: params.sort, cursor: params.cursor ?? null,
      }));
    }

    it('offers the two orders beside Posts, as tabs sized to their words, once the server says which it reads', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, {
        sort: 'top', posts: [post('saved'), post('new')],
      }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);

      expect(sortControls(tree)).toHaveLength(1);
      expect(sortControls(tree)[0].props).toMatchObject({
        role: 'tab',
        fill: false,
        accessibilityLabel: 'Sort posts',
        options: [{ value: 'top', label: 'Top' }, { value: 'latest', label: 'Latest' }],
        value: 'top',
      });
      expect(asked()).toEqual([{ type: 'posts', sort: 'top', cursor: null }]);

      await act(async () => tree.unmount());
    });

    it('asks for Latest at once and keeps the cards up, dimmed, under the control until it answers', async () => {
      searchPublicContent.mockResolvedValueOnce(searchAnswer('portrait', 'posts', { sort: 'top', posts: [post('saved'), post('new')] }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);
      expect(postTitles(tree)).toEqual(['saved', 'new']);

      const pending = deferred<PublicSearchResponse>();
      searchPublicContent.mockReturnValueOnce(pending.promise);
      await pickSort(tree, 'latest');
      // The query has not changed, so there is no pause before the request.
      await advance(1);

      expect(asked().at(-1)).toEqual({ type: 'posts', sort: 'latest', cursor: null });
      // No spinner in the cards' place: the control stays where the finger is.
      expect(isSearching(tree)).toBe(false);
      expect(sortControls(tree)[0].props.value).toBe('latest');
      expect(postTitles(tree)).toEqual(['saved', 'new']);
      const dimmed = tree.root.findAll((node) => node.type === 'view' && node.props.accessibilityState?.busy === true);
      expect(dimmed).toHaveLength(1);
      expect(dimmed[0].props.style).toMatchObject({ opacity: 0.5 });
      // A page of the other order is not offered while this one loads.
      expect(() => showMoreButton(tree)).toThrow();

      await act(async () => pending.resolve(searchAnswer('portrait', 'posts', { sort: 'latest', posts: [post('new'), post('saved')] })));
      expect(postTitles(tree)).toEqual(['new', 'saved']);
      expect(tree.root.findAll((node) => node.type === 'view' && node.props.accessibilityState?.busy === true)).toHaveLength(0);

      await act(async () => tree.unmount());
    });

    it('draws a failed switch to Latest as a failed search, with Retry and the control, never as cards left loading', async () => {
      searchPublicContent.mockResolvedValueOnce(searchAnswer('portrait', 'posts', { sort: 'top', posts: [post('saved'), post('new')] }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);

      searchPublicContent.mockRejectedValueOnce(new ApiError('Failed to search public content.', 500));
      await pickSort(tree, 'latest');
      await advance(1);

      const busyViews = () => tree.root.findAll((node) => node.type === 'view' && node.props.accessibilityState?.busy === true);
      // Nothing is loading any more: no dimmed cards of the other order, no spinner.
      expect(busyViews()).toHaveLength(0);
      expect(postTitles(tree)).toEqual([]);
      expect(isSearching(tree)).toBe(false);
      // The failed search, as every failed search is drawn.
      expect(statusTitles(tree)).toEqual(['Search did not load']);
      expect(statusBodies(tree)).toEqual(['Search could not be loaded. Check your connection and try again.']);
      expect(retryButton(tree).props.disabled).toBe(false);
      // The control stays, on the order that was asked for.
      expect(sortControls(tree)).toHaveLength(1);
      expect(sortControls(tree)[0].props).toMatchObject({ accessibilityLabel: 'Sort posts', value: 'latest' });

      // Retry asks for Latest again.
      searchPublicContent.mockResolvedValueOnce(searchAnswer('portrait', 'posts', { sort: 'latest', posts: [post('new'), post('saved')] }));
      await press(retryButton(tree));
      expect(asked().at(-1)).toEqual({ type: 'posts', sort: 'latest', cursor: null });
      expect(postTitles(tree)).toEqual(['new', 'saved']);
      expect(statusTitles(tree)).toEqual([]);

      // And from a failure, the other order is one press away.
      searchPublicContent.mockRejectedValueOnce(new ApiError('Too many requests.', 429, { retryAfterSeconds: 10 }));
      await pickSort(tree, 'top');
      await advance(1);
      expect(busyViews()).toHaveLength(0);
      expect(retryButton(tree).props.disabled).toBe(true);
      searchPublicContent.mockResolvedValueOnce(searchAnswer('portrait', 'posts', { sort: 'latest', posts: [post('new'), post('saved')] }));
      await pickSort(tree, 'latest');
      await advance(1);
      expect(postTitles(tree)).toEqual(['new', 'saved']);

      await act(async () => tree.unmount());
    });

    it('pages Latest with the order and its cursor', async () => {
      searchPublicContent.mockImplementation(async ({ query, type, sort, cursor }) => searchAnswer(query, type, {
        sort: sort ?? 'top',
        posts: cursor ? [post('older')] : [post('new')],
        postsCursor: cursor ? undefined : `${sort}-page-2`,
      }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);
      await pickSort(tree, 'latest');
      await advance(1);

      await press(showMoreButton(tree));
      expect(asked().at(-1)).toEqual({ type: 'posts', sort: 'latest', cursor: 'latest-page-2' });
      expect(postTitles(tree)).toEqual(['new', 'older']);

      await act(async () => tree.unmount());
    });

    it('gives Recipes the same control and keeps the choice across the two tabs', async () => {
      searchPublicContent.mockImplementation(async ({ query, type, sort }) => searchAnswer(query, type, {
        sort: type === 'posts' || type === 'recipes' ? sort ?? 'top' : 'top',
        posts: [post('p1')],
        recipes: [recipe('r1', { accessMode: 'free', priceUsdCents: 0 }, 'Noor')],
      }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Recipes'));
      await typeQuery(tree, 'lighting');
      await advance(300);

      expect(sortControls(tree)[0].props).toMatchObject({ accessibilityLabel: 'Sort recipes', value: 'top' });
      await pickSort(tree, 'latest');
      await advance(1);
      expect(asked().at(-1)).toEqual({ type: 'recipes', sort: 'latest', cursor: null });

      await press(tab(tree, 'Posts'));
      await advance(1);
      expect(asked().at(-1)).toEqual({ type: 'posts', sort: 'latest', cursor: null });
      expect(sortControls(tree)[0].props).toMatchObject({ accessibilityLabel: 'Sort posts', value: 'latest' });

      await act(async () => tree.unmount());
    });

    it('has one order on Top and Creators: no control, and the ranked order asked for', async () => {
      searchPublicContent.mockImplementation(async ({ query, type, sort }) => searchAnswer(query, type, {
        sort: type === 'posts' ? sort ?? 'top' : 'top',
        creators: [creator('jane')],
        posts: [post('p1')],
        recipes: [recipe('r1', { accessMode: 'free', priceUsdCents: 0 }, 'Noor')],
      }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'portrait');
      await advance(300);
      await pickSort(tree, 'latest');
      await advance(1);

      for (const label of ['Top', 'Creators'] as const) {
        await press(tab(tree, label));
        await advance(1);
        expect(sortControls(tree), label).toHaveLength(0);
        expect(asked().at(-1)?.sort, label).toBe('top');
      }

      await act(async () => tree.unmount());
    });

    it('draws no control against a server from before sorts, which says no order', async () => {
      // Its answers carry no `sort`, and it would read `sort=latest` as Top.
      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, {
        posts: [post('p1')],
        recipes: [recipe('r1', { accessMode: 'free', priceUsdCents: 0 }, 'Noor')],
      }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'portrait');
      await advance(300);

      for (const label of ['Posts', 'Recipes'] as const) {
        await press(tab(tree, label));
        await advance(1);
        expect(sortControls(tree), label).toHaveLength(0);
        expect(asked().at(-1)?.sort, label).toBe('top');
      }
      expect(() => pressableLabelled(tree, 'Open recipe Recipe r1')).not.toThrow();

      await act(async () => tree.unmount());
    });
  });
});

describe('ExploreSearchOverlay typeahead', () => {
  const PAUSE = SEARCH_TYPEAHEAD_DEBOUNCE_MS;
  const ANNOUNCE_PAUSE = SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS;
  const SETTLE = SEARCH_TYPEAHEAD_PRESS_SETTLE_MS;

  function suggestions(overrides: Partial<SearchSuggestResponse> = {}): SearchSuggestResponse {
    return {
      query: 'lum',
      normalizedQuery: 'lum',
      creators: [
        { id: 'c1', username: 'luma-studio', displayName: 'Luma Studio', avatarUrl: null, isFollowing: true },
        { id: 'c2', username: 'lumen', displayName: 'lumen', avatarUrl: null, isFollowing: false },
      ],
      entities: [{ kind: 'model', key: 'luma-ray-2', label: 'Luma Ray 2', postCount: 14, postCountCapped: false }],
      completions: [{ text: 'luminous' }, { text: 'lumen glow' }],
      ...overrides,
    };
  }

  // A host element of the mocked React Native, by its tag.
  const isHost = (node: Instance, ...tags: string[]) => tags.includes(node.type as unknown as string);
  function list(tree: Tree) {
    return tree.root.findAll((node) => isHost(node, 'view') && node.props.testID === 'search-typeahead-list')[0] ?? null;
  }
  function rowLabels(tree: Tree) {
    const panel = list(tree);
    if (!panel) return [];
    return panel.findAll((node) => isHost(node, 'pressable')).map((node) => node.props.accessibilityLabel as string);
  }
  function asked() {
    return suggestSearch.mock.calls.map(([params]) => params.query);
  }
  async function focusField(tree: Tree) {
    await act(async () => { searchInput(tree).props.onFocus(); });
  }
  async function blurField(tree: Tree) {
    await act(async () => { searchInput(tree).props.onBlur(); });
  }
  async function open() {
    const tree = await render({ visible: true, onClose: vi.fn() });
    await focusField(tree);
    return tree;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listeners.length = 0;
    mocks.focused.value = true;
    mocks.router.push.mockClear();
    mocks.keyboardDismiss.mockClear();
    mocks.readSearchHistory.mockClear();
    mocks.rememberSearchQuery.mockClear();
    mocks.user.value = null;
    mocks.announce.mockClear();
    mocks.scrollTo.mockClear();
    searchPublicContent.mockReset();
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type ?? 'top', { sort: 'top', creators: [creator('found')] }, {
      entities: [], filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false }, correctedQuery: { posts: null, recipes: null }, exact: false,
    }));
    suggestSearch.mockReset();
    suggestSearch.mockResolvedValue(suggestions());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers creators, then models and tools, then completions, above the results, as rows a thumb can press', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    expect(list(tree)).toBeNull();
    await advance(PAUSE);

    expect(asked()).toEqual(['lum']);
    const panel = list(tree)!;
    expect(panel.findAll((node) => isHost(node, 'text') && node.props.accessibilityRole === 'header').map(textOf))
      .toEqual(['Creators', 'Models and tools', 'Suggested searches']);
    expect(rowLabels(tree)).toEqual([
      'Luma Studio, @luma-studio, following. Open profile',
      '@lumen. Open profile',
      'Luma Ray 2, model, 14 posts. Show posts made with it',
      'Search for luminous',
      'Search for lumen glow',
    ]);
    for (const row of panel.findAll((node) => isHost(node, 'pressable'))) {
      expect(row.props.accessibilityRole).toBe('button');
      // The HIG's 44pt and more.
      expect(row.props.style.minHeight).toBeGreaterThanOrEqual(44);
    }
    expect(shownTexts(tree)).toEqual(expect.arrayContaining(['@luma-studio · Following', 'Model · 14 posts', 'luminous']));
    // This text's own answer: not busy.
    expect(panel.props.accessibilityState).toEqual({ busy: false });
    // Said to a screen reader once the list has stood for a pause, not as each letter lands.
    expect(mocks.announce).not.toHaveBeenCalled();

    // Above everything the search draws: the first thing in the scroll view, which hands a tap to the row under it
    // without first putting the keyboard away.
    const scroll = hostNodes(tree, 'scroll-view').find((node) => node.findAll((inner) => inner === panel).length > 0)!;
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scroll.findAll((node) => isHost(node, 'view', 'status-block', 'scroll-view'))[1]).toBe(panel);

    // The results load as they did, after their own longer pause, under the list.
    expect(searchPublicContent).not.toHaveBeenCalled();
    await advance(300 - PAUSE);
    expect(searchPublicContent).toHaveBeenCalledTimes(1);
    expect(list(tree)).not.toBeNull();
    expect(shownTexts(tree)).toContain('Creator found');
    await advance(ANNOUNCE_PAUSE);
    expect(mocks.announce.mock.calls).toEqual([['5 suggestions']]);
    await act(async () => tree.unmount());
  });

  it('asks once per pause in typing, and nothing until the field has the focus', async () => {
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'lum');
    await advance(400);
    // The search ran; the typeahead, with no focus in the field, asked nothing.
    expect(searchPublicContent).toHaveBeenCalledTimes(1);
    expect(asked()).toEqual([]);
    expect(list(tree)).toBeNull();

    await focusField(tree);
    await typeQuery(tree, 'l');
    await advance(PAUSE - 20);
    await typeQuery(tree, 'lu');
    await advance(PAUSE - 20);
    await typeQuery(tree, ' Lumi ');
    await advance(PAUSE);
    expect(asked()).toEqual(['Lumi']);
    // A handle is asked for with its @.
    await typeQuery(tree, '@lu');
    await advance(PAUSE);
    expect(asked()).toEqual(['Lumi', '@lu']);
    await act(async () => tree.unmount());
  });

  it('goes when the keyboard does, and asks again when the focus comes back: nothing is drawn from before', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    expect(list(tree)).not.toBeNull();
    await blurField(tree);
    expect(list(tree)).toBeNull();
    // A follow or a block made on a page opened meanwhile is in the answer asked for now.
    suggestSearch.mockResolvedValueOnce(suggestions({ creators: [], entities: [], completions: [{ text: 'lumen after' }] }));
    await focusField(tree);
    expect(list(tree)).toBeNull();
    await advance(PAUSE);
    expect(asked()).toEqual(['lum', 'lum']);
    expect(rowLabels(tree)).toEqual(['Search for lumen after']);
    await act(async () => tree.unmount());
  });

  it('keeps the list of the text before on show, busy, until this text’s answer lands, and says the count only when it changes', async () => {
    const later = deferred<SearchSuggestResponse>();
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    await advance(ANNOUNCE_PAUSE);
    expect(mocks.announce.mock.calls).toEqual([['5 suggestions']]);

    // The next letter: nothing goes. What was offered stays, less the model
    // the text no longer names (pressing it would search "lumi" narrowed to it).
    suggestSearch.mockReturnValueOnce(later.promise);
    await typeQuery(tree, 'lumi');
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: true });
    expect(rowLabels(tree)).toEqual([
      'Luma Studio, @luma-studio, following. Open profile',
      '@lumen. Open profile',
      'Search for luminous',
      'Search for lumen glow',
    ]);
    await advance(PAUSE);
    expect(asked()).toEqual(['lum', 'lumi']);
    // A stale list is not announced, however long its answer takes.
    await advance(ANNOUNCE_PAUSE * 2);
    expect(mocks.announce).toHaveBeenCalledTimes(1);

    await act(async () => {
      later.resolve(suggestions({
        creators: [{ id: 'c2', username: 'lumen', displayName: 'lumen', avatarUrl: null, isFollowing: false }],
        entities: [],
        completions: [{ text: 'lumina' }],
      }));
      await later.promise;
    });
    expect(rowLabels(tree)).toEqual(['@lumen. Open profile', 'Search for lumina']);
    // Its rows have only just taken their places: busy for a moment more, then not.
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: true });
    await advance(SETTLE);
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: false });
    expect(mocks.announce).toHaveBeenCalledTimes(1);
    await advance(ANNOUNCE_PAUSE - SETTLE);
    expect(mocks.announce.mock.calls).toEqual([['5 suggestions'], ['2 suggestions']]);

    // The same count on the next text is not said again.
    suggestSearch.mockResolvedValueOnce(suggestions({ creators: [], entities: [], completions: [{ text: 'luminal' }, { text: 'luminar' }] }));
    await typeQuery(tree, 'lumin');
    await advance(PAUSE);
    await advance(ANNOUNCE_PAUSE);
    expect(rowLabels(tree)).toEqual(['Search for luminal', 'Search for luminar']);
    expect(mocks.announce).toHaveBeenCalledTimes(2);
    await act(async () => tree.unmount());
  });

  it('has a stale row do what it shows, whatever the field holds by then', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    suggestSearch.mockReturnValueOnce(deferred<SearchSuggestResponse>().promise);
    await typeQuery(tree, 'lumi');
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: true });
    // The model went with the letter and the completions moved up: they take
    // a press once they have stood, still stale.
    await advance(SETTLE);
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: true });
    await press(pressableLabelled(tree, 'Search for lumen glow'));
    expect(searchInput(tree).props.value).toBe('lumen glow');
    await advance(0);
    expect(searchPublicContent.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'lumen glow', type: 'top' });
    expect(list(tree)).toBeNull();

    // And a stale creator opens that creator.
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    suggestSearch.mockReturnValueOnce(deferred<SearchSuggestResponse>().promise);
    await typeQuery(tree, 'lumx');
    await press(pressableLabelled(tree, '@lumen. Open profile'));
    expect(mocks.router.push).toHaveBeenCalledWith('/creators/lumen');
    await act(async () => tree.unmount());
  });

  it('takes no tap on a row that has only just come to stand under the finger, and takes it once the row has stood', async () => {
    const later = deferred<SearchSuggestResponse>();
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    // A list that has just come on show takes a tap at once, and is not busy.
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: false });

    // A letter takes the model away, and "luminous" moves up into its place:
    // a tap there now was aimed at the model.
    suggestSearch.mockReturnValueOnce(later.promise);
    await typeQuery(tree, 'lumi');
    await press(pressableLabelled(tree, 'Search for luminous'));
    expect(searchInput(tree).props.value).toBe('lumi');
    expect(mocks.keyboardDismiss).not.toHaveBeenCalled();
    expect(list(tree)).not.toBeNull();
    await advance(PAUSE);

    // The answer lands and puts the model back: it has only just come, and
    // the rows under it have moved down again.
    await act(async () => {
      later.resolve(suggestions());
      await later.promise;
    });
    expect(rowLabels(tree)).toHaveLength(5);
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: true });
    await press(pressableLabelled(tree, 'Luma Ray 2, model, 14 posts. Show posts made with it'));
    await press(pressableLabelled(tree, 'Search for luminous'));
    await advance(SETTLE - 1);
    await press(pressableLabelled(tree, 'Search for luminous'));
    expect(searchInput(tree).props.value).toBe('lumi');
    expect(tab(tree, 'Top').props.accessibilityState).toMatchObject({ selected: true });
    expect(mocks.keyboardDismiss).not.toHaveBeenCalled();

    // Once the rows have stood, the tap counts, and opens the row it is on.
    await advance(1);
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: false });
    await press(pressableLabelled(tree, 'Search for luminous'));
    expect(searchInput(tree).props.value).toBe('luminous');
    await act(async () => tree.unmount());
  });

  it('takes a tap at once on a row that stands where it stood, while the rows under another one move', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    suggestSearch.mockReturnValueOnce(deferred<SearchSuggestResponse>().promise);
    await typeQuery(tree, 'lumi');
    // The creators did not move when the model went.
    await press(pressableLabelled(tree, '@lumen. Open profile'));
    expect(mocks.router.push).toHaveBeenCalledWith('/creators/lumen');
    await act(async () => tree.unmount());
  });

  it('takes the list of the text before away at once when the field is emptied, and when this text has nothing', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    expect(list(tree)).not.toBeNull();
    await typeQuery(tree, '');
    expect(list(tree)).toBeNull();
    // What is typed next starts from nothing, not from the list of "lum".
    suggestSearch.mockResolvedValueOnce(suggestions({ creators: [], entities: [], completions: [{ text: 'veo' }] }));
    await typeQuery(tree, 'v');
    expect(list(tree)).toBeNull();
    await advance(PAUSE);
    expect(rowLabels(tree)).toEqual(['Search for veo']);
    // Stale on the next letter, then gone when that letter's own answer is empty.
    suggestSearch.mockResolvedValueOnce(suggestions({ creators: [], entities: [], completions: [] }));
    await typeQuery(tree, 'vq');
    expect(rowLabels(tree)).toEqual(['Search for veo']);
    await advance(PAUSE);
    expect(list(tree)).toBeNull();
    await act(async () => tree.unmount());
  });

  it('keeps an answer for a letter deleted, while the field keeps the focus and for half a minute at most', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    await typeQuery(tree, 'lumi');
    await advance(PAUSE);
    expect(asked()).toEqual(['lum', 'lumi']);
    // The rows of "lumi" have stood. "lum" is drawn at once from what was
    // kept, with the same rows in the same places: not busy, and not asked again.
    await advance(SETTLE);
    await typeQuery(tree, 'lum');
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: false });
    await advance(PAUSE);
    expect(asked()).toEqual(['lum', 'lumi']);
    // Past half a minute the kept answer is not drawn again: the text is asked about.
    await advance(SEARCH_TYPEAHEAD_KEPT_ANSWER_MS);
    await typeQuery(tree, 'lumi');
    await advance(PAUSE);
    expect(asked()).toEqual(['lum', 'lumi', 'lumi']);
    await act(async () => tree.unmount());
  });

  it('brings the list into view whenever it is shown: the results may have been scrolled', async () => {
    const tree = await open();
    expect(mocks.scrollTo).not.toHaveBeenCalled();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    expect(mocks.scrollTo.mock.calls).toEqual([[{ y: 0, animated: false }]]);
    // The scroll view moved is the one the list is first in.
    // The keyboard goes (a drag on the results), the results are scrolled, the field is focused again.
    await blurField(tree);
    await focusField(tree);
    expect(mocks.scrollTo).toHaveBeenCalledTimes(1);
    await advance(PAUSE);
    expect(list(tree)).not.toBeNull();
    expect(mocks.scrollTo).toHaveBeenCalledTimes(2);
    // Not at every letter while it stays shown: the person may be reading it.
    suggestSearch.mockReturnValueOnce(deferred<SearchSuggestResponse>().promise);
    await typeQuery(tree, 'lumi');
    await advance(PAUSE);
    expect(mocks.scrollTo).toHaveBeenCalledTimes(2);
    await act(async () => tree.unmount());
  });

  it('never draws the answer of a request the next letter ended', async () => {
    const early = deferred<SearchSuggestResponse>();
    suggestSearch.mockReturnValueOnce(early.promise);
    suggestSearch.mockResolvedValueOnce(suggestions({ creators: [], entities: [], completions: [{ text: 'lumina' }] }));
    const tree = await open();
    await typeQuery(tree, 'lu');
    await advance(PAUSE);
    expect(asked()).toEqual(['lu']);
    const firstSignal = suggestSearch.mock.calls[0][1] as AbortSignal;

    await typeQuery(tree, 'lum');
    // The request for the earlier text is aborted with the keystroke.
    expect(firstSignal.aborted).toBe(true);
    await act(async () => {
      early.resolve(suggestions({ creators: [], entities: [], completions: [{ text: 'lunar stale' }] }));
      await early.promise;
    });
    expect(list(tree)).toBeNull();
    await advance(PAUSE);
    expect(rowLabels(tree)).toEqual(['Search for lumina']);
    await act(async () => tree.unmount());
  });

  it('opens a creator’s profile, reading their page as the finger rests, with the keyboard left alone', async () => {
    const prepared: string[] = [];
    const remove = setCreatorProfilePreparer((username) => { prepared.push(username); });
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    const row = pressableLabelled(tree, 'Luma Studio, @luma-studio, following. Open profile');
    expect(row.props.unstable_pressDelay).toBe(CREATOR_PROFILE_PRESS_DELAY_MS);
    await act(async () => { row.props.onPressIn(); });
    expect(prepared).toEqual(['luma-studio']);
    await press(row);
    expect(mocks.router.push).toHaveBeenCalledWith('/creators/luma-studio');
    expect(mocks.keyboardDismiss).not.toHaveBeenCalled();
    expect(searchInput(tree).props.value).toBe('lum');
    remove();
    await act(async () => tree.unmount());
  });

  it('opens Posts narrowed to a model or tool, before any answer has said filters exist, and puts the keyboard away', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    // Before the search's own pause has passed: no answer has offered filters yet.
    expect(searchPublicContent).not.toHaveBeenCalled();
    await press(pressableLabelled(tree, 'Luma Ray 2, model, 14 posts. Show posts made with it'));
    await advance(0);

    expect(mocks.keyboardDismiss).toHaveBeenCalledTimes(1);
    expect(tab(tree, 'Posts').props.accessibilityState).toMatchObject({ selected: true });
    expect(searchPublicContent.mock.calls.at(-1)?.[0]).toMatchObject({
      query: 'lum',
      type: 'posts',
      filters: { madeWith: 'model:luma-ray-2', mediaKind: null, hasRecipe: false, following: false },
    });
    // Named on its chip at once.
    expect(textOf(pressableLabelled(tree, 'Remove filter: made with Luma Ray 2'))).toBe('Made with Luma Ray 2');
    expect(list(tree)).toBeNull();
    await act(async () => tree.unmount());
  });

  it('fills the field with a completion, searches for it at once and commits it, the list closed over its results', async () => {
    mocks.rememberSearchQuery.mockResolvedValue(['luminous']);
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    await press(pressableLabelled(tree, 'Search for luminous'));

    expect(searchInput(tree).props.value).toBe('luminous');
    expect(mocks.keyboardDismiss).toHaveBeenCalledTimes(1);
    // No pause for typing: the person chose this search.
    await advance(0);
    expect(searchPublicContent.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'luminous', type: 'top' });
    // Committed as the Search key commits one: kept once it finds something.
    expect(mocks.rememberSearchQuery).toHaveBeenCalledWith('luminous');
    // Its own suggestions are not drawn over the results it asked for.
    await advance(PAUSE);
    expect(list(tree)).toBeNull();
    // Typing on opens the list again.
    suggestSearch.mockResolvedValue(suggestions({ creators: [], entities: [], completions: [{ text: 'luminous glow' }] }));
    await typeQuery(tree, 'luminous g');
    await advance(PAUSE);
    expect(rowLabels(tree)).toEqual(['Search for luminous glow']);
    await act(async () => tree.unmount());
  });

  it('gets out of the way of the Search key: the search is what is typed', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    expect(list(tree)).not.toBeNull();
    await act(async () => { searchInput(tree).props.onSubmitEditing(); });
    expect(list(tree)).toBeNull();
    expect(searchInput(tree).props.value).toBe('lum');
    expect(mocks.router.push).not.toHaveBeenCalled();
    // Another letter is a new text: the list is offered again.
    await typeQuery(tree, 'lumi');
    await advance(PAUSE);
    expect(list(tree)).not.toBeNull();
    await act(async () => tree.unmount());
  });

  it.each([
    ['a failed request', () => Promise.reject(new ApiError('Failed to load search suggestions.', 500, null))],
    ['a request that never got an answer', () => Promise.reject(new ApiError('Network request failed', 0, null))],
    ['a body that is not an answer', () => Promise.resolve({ query: 'lum', type: 'top', creators: { items: [] } } as unknown as SearchSuggestResponse)],
    ['a switched-off route’s empty answer', () => Promise.resolve(suggestions({ creators: [], entities: [], completions: [] }))],
  ])('shows nothing, and no error, for %s', async (_name, reply) => {
    suggestSearch.mockImplementation(reply);
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(400);
    expect(asked()).toEqual(['lum']);
    expect(list(tree)).toBeNull();
    expect(mocks.announce).not.toHaveBeenCalled();
    // The search itself is untouched, and nothing is drawn as a failure.
    expect(shownTexts(tree)).toContain('Creator found');
    expect(statusTitles(tree)).toEqual([]);
    expect(hostNodes(tree, 'text').some((node) => node.props.accessibilityRole === 'alert')).toBe(false);
    await act(async () => tree.unmount());
  });

  it('shows nothing when rate limited, and asks no more until the limit has passed', async () => {
    suggestSearch.mockRejectedValue(new ApiError('Too many requests', 429, { code: 'RATE_LIMITED', retryAfterSeconds: 30 }));
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    await typeQuery(tree, 'lumi');
    await advance(PAUSE);
    await typeQuery(tree, 'lumin');
    await advance(PAUSE);
    expect(asked()).toEqual(['lum']);
    expect(list(tree)).toBeNull();
    // Once the window the server named has passed, typing asks again.
    suggestSearch.mockResolvedValue(suggestions());
    await advance(30_000);
    await typeQuery(tree, 'lumino');
    await advance(PAUSE);
    expect(asked()).toEqual(['lum', 'lumino']);
    await act(async () => tree.unmount());
  });

  it('draws no model or tool for two characters, whatever an answer carries', async () => {
    const tree = await open();
    await typeQuery(tree, 'lu');
    await advance(PAUSE);
    expect(rowLabels(tree)).toHaveLength(4);
    expect(shownTexts(tree)).not.toContain('Models and tools');
    await act(async () => tree.unmount());
  });

  it('offers handles alone at one character, over the recent searches, which stay as they were', async () => {
    mocks.readSearchHistory.mockResolvedValue(['neon harbor']);
    suggestSearch.mockResolvedValue(suggestions({ entities: [], completions: [] }));
    const tree = await open();
    // Empty: the recent searches, and nothing asked.
    expect(shownTexts(tree)).toContain('Recent searches');
    expect(asked()).toEqual([]);
    await typeQuery(tree, 'l');
    await advance(PAUSE);
    expect(asked()).toEqual(['l']);
    expect(rowLabels(tree)).toEqual([
      'Luma Studio, @luma-studio, following. Open profile',
      '@lumen. Open profile',
    ]);
    // One character is not yet a search: the idle state is still under the list.
    expect(shownTexts(tree)).toContain('Recent searches');
    expect(searchPublicContent).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('keeps one account’s answers to that account', async () => {
    mocks.user.value = { id: 'account-1' };
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    expect(asked()).toEqual(['lum']);
    expect(shownTexts(tree)).toContain('@luma-studio · Following');

    // Signed out with the search open: what was kept said whom that account follows.
    mocks.user.value = null;
    suggestSearch.mockResolvedValue(suggestions({
      creators: [{ id: 'c1', username: 'luma-studio', displayName: 'Luma Studio', avatarUrl: null, isFollowing: false }],
    }));
    await update(tree, { visible: true, onClose: vi.fn() });
    await advance(PAUSE);
    expect(asked()).toEqual(['lum', 'lum']);
    expect(shownTexts(tree)).not.toContain('@luma-studio · Following');
    expect(shownTexts(tree)).toContain('@luma-studio');
    await act(async () => tree.unmount());
  });

  it('asks nothing once the search is closed', async () => {
    const onClose = vi.fn();
    const tree = await open();
    await typeQuery(tree, 'lum');
    await update(tree, { visible: false, onClose });
    await advance(PAUSE);
    expect(asked()).toEqual([]);
    await act(async () => tree.unmount());
  });
});

