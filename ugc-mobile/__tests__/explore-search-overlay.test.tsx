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
import {
  SEARCH_FAILED_BODY,
  SEARCH_IDLE_BODY,
  SEARCH_IDLE_TITLE,
  SEARCH_OFFLINE_BODY,
  SEARCH_PLACEHOLDER,
  SEARCH_RELATED_HEADING,
  SEARCH_RELATED_SETTLE_MS,
  SEARCH_RETRY_LABEL,
  SEARCH_SORT_OPTIONS,
} from '../lib/public-search-policy/public-search-policy';
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
    // The phone's text size, as React Native reports it.
    fontScale: { value: 1 },
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
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: mocks.fontScale.value }),
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
  Play: (props: MockProps) => React.createElement('icon', props),
  ImageIcon: (props: MockProps) => React.createElement('icon', props),
}));

// A post's picture, as the feed's pins draw it: what it is given is what the test reads.
vi.mock('@/components/showcase-media-preview', () => ({
  ShowcaseMediaPreview: (props: MockProps) => React.createElement('showcase-media-preview', props),
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
// The starter (ideas before anything is typed): nothing, unless a case gives some.
const searchStarter = vi.fn<MagicbookletApiClient['searchStarter']>(async () => ({ entities: [], creators: [], searches: [] }));
const api = { searchPublicContent, suggestSearch, searchStarter } as unknown as MagicbookletApiClient;

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

// A result's label goes on to say all its card shows ("…, 3 posts. Films and
// stills"): a label given up to a comma or a full stop finds it, as an exact one does.
function pressableLabelled(tree: Tree, label: string) {
  const match = hostNodes(tree, 'pressable').find((node) => {
    const given = node.props.accessibilityLabel as string | undefined;
    return given === label || Boolean(given?.startsWith(`${label},`) || given?.startsWith(`${label}.`));
  });
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
  const match = hostNodes(tree, 'secondary-button').find((node) => node.props.label === SEARCH_RETRY_LABEL);
  if (!match) throw new Error('No Try again button');
  return match;
}

// What a person does to see results in the app: type, then commit (the
// Search key). Typing alone shows suggestions only (lib/search-typing-mode.ts).
async function typeQuery(tree: Tree, value: string) {
  await typeOnly(tree, value);
  await act(async () => {
    searchInput(tree).props.onSubmitEditing();
  });
}

// Typing, and nothing else: the screen is in its typing mode.
async function typeOnly(tree: Tree, value: string) {
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
    mocks.fontScale.value = 1;
    searchPublicContent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('search UX quick fixes (audit 2026-11-13)', () => {
    it('opens on the shared invitation and placeholder, with no rule about characters', async () => {
      const tree = await render({ visible: true, onClose: vi.fn() });
      expect(statusTitles(tree)).toEqual([SEARCH_IDLE_TITLE]);
      expect(statusBodies(tree)).toEqual([SEARCH_IDLE_BODY]);
      expect(searchInput(tree).props.placeholder).toBe(SEARCH_PLACEHOLDER);
      expect(shownTexts(tree).join(' ')).not.toMatch(/character/i);
      await act(async () => tree.unmount());
    });

    it('never says "No results" for two characters: the creators found, or the idle state', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'na');
      await advance(300);
      expect(requested()).toEqual([{ query: 'na', type: 'top' }]);
      expect(saysNoResults(tree)).toBe(false);
      expect(statusTitles(tree)).toEqual([SEARCH_IDLE_TITLE]);

      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { creators: [creator('nadia')] }));
      await typeQuery(tree, 'nad');
      await advance(300);
      expect(() => pressableLabelled(tree, "Open Creator nadia's profile, @nadia")).not.toThrow();
      await typeQuery(tree, 'na');
      await advance(300);
      expect(() => pressableLabelled(tree, "Open Creator nadia's profile, @nadia")).not.toThrow();
      await act(async () => tree.unmount());
    });

    it('keeps the corrected spelling among recent searches, and the typed one when asked for as typed', async () => {
      const corrected = { entities: [], correctedQuery: { posts: 'portrait', recipes: null }, exact: false };
      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { posts: [post('p1')] }, corrected));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'portriat');
      await advance(300);
      await act(async () => searchInput(tree).props.onSubmitEditing());
      expect(mocks.rememberSearchQuery.mock.calls).toEqual([['portrait']]);

      // Opening a result keeps it the same way.
      await press(pressableLabelled(tree, 'Open post Post p1 by Ana'));
      expect(mocks.rememberSearchQuery.mock.calls.at(-1)).toEqual(['portrait']);

      // Asked for as typed, the typed spelling is what the person meant.
      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { posts: [post('p1')] }, { ...corrected, correctedQuery: { posts: null, recipes: null }, exact: true }));
      await press(pressableLabelled(tree, 'Search instead for “portriat”'));
      await advance(1);
      await act(async () => searchInput(tree).props.onSubmitEditing());
      expect(mocks.rememberSearchQuery.mock.calls.at(-1)).toEqual(['portriat']);
      await act(async () => tree.unmount());
    });

    it('keeps the corrected spelling for a search committed before its answer landed', async () => {
      const pending = deferred<PublicSearchResponse>();
      searchPublicContent.mockImplementation(() => pending.promise);
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'portriat');
      await act(async () => searchInput(tree).props.onSubmitEditing());
      await advance(300);
      await act(async () => pending.resolve(searchAnswer('portriat', 'top', { posts: [post('p1')] }, {
        entities: [], correctedQuery: { posts: 'portrait', recipes: null }, exact: false,
      })));
      expect(mocks.rememberSearchQuery.mock.calls).toEqual([['portrait']]);
      await act(async () => tree.unmount());
    });

    it('offers "See all" by each Top section, and a full-width one under a full section', async () => {
      const posts = Array.from({ length: 12 }, (_, index) => post(`p${index}`));
      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, {
        creators: [creator('jane')],
        posts,
        recipes: [recipe('r1', { accessMode: 'free', priceUsdCents: 0 }, 'Jane')],
      }));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'portrait');
      await advance(300);

      for (const section of ['creators', 'posts', 'recipes']) {
        expect(() => pressableLabelled(tree, `See all ${section}`), section).not.toThrow();
      }
      // Twelve posts fill Top's section; one creator and one recipe do not.
      expect(hostNodes(tree, 'secondary-button').map((node) => node.props.label)).toEqual(['See all posts']);

      await act(async () => hostNodes(tree, 'secondary-button')[0].props.onPress());
      expect(tab(tree, 'Posts').props.accessibilityState.selected).toBe(true);
      await advance(1);
      expect(() => pressableLabelled(tree, 'See all posts')).toThrow();

      await press(tab(tree, 'Top'));
      await advance(1);
      await press(pressableLabelled(tree, 'See all creators'));
      expect(tab(tree, 'Creators').props.accessibilityState.selected).toBe(true);
      await act(async () => tree.unmount());
    });

    it('draws posts in two columns, one at the accessibility text sizes', async () => {
      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { posts: [post('p1'), post('p2'), post('p3')] }));
      const columns = (tree: Tree) => hostNodes(tree, 'view').find((node) => node.props.testID === 'search-posts')!.children.length;

      mocks.fontScale.value = 1.35;
      let tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'portrait');
      expect(columns(tree)).toBe(2);
      await act(async () => tree.unmount());

      mocks.fontScale.value = 1.65;
      tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'portrait');
      expect(columns(tree)).toBe(1);
      await act(async () => tree.unmount());
    });

    it('names its recents "Clear all", as the web does', async () => {
      mocks.readSearchHistory.mockResolvedValueOnce(['portrait']);
      const tree = await render({ visible: true, onClose: vi.fn() });
      await advance(200);
      expect(shownTexts(tree)).toContain('Clear all');
      expect(() => pressableLabelled(tree, 'Clear all recent searches')).not.toThrow();
      await act(async () => tree.unmount());
    });

    it('shows recent searches under an empty field only, as the web does (review of #784)', async () => {
      mocks.readSearchHistory.mockResolvedValue(['portrait']);
      const tree = await render({ visible: true, onClose: vi.fn() });
      await advance(200);
      expect(shownTexts(tree)).toContain('Recent searches');
      await press(tab(tree, 'Posts'));
      await typeQuery(tree, 'ab');
      await advance(300);
      expect(searchPublicContent).not.toHaveBeenCalled();
      expect(shownTexts(tree)).not.toContain('Recent searches');
      expect(statusTitles(tree)).toEqual([SEARCH_IDLE_TITLE]);
      await typeQuery(tree, '');
      expect(shownTexts(tree)).toContain('Recent searches');
      mocks.readSearchHistory.mockResolvedValue([]);
      await act(async () => tree.unmount());
    });

    it('keeps the typed query for a creator opened, the corrected one for a post (review of #784)', async () => {
      const corrected = { entities: [], correctedQuery: { posts: 'josh', recipes: null }, exact: false };
      searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { creators: [creator('joshh')], posts: [post('p1')] }, corrected));
      const tree = await render({ visible: true, onClose: vi.fn() });
      await typeQuery(tree, 'joshh');
      await advance(300);
      await press(pressableLabelled(tree, "Open Creator joshh's profile, @joshh, 3 posts"));
      await advance(CREATOR_PROFILE_PRESS_DELAY_MS + 10);
      expect(mocks.rememberSearchQuery.mock.calls.at(-1)).toEqual(['joshh']);
      await press(pressableLabelled(tree, 'Open post Post p1 by Ana'));
      expect(mocks.rememberSearchQuery.mock.calls.at(-1)).toEqual(['josh']);
      await act(async () => tree.unmount());
    });
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
      // (Then Top, once, for what an empty Posts would point to: finding 8.)
      expect(asked().filter((params) => params.type === 'posts').at(-1)).toMatchObject({ type: 'posts', exact: true });
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

    // Typing asks for suggestions only: nothing is searched, so nothing can have failed to match.
    await typeOnly(tree, 'portrait');
    await advance(1000);
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(isSearching(tree)).toBe(false);
    expect(saysNoResults(tree)).toBe(false);

    // Committed: asked at once, with no pause for typing.
    await act(async () => { searchInput(tree).props.onSubmitEditing(); });
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
    expect(() => pressableLabelled(tree, "Open Creator jane's profile, @jane")).not.toThrow();

    const failing = deferred<PublicSearchResponse>();
    searchPublicContent.mockReturnValueOnce(failing.promise);
    await typeQuery(tree, 'portraits');
    expect(isSearching(tree)).toBe(true);
    expect(() => pressableLabelled(tree, "Open Creator jane's profile, @jane")).toThrow();

    await act(async () => failing.reject(new ApiError('Failed to search public content.', 500)));
    expect(statusTitles(tree)).toContain('Search did not load');

    searchPublicContent.mockReturnValueOnce(deferred<PublicSearchResponse>().promise);
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
    expect(() => pressableLabelled(tree, 'Open post Post p1 by Ana')).not.toThrow();

    await act(async () => tree.unmount());
  });

  it('asks nothing for "@j", which the server counts as one character, and asks for "@jo"', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { creators: [creator('jo')] }));
    const tree = await render({ visible: true, onClose: vi.fn() });

    await typeQuery(tree, '@j');
    await advance(300);
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(isSearching(tree)).toBe(false);
    expect(statusTitles(tree)).toEqual([SEARCH_IDLE_TITLE]);

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
    expect(statusTitles(tree)).toEqual([SEARCH_IDLE_TITLE]);

    // Two characters: Posts still waits for a third.
    await typeQuery(tree, '\u{1F600}\u{1F600}');
    await advance(300);
    expect(searchPublicContent).not.toHaveBeenCalled();
    await typeQuery(tree, '\u{1F600}\u{1F600}\u{1F600}');
    await advance(300);
    // Posts found nothing: Top is asked once for what another tab holds.
    expect(requested()).toEqual([{ query: '\u{1F600}\u{1F600}\u{1F600}', type: 'posts' }, { query: '\u{1F600}\u{1F600}\u{1F600}', type: 'top' }]);

    await act(async () => tree.unmount());
  });

  it('never asks for posts with "@ab": Posts stays picked, undimmed and idle until a third character', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));

    await typeQuery(tree, '@ab');
    await advance(300);
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(tab(tree, 'Posts').props.accessibilityState).toEqual({ selected: true });
    expect(tab(tree, 'Creators').props.accessibilityState).toEqual({ selected: false });
    expect(statusTitles(tree)).toEqual([SEARCH_IDLE_TITLE]);

    await typeQuery(tree, '@abc');
    await advance(300);
    expect(requested()).toEqual([{ query: '@abc', type: 'posts' }, { query: '@abc', type: 'top' }]);
    expect(tab(tree, 'Posts').props.accessibilityState).toEqual({ selected: true });

    await act(async () => tree.unmount());
  });

  it('keeps the picked tab through a two-character query: Posts, "ab", then "abc" asks for posts', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));

    await typeQuery(tree, 'ab');
    await advance(300);
    expect(tab(tree, 'Posts').props.accessibilityState.selected).toBe(true);

    await typeQuery(tree, 'abc');
    await advance(300);
    expect(requested()).toEqual([{ query: 'abc', type: 'posts' }, { query: 'abc', type: 'top' }]);
    expect(tab(tree, 'Posts').props.accessibilityState.selected).toBe(true);

    // A new word passes through two characters again and still lands on Posts.
    await typeQuery(tree, '');
    await typeQuery(tree, 'la');
    await advance(300);
    await typeQuery(tree, 'lake');
    await advance(300);
    expect(requested().slice(-2)).toEqual([{ query: 'lake', type: 'posts' }, { query: 'lake', type: 'top' }]);

    await act(async () => tree.unmount());
  });

  it('searches and keeps only what was committed, never a step of the typing', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { creators: [creator('jane')] }));
    const tree = await render({ visible: true, onClose: vi.fn() });

    for (const value of ['po', 'por', 'port']) {
      await typeOnly(tree, value);
      await advance(300);
    }
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(mocks.rememberSearchQuery).not.toHaveBeenCalled();

    await act(async () => { searchInput(tree).props.onSubmitEditing(); });
    expect(requested()).toEqual([{ query: 'port', type: 'top' }]);
    // A commit that found something is kept, and opening a result keeps it again (at the top).
    expect(mocks.rememberSearchQuery.mock.calls).toEqual([['port']]);
    await press(pressableLabelled(tree, "Open Creator jane's profile, @jane"));
    expect(mocks.rememberSearchQuery.mock.calls).toEqual([['port'], ['port']]);
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
    const row = pressableLabelled(tree, "Open Creator jane's profile, @jane");

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

    expect(statusBodies(tree)).toContain('Too many searches at once. Wait 30 s.');
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
    expect(() => pressableLabelled(tree, "Open Creator jane's profile, @jane")).not.toThrow();

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
      // Creators are neither narrowed nor read as typed, and bring no related posts.
      filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false }, exact: false, related: false,
    });
    // The first page stays up, with the reason under it.
    expect(() => pressableLabelled(tree, "Open Creator jane's profile, @jane")).not.toThrow();
    expect(shownTexts(tree)).toContain('Search did not load. Too many searches at once. Wait 10 s.');
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
    [429, 'Too many searches at once. Wait a moment.'],
    [400, SEARCH_FAILED_BODY],
    [503, SEARCH_OFFLINE_BODY],
    [0, SEARCH_OFFLINE_BODY],
    [404, SEARCH_FAILED_BODY],
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
  function exactLabel(tree: Tree, label: string) {
    return pressableLabelled(tree, label).props.accessibilityLabel as string;
  }
  function expectLabelHoldsCard(tree: Tree, label: string) {
    const said = exactLabel(tree, label).toLowerCase();
    for (const text of cardTexts(tree, label)) expect(said, `${said} holds “${text}”`).toContain(text.toLowerCase());
  }
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
    expect(cardTexts(tree, "Open Creator jane's profile, @jane, following, 3 posts. Films and stills"))
      .toEqual(['Creator jane', 'Following', '@jane', 'Films and stills', '3 posts']);
    expect(exactLabel(tree, "Open Creator jane's profile, @jane, following")).toBe("Open Creator jane's profile, @jane, following, 3 posts. Films and stills");
    const bio = pressableLabelled(tree, "Open Creator jane's profile, @jane, following")
      .find((node) => node.type === 'text' && textOf(node) === 'Films and stills');
    expect(bio.props.numberOfLines).toBe(1);
    // No bio leaves no empty line, and no follow leaves no mark.
    expect(cardTexts(tree, "Open Creator janet's profile, @janet")).toEqual(['Creator janet', '@janet', '2 posts']);
    expect(exactLabel(tree, "Open Creator janet's profile, @janet")).toBe("Open Creator janet's profile, @janet, 2 posts");
    // Nothing the row shows is missing from what a screen reader hears (review of #784).
    expectLabelHoldsCard(tree, "Open Creator jane's profile");
    expectLabelHoldsCard(tree, "Open Creator janet's profile");

    await act(async () => tree.unmount());
  });

  // Search UX audit 2026-11-13, finding 3: a search post is drawn as Explore
  // draws one, and says what it was made with and when.
  it('draws a post as Explore does: its picture at its own shape, badge, video mark, @handle, made-with and date', async () => {
    const day = 86_400_000;
    const clip = {
      ...post('v1'),
      title: 'Neon portrait',
      creator: { name: 'Luna Studio', username: 'luna', avatar: null },
      model: 'nano-banana-2',
      mediaKind: 'video',
      mediaUrl: 'https://cdn.example.test/v1.mp4',
      createdAt: new Date(Date.now() - 3 * day).toISOString(),
      asset: { accessMode: 'free', priceUsdCents: 0, resourceKinds: ['prompt'], allowRemix: false },
      mediaItems: [{ id: 'm1', sortOrder: 0, mediaKind: 'video', url: 'https://cdn.example.test/v1.mp4', previewUrl: 'https://cdn.example.test/v1.jpg', width: 1080, height: 1920 }],
    } as unknown as ShowcaseFeedItem;
    const still = {
      ...post('i1'),
      title: 'Harbour',
      creator: { name: 'Noor', username: 'noor', avatar: null },
      model: 'an-unknown-slug',
      createdAt: new Date(Date.now() - 40 * day).toISOString(),
    } as unknown as ShowcaseFeedItem;
    searchPublicContent.mockResolvedValueOnce(searchAnswer('portrait', 'top', { posts: [clip, still] }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'portrait');

    const label = 'Open post Neon portrait by @luna';
    expect(exactLabel(tree, label)).toBe('Open post Neon portrait by @luna, video, made with Nano Banana 2.0, Free recipe, 3d ago, 0 saves, 0 comments');
    expect(cardTexts(tree, label)).toEqual(['Free recipe', '@luna', '· 3d ago', 'Made with Nano Banana 2.0']);
    // Everything the card shows is in its name.
    for (const shown of ['free recipe', '@luna', 'made with nano banana 2.0', '3d ago']) expect(exactLabel(tree, label).toLowerCase()).toContain(shown);
    // The picture at its own shape (9:16), not cut to one frame.
    const picture = pressableLabelled(tree, label).findAll((node) => (node.type as unknown as string) === 'showcase-media-preview')[0];
    expect(picture.props.height / picture.props.width).toBeCloseTo(16 / 9, 1);
    expect(picture.props.videoActivation).toBe('never');
    // A model the feed does not name is not made up: no made-with, only the date.
    expect(exactLabel(tree, 'Open post Harbour by @noor')).toMatch(/^Open post Harbour by @noor, [A-Z][a-z]{2} \d{1,2}, 0 saves, 0 comments$/);

    await press(pressableLabelled(tree, label));
    expect(mocks.router.push).toHaveBeenCalledWith('/post/v1');
    await act(async () => tree.unmount());
  });

  // Review of #793: a post opens over the search, and Back finds the same
  // results at the same place, with nothing asked again.
  it('comes back from a post to the same results at the same place, asking nothing again', async () => {
    searchPublicContent.mockResolvedValueOnce(searchAnswer('harbour', 'top', { posts: [post('v1'), post('v2')] }));
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });
    await typeQuery(tree, 'harbour');
    const asked = searchPublicContent.mock.calls.length;
    const shownBefore = hostNodes(tree, 'pressable').map((node) => node.props.accessibilityLabel as string | undefined).filter((label) => label?.startsWith('Open post '));
    expect(shownBefore).toHaveLength(2);
    mocks.scrollTo.mockClear();

    await press(pressableLabelled(tree, 'Open post Post v2 by Ana'));
    expect(mocks.router.push).toHaveBeenCalledWith('/post/v2');
    // The post's page covers the search, which stays mounted under it; then Back.
    mocks.focused.value = false;
    await update(tree, { visible: true, onClose });
    mocks.focused.value = true;
    await update(tree, { visible: true, onClose });

    expect(searchPublicContent.mock.calls.length).toBe(asked);
    expect(hostNodes(tree, 'pressable').map((node) => node.props.accessibilityLabel as string | undefined).filter((label) => label?.startsWith('Open post '))).toEqual(shownBefore);
    expect(searchInput(tree).props.value).toBe('harbour');
    // Not scrolled back to the top: the place is kept.
    expect(mocks.scrollTo).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('says a post was made with the model or tool the search is narrowed to', async () => {
    const made = { ...post('p1'), model: 'luma-ray-2' } as unknown as ShowcaseFeedItem;
    searchPublicContent.mockImplementation(async ({ query, type }) => searchAnswer(query, type, { posts: [made] }, {
      entities: [{ kind: 'model', key: 'luma-ray-2', label: 'Luma Ray 2', postCount: 1, postCountCapped: false }],
      filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
      correctedQuery: { posts: null, recipes: null },
      exact: false,
    }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'luma');
    // Not a model the feed names: nothing is said of it on Top.
    expect(exactLabel(tree, 'Open post Post p1 by Ana')).not.toContain('made with');
    await press(pressableLabelled(tree, 'Luma Ray 2, model, 1 post. Show posts made with it'));
    expect(exactLabel(tree, 'Open post Post p1 by Ana')).toContain('made with Luma Ray 2');
    await act(async () => tree.unmount());
  });

  it('draws a text post as its writing, title and all, at a fixed shape', async () => {
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

    // No caption under the pin names it, so the plate holds the title and the writing.
    const plate = pressableLabelled(tree, 'Open post Creative Idea by Ana').findAll((node) => node.props.testID === 'search-text-post-plate')[0];
    expect(plate.props.content).toMatchObject({ title: 'Creative Idea' });
    expect(cardTexts(tree, 'Open post Creative Idea by Ana')).toEqual(expect.arrayContaining(['Exploring the app features.', 'Creative Idea', 'Ana']));

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

    expect(cardTexts(tree, 'Open recipe Recipe r1 by Luna Studio, Free')).toEqual(['Recipe r1', 'Lighting, lens and grade', 'Luna Studio', 'Free']);
    expect(exactLabel(tree, 'Open recipe Recipe r1 by Luna Studio, Free')).toBe('Open recipe Recipe r1 by Luna Studio, Free. Lighting, lens and grade');
    expectLabelHoldsCard(tree, 'Open recipe Recipe r1 by Luna Studio, Free');
    // The app prices an unlock in credits where the web quotes cash; the seller reads the same.
    expect(cardTexts(tree, 'Open recipe Recipe r2 by Noor, 900 credits')).toEqual(['Recipe r2', 'Lighting, lens and grade', 'Noor', '900 credits']);

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
    mocks.rememberSearchQuery.mockClear();
    await press(pressableLabelled(tree, 'Open recipe Recipe r1 by Noor, 900 credits'));
    expect(mocks.router.push.mock.calls).toEqual([opensRecipe]);
    expect(mocks.rememberSearchQuery.mock.calls).toEqual([['lighting']]);

    // The Recipes tab draws the same row.
    await press(tab(tree, 'Recipes'));
    await advance(300);
    await press(pressableLabelled(tree, 'Open recipe Recipe r1 by Noor, 900 credits'));
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
        .map((label) => label.replace('Open post Post ', '').replace(/ by Ana.*$/, ''));
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
        options: SEARCH_SORT_OPTIONS,
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
      expect(statusBodies(tree)).toEqual([SEARCH_OFFLINE_BODY]);
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
      expect(() => pressableLabelled(tree, 'Open recipe Recipe r1 by Noor, Free')).not.toThrow();

      await act(async () => tree.unmount());
    });
  });
});

