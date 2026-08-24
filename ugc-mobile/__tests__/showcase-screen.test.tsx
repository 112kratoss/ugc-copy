(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const queryState = vi.hoisted(() => ({
  fetchNextPage: vi.fn(() => Promise.resolve()),
  filter: 'all',
  hasNextPage: false,
  isFetchNextPageError: false,
  isFetching: false,
  isFetchingNextPage: false,
  pages: [{ items: [], pageInfo: { hasMore: false, nextOffset: null } }] as Array<Record<string, unknown>>,
  refetch: vi.fn(() => Promise.resolve()),
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
    error: null,
    fetchNextPage: queryState.fetchNextPage,
    hasNextPage: queryState.hasNextPage,
    isFetchNextPageError: queryState.isFetchNextPageError,
    isFetching: queryState.isFetching,
    isFetchingNextPage: queryState.isFetchingNextPage,
    isLoading: false,
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
  useLocalSearchParams: () => ({ filter: queryState.filter }),
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

vi.mock('lucide-react-native', () => ({
  ImageIcon: (props: MockProps) => React.createElement('image-icon', props),
  MoreVertical: (props: MockProps) => React.createElement('more-vertical-icon', props),
  Play: (props: MockProps) => React.createElement('play-icon', props),
  RefreshCw: (props: MockProps) => React.createElement('refresh-icon', props),
  X: (props: MockProps) => React.createElement('x-icon', props),
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

vi.mock('@/components/ui', () => ({
  CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/components/workspace-side-menu-gesture-layer', () => ({
  WorkspaceSideMenuGestureLayer: ({ children, ...props }: MockProps) =>
    React.createElement('workspace-side-menu-gesture-layer', props, children),
}));

vi.mock('@/components/reveal', () => ({
  Reveal: ({ children, ...props }: MockProps) => React.createElement('reveal', props, children),
}));

vi.mock('@/components/skeleton', () => ({
  SkeletonBone: (props: MockProps) => React.createElement('skeleton-bone', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    api: {
      blockUser: vi.fn(),
      recordShowcaseFeedEvent: vi.fn(() => Promise.resolve()),
      reportPost: vi.fn(),
      reportUser: vi.fn(),
    },
    user: { id: 'viewer-1' },
  }),
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

describe('Showcase screen', () => {
  beforeEach(() => {
    queryState.fetchNextPage.mockClear();
    queryState.refetch.mockClear();
    queryState.filter = 'all';
    queryState.hasNextPage = false;
    queryState.isFetchNextPageError = false;
    queryState.isFetching = false;
    queryState.isFetchingNextPage = false;
    queryState.pages = [{ items: [], pageInfo: { hasMore: false, nextOffset: null } }];
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
