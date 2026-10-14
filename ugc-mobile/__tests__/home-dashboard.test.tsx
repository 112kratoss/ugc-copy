(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { Share } from 'react-native';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
type SentEvent = { eventType: string; deliveryId?: string; durationMs?: number };

// The header rail's pictures are `require`d at the screen's top level, as Metro
// bundles them, and that call reaches Node's own loader, which would read a
// .jpg as JavaScript. For this suite a .jpg is an asset number, as on a phone.
const jpegRequires = await vi.hoisted(async () => {
  const { default: Module } = await import('node:module');
  const extensions = (Module as unknown as {
    _extensions: Record<string, ((module: { exports: unknown }) => void) | undefined>;
  })._extensions;
  const previous = extensions['.jpg'];
  extensions['.jpg'] = (module) => {
    module.exports = 1;
  };
  return {
    restore() {
      if (previous) extensions['.jpg'] = previous;
      else delete extensions['.jpg'];
    },
  };
});
afterAll(() => jpegRequires.restore());

// One router object for every render: a new one per render hangs these suites.
const routerState = vi.hoisted(() => ({
  params: {},
  push: vi.fn(),
  setParams: vi.fn(),
}));

const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

const navState = vi.hoisted(() => ({ focused: true }));

const queryState = vi.hoisted(() => ({
  pages: [] as Array<Record<string, unknown>>,
  client: {
    getQueriesData: vi.fn(() => []),
    invalidateQueries: vi.fn(() => Promise.resolve()),
    setQueriesData: vi.fn(),
    setQueryData: vi.fn(),
  },
}));

// One object for every render, as the real context provides.
const authState = vi.hoisted(() => ({
  api: {
    getShowcasePost: vi.fn(),
    recordShowcaseFeedEvent: vi.fn((_request: SentEvent) => Promise.resolve()),
    shareShowcasePost: vi.fn((_postId: string, _options: { sourceSurface: string }) => Promise.resolve()),
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

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: MockProps) => React.createElement('flash-list', props),
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: () => ({
    data: { pages: queryState.pages, pageParams: [{ offset: 0 }] },
    dataUpdatedAt: 1,
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
    refetch: vi.fn(() => Promise.resolve()),
  }),
  useQuery: () => ({ data: undefined }),
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
  ImageIcon: (props: MockProps) => React.createElement('image-icon', props),
  Play: (props: MockProps) => React.createElement('play-icon', props),
  Plus: (props: MockProps) => React.createElement('plus-icon', props),
  Rocket: (props: MockProps) => React.createElement('rocket-icon', props),
  Sparkles: (props: MockProps) => React.createElement('sparkles-icon', props),
  WandSparkles: (props: MockProps) => React.createElement('wand-sparkles-icon', props),
}));

vi.mock('@/components/comments-sheet', () => ({
  CommentsSheet: (props: MockProps) => React.createElement('comments-sheet', props),
}));

vi.mock('@/components/feed-feedback-sheet', () => ({
  FeedFeedbackSheet: (props: MockProps) => React.createElement('feed-feedback-sheet', props),
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

vi.mock('@/lib/use-active-generations', () => ({
  useActiveGenerationCount: () => 0,
}));

vi.mock('@/lib/app-foreground', () => ({
  useAppForeground: () => true,
}));

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
import { schedulePersistHomeFeed } from '../lib/persisted-home-feed';
import { SHOWCASE_DWELL_VIEWABILITY } from '../lib/showcase-feed-events';
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

/** The handlers the screen gives the card at `index`, as the list would draw it. */
function cardAt(tree: renderer.ReactTestRenderer, index: number) {
  const props = listProps(tree);
  const cell = props.renderItem({ item: props.data[index], index, target: 'Cell' }) as React.ReactElement<{
    children: React.ReactElement<{
      onAssetPress: () => void;
      onOpen: (zoom: null) => void;
      onShare: () => void;
    }>;
  }>;
  return cell.props.children.props;
}

/** FlashList reporting these cards at the dwell's visibility (half on screen). */
function reportOnScreen(tree: renderer.ReactTestRenderer, indexes: number[]) {
  const props = listProps(tree);
  const dwell = (props.viewabilityConfigCallbackPairs as Array<{
    viewabilityConfig: unknown;
    onViewableItemsChanged: (info: { viewableItems: unknown[]; changed: unknown[] }) => void;
  }>).find((pair) => pair.viewabilityConfig === SHOWCASE_DWELL_VIEWABILITY);
  renderer.act(() => dwell!.onViewableItemsChanged({
    viewableItems: indexes.map((index) => ({ index, isViewable: true, item: props.data[index], key: props.data[index].id })),
    changed: [],
  }));
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
    queryState.pages = [];
  });

  afterEach(() => {
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
});
