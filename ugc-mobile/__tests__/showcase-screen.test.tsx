(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { Image } from 'expo-image';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const queryState = vi.hoisted(() => ({
  error: null as Error | null,
  fetchNextPage: vi.fn(() => Promise.resolve()),
  filter: 'all',
  hasNextPage: false,
  isFetchNextPageError: false,
  isFetching: false,
  isFetchingNextPage: false,
  isLoading: false,
  pages: [{ items: [], pageInfo: { hasMore: false, nextOffset: null } }] as Array<Record<string, unknown>>,
  refetch: vi.fn(() => Promise.resolve()),
  tool: undefined as string | undefined,
}));

// One object for every render, as the real context provides: a fresh `user`
// per render would rebuild the grid's cards each time.
const authState = vi.hoisted(() => ({
  api: {
    blockUser: vi.fn(),
    recordShowcaseFeedEvent: vi.fn(() => Promise.resolve()),
    reportPost: vi.fn(),
    reportUser: vi.fn(),
  },
  user: { id: 'viewer-1' },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: MockProps) => React.createElement('flash-list', props, props.ListFooterComponent as React.ReactNode),
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: () => ({
    data: {
      pages: queryState.pages,
      pageParams: [{ offset: 0 }],
    },
    error: queryState.error,
    fetchNextPage: queryState.fetchNextPage,
    hasNextPage: queryState.hasNextPage,
    isFetchNextPageError: queryState.isFetchNextPageError,
    isFetching: queryState.isFetching,
    isFetchingNextPage: queryState.isFetchingNextPage,
    isLoading: queryState.isLoading,
    isRefetching: false,
    refetch: queryState.refetch,
  }),
  useQueryClient: () => ({
    getQueriesData: vi.fn(() => []),
    invalidateQueries: vi.fn(() => Promise.resolve()),
    setQueriesData: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock('expo-router', () => ({
  router: {
    push: vi.fn(),
    setParams: vi.fn(),
  },
  useLocalSearchParams: () => ({ filter: queryState.filter, tool: queryState.tool }),
}));

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useScrollToTop: vi.fn(),
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
  usePressMotion: () => ({
    animatedStyle: {},
    onPressIn: vi.fn(),
    onPressOut: vi.fn(),
  }),
}));

import ShowcaseScreen from '../app/(tabs)/showcase';

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

describe('Showcase screen', () => {
  beforeEach(() => {
    vi.mocked(Image.loadAsync).mockClear();
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
});
