(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { Image } from 'expo-image';
import { Alert } from 'react-native';
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
    recordShowcaseFeedEvent: vi.fn(() => Promise.resolve()),
    reportPost: vi.fn(),
    reportUser: vi.fn(),
  },
  identityUserId: 'viewer-1' as string | null,
  user: { id: 'viewer-1' } as { id: string } | null,
}));

// One client for every render, as the real provider gives.
const queryClient = vi.hoisted(() => ({
  getQueriesData: vi.fn(() => []),
  invalidateQueries: vi.fn(() => Promise.resolve()),
  setQueriesData: vi.fn(),
  setQueryData: vi.fn(),
}));

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

import ShowcaseScreen, { partitionAspectRatiosByViewport } from '../app/(tabs)/showcase';
import { SHOWCASE_ONSCREEN_VIEWABILITY, resetAnonymousShowcaseFeedRemovalsForTests } from '../lib/showcase-feed-events';

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

/** Picks a row from the first tile's ⋮ menu. */
function selectTileMenuRow(list: ListProps, rowId: string) {
  const pin = pinProps(list, 0);
  const row = pin.feedbackMenu(pin.card.item).sections
    .flatMap((section) => section.items)
    .find((item) => item.id === rowId);
  if (!row?.onSelect) throw new Error(`The tile menu has no ${rowId} row.`);
  const select = row.onSelect;
  renderer.act(() => select());
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