// Related posts: when the app asks for them (`related: true` costs the viewer
// one of forty new queries a day, so never at a step of the typing), and what
// it draws. The rule is the web's too (lib/public-search-policy, "Related posts").
describe('ExploreSearchOverlay related posts', () => {
  const SETTLE = SEARCH_RELATED_SETTLE_MS;
  const RELATED = { posts: [post('sea'), post('cliffs')] };
  const full = (query: string, type: PublicSearchType, kinds: Parameters<typeof searchAnswer>[2] = {}, related?: PublicSearchResponse['related']) => ({
    ...searchAnswer(query, type, { sort: 'top', ...kinds }, {
      entities: [], filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false }, correctedQuery: { posts: null, recipes: null }, exact: false,
    }),
    ...(related ? { related } : {}),
  });
  const asked = () => searchPublicContent.mock.calls.map(([params]) => `${params.query}|${params.type}|${params.sort}|${params.related ? 'related' : 'plain'}${params.cursor ? `|${params.cursor}` : ''}`);
  const submit = (tree: Tree) => act(async () => { searchInput(tree).props.onSubmitEditing(); });
  const relatedGroup = (tree: Tree) => hostNodes(tree, 'view').find((node) => node.props.testID === 'search-related-posts') ?? null;
  const relatedLabels = (tree: Tree) => (relatedGroup(tree)?.findAll((node) => (node.type as unknown as string) === 'pressable') ?? [])
    .map((node) => node.props.accessibilityLabel as string);

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listeners.length = 0;
    mocks.focused.value = true;
    mocks.router.push.mockClear();
    mocks.readSearchHistory.mockReset();
    mocks.readSearchHistory.mockResolvedValue([]);
    mocks.rememberSearchQuery.mockClear();
    mocks.user.value = null;
    mocks.announce.mockClear();
    searchPublicContent.mockReset();
    searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top'));
    suggestSearch.mockReset();
    suggestSearch.mockResolvedValue({ query: '', normalizedQuery: '', creators: [], entities: [], completions: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks with every committed search, and never while the person types', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top', {}, RELATED));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeOnly(tree, 'ocean');
    await advance(300 + SETTLE * 2);
    await typeOnly(tree, 'ocean at dusk');
    await advance(300 + SETTLE * 2);
    expect(asked()).toEqual([]);

    // Committed: one request, with related posts, at once.
    await submit(tree);
    expect(asked()).toEqual(['ocean at dusk|top|top|related']);

    // Drawn under the search's own outcome with the cards its posts use, and said.
    expect(relatedLabels(tree)).toEqual(['Open post Post sea by Ana, Just now, 0 saves, 0 comments', 'Open post Post cliffs by Ana, Just now, 0 saves, 0 comments']);
    expect(shownTexts(tree)).toContain(SEARCH_RELATED_HEADING);
    expect(saysNoResults(tree)).toBe(true);
    expect(mocks.announce).toHaveBeenCalledWith('2 related posts');

    // Once per answer: nothing more however long it stands, nor for the Search key again.
    await submit(tree);
    await advance(SETTLE * 4);
    expect(asked()).toHaveLength(1);
    await act(async () => tree.unmount());
  });

  it('asks with the search itself for a recent search opened', async () => {
    mocks.readSearchHistory.mockResolvedValue(['ocean at dusk']);
    const tree = await render({ visible: true, onClose: vi.fn() });
    await advance(0);
    await press(pressableLabelled(tree, 'Search again for ocean at dusk'));
    await advance(300);
    expect(asked()).toEqual(['ocean at dusk|top|top|related']);
    await act(async () => tree.unmount());
  });

  it('does not ask again for an answer that is not thin, and never for a later page', async () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => post(id));
    searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top', { posts: six, postsCursor: 'page-2' }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));
    await typeQuery(tree, 'ocean at dusk');
    await submit(tree);
    await advance(300);
    expect(asked()).toEqual(['ocean at dusk|posts|top|related']);
    await advance(SETTLE * 2);
    expect(asked()).toHaveLength(1);
    await press(showMoreButton(tree));
    expect(asked().at(-1)).toBe('ocean at dusk|posts|top|plain|page-2');
    await act(async () => tree.unmount());
  });

  it('never asks on Creators, Recipes or Latest, nor for a query too short to be searched for posts', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top', type === 'posts' ? { posts: [post('own')] } : {}));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'ocean at dusk');
    await advance(300);
    await press(tab(tree, 'Creators'));
    await submit(tree);
    await advance(SETTLE * 2);
    await press(tab(tree, 'Recipes'));
    await advance(SETTLE * 2);
    // Posts in the ranked order is where they apply, and the person has settled on this query.
    await press(tab(tree, 'Posts'));
    await advance(0);
    await act(async () => { hostNodes(tree, 'segmented-control')[0].props.onChange('latest'); });
    await advance(SETTLE * 2);
    expect(asked()).toEqual([
      'ocean at dusk|top|top|related',
      'ocean at dusk|creators|top|plain',
      'ocean at dusk|recipes|top|plain',
      'ocean at dusk|posts|top|related',
      'ocean at dusk|posts|latest|plain',
    ]);
    await press(tab(tree, 'Top'));
    await typeQuery(tree, 'oc');
    await submit(tree);
    await advance(300 + SETTLE * 2);
    expect(asked().filter((line) => line.startsWith('oc|'))).toEqual(['oc|top|top|plain']);
    await act(async () => tree.unmount());
  });

  it('never asks for a handle search, and asks for the same letters without the "@"', async () => {
    // Seen on the simulator against production (2026-11-13): "@flu" spent a lookup.
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, '@flu');
    await advance(SETTLE * 2);
    expect(asked()).toEqual(['@flu|top|top|plain']);
    await typeQuery(tree, 'flu');
    await advance(SETTLE * 2);
    expect(asked().slice(1)).toEqual(['flu|top|top|related']);
    await act(async () => tree.unmount());
  });

  it('draws the group under the search’s own results, and nothing for an answer that brings none', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top', { posts: [post('own')] }, RELATED));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'ocean at dusk');
    await submit(tree);
    await advance(300);
    // After the search's own Posts group (the tab of that name comes first of all).
    const lines = shownTexts(tree);
    expect(lines.filter((line) => line === SEARCH_RELATED_HEADING)).toHaveLength(1);
    expect(lines.indexOf(SEARCH_RELATED_HEADING)).toBeGreaterThan(lines.lastIndexOf('Posts'));
    expect(lines.indexOf(SEARCH_RELATED_HEADING)).toBeGreaterThan(lines.indexOf('Post own'));
    expect(relatedLabels(tree)).toEqual(['Open post Post sea by Ana, Just now, 0 saves, 0 comments', 'Open post Post cliffs by Ana, Just now, 0 saves, 0 comments']);

    // Looked for and none found, and a server that says nothing: no group, no words.
    mocks.announce.mockClear();
    for (const [typed, related] of [['quiet harbour', { posts: [] }], ['quiet harbours', undefined]] as const) {
      searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top', { posts: [post('own')] }, related as PublicSearchResponse['related']));
      await typeQuery(tree, typed);
      await submit(tree);
      await advance(300);
      expect(relatedGroup(tree)).toBeNull();
      expect(shownTexts(tree)).not.toContain(SEARCH_RELATED_HEADING);
    }
    expect(mocks.announce).not.toHaveBeenCalledWith(expect.stringContaining('related'));
    await act(async () => tree.unmount());
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
  /** The rows drawn dimmed: they have only just come to stand where they are, and take no tap yet. */
  function dimmedRows(tree: Tree) {
    const panel = list(tree);
    if (!panel) return [];
    return panel.findAll((node) => isHost(node, 'pressable'))
      .filter((node) => {
        const style = node.props.style as unknown;
        const drawn = (typeof style === 'function' ? style({ pressed: false }) : style) as { opacity?: number };
        return drawn.opacity !== 1;
      })
      .map((node) => node.props.accessibilityLabel as string);
  }
  function asked() {
    return suggestSearch.mock.calls.map(([params]) => params.query);
  }
  async function focusField(tree: Tree) {
    await act(async () => { searchInput(tree).props.onFocus(); });
  }
  // In this suite typing is only typing: the list, never a search.
  const typeQuery = typeOnly;
  const commit = (tree: Tree) => act(async () => { searchInput(tree).props.onSubmitEditing(); });
  // The first row of the typing list: the text as it stands.
  const searchFor = (text: string) => `Search for “${text}”`;
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
    mocks.readSearchHistory.mockReset();
    mocks.readSearchHistory.mockResolvedValue([]);
    mocks.rememberSearchQuery.mockReset();
    mocks.rememberSearchQuery.mockResolvedValue([]);
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

  it('shows suggestions in place of results while typing: "Search for", creators, models and tools, completions', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    // There at the first letter: the text as it stands, searched as the Search key would.
    expect(rowLabels(tree)).toEqual([searchFor('lum')]);
    await advance(PAUSE);

    expect(asked()).toEqual(['lum']);
    const panel = list(tree)!;
    expect(panel.findAll((node) => isHost(node, 'text') && node.props.accessibilityRole === 'header').map(textOf))
      .toEqual(['Creators', 'Models and tools', 'Suggested searches']);
    expect(rowLabels(tree)).toEqual([
      searchFor('lum'),
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
    expect(shownTexts(tree)).toEqual(expect.arrayContaining([searchFor('lum'), '@luma-studio · Following', 'Model · 14 posts', 'luminous']));
    // This text's own answer: not busy.
    expect(panel.props.accessibilityState).toEqual({ busy: false });
    // Said to a screen reader once the list has stood for a pause, not as each letter lands.
    expect(mocks.announce).not.toHaveBeenCalled();

    // The whole body of the screen, in the scroll view that hands a tap to the
    // row under it without first putting the keyboard away, and that puts the
    // keyboard away on a drag.
    const scroll = hostNodes(tree, 'scroll-view').find((node) => node.findAll((inner) => inner === panel).length > 0)!;
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scroll.props.keyboardDismissMode).toBe('on-drag');
    expect(scroll.findAll((node) => isHost(node, 'view', 'status-block', 'scroll-view'))[1]).toBe(panel);

    // No search is sent, and nothing but the list is drawn, however long it stands.
    await advance(5_000);
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(statusTitles(tree)).toEqual([]);
    expect(shownTexts(tree)).not.toContain('Searching…');
    expect(mocks.announce.mock.calls).toEqual([['5 suggestions']]);
    await act(async () => tree.unmount());
  });

  it('draws the part not yet typed of a completion or a recent search emphasised, the typed part plain', async () => {
    mocks.readSearchHistory.mockResolvedValue(['neon lumen', 'lumen glow', 'portrait']);
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    const runsOf = (label: string) => pressableLabelled(tree, label)
      .findAll((node) => isHost(node, 'text') && node.children.every((child) => typeof child === 'string'))
      .map((node) => [textOf(node), (node.props.style as { fontWeight?: string }).fontWeight]);
    // Matching recent searches, newest first, under "Search for": the typed text begins the search or one of its words.
    expect(rowLabels(tree).slice(0, 3)).toEqual([searchFor('lum'), 'Search again for neon lumen', 'Search again for lumen glow']);
    expect(runsOf('Search again for neon lumen')).toEqual([['neon ', '700'], ['lum', '400'], ['en', '700']]);
    expect(runsOf('Search for luminous')).toEqual([['lum', '400'], ['inous', '700']]);
    // A completion that is already a recent search is not offered twice.
    expect(rowLabels(tree).filter((label) => label.endsWith('lumen glow'))).toEqual(['Search again for lumen glow']);
    await act(async () => tree.unmount());
  });

  it('asks once per pause in typing, and nothing once a search is committed', async () => {
    const tree = await render({ visible: true, onClose: vi.fn() });
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
    await commit(tree);
    await advance(PAUSE * 4);
    expect(asked()).toEqual(['Lumi', '@lu']);
    expect(list(tree)).toBeNull();
    await act(async () => tree.unmount());
  });

  it('stays when the keyboard is put away, ends with a commit, and comes back asked anew when the field is tapped', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    // The field leaving the focus (a drag of the list) is no event of the screen's: the list stays.
    expect(searchInput(tree).props.onBlur).toBeUndefined();
    await commit(tree);
    expect(list(tree)).toBeNull();
    expect(mocks.keyboardDismiss).toHaveBeenCalledTimes(1);
    expect(shownTexts(tree)).toContain('Creator found');
    // Tapped again: typing for the text it holds. A follow or a block made
    // meanwhile is in the answer asked for now.
    suggestSearch.mockResolvedValueOnce(suggestions({ creators: [], entities: [], completions: [{ text: 'lumen after' }] }));
    await focusField(tree);
    expect(rowLabels(tree)).toEqual([searchFor('lum')]);
    expect(shownTexts(tree)).not.toContain('Creator found');
    await advance(PAUSE);
    expect(asked()).toEqual(['lum', 'lum']);
    expect(rowLabels(tree)).toEqual([searchFor('lum'), 'Search for lumen after']);
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
      searchFor('lumi'),
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
    expect(rowLabels(tree)).toEqual([searchFor('lumi'), '@lumen. Open profile', 'Search for lumina']);
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
    expect(rowLabels(tree)).toEqual([searchFor('lumin'), 'Search for luminal', 'Search for luminar']);
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
    await advance(SETTLE);
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: false });

    // A letter takes the model away, and "luminous" moves up into its place:
    // a tap there now was aimed at the model.
    suggestSearch.mockReturnValueOnce(later.promise);
    await typeQuery(tree, 'lumi');
    // What a sighted person has of it: the rows that moved are dimmed, at
    // once, and the rows that stayed ("Search for" and the creators) are not.
    expect(dimmedRows(tree)).toEqual(['Search for luminous', 'Search for lumen glow']);
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
    expect(rowLabels(tree)).toHaveLength(6);
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: true });
    expect(dimmedRows(tree)).toEqual(['Luma Ray 2, model, 14 posts. Show posts made with it', 'Search for luminous', 'Search for lumen glow']);
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
    expect(dimmedRows(tree)).toEqual([]);
    await press(pressableLabelled(tree, 'Search for luminous'));
    expect(searchInput(tree).props.value).toBe('luminous');
    await act(async () => tree.unmount());
  });

  it('dims nothing and is not busy for an answer that leaves the rows where they were', async () => {
    // The common case as a person types on: every row the list has is still
    // named by the longer text, and its answer brings the same rows. Nothing
    // moves, so nothing may flicker.
    const later = deferred<SearchSuggestResponse>();
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    await advance(SETTLE);
    const before = rowLabels(tree).slice(1);
    suggestSearch.mockReturnValueOnce(later.promise);
    await typeQuery(tree, 'luma');
    // Stale until the answer lands: busy for that, with every row at full strength.
    expect(rowLabels(tree)).toEqual([searchFor('luma'), ...before]);
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: true });
    expect(dimmedRows(tree)).toEqual([]);
    await advance(PAUSE);
    await act(async () => {
      later.resolve(suggestions({ query: 'luma', normalizedQuery: 'luma' }));
      await later.promise;
    });
    // The answer is drawn: not busy at once, no row dimmed, and a tap counts.
    expect(rowLabels(tree)).toEqual([searchFor('luma'), ...before]);
    expect(list(tree)!.props.accessibilityState).toEqual({ busy: false });
    expect(dimmedRows(tree)).toEqual([]);
    await press(pressableLabelled(tree, 'Search for luminous'));
    expect(searchInput(tree).props.value).toBe('luminous');
    await act(async () => tree.unmount());
  });

  it('holds a tap on a row an answer adds where another row stood a moment before (review of #786, M1)', async () => {
    // "ne": "Search for", two recents, then the answer's "neon lights" at the
    // fourth place. "neo" drops "nebula", so "neon lights" moves up a place
    // and the fourth place is empty; the answer for "neo" lands 140 ms later
    // and adds "neon sign" there. A finger aimed at "neon lights" lands on it.
    mocks.readSearchHistory.mockResolvedValue(['neon portrait', 'nebula']);
    suggestSearch.mockResolvedValueOnce(suggestions({ query: 'ne', normalizedQuery: 'ne', creators: [], entities: [], completions: [{ text: 'neon lights' }] }));
    const later = deferred<SearchSuggestResponse>();
    const tree = await open();
    await typeQuery(tree, 'ne');
    await advance(PAUSE);
    await advance(SETTLE);
    expect(rowLabels(tree)).toEqual([searchFor('ne'), 'Search again for neon portrait', 'Search again for nebula', 'Search for neon lights']);
    suggestSearch.mockReturnValueOnce(later.promise);
    await typeQuery(tree, 'neo');
    expect(rowLabels(tree)).toEqual([searchFor('neo'), 'Search again for neon portrait', 'Search for neon lights']);
    await advance(PAUSE);
    await act(async () => {
      later.resolve(suggestions({ query: 'neo', normalizedQuery: 'neo', creators: [], entities: [], completions: [{ text: 'neon lights' }, { text: 'neon sign' }] }));
      await later.promise;
    });
    expect(rowLabels(tree)[3]).toBe('Search for neon sign');
    expect(dimmedRows(tree)).toContain('Search for neon sign');
    await press(pressableLabelled(tree, 'Search for neon sign'));
    expect(searchInput(tree).props.value).toBe('neo');
    expect(searchPublicContent).not.toHaveBeenCalled();
    await advance(SETTLE);
    expect(dimmedRows(tree)).toEqual([]);
    await press(pressableLabelled(tree, 'Search for neon sign'));
    expect(searchInput(tree).props.value).toBe('neon sign');
    await act(async () => tree.unmount());
  });

  it('takes a tap at once on a row that stands where it stood, while the rows under another one move', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    await advance(SETTLE);
    suggestSearch.mockReturnValueOnce(deferred<SearchSuggestResponse>().promise);
    await typeQuery(tree, 'lumi');
    // The creators did not move when the model went.
    await press(pressableLabelled(tree, '@lumen. Open profile'));
    expect(mocks.router.push).toHaveBeenCalledWith('/creators/lumen');
    // Nor did "Search for": it searches the text as it stands now.
    await press(pressableLabelled(tree, searchFor('lumi')));
    expect(searchPublicContent.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'lumi', type: 'top' });
    await act(async () => tree.unmount());
  });

  it('takes the list of the text before away at once when the field is emptied, and drops an answer that holds nothing', async () => {
    mocks.readSearchHistory.mockResolvedValue(['neon harbor']);
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    expect(list(tree)).not.toBeNull();
    await typeQuery(tree, '');
    // An empty field is the start of the screen: the recent searches.
    expect(list(tree)).toBeNull();
    expect(shownTexts(tree)).toContain('Recent searches');
    // What is typed next starts from nothing, not from the list of "lum".
    suggestSearch.mockResolvedValueOnce(suggestions({ creators: [], entities: [], completions: [{ text: 'veo' }] }));
    await typeQuery(tree, 'v');
    // One letter is searched on no tab: no "Search for" (review of #786, S2).
    expect(rowLabels(tree)).toEqual([]);
    await advance(PAUSE);
    expect(rowLabels(tree)).toEqual(['Search for veo']);
    // Stale on the next letter, then gone when that letter's own answer is empty.
    suggestSearch.mockResolvedValueOnce(suggestions({ creators: [], entities: [], completions: [] }));
    await typeQuery(tree, 'vq');
    expect(rowLabels(tree)).toEqual([searchFor('vq'), 'Search for veo']);
    await advance(PAUSE);
    expect(rowLabels(tree)).toEqual([searchFor('vq')]);
    await act(async () => tree.unmount());
  });

  it('keeps an answer for a letter deleted, while the typing lasts and for half a minute at most', async () => {
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

  it('brings the list into view whenever it comes on show: the results may have been scrolled', async () => {
    const tree = await open();
    expect(mocks.scrollTo).not.toHaveBeenCalled();
    await typeQuery(tree, 'lum');
    expect(mocks.scrollTo.mock.calls).toEqual([[{ y: 0, animated: false }]]);
    // A commit, the results scrolled, the field tapped again.
    await commit(tree);
    expect(mocks.scrollTo).toHaveBeenCalledTimes(1);
    await focusField(tree);
    expect(list(tree)).not.toBeNull();
    expect(mocks.scrollTo).toHaveBeenCalledTimes(2);
    // Not at every letter while it stays shown: the person may be reading it.
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
    expect(rowLabels(tree)).toEqual([searchFor('lum')]);
    await advance(PAUSE);
    expect(rowLabels(tree)).toEqual([searchFor('lum'), 'Search for lumina']);
    await act(async () => tree.unmount());
  });

  it('opens a creator’s profile, reading their page as the finger rests, and leaves the typing as it was', async () => {
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
    // Back from the profile: the list, and no search was made.
    expect(list(tree)).not.toBeNull();
    expect(searchPublicContent).not.toHaveBeenCalled();
    remove();
    await act(async () => tree.unmount());
  });

  it('opens Posts narrowed to a model or tool, before any answer has said filters exist, and puts the keyboard away', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    expect(searchPublicContent).not.toHaveBeenCalled();
    await press(pressableLabelled(tree, 'Luma Ray 2, model, 14 posts. Show posts made with it'));

    expect(mocks.keyboardDismiss).toHaveBeenCalledTimes(1);
    expect(tab(tree, 'Posts').props.accessibilityState).toMatchObject({ selected: true });
    expect(searchPublicContent.mock.calls).toHaveLength(1);
    expect(searchPublicContent.mock.calls[0][0]).toMatchObject({
      query: 'lum',
      type: 'posts',
      filters: { madeWith: 'model:luma-ray-2', mediaKind: null, hasRecipe: false, following: false },
    });
    // Named on its chip at once.
    expect(textOf(pressableLabelled(tree, 'Remove filter: made with Luma Ray 2'))).toBe('Made with Luma Ray 2');
    expect(list(tree)).toBeNull();
    await act(async () => tree.unmount());
  });

  it('fills the field with a completion, searches for it at once and commits it, the list gone for its results', async () => {
    mocks.rememberSearchQuery.mockResolvedValue(['luminous']);
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    await press(pressableLabelled(tree, 'Search for luminous'));

    expect(searchInput(tree).props.value).toBe('luminous');
    expect(mocks.keyboardDismiss).toHaveBeenCalledTimes(1);
    expect(searchPublicContent.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'luminous', type: 'top', related: true });
    // Committed as the Search key commits one: kept once it finds something.
    expect(mocks.rememberSearchQuery).toHaveBeenCalledWith('luminous');
    await advance(PAUSE);
    expect(list(tree)).toBeNull();
    expect(asked()).toEqual(['lum']);
    // Typing on is typing again.
    suggestSearch.mockResolvedValue(suggestions({ creators: [], entities: [], completions: [{ text: 'luminous glow' }] }));
    await typeQuery(tree, 'luminous g');
    await advance(PAUSE);
    expect(rowLabels(tree)).toEqual([searchFor('luminous g'), 'Search for luminous glow']);
    await act(async () => tree.unmount());
  });

  it('commits what is typed from the Search key, the "Search for" row, a recent search, or a tab', async () => {
    mocks.readSearchHistory.mockResolvedValue(['lumen glow']);
    // As the device's list does: the search kept comes first.
    mocks.rememberSearchQuery.mockImplementation(async (query: string) => [query, 'lumen glow']);
    const tree = await open();
    const searched = () => searchPublicContent.mock.calls.map(([params]) => `${params.query}|${params.type}`);

    await typeQuery(tree, 'lum');
    await commit(tree);
    expect(list(tree)).toBeNull();
    expect(searched()).toEqual(['lum|top']);

    await focusField(tree);
    await typeQuery(tree, 'lumi');
    await press(pressableLabelled(tree, searchFor('lumi')));
    expect(searched()).toEqual(['lum|top', 'lumi|top']);

    await typeQuery(tree, 'lumen');
    await press(pressableLabelled(tree, 'Search again for lumen glow'));
    expect(searchInput(tree).props.value).toBe('lumen glow');
    expect(searched()).toEqual(['lum|top', 'lumi|top', 'lumen glow|top']);

    // A tab pressed while typing opens on the results for what is typed.
    await typeQuery(tree, 'luma');
    await press(tab(tree, 'Creators'));
    expect(list(tree)).toBeNull();
    expect(searched().at(-1)).toBe('luma|creators');
    // The Search key on an empty field searches nothing.
    await typeQuery(tree, '');
    await commit(tree);
    expect(searched()).toHaveLength(4);
    expect(mocks.router.push).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  // Seen on the simulator (2026-11-13): iOS sends the field's text again as
  // its on-screen keyboard goes, which a commit makes it do. Read as typing,
  // that took the results of a tab pressed while typing away again.
  it('keeps the results when the field reports the text it already holds, as iOS does when its keyboard goes', async () => {
    const tree = await open();
    await typeQuery(tree, 'lum');
    await press(tab(tree, 'Posts'));
    expect(list(tree)).toBeNull();
    await act(async () => { searchInput(tree).props.onChangeText('lum'); });
    expect(list(tree)).toBeNull();
    // Posts holds nothing here: Top is asked once for what another tab holds, and nothing more.
    expect(searchPublicContent.mock.calls.map(([params]) => `${params.query}|${params.type}`)).toEqual(['lum|posts', 'lum|top']);
    // A real change is typing again.
    await typeQuery(tree, 'lumi');
    expect(list(tree)).not.toBeNull();
    await act(async () => tree.unmount());
  });

  it.each([
    ['a failed request', () => Promise.reject(new ApiError('Failed to load search suggestions.', 500, null))],
    ['a request that never got an answer', () => Promise.reject(new ApiError('Network request failed', 0, null))],
    ['a body that is not an answer', () => Promise.resolve({ query: 'lum', type: 'top', creators: { items: [] } } as unknown as SearchSuggestResponse)],
    ['a switched-off route’s empty answer', () => Promise.resolve(suggestions({ creators: [], entities: [], completions: [] }))],
  ])('offers "Search for" alone, and no error, for %s', async (_name, reply) => {
    suggestSearch.mockImplementation(reply);
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(400);
    expect(asked()).toEqual(['lum']);
    expect(rowLabels(tree)).toEqual([searchFor('lum')]);
    expect(statusTitles(tree)).toEqual([]);
    expect(hostNodes(tree, 'text').some((node) => node.props.accessibilityRole === 'alert')).toBe(false);
    await act(async () => tree.unmount());
  });

  it('offers "Search for" alone when rate limited, and asks no more until the limit has passed', async () => {
    suggestSearch.mockRejectedValue(new ApiError('Too many requests', 429, { code: 'RATE_LIMITED', retryAfterSeconds: 30 }));
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    await typeQuery(tree, 'lumi');
    await advance(PAUSE);
    await typeQuery(tree, 'lumin');
    await advance(PAUSE);
    expect(asked()).toEqual(['lum']);
    expect(rowLabels(tree)).toEqual([searchFor('lumin')]);
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
    expect(rowLabels(tree)).toHaveLength(5);
    expect(shownTexts(tree)).not.toContain('Models and tools');
    await act(async () => tree.unmount());
  });

  it('offers handles at one character, and the recent searches under an empty field only', async () => {
    mocks.readSearchHistory.mockResolvedValue(['neon harbor']);
    suggestSearch.mockResolvedValue(suggestions({ entities: [], completions: [] }));
    const tree = await open();
    // Empty: the recent searches, and nothing asked.
    expect(shownTexts(tree)).toContain('Recent searches');
    expect(asked()).toEqual([]);
    await typeQuery(tree, 'l');
    await advance(PAUSE);
    expect(asked()).toEqual(['l']);
    // No "Search for": one letter is searched on no tab.
    expect(rowLabels(tree)).toEqual([
      'Luma Studio, @luma-studio, following. Open profile',
      '@lumen. Open profile',
    ]);
    expect(shownTexts(tree)).not.toContain('Recent searches');
    expect(statusTitles(tree)).toEqual([]);
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

  it('opens again in typing, with no search sent and no old results drawn, after closing on results (review of #786, S1)', async () => {
    const onClose = vi.fn();
    const tree = await open();
    await typeQuery(tree, 'lum');
    await commit(tree);
    expect(searchPublicContent).toHaveBeenCalledTimes(1);
    expect(shownTexts(tree)).toContain('Creator found');
    await update(tree, { visible: false, onClose });
    await update(tree, { visible: true, onClose });
    // Before the field takes the focus, and after.
    expect(shownTexts(tree)).not.toContain('Creator found');
    expect(list(tree)).not.toBeNull();
    await advance(PAUSE * 2);
    await focusField(tree);
    expect(searchPublicContent).toHaveBeenCalledTimes(1);
    expect(shownTexts(tree)).not.toContain('Creator found');
    await act(async () => tree.unmount());
  });

  it('drops a search still on its way when the screen goes back to typing (review of #786, S1)', async () => {
    const tree = await open();
    let signal: AbortSignal | undefined;
    searchPublicContent.mockImplementationOnce((_params, given) => {
      signal = given;
      return deferred<never>().promise;
    });
    await typeQuery(tree, 'lum');
    await commit(tree);
    expect(signal?.aborted).toBe(false);
    await focusField(tree);
    expect(signal?.aborted).toBe(true);
    await act(async () => tree.unmount());
  });

  it('offers no search a tab would not run: no "Search for" row, and the Search key keeps typing (review of #786, S2)', async () => {
    mocks.readSearchHistory.mockResolvedValue(['lu', 'lumen glow']);
    suggestSearch.mockResolvedValue(suggestions({ query: 'l', normalizedQuery: 'l', creators: [], entities: [], completions: [] }));
    const tree = await open();
    // One letter: below every tab's minimum.
    await typeQuery(tree, 'l');
    await advance(PAUSE);
    expect(rowLabels(tree)).not.toContain(searchFor('l'));
    expect(searchInput(tree).props.submitBehavior).toBe('submit');
    await commit(tree);
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(mocks.keyboardDismiss).not.toHaveBeenCalled();
    expect(shownTexts(tree)).not.toContain(SEARCH_IDLE_TITLE);
    // Two letters: Top runs them, so "Search for" is back.
    await typeQuery(tree, 'lu');
    expect(rowLabels(tree)[0]).toBe(searchFor('lu'));
    expect(searchInput(tree).props.submitBehavior).toBe('blurAndSubmit');
    // Posts asks for three: pressing it picks it and keeps typing; the rows
    // that would commit "lu" go, and a longer recent search stays.
    await press(tab(tree, 'Posts'));
    expect(tab(tree, 'Posts').props.accessibilityState).toMatchObject({ selected: true });
    expect(searchPublicContent).not.toHaveBeenCalled();
    expect(list(tree)).not.toBeNull();
    expect(rowLabels(tree)).toEqual(['Search again for lumen glow']);
    await commit(tree);
    expect(searchPublicContent).not.toHaveBeenCalled();
    // A third letter runs on Posts.
    await typeQuery(tree, 'lum');
    await commit(tree);
    // (An empty Posts may then ask Top for its counts: the empty-tab pointer.)
    expect(searchPublicContent.mock.calls[0]?.[0]).toMatchObject({ query: 'lum', type: 'posts' });
    await act(async () => tree.unmount());
  });

  it('keeps "Search for" to one line however long the text, its name whole (review of #786, S3)', async () => {
    const long = 'a neon portrait of a lighthouse keeper at dusk in the rain';
    const tree = await open();
    await typeQuery(tree, long);
    const row = pressableLabelled(tree, searchFor(long));
    const lines = row.findAll((node) => isHost(node, 'text')).map((node) => node.props.numberOfLines);
    expect(lines).toEqual([1]);
    await act(async () => tree.unmount());
  });

  it('counts only the answer\'s rows when it says how many suggestions there are (review of #786, N3)', async () => {
    mocks.readSearchHistory.mockResolvedValue(['lumen glow']);
    suggestSearch.mockResolvedValue(suggestions({ creators: [], entities: [], completions: [] }));
    const tree = await open();
    await typeQuery(tree, 'lum');
    await advance(PAUSE);
    await advance(ANNOUNCE_PAUSE);
    // "Search for" and a recent search are on show; the answer held nothing.
    expect(rowLabels(tree)).toEqual([searchFor('lum'), 'Search again for lumen glow']);
    expect(mocks.announce).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('searches a recent search the picked tab would not run on Top, picked with it (review of #786, S2)', async () => {
    mocks.readSearchHistory.mockResolvedValue(['ai']);
    const tree = await open();
    await press(tab(tree, 'Posts'));
    await press(pressableLabelled(tree, 'Search again for ai'));
    expect(searchPublicContent.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'ai', type: 'top' });
    expect(tab(tree, 'Top').props.accessibilityState).toMatchObject({ selected: true });
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

// Search UX audit 2026-11-13, findings 2 and 8: what the screen offers before
// anything is typed, when nothing is found, and when one tab is empty.
describe('ExploreSearchOverlay starting and ending screens', () => {
  const STARTER = {
    entities: [{ kind: 'model' as const, key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 200, postCountCapped: true, query: 'nano-banana-pro' }],
    creators: [{ id: 'c-luna', username: 'luna', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 42, isFollowing: false }],
    searches: [{ text: 'portrait' }, { text: 'anime' }],
  };
  const full = (query: string, type: PublicSearchType, kinds: Parameters<typeof searchAnswer>[2] = {}) => searchAnswer(query, type, { sort: 'top', ...kinds }, {
    entities: [], filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false }, correctedQuery: { posts: null, recipes: null }, exact: false,
  });
  const searched = () => searchPublicContent.mock.calls.map(([params]) => `${params.query}|${params.type}${params.filters?.madeWith ? `|${params.filters.madeWith}` : ''}`);
  const headers = (tree: Tree) => hostNodes(tree, 'text').filter((node) => node.props.accessibilityRole === 'header').map(textOf);

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listeners.length = 0;
    mocks.focused.value = true;
    mocks.router.push.mockClear();
    mocks.readSearchHistory.mockReset();
    mocks.readSearchHistory.mockResolvedValue([]);
    mocks.rememberSearchQuery.mockReset();
    mocks.rememberSearchQuery.mockResolvedValue([]);
    mocks.user.value = null;
    searchPublicContent.mockReset();
    suggestSearch.mockReset();
    suggestSearch.mockResolvedValue({ query: '', normalizedQuery: '', creators: [], entities: [], completions: [] });
    searchStarter.mockReset();
    searchStarter.mockResolvedValue(STARTER);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on the recent searches, then popular models and tools, creators to follow and searches to try', async () => {
    mocks.readSearchHistory.mockResolvedValue(['neon harbor']);
    const tree = await render({ visible: true, onClose: vi.fn() });
    expect(headers(tree)).toEqual(['Recent searches', 'Popular models and tools', 'Creators to follow', 'Try searching for']);
    expect(() => pressableLabelled(tree, 'Nano Banana Pro, model, 200+ posts. Show posts made with it')).not.toThrow();
    expect(() => pressableLabelled(tree, 'Luna Studio, @luna, 42 posts. Open profile')).not.toThrow();
    expect(() => pressableLabelled(tree, 'Search for portrait')).not.toThrow();
    expect(statusTitles(tree)).toEqual([]);
    expect(searchStarter).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  });

  it('asks once each time the search opens, and draws the invitation for a failure or an empty answer', async () => {
    searchStarter.mockRejectedValueOnce(new ApiError('Not found', 404));
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });
    expect(statusTitles(tree)).toEqual([SEARCH_IDLE_TITLE]);
    // Typing and committing ask nothing more of it.
    await typeQuery(tree, 'zzz');
    await typeQuery(tree, '');
    expect(searchStarter).toHaveBeenCalledTimes(1);

    // Opened again: asked again. The switch's answer, three empty lists, is the invitation too.
    searchStarter.mockResolvedValueOnce({ entities: [], creators: [], searches: [] });
    await update(tree, { visible: false, onClose });
    await update(tree, { visible: true, onClose });
    expect(searchStarter).toHaveBeenCalledTimes(2);
    expect(statusTitles(tree)).toEqual([SEARCH_IDLE_TITLE]);
    expect(headers(tree)).not.toContain('Popular models and tools');
    await act(async () => tree.unmount());
  });

  it('runs what each starter row offers: Posts made with a model, a creator’s profile, a search', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top', { posts: [post('p1')] }));
    const tree = await render({ visible: true, onClose: vi.fn() });

    await press(pressableLabelled(tree, 'Nano Banana Pro, model, 200+ posts. Show posts made with it'));
    // The search the starter counted: its own query, on Posts, narrowed to it, named on the chip.
    expect(searched()).toEqual(['nano-banana-pro|posts|model:nano-banana-pro']);
    expect(searchInput(tree).props.value).toBe('nano-banana-pro');
    expect(textOf(pressableLabelled(tree, 'Remove filter: made with Nano Banana Pro'))).toBe('Made with Nano Banana Pro');

    await typeQuery(tree, '');
    await press(pressableLabelled(tree, 'Search for anime'));
    expect(searchInput(tree).props.value).toBe('anime');
    expect(searched().at(-1)).toBe('anime|posts');

    await typeQuery(tree, '');
    await act(async () => { pressableLabelled(tree, 'Luna Studio, @luna, 42 posts. Open profile').props.onPress(); });
    expect(mocks.router.push).toHaveBeenCalledWith('/creators/luna');
    await act(async () => tree.unmount());
  });

  it('shows the starter under "No results" when a search finds nothing anywhere', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top'));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'qwxyz');
    expect(statusTitles(tree)).toEqual(['No results for “qwxyz”']);
    expect(shownTexts(tree)).toContain('Try one of these instead');
    expect(headers(tree)).toContain('Popular models and tools');
    await act(async () => tree.unmount());
  });

  it('says on an empty tab what another holds, from the Top answer on hand, with the way there', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => (type === 'recipes'
      ? full(query, 'recipes')
      : full(query, type ?? 'top', { posts: Array.from({ length: 12 }, (_, index) => post(`p${index}`)) })));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await typeQuery(tree, 'nano');
    await press(tab(tree, 'Recipes'));
    expect(statusTitles(tree)).toEqual(['No recipes for “nano”']);
    // Top shows a full section of posts: there are more.
    expect(statusBodies(tree)).toEqual(['12+ posts match']);
    // Top's answer was on hand: no request for it.
    expect(searched()).toEqual(['nano|top', 'nano|recipes']);
    expect(shownTexts(tree)).not.toContain('Try one of these instead');

    await press(hostNodes(tree, 'secondary-button').find((node) => node.props.label === 'See posts')!);
    expect(tab(tree, 'Posts').props.accessibilityState).toMatchObject({ selected: true });
    await act(async () => tree.unmount());
  });

  it('asks Top once for an empty tab with no Top answer on hand, and says nothing found when no tab holds anything', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => (type === 'top'
      ? full(query, 'top', { creators: [creator('lake-studio')] })
      : full(query, type ?? 'top')));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));
    await typeQuery(tree, 'lake');
    expect(searched()).toEqual(['lake|posts', 'lake|top']);
    expect(statusTitles(tree)).toEqual(['No posts for “lake”']);
    expect(statusBodies(tree)).toEqual(['1 creator matches']);
    // Back on the tab later: not asked again.
    await press(tab(tree, 'Recipes'));
    await press(tab(tree, 'Posts'));
    expect(searched().filter((line) => line === 'lake|top')).toHaveLength(1);

    // Nothing anywhere: "No results", and the ideas to start from.
    searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top'));
    await typeQuery(tree, 'lakes');
    expect(searched().slice(-2)).toEqual(['lakes|posts', 'lakes|top']);
    expect(statusTitles(tree)).toEqual(['No results for “lakes”']);
    expect(shownTexts(tree)).toContain('Try one of these instead');
    await act(async () => tree.unmount());
  });

  // The web review's fixes, taken the same way here (#790's review).
  it('marks the request an empty tab makes of Top as a probe, never the person\'s own searches', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => (type === 'top'
      ? full(query, 'top', { creators: [creator('lake-studio')] })
      : full(query, type ?? 'top')));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));
    await typeQuery(tree, 'lake');
    expect(searched()).toEqual(['lake|posts', 'lake|top']);
    expect(searchPublicContent.mock.calls.map(([params]) => params.probe ?? false)).toEqual([false, true]);
    await act(async () => tree.unmount());
  });

  it('asks Top again for a pointer whose request was cut off, and not for one that failed', async () => {
    const pending: Array<{ resolve: (value: PublicSearchResponse) => void; query: string }> = [];
    searchPublicContent.mockImplementation(({ query, type }, signal) => {
      if (type !== 'top') return Promise.resolve(full(query, type ?? 'top'));
      return new Promise<PublicSearchResponse>((resolve, reject) => {
        pending.push({ resolve, query });
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));
    await typeQuery(tree, 'lake');
    expect(searched().filter((line) => line === 'lake|top')).toHaveLength(1);
    // Back to typing before Top answers: the request is cut off, not settled.
    await act(async () => { searchInput(tree).props.onFocus(); });
    await act(async () => { searchInput(tree).props.onSubmitEditing(); });
    expect(searched().filter((line) => line === 'lake|top')).toHaveLength(2);
    await act(async () => { pending.at(-1)!.resolve(full('lake', 'top', { creators: [creator('lake-studio')] })); });
    expect(statusBodies(tree)).toEqual(['1 creator matches']);

    // A request that fails has settled: the tab's own words stand and it is not asked again.
    searchPublicContent.mockImplementation(async ({ query, type }) => {
      if (type === 'top') throw new ApiError('Server error', 500);
      return full(query, type ?? 'top');
    });
    await typeQuery(tree, 'pond');
    expect(searched().filter((line) => line === 'pond|top')).toHaveLength(1);
    await act(async () => { searchInput(tree).props.onFocus(); });
    await act(async () => { searchInput(tree).props.onSubmitEditing(); });
    expect(searched().filter((line) => line === 'pond|top')).toHaveLength(1);
    expect(statusTitles(tree)).toEqual(['No posts for “pond”']);
    await act(async () => tree.unmount());
  });

  it('opens Posts unfiltered from "See posts", so the count it states is what opens', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => (type === 'creators'
      ? full(query, 'creators')
      : full(query, type ?? 'top', { posts: [post('p1'), post('p2')] })));
    const tree = await render({ visible: true, onClose: vi.fn() });
    // Posts narrowed to a model, from a starter row; then Creators finds nobody.
    await press(pressableLabelled(tree, 'Nano Banana Pro, model, 200+ posts. Show posts made with it'));
    expect(searched()).toEqual(['nano-banana-pro|posts|model:nano-banana-pro']);
    await press(tab(tree, 'Creators'));
    expect(statusBodies(tree)).toEqual(['2 posts match']);
    await press(hostNodes(tree, 'secondary-button').find((node) => node.props.label === 'See posts')!);
    expect(tab(tree, 'Posts').props.accessibilityState).toMatchObject({ selected: true });
    expect(searched().at(-1)).toBe('nano-banana-pro|posts');
    expect(() => pressableLabelled(tree, 'Remove filter: made with Nano Banana Pro')).toThrow();
    await act(async () => tree.unmount());
  });

  // Review of #794.
  it('opens Posts from "See posts" without a switch left on there, Videos or Has recipe (review of #794, must-fix)', async () => {
    searchPublicContent.mockImplementation(async ({ query, type }) => (type === 'creators'
      ? full(query, 'creators')
      : full(query, type ?? 'top', { posts: [post('p1'), post('p2')] })));
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Posts'));
    await typeQuery(tree, 'nano');
    const switchNamed = (label: string) => hostNodes(tree, 'choice-chip').find((node) => node.props.label === label)!;
    await press(switchNamed('Videos'));
    await press(switchNamed('Has recipe'));
    expect(searchPublicContent.mock.calls.at(-1)?.[0].filters).toMatchObject({ mediaKind: 'video', hasRecipe: true });

    await press(tab(tree, 'Creators'));
    expect(statusBodies(tree)).toEqual(['2 posts match']);
    await press(hostNodes(tree, 'secondary-button').find((node) => node.props.label === 'See posts')!);
    expect(searchPublicContent.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'nano', type: 'posts' });
    expect(searchPublicContent.mock.calls.at(-1)?.[0].filters).toMatchObject({ madeWith: null, mediaKind: null, hasRecipe: false, following: false });
    expect(switchNamed('Videos').props.active).toBe(false);
    await act(async () => tree.unmount());
  });

  it('draws no starter of an earlier opening: cleared on close, so a failed request leaves the invitation (review of #794)', async () => {
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });
    expect(headers(tree)).toContain('Creators to follow');
    await update(tree, { visible: false, onClose });
    searchStarter.mockRejectedValueOnce(new ApiError('Server error', 500));
    await update(tree, { visible: true, onClose });
    expect(searchStarter).toHaveBeenCalledTimes(2);
    expect(headers(tree)).not.toContain('Creators to follow');
    expect(statusTitles(tree)).toEqual([SEARCH_IDLE_TITLE]);
    await act(async () => tree.unmount());
  });

  it('keeps a late Top answer for an earlier query from the current query\'s pointer (review of #794)', async () => {
    // A request that answers even after it was cut off, as a slow server's may.
    const late: Array<(value: PublicSearchResponse) => void> = [];
    searchPublicContent.mockImplementation(({ query, type }) => {
      if (type !== 'top') return Promise.resolve(full(query, type ?? 'top'));
      if (query === 'lake') return new Promise<PublicSearchResponse>((resolve) => { late.push(resolve); });
      return Promise.resolve(full(query, 'top', { posts: [post('p1')] }));
    });
    const tree = await render({ visible: true, onClose: vi.fn() });
    await press(tab(tree, 'Creators'));
    await typeQuery(tree, 'lake');
    await typeQuery(tree, 'lakes');
    expect(statusBodies(tree)).toEqual(['1 post matches']);
    await act(async () => { late[0](full('lake', 'top')); });
    expect(statusBodies(tree)).toEqual(['1 post matches']);
    // Nor is the current query's asked again for it.
    expect(searched().filter((line) => line === 'lakes|top')).toHaveLength(1);
    expect(statusTitles(tree)).toEqual(['No creators for “lakes”']);
    await act(async () => tree.unmount());
  });

  it('does not run a starter row whose query no tab can search, nor leave a filter or tab picked by it (review of #794)', async () => {
    searchStarter.mockResolvedValue({
      ...STARTER,
      entities: [
        { kind: 'model' as const, key: 'o3', label: 'o3', postCount: 4, postCountCapped: false, query: 'o3' },
        { kind: 'tool' as const, key: 'x', label: 'X', postCount: 2, postCountCapped: false, query: 'x' },
      ],
    });
    searchPublicContent.mockImplementation(async ({ query, type }) => full(query, type ?? 'top', { posts: [post('p1')] }));
    const tree = await render({ visible: true, onClose: vi.fn() });
    // One character: no tab searches it, so no row is drawn for it.
    expect(() => pressableLabelled(tree, 'X, tool, 2 posts. Show posts made with it')).toThrow();
    // Two: Posts cannot run it, so it runs on Top, picked, with no filter.
    await press(pressableLabelled(tree, 'o3, model, 4 posts. Show posts made with it'));
    expect(searched()).toEqual(['o3|top']);
    expect(tab(tree, 'Top').props.accessibilityState).toMatchObject({ selected: true });
    // Nothing of it is left for the next search on Posts.
    await press(tab(tree, 'Posts'));
    await typeQuery(tree, 'nano');
    expect(searched().at(-1)).toBe('nano|posts');
    await act(async () => tree.unmount());
  });

  it('asks for the starter again when the signed-in account changes, not when its session is renewed', async () => {
    mocks.user.value = { id: 'account-1' };
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });
    expect(searchStarter).toHaveBeenCalledTimes(1);
    // The same account with a renewed token: a new user object, the same id.
    mocks.user.value = { id: 'account-1' };
    await update(tree, { visible: true, onClose });
    expect(searchStarter).toHaveBeenCalledTimes(1);
    // Another account: its own starter (whom it follows, whom it is blocked with).
    mocks.user.value = { id: 'account-2' };
    await update(tree, { visible: true, onClose });
    expect(searchStarter).toHaveBeenCalledTimes(2);
    // Signed out: asked as a visitor.
    mocks.user.value = null;
    await update(tree, { visible: true, onClose });
    expect(searchStarter).toHaveBeenCalledTimes(3);
    await act(async () => tree.unmount());
  });
});
