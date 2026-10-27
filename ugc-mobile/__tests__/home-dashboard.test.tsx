(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { AccessibilityInfo, Alert, Share } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedVideoActivationStore } from '../lib/feed-video-activation';
import type { PlaybackNetwork } from '../lib/playback-metrics';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
type SentEvent = { eventType: string; deliveryId?: string; durationMs?: number; clientEventId?: string };
type NewestAnswer = { newestPostId: string | null; newestPublishedAt: string | null };
type UndoAnswer = { ok: true; removed: boolean };

// One router object for every render: a new one per render hangs these suites.
const routerState = vi.hoisted(() => ({
  params: {},
  push: vi.fn(),
  setParams: vi.fn(),
}));

const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

const navState = vi.hoisted(() => ({ focused: true }));

const queryState = vi.hoisted(() => ({
  // `enabled` of every lane query the screen made, in render order.
  enabled: [] as Array<boolean | undefined>,
  pages: [] as Array<Record<string, unknown>>,
  // When the lane's pages were fetched (React Query's `dataUpdatedAt`).
  dataUpdatedAt: 1,
  refetch: vi.fn(() => Promise.resolve()),
  // Every other query's refetch (the profile, the shelf), kept apart from the lane's.
  otherRefetch: vi.fn(() => Promise.resolve()),
  // The options of every other query the screen made, in render order.
  queries: [] as Array<{ queryKey: readonly unknown[]; queryFn?: () => unknown }>,
  client: {
    getQueriesData: vi.fn((): Array<[readonly unknown[], unknown]> => []),
    invalidateQueries: vi.fn(() => Promise.resolve()),
    setQueriesData: vi.fn(),
    setQueryData: vi.fn(),
  },
}));

// One object for every render, as the real context provides.
const authState = vi.hoisted(() => ({
  api: {
    getShowcaseFeedNewest: vi.fn((_params?: { category?: string }): Promise<NewestAnswer> => (
      Promise.resolve({ newestPostId: null, newestPublishedAt: null })
    )),
    getShowcasePost: vi.fn(),
    getHomeShelf: vi.fn(),
    remixShowcasePost: vi.fn((_postId: string) => Promise.resolve({
      success: true,
      redirectTo: '/create-video?remix=generation-1&remixPost=post-1',
      prefill: { prompt: 'A paper boat drifting slowly across a sunlit pond', settings: {} },
    })),
    unlockFreeBundle: vi.fn(),
    recordShowcaseFeedEvent: vi.fn((_request: SentEvent) => Promise.resolve()),
    shareShowcasePost: vi.fn((_postId: string, _options: { sourceSurface: string }) => Promise.resolve()),
    undoFeedFeedback: vi.fn((_body: Record<string, string>): Promise<UndoAnswer> => (
      Promise.resolve({ ok: true, removed: true })
    )),
  },
  credits: 0,
  identityUserId: 'viewer-1' as string | null,
  isLoading: false,
  signOut: vi.fn(),
  user: { id: 'viewer-1' } as { id: string } | null,
}));

// Every attention tracker the screen makes, so a test can watch its hand-offs.
const trackers = vi.hoisted(() => [] as Array<{ handOff: (target: unknown) => void }>);

const tabBarAmbient = vi.hoisted(() => ({ report: vi.fn() }));

// AppState's foreground reports, as `subscribeToAppForeground` hands them on.
const foregroundState = vi.hoisted(() => ({ listeners: new Set<(foreground: boolean) => void>() }));

// The phone's network, as lib/playback-device.ts reports it: a store a test
// switches, so the screen re-renders the way it does on a real change.
const networkState = vi.hoisted(() => ({
  kind: 'wifi' as PlaybackNetwork,
  listeners: new Set<() => void>(),
}));

// Every playback store the screen makes, so a test can read what it plays and prepares.
const activationStores = vi.hoisted(() => [] as FeedVideoActivationStore[]);

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: MockProps) => React.createElement('flash-list', props),
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: (options: { enabled?: boolean }) => (queryState.enabled.push(options.enabled), {
    data: { pages: queryState.pages, pageParams: [{ offset: 0 }] },
    dataUpdatedAt: queryState.dataUpdatedAt,
    fetchNextPage: vi.fn(() => Promise.resolve()),
    fetchPreviousPage: vi.fn(() => Promise.resolve()),
    hasNextPage: false,
    hasPreviousPage: false,
    isError: false,
    isFetchNextPageError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isSuccess: true,
    refetch: queryState.refetch,
  }),
  useQuery: (options: { queryKey: readonly unknown[]; queryFn?: () => unknown }) => (
    queryState.queries.push(options),
    { data: undefined, isPending: false, refetch: queryState.otherRefetch }
  ),
  useQueryClient: () => queryState.client,
}));

vi.mock('expo-router', () => ({
  router: routerState,
  useLocalSearchParams: () => routerState.params,
}));

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => navState.focused,
  useScrollToTop: vi.fn(),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: {
    get OS() {
      return platformState.os;
    },
    Version: 0,
    select: (options: Record<string, unknown>) => options[platformState.os] ?? options.default,
  },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  RefreshControl: (props: MockProps) => React.createElement('refresh-control', props),
  Share: {
    dismissedAction: 'dismissedAction',
    share: vi.fn(),
    sharedAction: 'sharedAction',
  },
  StatusBar: { currentHeight: 0 },
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => ({
  Crown: (props: MockProps) => React.createElement('crown-icon', props),
  Plus: (props: MockProps) => React.createElement('plus-icon', props),
  Search: (props: MockProps) => React.createElement('search-icon', props),
}));

// The shelf has a suite of its own (home-shelf.test.tsx); here it is the props
// the screen hands it.
vi.mock('@/components/home-shelf', () => ({
  HomeShelf: (props: MockProps) => React.createElement('home-shelf', props),
}));

vi.mock('@/components/comments-sheet', () => ({
  CommentsSheet: (props: MockProps) => React.createElement('comments-sheet', props),
}));

// The overlay, the pill and the notice have suites of their own; here they are
// the props the screen hands them.
vi.mock('@/components/explore-search-overlay', () => ({
  ExploreSearchOverlay: (props: MockProps) => React.createElement('explore-search-overlay', props),
}));

vi.mock('@/components/new-posts-pill', () => ({
  NewPostsPill: (props: MockProps) => React.createElement('new-posts-pill', props),
}));

