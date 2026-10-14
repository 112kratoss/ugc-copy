(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import type { InfiniteData } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { AccessibilityInfo, Alert } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const queryState = vi.hoisted(() => ({
  /** When the lane's pages were fetched, as React Query reports it. */
  dataUpdatedAt: 0,
  error: null as Error | null,
  fetchNextPage: vi.fn(() => Promise.resolve()),
  filter: 'all',
  hasNextPage: false,
  isFetchNextPageError: false,
  isFetching: false,
  isFetchingNextPage: false,
  isLoading: false,
  pages: [{ items: [], pageInfo: { hasMore: false, nextOffset: null } }] as object[],
  /** The key of the lane the screen last asked for. */
  queryKey: null as readonly unknown[] | null,
  refetch: vi.fn(() => Promise.resolve()),
  tool: undefined as string | undefined,
}));

// One object for every render, as the real context provides: a fresh `user`
// per render would rebuild the grid's cards each time.
const authState = vi.hoisted(() => ({
  api: {
    blockUser: vi.fn(),
    getShowcaseFeedNewest: vi.fn((_params?: { category?: string }) => Promise.resolve({
      newestPostId: null as string | null,
      newestPublishedAt: null as string | null,
    })),
    recordShowcaseFeedEvent: vi.fn(() => Promise.resolve()),
    reportPost: vi.fn(),
    reportUser: vi.fn(),
    undoFeedFeedback: vi.fn((_body: unknown) => Promise.resolve({ ok: true as const, removed: true })),
  },
  identityUserId: 'viewer-1' as string | null,
  user: { id: 'viewer-1' } as { id: string } | null,
}));

type QueryKey = readonly unknown[];

// One client for every render, as the real provider gives. `laneCache` below
// gives it a cache for the tests that read one back.
const queryClient = vi.hoisted(() => ({
  getQueriesData: vi.fn((_filters: { queryKey: QueryKey }): Array<[QueryKey, unknown]> => []),
  invalidateQueries: vi.fn(() => Promise.resolve()),
  setQueriesData: vi.fn((_filters: { queryKey: QueryKey }, _updater: unknown): void => undefined),
  setQueryData: vi.fn((_queryKey: QueryKey, _updater: unknown): void => undefined),
}));

const navigation = vi.hoisted(() => ({ isFocused: true }));

// What the "New posts" probe subscribed to: a test brings the app back to the
// foreground by calling it.
const appForeground = vi.hoisted(() => ({ listeners: new Set<(foreground: boolean) => void>() }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: MockProps) => React.createElement('flash-list', props, props.ListFooterComponent as React.ReactNode),
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: (options: { queryKey: readonly unknown[] }) => {
    queryState.queryKey = options.queryKey;
    return {
      data: {
        pages: queryState.pages,
        pageParams: [{ offset: 0 }],
      },
      dataUpdatedAt: queryState.dataUpdatedAt,
      error: queryState.error,
      fetchNextPage: queryState.fetchNextPage,
      hasNextPage: queryState.hasNextPage,
      isFetchNextPageError: queryState.isFetchNextPageError,
      isFetching: queryState.isFetching,
      isFetchingNextPage: queryState.isFetchingNextPage,
      isLoading: queryState.isLoading,
      isRefetching: false,
      refetch: queryState.refetch,
    };
  },
  useQueryClient: () => queryClient,
}));

vi.mock('expo-router', () => ({
  router: {
    push: vi.fn(),
    setParams: vi.fn(),
  },
  useLocalSearchParams: () => ({ filter: queryState.filter, tool: queryState.tool }),
}));

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => navigation.isFocused,
  useScrollToTop: vi.fn(),
}));

vi.mock('@/lib/app-foreground', () => ({
  isAppForeground: () => true,
  subscribeToAppForeground: (listener: (foreground: boolean) => void) => {
    appForeground.listeners.add(listener);
    return () => {
      appForeground.listeners.delete(listener);
    };
  },
  useAppForeground: () => true,
}));

// The tiles read the Autoplay previews choice, which is kept on the device.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement(
    'pressable',
    { ...props, style: typeof style === 'function' ? style({ pressed: false }) : style },
    children
  ),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  StatusBar: { currentHeight: 0 },
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
  Image: Object.assign(
    (props: MockProps) => React.createElement('image', props),
    { loadAsync: vi.fn(() => Promise.resolve({ width: 100, height: 100 })) }
  ),
}));

// The zoom's flight layer can draw a video a tile lent it.
vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

vi.mock('lucide-react-native', () => ({
  ImageIcon: (props: MockProps) => React.createElement('image-icon', props),
  MoreVertical: (props: MockProps) => React.createElement('more-vertical-icon', props),
  Play: (props: MockProps) => React.createElement('play-icon', props),
  RefreshCw: (props: MockProps) => React.createElement('refresh-icon', props),
  Search: (props: MockProps) => React.createElement('search-icon', props),
  X: (props: MockProps) => React.createElement('x-icon', props),
}));

vi.mock('@/components/explore-search-overlay', () => ({
  ExploreSearchOverlay: (props: MockProps) => React.createElement('explore-search-overlay', props),
}));

vi.mock('@/components/showcase-media-preview', () => ({
  ShowcaseMediaPreview: (props: MockProps) => React.createElement('showcase-media-preview', props),
}));

vi.mock('@/components/feed-feedback-sheet', () => ({
  FeedFeedbackSheet: (props: MockProps) => React.createElement('feed-feedback-sheet', props),
}));

vi.mock('@/components/new-posts-pill', () => ({
  NewPostsPill: (props: MockProps) => React.createElement('new-posts-pill', props),
}));

vi.mock('@/components/feed-undo-notice', () => ({
  FeedUndoNotice: (props: MockProps) => React.createElement('feed-undo-notice', props),
}));

vi.mock('@/components/top-scrim', () => ({
  TopScrim: (props: MockProps) => React.createElement('top-scrim', props),
}));

// Same reason as the scrim: the zoom's flight layer shades letterbox bands with
// expo-linear-gradient, which vitest cannot parse.
vi.mock('@/components/letterbox-bands', () => ({
  LetterboxBands: (props: MockProps) => React.createElement('letterbox-bands', props),
}));

vi.mock('@/components/ui', () => ({
  CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/components/workspace-side-menu-gesture-layer', () => ({
  WORKSPACE_SIDE_MENU_LABEL: 'Open workspace menu',
  WorkspaceSideMenuGestureLayer: ({ children, ...props }: MockProps) =>
    React.createElement('workspace-side-menu-gesture-layer', props, children),
  WorkspaceSideMenuGlyph: (props: MockProps) => React.createElement('workspace-side-menu-glyph', props),
  useWorkspaceSideMenu: () => null,
}));