vi.mock('@/components/feed-undo-notice', () => ({
  FeedUndoNotice: (props: MockProps) => React.createElement('feed-undo-notice', props),
}));

vi.mock('@/components/feed-feedback-sheet', () => ({
  FeedFeedbackSheet: (props: MockProps) => React.createElement('feed-feedback-sheet', props),
}));

// What the banner says is its own suite's (it draws nothing without an outcome);
// here only where Home puts it.
vi.mock('@/components/guest-merge-banner', () => ({
  GuestMergeBanner: () => React.createElement('guest-merge-banner'),
}));

vi.mock('@/components/feed-pagination-footer', () => ({
  FeedEndFooter: (props: MockProps) => React.createElement('feed-end-footer', props),
  FeedLoadMoreErrorFooter: (props: MockProps) => React.createElement('feed-load-more-error-footer', props),
}));

// The card is drawn by the list; these tests call the handlers the screen hands it.
vi.mock('@/components/home-feed-card', () => ({
  HomeFeedCardView: (props: MockProps) => React.createElement('home-feed-card', props),
}));

vi.mock('@/components/media-zoom', () => ({
  MediaZoomSurface: ({ children }: MockProps) => React.createElement('media-zoom-surface', null, children),
}));

vi.mock('@/components/home-side-menu', () => ({
  HomeSideMenu: (props: MockProps) => React.createElement('home-side-menu', props),
}));

vi.mock('@/components/workspace-side-menu-gesture-layer', () => ({
  WORKSPACE_SIDE_MENU_LABEL: 'Open workspace menu',
  WorkspaceSideMenuGlyph: (props: MockProps) => React.createElement('workspace-side-menu-glyph', props),
}));

vi.mock('@/components/onboarding-resume-card', () => ({
  OnboardingResumeCard: () => React.createElement('onboarding-resume-card'),
}));

vi.mock('@/components/reveal', () => ({
  Reveal: ({ children, ...props }: MockProps) => React.createElement('reveal', props, children),
}));

vi.mock('@/components/skeleton', () => ({
  HomeFeedSkeleton: (props: MockProps) => React.createElement('home-feed-skeleton', props),
}));

vi.mock('@/components/top-scrim', () => ({
  TopScrim: (props: MockProps) => React.createElement('top-scrim', props),
}));

vi.mock('@/components/ui', () => ({
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/components/unlock-remix-prompt', () => ({
  UnlockRemixPrompt: (props: MockProps) => React.createElement('unlock-remix-prompt', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

// Every event goes straight to the API double, batched type or not.
vi.mock('@/lib/feed-event-queue', () => ({
  enqueueShowcaseFeedEvent: vi.fn(() => Promise.resolve()),
  flushShowcaseFeedEvents: vi.fn(() => Promise.resolve()),
  isBatchedShowcaseFeedEventType: () => false,
}));

vi.mock('@/lib/persisted-home-feed', () => ({
  PERSISTED_HOME_FEED_CHIP_ID: 'for-you',
  cancelScheduledPersistHomeFeed: vi.fn(),
  isPersistedHomeFeedData: () => false,
  schedulePersistHomeFeed: vi.fn(),
}));

vi.mock('@/lib/startup-interactive', () => ({
  reportStartupMilestone: vi.fn(),
}));

vi.mock('@/lib/use-showcase-save-mutation', () => ({
  useShowcaseSaveMutation: () => ({ toggleSave: vi.fn() }),
}));

// The viewer's runs in flight, which the renders row counts.
const activeGenerationState = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/lib/use-active-generations', () => ({
  useActiveGenerationCount: () => activeGenerationState.count,
}));

vi.mock('@/lib/app-foreground', () => ({
  useAppForeground: () => true,
  subscribeToAppForeground: (listener: (foreground: boolean) => void) => {
    foregroundState.listeners.add(listener);
    return () => {
      foregroundState.listeners.delete(listener);
    };
  },
}));

// The autoplay preference's storage: nothing stored, so Wi-Fi only.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: () => Promise.resolve(null),
    setItem: () => Promise.resolve(),
  },
}));

vi.mock('@/lib/playback-device', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    networkState.listeners.add(listener);
    return () => {
      networkState.listeners.delete(listener);
    };
  };
  return { useNetworkKind: () => useSyncExternalStore(subscribe, () => networkState.kind) };
});

vi.mock('@/lib/feed-video-activation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/feed-video-activation')>();
  return {
    ...actual,
    createFeedVideoActivationStore: () => {
      const store = actual.createFeedVideoActivationStore();
      activationStores.push(store);
      return store;
    },
  };
});

vi.mock('@/lib/tab-bar-ambient', () => ({
  useTabBarAmbientFeed: () => tabBarAmbient.report,
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  usePressMotion: () => ({ animatedStyle: {}, onPressIn: vi.fn(), onPressOut: vi.fn() }),
  useReducedMotion: () => false,
}));

vi.mock('@/lib/showcase-feed-lane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/showcase-feed-lane')>();
  return { ...actual, showcaseFeedLaneQueryOptions: vi.fn(actual.showcaseFeedLaneQueryOptions) };
});

vi.mock('@/lib/showcase-feed-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/showcase-feed-query')>();
  return { ...actual, createShowcaseFeedViewerQueryKey: vi.fn(actual.createShowcaseFeedViewerQueryKey) };
});

vi.mock('@/lib/feed-attention-view-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/feed-attention-view-model')>();
  return {
    ...actual,
    createFeedAttentionTracker: <T,>(keyOf: (target: T) => string | null | undefined) => {
      const tracker = actual.createFeedAttentionTracker(keyOf);
      vi.spyOn(tracker, 'handOff');
      trackers.push(tracker as unknown as { handOff: (target: unknown) => void });
      return tracker;
    },
  };
});

import { HomeDashboard } from '../components/home-dashboard';
import { resetAutoplayPreferenceForTests } from '../lib/autoplay-preference';
import { haptic } from '../lib/haptics';
import { FEED_PREPARED_WINDOW_STEP_MS } from '../lib/media-performance';
import { schedulePersistHomeFeed } from '../lib/persisted-home-feed';
import {
  SHOWCASE_DWELL_VIEWABILITY,
  SHOWCASE_PLAYBACK_VIEWABILITY,
  filterAnonymousSessionShowcaseFeedItems,
  resetAnonymousShowcaseFeedRemovalsForTests,
  resetFeedFeedbackRequestsForTests,
} from '../lib/showcase-feed-events';
import { showcaseFeedLaneQueryOptions } from '../lib/showcase-feed-lane';
import { createShowcaseFeedViewerQueryKey } from '../lib/showcase-feed-query';

const T0 = Date.parse('2026-10-14T09:00:00.000Z');
let now = T0;

function mediaItem(id: string, deliveryId: string) {
  return {
    id,
    mediaUrl: `https://cdn.example.com/${id}.jpg`,
    mediaKind: 'image',
    mediaItems: [{
      id: `${id}:media`,
      url: `https://cdn.example.com/${id}.jpg`,
      previewUrl: `https://cdn.example.com/${id}.preview.webp`,
      gridReady: true,
      mediaKind: 'image',
      contentType: 'image/jpeg',
      originalName: null,
      width: 800,
      height: 1000,
      durationSeconds: null,
      sortOrder: 0,
    }],
    model: 'manual',
    title: `Post ${id}`,
    prompt: 'A prompt',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-13T09:00:00.000Z',
    creator: { id: `creator-${id}`, username: `creator${id}`, name: 'Creator', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    recommendation: { deliveryId, position: 0, algorithmVersion: 'for-you-rules-v4' },
  };
}

/** A post as the shelf sends it: made in the app, remix open, and no feed delivery. */
function shelfPost(id: string) {
  const { recommendation: _delivery, ...post } = videoItem(id, 'unused');
  return { ...post, generationId: `generation-${id}`, canRemix: true, remixCapability: 'public', remixTarget: 'video' };
}

function videoItem(id: string, deliveryId: string) {
  return {
    ...mediaItem(id, deliveryId),
    mediaUrl: `https://cdn.example.com/${id}.mp4`,
    mediaKind: 'video',
    category: 'video',
  };
}

function textItem(id: string, deliveryId: string) {
  return {
    ...mediaItem(id, deliveryId),
    mediaUrl: null,
    mediaKind: null,
    mediaItems: [],
    body: 'A written post.',
    category: 'text',
    postFormat: 'text',
  };
}

function page(items: unknown[]) {
  return {
    items,
    feedSessionId: 'session-1',
    algorithmVersion: 'for-you-rules-v4',
    pageInfo: { hasMore: false, nextOffset: null },
  };
}

function renderHome() {
  const list = { recomputeViewableItems: vi.fn(), scrollToOffset: vi.fn() };
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(<HomeDashboard />, {
      createNodeMock: (element) => (String(element.type) === 'flash-list' ? list : null),
    });
  });
  return { tree: tree!, list };
}

function listProps(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'flash-list').props;
}

/** The props the screen hands a mocked child drawn as `type`. */
function hostProps(tree: renderer.ReactTestRenderer, type: string) {
  return tree.root.find((node) => String(node.type) === type).props;
}

/** The list header (top bar, rail and chips), drawn on its own so its controls can be pressed. */
function renderHeader(tree: renderer.ReactTestRenderer) {
  let header: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    header = renderer.create(listProps(tree).ListHeaderComponent as React.ReactElement);
  });
  return header!;
}

function press(root: renderer.ReactTestRenderer, label: string) {
  const control = root.root.find((node) => (
    String(node.type) === 'pressable' && node.props.accessibilityLabel === label
  ));
  renderer.act(() => control.props.onPress());
}