vi.mock('@/components/reveal', () => ({
  Reveal: ({ children, ...props }: MockProps) => React.createElement('reveal', props, children),
}));

vi.mock('@/components/skeleton', () => ({
  SkeletonBone: (props: MockProps) => React.createElement('skeleton-bone', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/feed-event-queue', () => ({
  enqueueShowcaseFeedEvent: vi.fn(() => Promise.resolve()),
  flushShowcaseFeedEvents: vi.fn(() => Promise.resolve()),
  isBatchedShowcaseFeedEventType: () => false,
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  // No fade here: an overlay is drawn exactly while it is visible.
  useOverlayPresence: (visible: boolean) => ({ mounted: visible, animatedStyle: undefined }),
  usePressMotion: () => ({
    animatedStyle: {},
    onPressIn: vi.fn(),
    onPressOut: vi.fn(),
  }),
  useReducedMotion: () => false,
}));

import ShowcaseScreen, { partitionAspectRatiosByViewport } from '../app/(tabs)/showcase';
import { resetAutoplayPreferenceForTests, type AutoplayPreference } from '../lib/autoplay-preference';
import { createFeedVideoActivationStore, FeedVideoActivationContext } from '../lib/feed-video-activation';
import { haptic } from '../lib/haptics';
import { resolvedBottomInset, resolvedTopInset } from '../lib/safe-area';
import {
  SHOWCASE_ONSCREEN_VIEWABILITY,
  resetAnonymousShowcaseFeedRemovalsForTests,
  resetFeedFeedbackRequestsForTests,
} from '../lib/showcase-feed-events';
import { getMagicTabBarMetrics } from '../lib/tab-bar-layout';
import type { CreatorProfileResponse, ShowcaseFeedItem, ShowcaseFeedResponse } from '../lib/types';
import { NEW_POSTS_PROBE_MIN_LANE_AGE_MS } from '../lib/use-new-posts-probe';

function feedItem() {
  return {
    id: 'post-1',
    mediaUrl: 'https://cdn.example.com/post-1.jpg',
    mediaKind: 'image',
    mediaItems: [{
      id: 'post-1:media',
      url: 'https://cdn.example.com/post-1.jpg',
      previewUrl: 'https://cdn.example.com/post-1.preview.webp',
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
    title: 'Portrait',
    prompt: 'Portrait prompt',
    body: null,
    category: 'image',
    postFormat: 'media',
    saveCount: 1,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-08-25T00:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

/** The props the screen hands FlashList in the current query state. */
function flashListProps() {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(<ShowcaseScreen />);
  });
  const props = tree!.root.find((node) => String(node.type) === 'flash-list').props;
  renderer.act(() => tree!.unmount());
  return props;
}

/** Draws one of those props on its own, as FlashList would. */
function renderAlone(element: React.ReactNode) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(<>{element}</>);
  });
  return tree!;
}

type Shape = string | { type: string; children: Shape[] };

/** What a rendered tree is made of, host types and text, leaving out how it is styled. */
function shapeOf(element: React.ReactNode): Shape[] {
  const tree = renderAlone(element);
  const shape = toShapes(tree.toJSON());
  renderer.act(() => tree.unmount());
  return shape;
}

function toShapes(node: renderer.ReactTestRendererNode | renderer.ReactTestRendererJSON[] | null): Shape[] {
  if (node === null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(toShapes);
  return [{ type: node.type, children: (node.children ?? []).flatMap(toShapes) }];
}

/** The filter chip with this label in a rendered list header. */
function filterChip(header: renderer.ReactTestRenderer, label: string) {
  return header.root.find((node) => (
    String(node.type) === 'pressable'
    && node.props.accessibilityState !== undefined
    && node.findAll((child) => String(child.type) === 'text' && child.props.children === label).length > 0
  ));
}

type ListProps = renderer.ReactTestInstance['props'];

type PinProps = {
  card: { id: string; item: unknown };
  onAspectRatio: (cardId: string, ratio: number) => void;
  feedbackMenu: (item: unknown) => { sections: Array<{ items: Array<{ id?: string; onSelect?: () => void }> }> };
};

/** What the grid hands the pin at `index`, rendered as FlashList would render it. */
function pinProps(list: ListProps, index: number): PinProps {
  const cell = list.renderItem({ item: list.data[index], index, target: 'Cell' }) as React.ReactElement<{
    children: React.ReactElement<PinProps>;
  }>;
  return cell.props.children.props;
}

/** Picks a row from a tile's ⋮ menu: the first tile's, or the one showing `postId`. */
function selectTileMenuRow(list: ListProps, rowId: string, postId?: string) {
  const index = postId ? (list.data as Array<{ id: string }>).findIndex((card) => card.id === postId) : 0;
  if (index < 0) throw new Error(`No tile shows ${postId}.`);
  const pin = pinProps(list, index);
  const row = pin.feedbackMenu(pin.card.item).sections
    .flatMap((section) => section.items)
    .find((item) => item.id === rowId);
  if (!row?.onSelect) throw new Error(`The tile menu has no ${rowId} row.`);
  const select = row.onSelect;
  renderer.act(() => select());
}

/** The one host element of this type the screen draws. */
function hostElement(tree: renderer.ReactTestRenderer, type: string) {
  return tree.root.find((node) => String(node.type) === type);
}

/** Lets the promises the screen started settle. */
async function settle() {
  await renderer.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Reports the list header's title row and chips laid out at this height, as the native layout would. */
function measureListHeader(tree: renderer.ReactTestRenderer, height: number) {
  const header = renderAlone(hostElement(tree, 'flash-list').props.ListHeaderComponent);
  const measured = header.root.find((node) => String(node.type) === 'view' && typeof node.props.onLayout === 'function');
  renderer.act(() => measured.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 374, height } } }));
  renderer.act(() => header.unmount());
}

/** The app coming back to the foreground, as `subscribeToAppForeground` reports it. */
async function returnToApp() {
  await renderer.act(async () => {
    appForeground.listeners.forEach((listener) => listener(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

type Lane = InfiniteData<ShowcaseFeedResponse>;

/** One page of a lane, a post per entry, each the fixture post with the fields given. */
function lanePage(posts: Array<{ id: string; creatorId?: string }>): ShowcaseFeedResponse {
  return {
    items: posts.map(({ id, creatorId = 'creator-1' }) => ({
      ...feedItem(),
      id,
      title: id,
      creator: { id: creatorId, username: creatorId, name: creatorId, avatar: null },
    })) as unknown as ShowcaseFeedItem[],
    pageInfo: { hasMore: false, nextOffset: null },
  };
}

/**
 * Gives the client double a cache holding these lanes, so what a removal takes
 * out and an Undo puts back can be read back. Returns the post ids a lane holds
 * now, in order.
 */
function laneCache(entries: Array<[QueryKey, Lane]>) {
  const lanes = new Map(entries.map(([key, data]) => [JSON.stringify(key), { key, data }]));
  const under = (prefix: QueryKey) => [...lanes.values()].filter(({ key }) => (
    prefix.every((part, index) => JSON.stringify(key[index]) === JSON.stringify(part))
  ));
  // As React Query does: an updater that answers `undefined` leaves the data as it was.
  const next = (current: Lane, updater: unknown) => (
    typeof updater === 'function' ? (updater as (lane: Lane) => Lane | undefined)(current) ?? current : updater as Lane
  );
  queryClient.getQueriesData.mockImplementation(({ queryKey }) => (
    under(queryKey).map(({ key, data }): [QueryKey, unknown] => [key, data])
  ));
  queryClient.setQueriesData.mockImplementation(({ queryKey }, updater) => {
    for (const lane of under(queryKey)) lane.data = next(lane.data, updater);
  });
  queryClient.setQueryData.mockImplementation((queryKey, updater) => {
    const lane = lanes.get(JSON.stringify(queryKey));
    if (lane) lane.data = next(lane.data, updater);
  });
  return (key: QueryKey) => lanes.get(JSON.stringify(key))?.data.pages.flatMap((page) => page.items.map((item) => item.id));
}

/** A creator's cached grid with two pages loaded, as `['creator-profile', 'infinite', <handle>]` holds it. */
function creatorGrid(creatorId: string): InfiniteData<CreatorProfileResponse> {
  const page = (offset: number): CreatorProfileResponse => ({
    profile: {
      id: creatorId,
      username: creatorId,
      displayName: creatorId,
      bio: null,
      avatarUrl: null,
      coverUrl: null,
      websiteUrl: null,
      twitterHandle: null,
      instagramHandle: null,
      tiktokHandle: null,
      location: null,
    },
    items: lanePage([{ id: `${creatorId}-post-${offset}`, creatorId }]).items,
    pageInfo: { hasMore: true, nextLimit: 24, nextOffset: offset + 24, limit: 24, offset },
    viewer: { isOwner: false, isFollowing: true, blockedByViewer: false },
  });
  return { pages: [page(0), page(24)], pageParams: [0, 24] };
}

describe('Showcase screen', () => {
  beforeEach(() => {
    vi.mocked(Image.loadAsync).mockClear();
    queryClient.getQueriesData.mockReset();
    queryClient.setQueriesData.mockReset();
    queryClient.setQueryData.mockReset();
    authState.api.getShowcaseFeedNewest.mockReset();
    authState.api.recordShowcaseFeedEvent.mockReset();
    authState.api.undoFeedFeedback.mockReset();
    resetFeedFeedbackRequestsForTests();
    resetAnonymousShowcaseFeedRemovalsForTests();
    navigation.isFocused = true;
    queryState.dataUpdatedAt = 0;
    queryState.error = null;
    queryState.fetchNextPage.mockClear();
    queryState.refetch.mockClear();
    queryState.filter = 'all';
    queryState.hasNextPage = false;
    queryState.isFetchNextPageError = false;
    queryState.isFetching = false;
    queryState.isFetchingNextPage = false;
    queryState.isLoading = false;
    queryState.pages = [{ items: [], pageInfo: { hasMore: false, nextOffset: null } }];
    queryState.tool = undefined;
  });

  it('keeps the list header one height while the feed loads, fails or comes back empty', () => {
    // FlashList offsets the first card by the header's height, but the render
    // that delivers the first page reads the height from before it. With the
    // loading skeleton in the header, a cold first visit left every card
    // "below the screen": nothing was viewable and no video played until a
    // scroll. Whatever the load state shows has to live below the header.
    queryState.pages = [{ items: [feedItem()], pageInfo: { hasMore: false, nextOffset: null } }];
    const loaded = flashListProps();

    queryState.pages = [];
    queryState.isLoading = true;
    const loading = flashListProps();

    queryState.isLoading = false;
    queryState.error = new Error('Network request failed');
    const failed = flashListProps();

    queryState.error = null;
    const empty = flashListProps();

    const header = shapeOf(loaded.ListHeaderComponent);
    expect(shapeOf(loading.ListHeaderComponent)).toEqual(header);
    expect(shapeOf(failed.ListHeaderComponent)).toEqual(header);
    expect(shapeOf(empty.ListHeaderComponent)).toEqual(header);

    const skeleton = renderAlone(loading.ListEmptyComponent);
    expect(skeleton.root.findAll((node) => String(node.type) === 'skeleton-bone').length).toBeGreaterThan(0);
    renderer.act(() => skeleton.unmount());

    const failure = renderAlone(failed.ListEmptyComponent);
    expect(failure.root.findByProps({ title: 'Could not load Explore' }).props.tone).toBe('danger');
    expect(failure.root.findAllByProps({ label: 'Retry Explore' })).not.toHaveLength(0);
    renderer.act(() => failure.unmount());
  });

  it('recomputes viewability when new posts land on the indices already on screen', () => {
    // FlashList reports viewability by index. A filter switch to a cached feed
    // puts different posts at the same indices and reports nothing, which left
    // the grid with no video after the filter reset its election.
    const recomputeViewableItems = vi.fn();
    queryState.pages = [{ items: [feedItem()], pageInfo: { hasMore: false, nextOffset: null } }];
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />, {
        createNodeMock: (element) => (
          String(element.type) === 'flash-list' ? { recomputeViewableItems, scrollToOffset: vi.fn() } : null
        ),
      });
    });

    // A render that leaves the posts alone has nothing new to report.
    recomputeViewableItems.mockClear();
    renderer.act(() => tree!.update(<ShowcaseScreen />));
    expect(recomputeViewableItems).not.toHaveBeenCalled();

    queryState.pages = [{
      items: [{ ...feedItem(), id: 'post-2', title: 'Landscape' }],
      pageInfo: { hasMore: false, nextOffset: null },
    }];
    renderer.act(() => tree!.update(<ShowcaseScreen />));
    expect(recomputeViewableItems).toHaveBeenCalledTimes(1);

    renderer.act(() => tree!.unmount());
  });

  it('opens another filter or tool at the top of its feed', () => {
    // FlashList v2 keeps whichever post is first on screen in place across a
    // data change unless maintainVisibleContentPosition is disabled. Free's
    // first post also sits further down All, so switching Free → All to the
    // cached All feed opened it mid-way down instead of at the top.
    const list = { recomputeViewableItems: vi.fn(), scrollToOffset: vi.fn() };
    queryState.pages = [{ items: [feedItem()], pageInfo: { hasMore: false, nextOffset: null } }];
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />, {
        createNodeMock: (element) => (String(element.type) === 'flash-list' ? list : null),
      });
    });

    const flashList = tree!.root.find((node) => String(node.type) === 'flash-list');
    expect(flashList.props.maintainVisibleContentPosition).toEqual({ disabled: true });

    // Without that anchor the list keeps its offset, so a new feed has to go
    // to the top itself: from a chip, and from a link that sets a tool, which
    // can arrive while the grid is deep in the previous feed.
    list.scrollToOffset.mockClear();
    const header = renderAlone(flashList.props.ListHeaderComponent);
    renderer.act(() => filterChip(header, 'Free').props.onPress());
    renderer.act(() => header.unmount());
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });

    list.scrollToOffset.mockClear();
    renderer.act(() => tree!.update(<ShowcaseScreen />));
    expect(list.scrollToOffset).not.toHaveBeenCalled();

    queryState.tool = 'seedance';
    renderer.act(() => tree!.update(<ShowcaseScreen />));
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });

    renderer.act(() => tree!.unmount());
  });

  it('does not load every cached preview just to measure missing dimensions', async () => {
    const base = feedItem();
    queryState.pages = [{
      items: Array.from({ length: 48 }, (_, index) => ({
        ...base, id: `post-${index}`,
        mediaItems: base.mediaItems.map(media => ({ ...media, width: null, height: null })),
      })),
      pageInfo: { hasMore: false, nextOffset: null },
    }];
    let tree: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(<ShowcaseScreen />); });
    expect(Image.loadAsync).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
  });

  it('balances variable-height cards across two masonry columns', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />);
    });

    const list = tree!.root.find((node) => String(node.type) === 'flash-list');
    expect(list.props.masonry).toBe(true);
    expect(list.props.numColumns).toBe(2);
    expect(list.props.optimizeItemArrangement).toBe(true);

    renderer.act(() => tree!.unmount());
  });

  it('explains when a filtered Showcase has reached its end', () => {
    queryState.filter = 'unlocks';
    queryState.pages = [{ items: [feedItem()], pageInfo: { hasMore: false, nextOffset: null } }];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />);
    });

    expect(tree!.root.findAll((node) => (
      String(node.type) === 'text' && node.props.children === "You've reached the end of Unlocks."
    ))).toHaveLength(1);
    renderer.act(() => tree!.unmount());
  });

  it('uses a neutral all-caught-up message for the unfiltered feed', () => {
    queryState.pages = [{ items: [feedItem()], pageInfo: { hasMore: false, nextOffset: null } }];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />);
    });

    expect(tree!.root.findAll((node) => (
      String(node.type) === 'text' && node.props.children === "You're all caught up."
    ))).toHaveLength(1);
    renderer.act(() => tree!.unmount());
  });

  it('shows a visible load-more retry and clears the automatic page lock', async () => {
    queryState.hasNextPage = true;
    queryState.isFetchNextPageError = true;
    queryState.pages = [{ items: [feedItem()], pageInfo: { hasMore: true, nextOffset: 12 } }];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />);
    });

    const retry = tree!.root.findByProps({ accessibilityLabel: "Couldn't load more. Retry" });
    await renderer.act(async () => {
      retry.props.onPress();
      await Promise.resolve();
    });

    expect(queryState.fetchNextPage).toHaveBeenCalledTimes(1);
    renderer.act(() => tree!.unmount());
  });

  // The server files the report as that delivery's `report` feed event, the
  // one way the ranker hears it.
  it('names the delivery a ranked tile was reported from', async () => {
    queryState.pages = [{
      items: [{ ...feedItem(), recommendation: { deliveryId: '812', position: 0, algorithmVersion: 'for-you-rules-v4' } }],
      pageInfo: { hasMore: false, nextOffset: null },
    }];
    authState.api.reportPost.mockReset();
    authState.api.reportPost.mockResolvedValue({ success: true });
    vi.mocked(Alert.alert).mockClear();

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />);
    });
    // The tile's ⋮ menu, as its pin builds it.
    const list = tree!.root.find((node) => String(node.type) === 'flash-list').props;
    const cell = list.renderItem({ item: list.data[0], index: 0, target: 'Cell' }) as React.ReactElement<{
      children: React.ReactElement<{ feedbackMenu: (item: unknown) => { sections: Array<{ items: Array<{ id?: string; onSelect?: () => void }> }> } }>;
    }>;
    const menu = cell.props.children.props.feedbackMenu(list.data[0].item);
    const report = menu.sections.flatMap((section) => section.items).find((row) => row.id === 'report-content');
    renderer.act(() => report?.onSelect?.());

    const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
    await renderer.act(async () => {
      buttons.find((button) => button.text === 'Report content')?.onPress?.();
    });

    expect(authState.api.reportPost).toHaveBeenCalledWith('post-1', {
      reason: 'unsafe_content',
      details: 'Reported from the mobile Showcase.',
      deliveryId: '812',
    });
    renderer.act(() => tree!.unmount());
  });

  it('keeps the loader ahead of an error footer while a page is in flight', () => {
    queryState.hasNextPage = true;
    queryState.isFetchNextPageError = true;
    queryState.isFetching = true;
    queryState.isFetchingNextPage = true;
    queryState.pages = [{ items: [feedItem()], pageInfo: { hasMore: true, nextOffset: 12 } }];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />);
    });

    expect(tree!.root.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(1);
    expect(tree!.root.findAllByProps({ accessibilityLabel: "Couldn't load more. Retry" })).toHaveLength(0);
    renderer.act(() => tree!.unmount());
  });

  // The web's feed, Explore and reel, and this app's reel and Home, all file a
  // reported creator under `harassment`; the tile was the one that differed.
  it('files a creator reported from a tile under the reason every other surface uses', async () => {
    queryState.pages = [{ items: [feedItem()], pageInfo: { hasMore: false, nextOffset: null } }];
    authState.api.reportUser.mockReset();
    authState.api.reportUser.mockResolvedValue({ success: true });
    vi.mocked(Alert.alert).mockClear();

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />);
    });
    selectTileMenuRow(tree!.root.find((node) => String(node.type) === 'flash-list').props, 'report-user');

    const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
    await renderer.act(async () => {
      buttons.find((button) => button.text === 'Report user')?.onPress?.();
    });

    expect(authState.api.reportUser).toHaveBeenCalledWith('creator-1', {
      reason: 'harassment',
      sourceSurface: 'showcase',
      details: 'Reported from post post-1.',
    });
    renderer.act(() => tree!.unmount());
  });

  // The creator page's Block writes the server's blocked answer into that
  // creator's cached grid (WP10). The tile's Block invalidated every cached
  // creator grid instead, which read every loaded page of each one again.
  it('blocks a creator from a tile by writing their cached grid as blocked, and reads no grid again', async () => {
    const tile = lanePage([{ id: 'post-1' }, { id: 'post-2', creatorId: 'creator-2' }]);
    queryState.pages = [tile];
    authState.api.blockUser.mockReset();
    authState.api.blockUser.mockResolvedValue({ success: true });
    queryClient.invalidateQueries.mockClear();
    vi.mocked(Alert.alert).mockClear();
    vi.mocked(AccessibilityInfo.announceForAccessibility).mockClear();

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />);
    });
    try {
      const exploreKey = queryState.queryKey!;
      const blockedGridKey: QueryKey = ['creator-profile', 'infinite', 'creator-1'];
      const otherGridKey: QueryKey = ['creator-profile', 'infinite', 'creator-2'];
      const otherGrid = creatorGrid('creator-2');
      const idsIn = laneCache([
        [exploreKey, { pages: [tile], pageParams: [{ offset: 0 }] }],
        [blockedGridKey, creatorGrid('creator-1') as unknown as Lane],
        [otherGridKey, otherGrid as unknown as Lane],
      ]);

      selectTileMenuRow(hostElement(tree!, 'flash-list').props, 'block-user', 'post-1');
      const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
      await renderer.act(async () => {
        buttons.find((button) => button.text === 'Block user')?.onPress?.();
      });
      await settle();

      expect(authState.api.blockUser).toHaveBeenCalledWith('creator-1');
      expect(idsIn(exploreKey)).toEqual(['post-2']);
      // Their grid is the page the server answers now: one page, no posts, blocked.
      const [[, blocked]] = queryClient.getQueriesData({ queryKey: blockedGridKey }) as Array<
        [QueryKey, InfiniteData<CreatorProfileResponse>]
      >;
      expect(blocked.pages).toHaveLength(1);
      expect(blocked.pages[0]).toMatchObject({
        items: [],
        pageInfo: { hasMore: false, nextOffset: null },
        viewer: { isOwner: false, isFollowing: false, blockedByViewer: true },
      });
      // Another creator's grid keeps its pages, and its age.
      expect(queryClient.getQueriesData({ queryKey: otherGridKey })[0]?.[1]).toBe(otherGrid);
      // Only the Saved list, which loses their posts, is read again.
      expect(queryClient.invalidateQueries.mock.calls).toEqual([[{ queryKey: ['profile-saved-media', 'viewer-1'] }]]);
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('@creator-1 blocked.');
    } finally {
      renderer.act(() => tree!.unmount());
    }
  });

  // A guest has no `user` but has a backend identity, and the server refuses a
  // page's events and cursor from anyone but the identity it was ranked for.
  it("keys a guest's lane, and what the guest removes from it, by the guest's identity", () => {
    const registeredUser = authState.user;
    authState.user = null;
    authState.identityUserId = 'guest-1';
    queryState.pages = [{ items: [feedItem()], pageInfo: { hasMore: false, nextOffset: null } }];
    queryClient.setQueriesData.mockClear();

    let tree: renderer.ReactTestRenderer | undefined;
    try {
      renderer.act(() => {
        tree = renderer.create(<ShowcaseScreen />);
      });
      expect(queryState.queryKey?.slice(0, 3)).toEqual(['showcase-feed', 'infinite', 'guest-1']);

      selectTileMenuRow(tree!.root.find((node) => String(node.type) === 'flash-list').props, 'not-interested');
      expect(queryClient.setQueriesData).toHaveBeenCalledWith(
        { queryKey: ['showcase-feed', 'infinite', 'guest-1'] },
        expect.any(Function),
      );
    } finally {
      if (tree) renderer.act(() => tree!.unmount());
      resetAnonymousShowcaseFeedRemovalsForTests();
      authState.user = registeredUser;
      authState.identityUserId = 'viewer-1';
    }
  });

  // A cover without dimensions is measured once it loads. With MVCP off, a card
  // above the screen that changes height moves every card being read.
  it('lets a measured cover resize its card only below the screen, or at a refresh', async () => {
    const base = feedItem();
    queryState.pages = [{
      items: Array.from({ length: 6 }, (_, index) => ({
        ...base,
        id: `post-${index}`,
        mediaItems: base.mediaItems.map((media) => ({ ...media, width: null, height: null })),
      })),
      pageInfo: { hasMore: false, nextOffset: null },
    }];

    let tree: renderer.ReactTestRenderer | undefined;
    const listProps = () => tree!.root.find((node) => String(node.type) === 'flash-list').props;
    // FlashList's ref hands out the list's current props, data included.
    const list = {
      recomputeViewableItems: vi.fn(),
      scrollToOffset: vi.fn(),
      get props() {
        return listProps();
      },
    };
    /** FlashList's "any pixel on screen" report, for the cards at these indices. */
    const onScreen = (indices: number[]) => {
      const props = listProps();
      const pair = (props.viewabilityConfigCallbackPairs as Array<{
        viewabilityConfig: unknown;
        onViewableItemsChanged: (info: { viewableItems: unknown[]; changed: unknown[] }) => void;
      }>).find((candidate) => candidate.viewabilityConfig === SHOWCASE_ONSCREEN_VIEWABILITY);
      renderer.act(() => pair!.onViewableItemsChanged({
        viewableItems: indices.map((index) => ({
          index,
          isViewable: true,
          item: props.data[index],
          key: props.data[index].id,
          timestamp: 0,
        })),
        changed: [],
      }));
    };
    /** Covers loading: each pin reports its ratio, and the grid's flush runs. */
    const measure = (ratios: Record<string, number>) => {
      const props = listProps();
      for (const [cardId, ratio] of Object.entries(ratios)) {
        const index = (props.data as Array<{ id: string }>).findIndex((card) => card.id === cardId);
        pinProps(props, index).onAspectRatio(cardId, ratio);
      }
      renderer.act(() => {
        vi.advanceTimersByTime(50);
      });
    };
    const applied = () => listProps().extraData.resolvedAspectRatios;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderer.act(() => {
        tree = renderer.create(<ShowcaseScreen />, {
          createNodeMock: (element) => (String(element.type) === 'flash-list' ? list : null),
        });
      });

      onScreen([2, 3]);
      measure({ 'post-0': 1.25, 'post-2': 0.5, 'post-5': 2 });
      // Below the screen it applies at once; on the screen and above it, it waits.
      expect(applied()).toEqual({ 'post-5': 2 });

      // Scrolling on, post-2 leaves through the top and keeps its height.
      onScreen([4, 5]);
      expect(applied()).toEqual({ 'post-5': 2 });

      // Scrolling back up past it, post-2 leaves through the bottom.
      onScreen([0, 1]);
      expect(applied()).toEqual({ 'post-5': 2, 'post-2': 0.5 });

      // A refresh re-places every card anyway, so whatever still waits lands.
      await renderer.act(async () => {
        listProps().onRefresh();
      });
      expect(queryState.refetch).toHaveBeenCalledTimes(1);
      expect(applied()).toEqual({ 'post-5': 2, 'post-2': 0.5, 'post-0': 1.25 });
    } finally {
      vi.useRealTimers();
      if (tree) renderer.act(() => tree!.unmount());
    }
  });

  // Product decision D2: a ranked lane is never swapped under the reader on a
  // return to the app. A pill offers the refresh instead, and nothing comes
  // into the lane until it is tapped.
  describe('"New posts"', () => {
    const fiveMinutesOld = () => Date.now() - NEW_POSTS_PROBE_MIN_LANE_AGE_MS;

    function renderWithList() {
      const list = { recomputeViewableItems: vi.fn(), scrollToOffset: vi.fn() };
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<ShowcaseScreen />, {
          createNodeMock: (element) => (String(element.type) === 'flash-list' ? list : null),
        });
      });
      const pill = () => hostElement(tree!, 'new-posts-pill').props;
      return { list, tree: tree!, pill };
    }

    beforeEach(() => {
      // The lane's newest post is from August; the server has one from today.
      queryState.pages = [lanePage([{ id: 'post-1' }])];
      authState.api.getShowcaseFeedNewest.mockResolvedValue({
        newestPostId: 'post-9',
        newestPublishedAt: '2026-10-14T05:00:00.000Z',
      });
    });

    it('asks on a return to the app once the lane is five minutes old, and fetches nothing into it', async () => {
      queryState.dataUpdatedAt = Date.now() - 60_000;
      const { tree, pill } = renderWithList();
      try {
        expect(pill().visible).toBe(false);
        await returnToApp();
        expect(authState.api.getShowcaseFeedNewest).not.toHaveBeenCalled();

        queryState.dataUpdatedAt = fiveMinutesOld();
        renderer.act(() => tree.update(<ShowcaseScreen />));
        await returnToApp();

        // Every Explore lane is a ranked media lane.
        expect(authState.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
        expect(authState.api.getShowcaseFeedNewest).toHaveBeenCalledWith({ category: 'media' });
        expect(pill().visible).toBe(true);
        expect(queryState.refetch).not.toHaveBeenCalled();
        expect(queryClient.setQueryData).not.toHaveBeenCalled();
      } finally {
        renderer.act(() => tree.unmount());
      }
    });

    it('asks nothing while another tab is in front', async () => {
      queryState.dataUpdatedAt = fiveMinutesOld();
      navigation.isFocused = false;
      const { tree, pill } = renderWithList();
      try {
        await returnToApp();
        expect(authState.api.getShowcaseFeedNewest).not.toHaveBeenCalled();

        navigation.isFocused = true;
        renderer.act(() => tree.update(<ShowcaseScreen />));
        await returnToApp();
        expect(authState.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
        expect(pill().visible).toBe(true);
      } finally {
        renderer.act(() => tree.unmount());
      }
    });

    it('takes the reader to the top and fetches page 1 again, without the pull spinner', async () => {
      queryState.dataUpdatedAt = fiveMinutesOld();
      const { list, tree, pill } = renderWithList();
      const refreshing = () => hostElement(tree, 'flash-list').props.refreshing;
      let finishRefetch: () => void = () => undefined;
      const heldRefetch = () => new Promise<void>((resolve) => {
        finishRefetch = resolve;
      });
      try {
        await returnToApp();
        expect(pill().visible).toBe(true);
        list.scrollToOffset.mockClear();

        queryState.refetch.mockImplementationOnce(heldRefetch);
        renderer.act(() => pill().onPress());

        expect(pill().visible).toBe(false);
        expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
        expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
        // The lane trimmed to its first page, and that page fetched again,
        // once the list is at the top.
        expect(queryClient.setQueryData).toHaveBeenCalledTimes(1);
        const [trimmedKey, trim] = queryClient.setQueryData.mock.calls[0];
        expect(trimmedKey).toEqual(queryState.queryKey);
        const pages = [lanePage([{ id: 'post-1' }]), lanePage([{ id: 'post-2' }])];
        expect((trim as (lane: Lane) => Lane)({ pages, pageParams: [{ offset: 0 }, { offset: 12 }] }))
          .toEqual({ pages: [pages[0]], pageParams: [{ offset: 0 }] });
        expect(queryState.refetch).toHaveBeenCalledTimes(1);
        expect(list.scrollToOffset.mock.invocationCallOrder[0])
          .toBeLessThan(queryState.refetch.mock.invocationCallOrder[0]);
        // No spinner while the page is on its way: set from a tap deep in the
        // grid, it would shift the iOS list down and leave it there.
        expect(refreshing()).toBe(false);
        finishRefetch();
        await settle();
        expect(refreshing()).toBe(false);

        // The same reading sees a pull's own spinner.
        queryState.refetch.mockImplementationOnce(heldRefetch);
        renderer.act(() => hostElement(tree, 'flash-list').props.onRefresh());
        expect(refreshing()).toBe(true);
        finishRefetch();
        await settle();
        expect(refreshing()).toBe(false);
      } finally {
        renderer.act(() => tree.unmount());
      }
    });

    it('takes the pill down when a chip opens another lane, and leaves it down on coming back', async () => {
      queryState.dataUpdatedAt = fiveMinutesOld();
      const { tree, pill } = renderWithList();
      const pressChip = (label: string) => {
        const header = renderAlone(hostElement(tree, 'flash-list').props.ListHeaderComponent);
        renderer.act(() => filterChip(header, label).props.onPress());
        renderer.act(() => header.unmount());
      };
      try {
        await returnToApp();
        expect(pill().visible).toBe(true);

        // This double gives every lane the same fetch time, so it is the
        // screen, not a new fetch, that takes the pill down here.
        pressChip('Free');
        expect(pill().visible).toBe(false);
        // Back on All, its pages unrefreshed: only the next return asks again.
        pressChip('All');
        expect(pill().visible).toBe(false);
        expect(authState.api.getShowcaseFeedNewest).toHaveBeenCalledTimes(1);
      } finally {
        renderer.act(() => tree.unmount());
      }
    });

    it('floats under the chips as they sit at rest', () => {
      const { tree, pill } = renderWithList();
      try {
        measureListHeader(tree, 106);
        expect(pill().topOffset).toBe(resolvedTopInset(24) + 12 + 106 + 8);
      } finally {
        renderer.act(() => tree.unmount());
      }
    });
  });

  // Product decision D7: Not interested and Hide offer an Undo for five
  // seconds, and an Undo puts the posts back at the indices they left.
  describe('Undo', () => {
    const homeKey: QueryKey = ['showcase-feed', 'infinite', 'viewer-1', { sort: 'for-you' }];

    /** Explore holding three posts, the last two by creator-2; Home holds one of them too. */
    function renderWithLanes() {
      const explore = lanePage([{ id: 'post-0' }, { id: 'post-1', creatorId: 'creator-2' }, { id: 'post-2', creatorId: 'creator-2' }]);
      queryState.pages = [explore];
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<ShowcaseScreen />);
      });
      const exploreKey = queryState.queryKey!;
      const idsIn = laneCache([
        [exploreKey, { pages: [explore], pageParams: [{ offset: 0 }] }],
        [homeKey, { pages: [lanePage([{ id: 'post-7' }, { id: 'post-1', creatorId: 'creator-2' }])], pageParams: [{ offset: 0 }] }],
      ]);
      return {
        tree: tree!,
        explore: () => idsIn(exploreKey),
        home: () => idsIn(homeKey),
        list: () => hostElement(tree!, 'flash-list').props,
        noticeProps: () => hostElement(tree!, 'feed-undo-notice').props,
        notice: () => hostElement(tree!, 'feed-undo-notice').props.notice as {
          id: string;
          message: string;
          onUndo: () => void;
        } | null,
      };
    }

    it('puts a post back where it was in every lane once the server has taken the choice back', async () => {
      const screen = renderWithLanes();
      try {
        vi.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
        selectTileMenuRow(screen.list(), 'not-interested', 'post-1');
        await settle();
        expect(screen.explore()).toEqual(['post-0', 'post-2']);
        expect(screen.home()).toEqual(['post-7']);
        // The notice says it, above the tab bar, and announces itself: the
        // screen no longer announces the choice on its own.
        expect(screen.notice()?.message).toBe('Post hidden');
        expect(screen.noticeProps().bottomOffset)
          .toBe(getMagicTabBarMetrics(390, resolvedBottomInset(24)).contentBottomPadding);
        expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();

        let answer: (value: { ok: true; removed: boolean }) => void = () => undefined;
        authState.api.undoFeedFeedback.mockImplementationOnce(() => new Promise((resolve) => {
          answer = resolve;
        }));
        const { onUndo } = screen.notice()!;
        renderer.act(() => onUndo());
        await settle();
        expect(authState.api.undoFeedFeedback).toHaveBeenCalledWith({ feedbackType: 'not_interested', postId: 'post-1' });
        // Not back before the server has answered.
        expect(screen.explore()).toEqual(['post-0', 'post-2']);

        answer({ ok: true, removed: true });
        await settle();
        expect(screen.explore()).toEqual(['post-0', 'post-1', 'post-2']);
        expect(screen.home()).toEqual(['post-7', 'post-1']);
      } finally {
        renderer.act(() => screen.tree.unmount());
      }
    });

    it('brings back every post a Hide took, each at its place', async () => {
      const screen = renderWithLanes();
      try {
        selectTileMenuRow(screen.list(), 'hide-creator', 'post-1');
        await settle();
        expect(screen.explore()).toEqual(['post-0']);
        expect(screen.home()).toEqual(['post-7']);
        expect(screen.notice()?.message).toBe('Creator hidden');

        const { onUndo } = screen.notice()!;
        renderer.act(() => onUndo());
        await settle();
        expect(authState.api.undoFeedFeedback).toHaveBeenCalledWith({ feedbackType: 'hide_creator', creatorId: 'creator-2' });
        expect(screen.explore()).toEqual(['post-0', 'post-1', 'post-2']);
        expect(screen.home()).toEqual(['post-7', 'post-1']);
      } finally {
        renderer.act(() => screen.tree.unmount());
      }
    });

    it('leaves the post hidden and says so when the undo is refused', async () => {
      const screen = renderWithLanes();
      const errorHaptic = vi.spyOn(haptic, 'error');
      try {
        selectTileMenuRow(screen.list(), 'not-interested', 'post-1');
        await settle();
        authState.api.undoFeedFeedback.mockRejectedValueOnce(new Error('Network request failed'));
        vi.mocked(Alert.alert).mockClear();

        const { onUndo } = screen.notice()!;
        renderer.act(() => onUndo());
        await settle();
        expect(screen.explore()).toEqual(['post-0', 'post-2']);
        expect(errorHaptic).toHaveBeenCalledTimes(1);
        expect(Alert.alert).toHaveBeenCalledWith('Couldn’t undo', 'The post is still hidden. Check your connection and try again.');
      } finally {
        errorHaptic.mockRestore();
        renderer.act(() => screen.tree.unmount());
      }
    });

    it('undoes on the device alone when there is no session to send it from', async () => {
      const registeredUser = authState.user;
      authState.user = null;
      authState.identityUserId = null;
      const screen = renderWithLanes();
      /** The posts the grid draws once it reads its pages again. */
      const drawn = () => {
        queryState.pages = [...queryState.pages];
        renderer.act(() => screen.tree.update(<ShowcaseScreen />));
        return (screen.list().data as Array<{ id: string }>).map((card) => card.id);
      };
      try {
        selectTileMenuRow(screen.list(), 'not-interested', 'post-1');
        await settle();
        expect(screen.explore()).toEqual(['post-0', 'post-2']);
        // The device's own memory keeps it out of the pages it already had.
        expect(drawn()).not.toContain('post-1');

        const { onUndo } = screen.notice()!;
        renderer.act(() => onUndo());
        await settle();
        expect(authState.api.undoFeedFeedback).not.toHaveBeenCalled();
        expect(screen.explore()).toEqual(['post-0', 'post-1', 'post-2']);
        expect(drawn()).toContain('post-1');
      } finally {
        renderer.act(() => screen.tree.unmount());
        authState.user = registeredUser;
        authState.identityUserId = 'viewer-1';
      }
    });

    it('withdraws the notice when the choice could not be sent', async () => {
      authState.api.recordShowcaseFeedEvent.mockRejectedValueOnce(new Error('Network request failed'));
      const screen = renderWithLanes();
      try {
        selectTileMenuRow(screen.list(), 'not-interested', 'post-1');
        expect(screen.notice()?.message).toBe('Post hidden');
        await settle();
        expect(screen.notice()).toBeNull();
        // As before: the post is back, and the reader is told.
        expect(screen.explore()).toEqual(['post-0', 'post-1', 'post-2']);
      } finally {
        renderer.act(() => screen.tree.unmount());
      }
    });
  });

  // Product decision E2: Explore's only search entry is in the list header,
  // which scrolls away with the grid.
  it('keeps a compact search button at the top once the list header has scrolled off', () => {
    queryState.pages = [lanePage([{ id: 'post-1' }])];
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ShowcaseScreen />);
    });
    const compactSearch = () => tree!.root.findAll((node) => (
      String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Search creators, posts, and recipes'
    ));
    const scrollTo = (y: number) => {
      renderer.act(() => hostElement(tree!, 'flash-list').props.onScroll({ nativeEvent: { contentOffset: { x: 0, y } } }));
    };
    try {
      // Before the header is measured there is no telling where it is: it
      // counts as on screen.
      scrollTo(2000);
      expect(compactSearch()).toHaveLength(0);
      scrollTo(0);

      // The title row and chips, 106pt, start 12pt below the status bar.
      measureListHeader(tree!, 106);
      scrollTo(117);
      expect(compactSearch()).toHaveLength(0);
      scrollTo(118);
      expect(compactSearch()).toHaveLength(1);

      renderer.act(() => compactSearch()[0].props.onPress());
      expect(hostElement(tree!, 'explore-search-overlay').props.visible).toBe(true);

      // Back up, the header's own button is in view again: one entry at a time.
      scrollTo(60);
      expect(compactSearch()).toHaveLength(0);
    } finally {
      renderer.act(() => tree!.unmount());
    }
  });

  // Autoplay previews → Never keeps every tile on its poster, as Reduce Motion
  // does, without changing which tile the grid elects (product decision D3).
  it('keeps the play badge on an elected tile that Never holds on its poster', () => {
    const base = feedItem();
    queryState.pages = [{
      items: [{
        ...base,
        id: 'clip-1',
        // Drawn for real here, and the reel's copy of the post reads the body.
        body: '',
        category: 'video',
        mediaKind: 'video',
        mediaUrl: 'https://cdn.example.com/clip-1.mp4',
        mediaItems: [{
          ...base.mediaItems[0],
          id: 'clip-1:media',
          url: 'https://cdn.example.com/clip-1.mp4',
          previewUrl: 'https://cdn.example.com/clip-1.poster.jpg',
          mediaKind: 'video',
          contentType: 'video/mp4',
          feedStreamUrl: 'https://cdn.example.com/clip-1.teaser.mp4',
        }],
      }],
      pageInfo: { hasMore: false, nextOffset: null },
    }];
    const list = flashListProps();
    const store = createFeedVideoActivationStore();
    store.publish({ activeIds: ['clip-1'] });
    /** The corner play badges on the elected clip's tile under this choice. */
    const badges = (preference: AutoplayPreference) => {
      resetAutoplayPreferenceForTests(preference);
      const tile = renderAlone(
        <FeedVideoActivationContext.Provider value={store}>
          {list.renderItem({ item: list.data[0], index: 0, target: 'Cell' })}
        </FeedVideoActivationContext.Provider>
      );
      const count = tile.root.findAll((node) => String(node.type) === 'play-icon').length;
      renderer.act(() => tile.unmount());
      return count;
    };
    try {
      // Playing: no play control over a clip that is already playing.
      expect(badges('always')).toBe(0);
      expect(badges('wifi')).toBe(0);
      // Never: the same elected tile shows its poster, and the poster its badge.
      expect(badges('never')).toBe(1);
    } finally {
      resetAutoplayPreferenceForTests();
    }
  });
});