const settlePromises = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The app going to the background and coming back, as AppState reports it. */
async function returnToApp() {
  await renderer.act(async () => {
    for (const listener of [...foregroundState.listeners]) listener(false);
    for (const listener of [...foregroundState.listeners]) listener(true);
    await settlePromises();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** The handlers the screen gives the card at `index`, as the list would draw it. */
function cardAt(tree: renderer.ReactTestRenderer, index: number) {
  const props = listProps(tree);
  const cell = props.renderItem({ item: props.data[index], index, target: 'Cell' }) as React.ReactElement<{
    children: React.ReactElement<{
      onAssetPress: () => void;
      onFeedbackOpen: () => void;
      onOpen: (zoom: null) => void;
      onShare: () => void;
    }>;
  }>;
  return cell.props.children.props;
}

/** FlashList reporting these cards at one viewability config's threshold. */
function reportViewable(tree: renderer.ReactTestRenderer, config: unknown, indexes: number[]) {
  const props = listProps(tree);
  const pair = (props.viewabilityConfigCallbackPairs as Array<{
    viewabilityConfig: unknown;
    onViewableItemsChanged: (info: { viewableItems: unknown[]; changed: unknown[] }) => void;
  }>).find((candidate) => candidate.viewabilityConfig === config);
  renderer.act(() => pair!.onViewableItemsChanged({
    viewableItems: indexes.map((index) => ({ index, isViewable: true, item: props.data[index], key: props.data[index].id })),
    changed: [],
  }));
}

/** FlashList reporting these cards at the dwell's visibility (half on screen). */
function reportOnScreen(tree: renderer.ReactTestRenderer, indexes: number[]) {
  reportViewable(tree, SHOWCASE_DWELL_VIEWABILITY, indexes);
}

function sentEvents(): SentEvent[] {
  return authState.api.recordShowcaseFeedEvent.mock.calls.map(([request]) => ({
    eventType: request.eventType,
    deliveryId: request.deliveryId,
    durationMs: request.durationMs,
  }));
}

describe('Home screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackers.length = 0;
    now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    platformState.os = 'ios';
    navState.focused = true;
    authState.user = { id: 'viewer-1' };
    authState.identityUserId = 'viewer-1';
    authState.isLoading = false;
    queryState.enabled.length = 0;
    queryState.queries.length = 0;
    activeGenerationState.count = 0;
    queryState.pages = [];
    queryState.dataUpdatedAt = 1;
    // Back to each double's own answer after a test that changed it.
    queryState.refetch.mockReset();
    queryState.otherRefetch.mockReset();
    queryState.otherRefetch.mockImplementation(() => Promise.resolve());
    queryState.client.getQueriesData.mockReset();
    authState.api.getShowcaseFeedNewest.mockReset();
    authState.api.recordShowcaseFeedEvent.mockReset();
    authState.api.undoFeedFeedback.mockReset();
    foregroundState.listeners.clear();
    networkState.kind = 'wifi';
    networkState.listeners.clear();
    activationStores.length = 0;
    resetAutoplayPreferenceForTests('wifi');
    resetAnonymousShowcaseFeedRemovalsForTests();
    resetFeedFeedbackRequestsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 2026-10-14 fix run (01-1): FlashList reports viewability by index, so a
  // refreshed page under a still viewport filed no impression for the posts
  // now on screen until they were scrolled away and back.
  it('asks the list to report what is on screen again when new posts land at the same places', () => {
    queryState.pages = [page([mediaItem('a', 'delivery-recompute-a')])];
    const { tree, list } = renderHome();

    // A render that leaves the posts alone has nothing new to report.
    list.recomputeViewableItems.mockClear();
    renderer.act(() => tree.update(<HomeDashboard />));
    expect(list.recomputeViewableItems).not.toHaveBeenCalled();

    // A pull to refresh's page: another post at the same index.
    queryState.pages = [page([mediaItem('b', 'delivery-recompute-b')])];
    renderer.act(() => tree.update(<HomeDashboard />));
    expect(list.recomputeViewableItems).toHaveBeenCalledTimes(1);

    renderer.act(() => tree.unmount());
  });

  // 04-5: the server keeps a delivery's first dwell. The reel opened on a
  // card's post reads the same delivery, so the card hands the post over and
  // the reel's dwell is the one kept.
  it('hands a media card’s post to the reel, so only the other cards file their dwell as Home blurs', () => {
    queryState.pages = [page([mediaItem('a', 'delivery-handoff-a'), textItem('b', 'delivery-handoff-b')])];
    const { tree } = renderHome();
    reportOnScreen(tree, [0, 1]);

    now = T0 + 4_000;
    renderer.act(() => cardAt(tree, 0).onOpen(null));
    expect(trackers.at(-1)!.handOff).toHaveBeenCalledTimes(1);
    expect(trackers.at(-1)!.handOff).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(routerState.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/viewer' }));

    // The reel's push blurs Home.
    navState.focused = false;
    renderer.act(() => tree.update(<HomeDashboard />));
    expect(sentEvents()).toEqual([
      { eventType: 'open', deliveryId: 'delivery-handoff-a' },
      { eventType: 'dwell', deliveryId: 'delivery-handoff-b', durationMs: 4_000 },
    ]);

    renderer.act(() => tree.unmount());
  });

  it('keeps a text card’s dwell when it opens the post page, which records no attention of its own', () => {
    queryState.pages = [page([mediaItem('a', 'delivery-text-a'), textItem('b', 'delivery-text-b')])];
    const { tree } = renderHome();
    reportOnScreen(tree, [0, 1]);

    now = T0 + 4_000;
    renderer.act(() => cardAt(tree, 1).onOpen(null));
    expect(trackers.at(-1)!.handOff).not.toHaveBeenCalled();
    expect(routerState.push).toHaveBeenCalledTimes(1);
    expect(routerState.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: '/viewer' }));

    navState.focused = false;
    renderer.act(() => tree.update(<HomeDashboard />));
    expect(sentEvents()).toEqual([
      { eventType: 'open', deliveryId: 'delivery-text-b' },
      { eventType: 'dwell', deliveryId: 'delivery-text-a', durationMs: 4_000 },
      { eventType: 'dwell', deliveryId: 'delivery-text-b', durationMs: 4_000 },
    ]);

    renderer.act(() => tree.unmount());
  });

  // 04-4: React Native's Share.share answers "shared" on Android whether or
  // not anything was shared, so only iOS's answer can count a share.
  it.each([
    ['android', 'sharedAction', false],
    ['ios', 'sharedAction', true],
    ['ios', 'dismissedAction', false],
  ] as const)('on %s, a share sheet answering %s counts a share: %s', async (os, action, counted) => {
    platformState.os = os;
    vi.mocked(Share.share).mockResolvedValue({ action });
    const deliveryId = `delivery-share-${os}-${action}`;
    queryState.pages = [page([mediaItem('a', deliveryId)])];
    const { tree } = renderHome();

    await renderer.act(async () => {
      cardAt(tree, 0).onShare();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The sheet opens either way.
    expect(Share.share).toHaveBeenCalledTimes(1);
    if (counted) {
      expect(authState.api.shareShowcasePost).toHaveBeenCalledWith('a', { sourceSurface: 'feed' });
      expect(sentEvents()).toEqual([{ eventType: 'share', deliveryId }]);
    } else {
      expect(authState.api.shareShowcasePost).not.toHaveBeenCalled();
      expect(sentEvents()).toEqual([]);
    }

    renderer.act(() => tree.unmount());
  });

  // 04-7: the recipe chip is the post's resources opening (`resource_open`),
  // as the web defines it, not a second way of opening the post.
  it('reports the recipe chip as the post’s resources opening only, and the card’s own tap as an open', () => {
    queryState.pages = [page([mediaItem('a', 'delivery-chip-a')])];
    const { tree } = renderHome();

    renderer.act(() => cardAt(tree, 0).onAssetPress());
    expect(sentEvents()).toEqual([{ eventType: 'resource_open', deliveryId: 'delivery-chip-a' }]);
    // It still opens the reel on the post's Details, where the recipe is.
    expect(routerState.push).toHaveBeenCalledWith(expect.objectContaining({
      pathname: '/viewer',
      params: expect.objectContaining({ initialId: 'a', initialPage: 'details' }),
    }));

    renderer.act(() => cardAt(tree, 0).onOpen(null));
    expect(sentEvents().map((event) => event.eventType)).toEqual(['resource_open', 'open']);

    renderer.act(() => tree.unmount());
  });

  // 04-3: a guest is a viewer of its own. Its lane, the key its removals
  // reach and the page saved for the next launch are all its identity's.
  // A cold start: the stored session lands a moment after Home mounts. The lane is
  // keyed by identity, so a request made before it would be keyed to no identity
  // and made again for the identity, two fresh ranked sessions on the server.
  it('asks for its lane only once auth has settled whose lane it is', () => {
    authState.isLoading = true;
    authState.identityUserId = null;
    authState.user = null;
    const { tree } = renderHome();
    expect(queryState.enabled.length).toBeGreaterThan(0);
    expect(queryState.enabled.every((enabled) => enabled === false)).toBe(true);

    authState.isLoading = false;
    authState.identityUserId = 'viewer-1';
    authState.user = { id: 'viewer-1' };
    renderer.act(() => tree.update(<HomeDashboard />));
    expect(queryState.enabled.at(-1)).toBe(true);

    renderer.act(() => tree.unmount());
  });

  it('keys a guest’s lane, its cached feeds and its saved page by the guest’s identity', () => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    queryState.pages = [page([mediaItem('a', 'delivery-guest-a')])];
    const { tree } = renderHome();

    expect(showcaseFeedLaneQueryOptions).toHaveBeenCalledWith(authState.api, { sort: 'for-you' }, 'guest-1');
    // Every key the screen builds is the guest's: none falls back to the
    // registered `user`, which a guest does not have.
    expect(new Set(vi.mocked(showcaseFeedLaneQueryOptions).mock.calls.map(([, , identity]) => identity)))
      .toEqual(new Set(['guest-1']));
    expect(new Set(vi.mocked(createShowcaseFeedViewerQueryKey).mock.calls.map(([identity]) => identity)))
      .toEqual(new Set(['guest-1']));
    expect(schedulePersistHomeFeed).toHaveBeenCalledWith(queryState.client, 'guest-1');

    renderer.act(() => tree.unmount());
  });

  // A guest's Not interested and Hide are kept under its uid (D1), and only its
  // token lets the server leave those creators and posts off the shelf too.
  it('asks for a guest’s shelf under its identity, with its token', async () => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    authState.api.getHomeShelf.mockReset();
    authState.api.getHomeShelf.mockResolvedValue({ success: true, schemaVersion: 1, items: [] });
    const { tree } = renderHome();

    const shelf = queryState.queries.findLast((query) => query.queryKey[0] === 'home-shelf');
    expect(shelf?.queryKey).toEqual(['home-shelf', 'guest-1']);
    await shelf?.queryFn?.();
    expect(authState.api.getHomeShelf).toHaveBeenCalledTimes(1);
    // No `auth: false`: the client sends whatever session token it holds.
    expect(authState.api.getHomeShelf).toHaveBeenCalledWith();

    renderer.act(() => tree.unmount());
  });

  // Product decision D2 (2026-10-14): a ranked lane is never refetched under
  // the reader on a return to the app; a pill offers the newer posts instead.
  it('offers newer posts on a return five minutes after the lane was fetched, and fetches nothing into the lane', async () => {
    queryState.pages = [page([mediaItem('a', 'delivery-pill-a')])];
    queryState.dataUpdatedAt = T0 - 5 * 60_000;
    authState.api.getShowcaseFeedNewest.mockResolvedValue({
      newestPostId: 'fresh',
      newestPublishedAt: '2026-10-14T08:58:00.000Z',
    });
    const { tree } = renderHome();
    expect(hostProps(tree, 'new-posts-pill').visible).toBe(false);
    expect(authState.api.getShowcaseFeedNewest).not.toHaveBeenCalled();

    await returnToApp();

    // For You has no category: every post counts.
    expect(authState.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
    expect(authState.api.getShowcaseFeedNewest).toHaveBeenCalledWith({ category: 'all' });
    const pill = hostProps(tree, 'new-posts-pill');
    expect(pill.visible).toBe(true);
    // Below the top bar's row (10pt above it, 48pt tall), clear of its controls.
    expect(pill.topOffset).toBe(listProps(tree).contentContainerStyle.paddingTop + 10 + 48 + 8);
    expect(queryState.refetch).not.toHaveBeenCalled();
    expect(queryState.client.setQueryData).not.toHaveBeenCalled();

    renderer.act(() => tree.unmount());
  });

  it('takes the pill’s tap to the top, then cuts the lane to its first page and refetches it, with no refresh control', async () => {
    queryState.pages = [page([mediaItem('a', 'delivery-tap-a')])];
    queryState.dataUpdatedAt = T0 - 10 * 60_000;
    authState.api.getShowcaseFeedNewest.mockResolvedValue({
      newestPostId: 'fresh',
      newestPublishedAt: '2026-10-14T08:58:00.000Z',
    });
    const refetched = deferred<void>();
    queryState.refetch.mockImplementation(() => refetched.promise);
    const lightHaptic = vi.spyOn(haptic, 'light');
    const { tree, list } = renderHome();
    await returnToApp();
    expect(hostProps(tree, 'new-posts-pill').visible).toBe(true);

    renderer.act(() => hostProps(tree, 'new-posts-pill').onPress());

    expect(hostProps(tree, 'new-posts-pill').visible).toBe(false);
    expect(lightHaptic).toHaveBeenCalledTimes(1);
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
    const laneKey = vi.mocked(showcaseFeedLaneQueryOptions).mock.results.at(-1)!.value.queryKey;
    expect(queryState.client.setQueryData).toHaveBeenCalledTimes(1);
    const [trimmedKey, trim] = queryState.client.setQueryData.mock.calls[0] as [unknown, (current: unknown) => unknown];
    expect(trimmedKey).toEqual(laneKey);
    const firstPage = page([mediaItem('a', 'delivery-tap-a')]);
    expect(trim({ pages: [firstPage, page([mediaItem('b', 'delivery-tap-b')])], pageParams: [{ offset: 0 }, { offset: 1 }] }))
      .toEqual({ pages: [firstPage], pageParams: [{ offset: 0 }] });
    expect(queryState.refetch).toHaveBeenCalledTimes(1);
    expect(list.scrollToOffset.mock.invocationCallOrder[0]).toBeLessThan(queryState.refetch.mock.invocationCallOrder[0]);
    // No pull is behind this refresh: the control stays down while the page loads.
    expect(listProps(tree).refreshControl.props.refreshing).toBe(false);
    await renderer.act(async () => {
      refetched.resolve();
      await settlePromises();
    });
    expect(listProps(tree).refreshControl.props.refreshing).toBe(false);

    // A pull, by contrast, holds the control until its page has loaded.
    const pulled = deferred<void>();
    queryState.refetch.mockImplementation(() => pulled.promise);
    renderer.act(() => listProps(tree).refreshControl.props.onRefresh());
    expect(listProps(tree).refreshControl.props.refreshing).toBe(true);
    await renderer.act(async () => {
      pulled.resolve();
      await settlePromises();
    });
    expect(listProps(tree).refreshControl.props.refreshing).toBe(false);

    renderer.act(() => tree.unmount());
  });

  it('asks about the lane on screen, and nothing for Recent, which keeps its own refetch', async () => {
    queryState.pages = [page([textItem('a', 'delivery-lanes-a')])];
    queryState.dataUpdatedAt = T0 - 6 * 60_000;
    const { tree } = renderHome();

    let header = renderHeader(tree);
    press(header, 'Notes');
    renderer.act(() => header.unmount());
    await returnToApp();
    expect(authState.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
    expect(authState.api.getShowcaseFeedNewest).toHaveBeenCalledWith({ category: 'text' });

    header = renderHeader(tree);
    press(header, 'Recent');
    renderer.act(() => header.unmount());
    await returnToApp();
    expect(authState.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
    expect(hostProps(tree, 'new-posts-pill').visible).toBe(false);

    renderer.act(() => tree.unmount());
  });

  // Product decision D7 (2026-10-14): Undo is a preference delete, sent once
  // the choice's own request has landed, and the post returns to its index.
  it('offers a Not interested back, and puts the post at its index once the server has taken the choice back', async () => {
    const items = [mediaItem('a', 'delivery-undo-a'), mediaItem('b', 'delivery-undo-b'), mediaItem('c', 'delivery-undo-c')];
    queryState.pages = [page(items)];
    const laneKey = ['showcase-feed', 'infinite', 'viewer-1', 'for-you'] as const;
    queryState.client.getQueriesData.mockReturnValue([
      [laneKey, { pages: [page(items)], pageParams: [{ offset: 0 }] }],
      [['showcase-feed', 'infinite', 'viewer-1', 'notes'], {
        pages: [page([textItem('t', 'delivery-undo-t')])],
        pageParams: [{ offset: 0 }],
      }],
    ]);
    const answer = deferred<UndoAnswer>();
    authState.api.undoFeedFeedback.mockImplementation(() => answer.promise);
    const { tree } = renderHome();

    renderer.act(() => cardAt(tree, 1).onFeedbackOpen());
    await renderer.act(async () => {
      hostProps(tree, 'feed-feedback-sheet').onNotInterested();
      await settlePromises();
    });

    expect(sentEvents()).toEqual([{ eventType: 'not_interested', deliveryId: 'delivery-undo-b' }]);
    // The lanes lose the post, and so does Home's shelf.
    expect(queryState.client.setQueriesData).toHaveBeenCalledTimes(2);
    expect(queryState.client.setQueriesData.mock.calls[1][0]).toEqual({ queryKey: ['home-shelf'] });
    const { clientEventId } = authState.api.recordShowcaseFeedEvent.mock.calls[0][0];
    const shown = hostProps(tree, 'feed-undo-notice');
    expect(shown.notice).toEqual({ id: clientEventId, message: 'Post hidden', onUndo: expect.any(Function) });
    // Above the tab bar and its raised Create button: the room the last card keeps, less its own 24pt.
    expect(shown.bottomOffset).toBe(listProps(tree).contentContainerStyle.paddingBottom - 24);
    // The notice announces the choice; the request's success adds nothing.
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();

    await renderer.act(async () => {
      shown.notice.onUndo();
      await settlePromises();
    });
    expect(authState.api.undoFeedFeedback).toHaveBeenCalledWith({ feedbackType: 'not_interested', postId: 'b' });
    // Nothing comes back before the server has answered.
    expect(queryState.client.setQueryData).not.toHaveBeenCalled();

    await renderer.act(async () => {
      answer.resolve({ ok: true, removed: true });
      await settlePromises();
    });
    // Only the lane that held the post changes, and the post is back where it was.
    expect(queryState.client.setQueryData).toHaveBeenCalledTimes(1);
    const [restoredKey, restore] = queryState.client.setQueryData.mock.calls[0] as [
      unknown,
      (current: unknown) => { pages: Array<{ items: Array<{ id: string }> }> },
    ];
    expect(restoredKey).toBe(laneKey);
    const withoutB = { pages: [page([items[0], items[2]])], pageParams: [{ offset: 0 }] };
    expect(restore(withoutB).pages[0].items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    // An Undo is no feed event: the choice stays in the facts.
    expect(sentEvents()).toHaveLength(1);

    renderer.act(() => tree.unmount());
  });

  it('keeps the creator hidden, and says so, when the Undo does not go through', async () => {
    const items = [mediaItem('a', 'delivery-undo-fail-a'), mediaItem('b', 'delivery-undo-fail-b')];
    queryState.pages = [page(items)];
    queryState.client.getQueriesData.mockReturnValue([
      [['showcase-feed', 'infinite', 'viewer-1', 'for-you'], { pages: [page(items)], pageParams: [{ offset: 0 }] }],
    ]);
    authState.api.undoFeedFeedback.mockRejectedValue(new Error('offline'));
    const errorHaptic = vi.spyOn(haptic, 'error');
    const { tree } = renderHome();

    renderer.act(() => cardAt(tree, 0).onFeedbackOpen());
    await renderer.act(async () => {
      hostProps(tree, 'feed-feedback-sheet').onHideCreator();
      await settlePromises();
    });
    const shown = hostProps(tree, 'feed-undo-notice');
    expect(shown.notice.message).toBe('Creator hidden');

    await renderer.act(async () => {
      shown.notice.onUndo();
      await settlePromises();
    });
    expect(authState.api.undoFeedFeedback).toHaveBeenCalledWith({ feedbackType: 'hide_creator', creatorId: 'creator-a' });
    expect(queryState.client.setQueryData).not.toHaveBeenCalled();
    expect(errorHaptic).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      'Couldn’t undo',
      'The creator is still hidden. Check your connection and try again.',
    );

    renderer.act(() => tree.unmount());
  });

  it.each([
    ['a device with no session forgets the choice itself', null, false],
    ['a guest with a session asks the server', 'guest-1', true],
  ] as const)('undoes a guest’s choice where it is kept: %s', async (_case, identityUserId, asksServer) => {
    authState.user = null;
    authState.identityUserId = identityUserId;
    const items = [mediaItem('a', 'delivery-guest-undo-a'), mediaItem('b', 'delivery-guest-undo-b')];
    queryState.pages = [page(items)];
    queryState.client.getQueriesData.mockReturnValue([
      [['showcase-feed', 'infinite', identityUserId, 'for-you'], { pages: [page(items)], pageParams: [{ offset: 0 }] }],
    ]);
    const { tree } = renderHome();

    renderer.act(() => cardAt(tree, 1).onFeedbackOpen());
    await renderer.act(async () => {
      hostProps(tree, 'feed-feedback-sheet').onNotInterested();
      await settlePromises();
    });
    // The device hides the post from later pages too.
    expect(filterAnonymousSessionShowcaseFeedItems(items as never).map((item) => item.id)).toEqual(['a']);

    await renderer.act(async () => {
      hostProps(tree, 'feed-undo-notice').notice.onUndo();
      await settlePromises();
    });
    if (asksServer) {
      expect(authState.api.undoFeedFeedback).toHaveBeenCalledWith({ feedbackType: 'not_interested', postId: 'b' });
    } else {
      expect(authState.api.undoFeedFeedback).not.toHaveBeenCalled();
    }
    expect(filterAnonymousSessionShowcaseFeedItems(items as never).map((item) => item.id)).toEqual(['a', 'b']);
    expect(queryState.client.setQueryData).toHaveBeenCalledTimes(1);

    renderer.act(() => tree.unmount());
  });

  it('withdraws the notice when the choice itself fails, and an Undo waiting on it adds no second message', async () => {
    const items = [mediaItem('a', 'delivery-hide-fail-a'), mediaItem('b', 'delivery-hide-fail-b')];
    queryState.pages = [page(items)];
    const laneKey = ['showcase-feed', 'infinite', 'viewer-1', 'for-you'];
    const lane = { pages: [page(items)], pageParams: [{ offset: 0 }] };
    queryState.client.getQueriesData.mockReturnValue([[laneKey, lane]]);
    const sent = deferred<void>();
    authState.api.recordShowcaseFeedEvent.mockImplementation(() => sent.promise);
    authState.api.undoFeedFeedback.mockRejectedValue(new Error('offline'));
    const { tree } = renderHome();

    renderer.act(() => cardAt(tree, 1).onFeedbackOpen());
    renderer.act(() => hostProps(tree, 'feed-feedback-sheet').onNotInterested());
    // Undo while the choice is still on its way: it waits for that request.
    await renderer.act(async () => {
      hostProps(tree, 'feed-undo-notice').notice.onUndo();
      await settlePromises();
    });
    expect(authState.api.undoFeedFeedback).not.toHaveBeenCalled();

    await renderer.act(async () => {
      sent.reject(new Error('offline'));
      await settlePromises();
    });
    // The choice failed: the lane is put back from the copy taken before it, and the notice goes.
    expect(queryState.client.setQueryData).toHaveBeenCalledWith(laneKey, lane);
    expect(hostProps(tree, 'feed-undo-notice').notice).toBeNull();
    // The Undo still went, since a failed request may have written the row; its failure says nothing more.
    expect(authState.api.undoFeedFeedback).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      'Couldn’t update your feed',
      'The post was restored. Check your connection and try again.',
    );

    renderer.act(() => tree.unmount());
  });

  // Product decision E1 (2026-10-14): Explore's search, a tap from Home.
  it('opens the search from the top bar, and counts no card as read while the search covers it', () => {
    queryState.pages = [page([mediaItem('a', 'delivery-search-a'), textItem('b', 'delivery-search-b')])];
    const { tree } = renderHome();
    expect(hostProps(tree, 'explore-search-overlay').visible).toBe(false);
    reportOnScreen(tree, [0, 1]);

    now = T0 + 3_000;
    const header = renderHeader(tree);
    press(header, 'Search creators, posts, and recipes');
    expect(hostProps(tree, 'explore-search-overlay').visible).toBe(true);
    expect(hostProps(tree, 'explore-search-overlay').api).toBe(authState.api);
    // The stretch on screen ends as the search covers the cards.
    expect(sentEvents()).toEqual([
      { eventType: 'dwell', deliveryId: 'delivery-search-a', durationMs: 3_000 },
      { eventType: 'dwell', deliveryId: 'delivery-search-b', durationMs: 3_000 },
    ]);

    now = T0 + 60_000;
    renderer.act(() => hostProps(tree, 'explore-search-overlay').onClose());
    expect(hostProps(tree, 'explore-search-overlay').visible).toBe(false);
    // A minute spent searching is not read as a minute on either card.
    navState.focused = false;
    renderer.act(() => tree.update(<HomeDashboard />));
    expect(sentEvents()).toHaveLength(2);

    renderer.act(() => header.unmount());
    renderer.act(() => tree.unmount());
  });

  // Product decision D3 (2026-10-14): Autoplay previews, Wi-Fi only by default.
  it('prepares no neighbour video on mobile data under Wi-Fi only, and follows the network as it changes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    networkState.kind = 'cellular';
    queryState.pages = [page(['a', 'b', 'c', 'd'].map((id) => videoItem(id, `delivery-video-${id}`)))];
    const { tree } = renderHome();
    const store = activationStores.at(-1)!;
    const settleWindow = () => renderer.act(() => {
      vi.advanceTimersByTime(FEED_PREPARED_WINDOW_STEP_MS * 8);
    });
    const switchNetwork = (kind: PlaybackNetwork) => renderer.act(() => {
      networkState.kind = kind;
      for (const listener of [...networkState.listeners]) listener();
    });

    // On mobile data the card in view plays and nothing loads ahead.
    reportViewable(tree, SHOWCASE_PLAYBACK_VIEWABILITY, [0]);
    settleWindow();
    expect(store.snapshot()).toEqual({ activeIds: ['a'], preparedIds: [] });

    // On Wi-Fi its neighbour is made ready, as before the setting.
    switchNetwork('wifi');
    settleWindow();
    expect(store.snapshot().activeIds).toEqual(['a']);
    expect(store.snapshot().preparedIds).toContain('b');

    // Back on mobile data the prepared players are let go.
    switchNetwork('cellular');
    settleWindow();
    expect(store.snapshot()).toEqual({ activeIds: ['a'], preparedIds: [] });

    renderer.act(() => tree.unmount());
  });

  it("gives Home's one clip to the shelf while it is on screen, and back to the feed once it has gone", () => {
    queryState.pages = [page([videoItem('a', 'delivery-video-a')])];
    const { tree } = renderHome();
    const store = activationStores.at(-1)!;
    // Where the shelf sits in the window, as measureInWindow reports it.
    const shelfBox = { top: 120, height: 270 };
    let header!: renderer.ReactTestRenderer;
    renderer.act(() => {
      header = renderer.create(listProps(tree).ListHeaderComponent as React.ReactElement, {
        createNodeMock: (element) => ((element.props as { collapsable?: boolean }).collapsable === false
          ? { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, shelfBox.top, 390, shelfBox.height) }
          : null),
      });
    });
    const restScroll = () => renderer.act(() => {
      listProps(tree).onScrollBeginDrag();
      listProps(tree).onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } });
    });

    // The feed's first video plays until the shelf puts up a clip card.
    reportViewable(tree, SHOWCASE_PLAYBACK_VIEWABILITY, [0]);
    expect(store.snapshot().activeIds).toEqual(['a']);

    // The shelf heads the screen: its card takes the slot from the card half under it.
    const shelfClip = { ...videoItem('post-1', 'delivery-shelf'), id: 'home-shelf:post-1' };
    renderer.act(() => hostProps(header, 'home-shelf').onPlaybackCandidateChange(shelfClip));
    expect(store.snapshot().activeIds).toEqual(['home-shelf:post-1']);

    // Scrolled until most of the shelf is off screen: the feed's card plays again.
    shelfBox.top = -200;
    restScroll();
    expect(store.snapshot().activeIds).toEqual(['a']);

    // Back at the top, but the row rests on cards without a clip: the feed keeps it.
    shelfBox.top = 120;
    renderer.act(() => hostProps(header, 'home-shelf').onPlaybackCandidateChange(null));
    restScroll();
    expect(store.snapshot().activeIds).toEqual(['a']);

    renderer.act(() => header.unmount());
    renderer.act(() => tree.unmount());
  });

  // 02-8: the merge outcome showed on Pricing alone, so a restart before a
  // visit there lost the only word that paid guest credits had not arrived.
  it.each([
    ['an account', { id: 'viewer-1' }, 'viewer-1'],
    ['a guest', null, 'guest-1'],
  ] as const)('draws the guest merge banner at the top of Home for %s, under the top bar', (_who, user, identityUserId) => {
    authState.user = user;
    authState.identityUserId = identityUserId;
    const { tree } = renderHome();
    const header = renderHeader(tree);

    const banners = header.root.findAll((node) => String(node.type) === 'guest-merge-banner');
    expect(banners).toHaveLength(1);
    // In the top bar's own block, right after the bar: the first thing under the balance.
    let block = banners[0].parent;
    while (block && String(block.type) !== 'view') block = block.parent;
    const [bar, ...rest] = block!.children as renderer.ReactTestInstance[];
    expect(bar.findAll((node) => node.props.accessibilityLabel === 'Search creators, posts, and recipes').length).toBeGreaterThan(0);
    expect(rest).toHaveLength(1);
    expect(rest[0].findAll((node) => String(node.type) === 'guest-merge-banner')).toHaveLength(1);

    renderer.act(() => header.unmount());
    renderer.act(() => tree.unmount());
  });

  // 02-1: a guest's count used to open a Creations tab that only said "Sign in
  // to view your creations"; it now opens the guest's own creations. The count
  // lived on the workspace slide until the shelf replaced it, and now takes the
  // shelf's subtitle line (home-shelf.test.tsx presses it).
  it("hands a guest's renders in progress to the shelf", () => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    activeGenerationState.count = 2;
    const { tree } = renderHome();
    const header = renderHeader(tree);

    expect(hostProps(header, 'home-shelf').activeRenders).toBe(2);

    renderer.act(() => header.unmount());
    renderer.act(() => tree.unmount());
  });

  it('hands the shelf no renders while nothing is rendering', () => {
    activeGenerationState.count = 0;
    const { tree } = renderHome();
    const header = renderHeader(tree);

    expect(hostProps(header, 'home-shelf').activeRenders).toBe(0);

    renderer.act(() => header.unmount());
    renderer.act(() => tree.unmount());
  });

  // The shelf's Make this is the feed's Remix: the same requests and the same
  // landing in the creator. A shelf post carries no feed delivery, so it files
  // no remix_start into the ranker's telemetry.
  it("runs the feed's remix for a shelf card", async () => {
    const { tree } = renderHome();
    const header = renderHeader(tree);
    const shelf = hostProps(header, 'home-shelf');
    expect(shelf.offerFreeToTry).toBe(false);

    await renderer.act(async () => {
      shelf.onMake({ id: 'post-1', post: shelfPost('post-1') });
      await settlePromises();
    });

    expect(authState.api.remixShowcasePost).toHaveBeenCalledWith('post-1');
    expect(authState.api.unlockFreeBundle).not.toHaveBeenCalled();
    expect(routerState.push).toHaveBeenCalledTimes(1);
    expect(authState.api.recordShowcaseFeedEvent).not.toHaveBeenCalled();

    renderer.act(() => header.unmount());
    renderer.act(() => tree.unmount());
  });

  it('opens one remix at a time from the shelf', async () => {
    const opened = deferred<{ success: boolean; redirectTo: string; prefill: { prompt: string; settings: {} } }>();
    authState.api.remixShowcasePost.mockImplementationOnce(() => opened.promise);
    const { tree } = renderHome();
    let header = renderHeader(tree);

    renderer.act(() => {
      hostProps(header, 'home-shelf').onMake({ id: 'post-1', post: shelfPost('post-1') });
    });
    // The screen re-renders with the remix pending: the shelf is told, and a
    // second tap is not another request.
    renderer.act(() => header.unmount());
    header = renderHeader(tree);
    expect(hostProps(header, 'home-shelf').pendingId).toBe('post-1');
    renderer.act(() => {
      hostProps(header, 'home-shelf').onMake({ id: 'post-2', post: shelfPost('post-2') });
    });
    expect(authState.api.remixShowcasePost).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      opened.resolve({ success: true, redirectTo: '/create-video?remix=generation-post-1&remixPost=post-1', prefill: { prompt: '', settings: {} } });
      await settlePromises();
    });
    expect(routerState.push).toHaveBeenCalledTimes(1);

    renderer.act(() => header.unmount());
    renderer.act(() => tree.unmount());
  });

  it("sends a guest's Make this to sign in, and offers a guest the welcome credits", () => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    const { tree } = renderHome();
    const header = renderHeader(tree);
    const shelf = hostProps(header, 'home-shelf');
    expect(shelf.offerFreeToTry).toBe(true);

    renderer.act(() => {
      shelf.onMake({ id: 'post-1', post: shelfPost('post-1') });
    });

    expect(authState.api.remixShowcasePost).not.toHaveBeenCalled();
    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/post/post-1' } });

    renderer.act(() => header.unmount());
    renderer.act(() => tree.unmount());
  });
});