describe('partitionAspectRatiosByViewport', () => {
  const cards = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));

  it('applies a ratio at once only to a card past the last one on screen', () => {
    const { apply, hold } = partitionAspectRatiosByViewport(
      { a: 1.25, c: 0.5, e: 2, f: 0.75 },
      cards,
      { onScreenCardIds: new Set(['c', 'd']), lastViewableIndex: 3 },
    );

    expect(apply).toEqual({ e: 2, f: 0.75 });
    // c is on screen; a is above it, so its height would move c and d.
    expect(hold).toEqual({ a: 1.25, c: 0.5 });
  });

  it('keeps holding a card that left through the top, and releases it through the bottom', () => {
    const held = { c: 0.5 };

    expect(partitionAspectRatiosByViewport(held, cards, {
      onScreenCardIds: new Set(['e', 'f']),
      lastViewableIndex: 5,
    })).toEqual({ apply: {}, hold: { c: 0.5 } });
    expect(partitionAspectRatiosByViewport(held, cards, {
      onScreenCardIds: new Set(['a', 'b']),
      lastViewableIndex: 1,
    })).toEqual({ apply: { c: 0.5 }, hold: {} });
  });

  it('holds an off-screen card listed before the last one on screen', () => {
    // Masonry: a short card in one column scrolls off the top while a tall card
    // listed before it still shows in the other, so its index sits inside the
    // on-screen range while the card is above the screen.
    expect(partitionAspectRatiosByViewport({ c: 0.5 }, cards, {
      onScreenCardIds: new Set(['b', 'd']),
      lastViewableIndex: 3,
    })).toEqual({ apply: {}, hold: { c: 0.5 } });
  });

  it('holds a card on screen whatever its index says', () => {
    expect(partitionAspectRatiosByViewport({ e: 2 }, cards, {
      onScreenCardIds: new Set(['e']),
      lastViewableIndex: 3,
    })).toEqual({ apply: {}, hold: { e: 2 } });
  });

  it('holds everything until a card is known to be on screen', () => {
    expect(partitionAspectRatiosByViewport({ a: 1.25, f: 0.75 }, cards, {
      onScreenCardIds: new Set(),
      lastViewableIndex: -1,
    })).toEqual({ apply: {}, hold: { a: 1.25, f: 0.75 } });
  });

  it('holds a card the list no longer has', () => {
    expect(partitionAspectRatiosByViewport({ gone: 1 }, cards, {
      onScreenCardIds: new Set(['a']),
      lastViewableIndex: 0,
    })).toEqual({ apply: {}, hold: { gone: 1 } });
  });
});
