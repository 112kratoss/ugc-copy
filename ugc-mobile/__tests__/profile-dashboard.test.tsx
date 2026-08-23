// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Router mock
const routerState = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: routerState,
}));

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useScrollToTop: vi.fn(),
}));

// react-native mock
type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', {
      ...props,
      style: resolvePressableStyle(style),
    }, children),
  Text: ({ children, ...props }: MockProps) =>
    React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) =>
    React.createElement('view', props, children),
  ScrollView: ({ children, ...props }: MockProps) =>
    React.createElement('scrollview', props, children),
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  PanResponder: {
    create: () => ({ panHandlers: {} }),
  },
  TurboModuleRegistry: {
    get: () => null,
    getEnforcing: () => null,
  },
  Platform: {
    OS: 'ios',
    select: (obj: Record<string, unknown>) => obj.ios || obj.default,
  },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: MockProps & {
    data?: unknown[];
    ListHeaderComponent?: React.ReactNode;
    ListEmptyComponent?: React.ReactNode;
    renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
  }) => React.createElement(
    'flash-list',
    props,
    props.ListHeaderComponent,
    props.data?.length
      ? props.data.map((item, index) => props.renderItem?.({ item, index }))
      : props.ListEmptyComponent
  ),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: MockProps) =>
    React.createElement('blur-view', props, children),
}));

vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) =>
    React.createElement('linear-gradient', props, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => ({
  ChevronRight: (props: Record<string, unknown>) => React.createElement('chevron-right-icon', props),
  Crown: (props: Record<string, unknown>) => React.createElement('crown-icon', props),
  Gift: (props: Record<string, unknown>) => React.createElement('gift-icon', props),
  Heart: (props: Record<string, unknown>) => React.createElement('heart-icon', props),
  ImageIcon: (props: Record<string, unknown>) => React.createElement('image-icon', props),
  Pencil: (props: Record<string, unknown>) => React.createElement('pencil-icon', props),
  Play: (props: Record<string, unknown>) => React.createElement('play-icon', props),
  RefreshCw: (props: Record<string, unknown>) => React.createElement('refresh-cw-icon', props),
  Sparkles: (props: Record<string, unknown>) => React.createElement('sparkles-icon', props),
  Store: (props: Record<string, unknown>) => React.createElement('store-icon', props),
  UserRound: (props: Record<string, unknown>) => React.createElement('user-round-icon', props),
  Wallet: (props: Record<string, unknown>) => React.createElement('wallet-icon', props),
}));

vi.mock('@/components/feed-video-preview', () => ({
  FeedVideoPreview: (props: MockProps) => React.createElement('feed-video-preview', props),
}));

vi.mock('@/components/media-preview', () => ({
  StableMediaImage: (props: MockProps) => React.createElement('stable-media-image', props),
}));

vi.mock('@/components/fantasy-portal-art', () => ({
  FantasyPortalArt: (props: MockProps) => React.createElement('fantasy-portal-art', props),
}));

// Auth mock
const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'user@example.com' },
  credits: 100,
  api: {
    getProfile: vi.fn(),
    listGenerations: vi.fn(),
    listOwnerPosts: vi.fn(),
    getSavedMedia: vi.fn(),
    getShowcaseFeed: vi.fn(),
  },
}));

const queryState = vi.hoisted(() => ({
  profileData: { id: 'user-123', username: 'luna_dreams', displayName: 'Luna Dreams', avatarUrl: 'avatar.png' } as null | {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
  },
  profileError: null as Error | null,
  generations: [] as Array<Record<string, unknown>>,
  ownerPosts: [] as Array<Record<string, unknown>>,
  savedItems: [] as Array<Record<string, unknown>>,
  // Set to override the default single-page wrapping of the arrays above.
  generationPages: null as Array<Record<string, unknown>> | null,
  ownerPostPages: null as Array<Record<string, unknown>> | null,
  savedPages: null as Array<Record<string, unknown>> | null,
  generationsPageParam: undefined as unknown,
  ownerPostsPageParam: undefined as unknown,
  savedMediaPageParam: undefined as unknown,
  generationsHasNextPage: false,
  ownerPostsHasNextPage: false,
  savedMediaHasNextPage: false,
  generationsIsFetchingNextPage: false,
  ownerPostsIsFetchingNextPage: false,
  savedMediaIsFetchingNextPage: false,
  generationsIsFetched: false,
  generationsIsFetching: false,
  generationsIsStale: false,
  ownerPostsIsFetched: false,
  ownerPostsIsFetching: false,
  ownerPostsIsStale: false,
  savedMediaIsFetched: false,
  savedMediaIsFetching: false,
  savedMediaIsStale: false,
  refetchGenerations: vi.fn(),
  refetchOwnerPosts: vi.fn(),
  refetchSavedMedia: vi.fn(),
  fetchNextGenerations: vi.fn(() => Promise.resolve()),
  fetchNextOwnerPosts: vi.fn(() => Promise.resolve()),
  fetchNextSavedMedia: vi.fn(() => Promise.resolve()),
  setQueryData: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

// react-query mock
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === 'profile') {
      return {
        data: queryState.profileData,
        error: queryState.profileError,
        isLoading: false,
      };
    }
    return { data: null, isLoading: false };
  },
  useQueryClient: () => ({ setQueryData: queryState.setQueryData }),
  useInfiniteQuery: ({ enabled = true, queryKey, queryFn, initialPageParam }: {
    enabled?: boolean;
    queryKey: string[];
    queryFn?: (context: { pageParam: unknown }) => unknown;
    initialPageParam?: unknown;
  }) => {
    if (queryKey[0] === 'profile-generations') {
      if (enabled) {
        queryFn?.({
          pageParam: queryState.generationsPageParam === undefined
            ? initialPageParam
            : queryState.generationsPageParam,
        });
      }
      return {
        data: {
          pages: queryState.generationPages ?? [{ generations: queryState.generations }],
          pageParams: [initialPageParam],
        },
        fetchNextPage: queryState.fetchNextGenerations,
        hasNextPage: queryState.generationsHasNextPage,
        isFetchingNextPage: queryState.generationsIsFetchingNextPage,
        isFetched: queryState.generationsIsFetched,
        isFetching: queryState.generationsIsFetching,
        isLoading: false,
        isStale: queryState.generationsIsStale,
        refetch: queryState.refetchGenerations,
      };
    }
    if (queryKey[0] === 'profile-owner-posts') {
      if (enabled) {
        queryFn?.({
          pageParam: queryState.ownerPostsPageParam === undefined
            ? initialPageParam
            : queryState.ownerPostsPageParam,
        });
      }
      return {
        data: {
          pages: queryState.ownerPostPages ?? [{ posts: queryState.ownerPosts }],
          pageParams: [initialPageParam],
        },
        fetchNextPage: queryState.fetchNextOwnerPosts,
        hasNextPage: queryState.ownerPostsHasNextPage,
        isFetchingNextPage: queryState.ownerPostsIsFetchingNextPage,
        isFetched: queryState.ownerPostsIsFetched,
        isFetching: queryState.ownerPostsIsFetching,
        isLoading: false,
        isStale: queryState.ownerPostsIsStale,
        refetch: queryState.refetchOwnerPosts,
      };
    }
    if (queryKey[0] === 'profile-saved-media') {
      if (enabled) {
        queryFn?.({
          pageParam: queryState.savedMediaPageParam === undefined
            ? initialPageParam
            : queryState.savedMediaPageParam,
        });
      }
      return {
        data: {
          pages: queryState.savedPages ?? [{ items: queryState.savedItems }],
          pageParams: [initialPageParam],
        },
        fetchNextPage: queryState.fetchNextSavedMedia,
        hasNextPage: queryState.savedMediaHasNextPage,
        isFetchingNextPage: queryState.savedMediaIsFetchingNextPage,
        isFetched: queryState.savedMediaIsFetched,
        isFetching: queryState.savedMediaIsFetching,
        isLoading: false,
        isStale: queryState.savedMediaIsStale,
        refetch: queryState.refetchSavedMedia,
      };
    }
    return { data: undefined, isLoading: false };
  },
}));

import { ProfileDashboard } from '../components/profile-dashboard';

function findPressableByText(root: renderer.ReactTestInstance, text: string) {
  const textInstances = root.findAllByProps({ children: text });
  for (const textInstance of textInstances) {
    let current: renderer.ReactTestInstance | null = textInstance;
    while (current && String(current.type) !== 'pressable') {
      current = current.parent;
    }
    if (current) return current;
  }
  throw new Error(`No pressable containing text "${text}" was found`);
}

function findViewByTestId(root: renderer.ReactTestInstance, testID: string) {
  return root.findAll((node) => String(node.type) === 'view' && node.props.testID === testID);
}

describe('ProfileDashboard media tiles routing', () => {
  beforeEach(() => {
    routerState.push.mockClear();
    authState.api.listGenerations.mockClear();
    authState.api.listOwnerPosts.mockClear();
    queryState.profileData = { id: 'user-123', username: 'luna_dreams', displayName: 'Luna Dreams', avatarUrl: 'avatar.png' };
    queryState.profileError = null;
    queryState.generations = [
      {
        id: 'gen-1',
        status: 'succeeded',
        output_url: 'gen.mp4',
        preview_url: 'gen-poster.webp',
        previewUrl: 'gen-poster.webp',
        category: 'video',
        title: 'Cre',
        prompt: 'Prompt',
        linked_post_id: 'post-1',
      },
    ];
    queryState.ownerPosts = [
      {
        id: 'post-1',
        title: 'Post Title',
        createdAt: '2026-06-10T00:00:00Z',
        visibility: 'public',
        mediaUrl: 'post.png',
        mediaKind: 'image',
        mediaItems: [{
          id: 'post-1-media',
          url: 'post.png',
          previewUrl: 'post.preview.webp',
          mediaKind: 'image',
          gridReady: true,
        }],
        body: 'Post body',
        category: 'image',
      },
    ];
    queryState.savedItems = [
      {
        id: 'saved-1',
        mediaUrl: 'saved.png',
        mediaKind: 'image',
        mediaItems: [{
          id: 'saved-1-media',
          url: 'saved.png',
          previewUrl: 'saved.preview.webp',
          mediaKind: 'image',
          gridReady: true,
        }],
        title: 'Saved Title',
        creator: { name: 'Luna', username: 'luna' },
        isSaved: true,
        saveCount: 5,
      },
    ];
    queryState.generationsIsFetched = false;
    queryState.generationsIsFetching = false;
    queryState.generationsIsStale = false;
    queryState.ownerPostsIsFetched = false;
    queryState.ownerPostsIsFetching = false;
    queryState.ownerPostsIsStale = false;
    queryState.savedMediaIsFetched = false;
    queryState.savedMediaIsFetching = false;
    queryState.savedMediaIsStale = false;
    queryState.refetchGenerations.mockClear();
    queryState.refetchOwnerPosts.mockClear();
    queryState.refetchSavedMedia.mockClear();
    queryState.generationPages = null;
    queryState.ownerPostPages = null;
    queryState.savedPages = null;
    queryState.generationsPageParam = undefined;
    queryState.ownerPostsPageParam = undefined;
    queryState.savedMediaPageParam = undefined;
    queryState.generationsHasNextPage = false;
    queryState.ownerPostsHasNextPage = false;
    queryState.savedMediaHasNextPage = false;
    queryState.generationsIsFetchingNextPage = false;
    queryState.ownerPostsIsFetchingNextPage = false;
    queryState.savedMediaIsFetchingNextPage = false;
    queryState.fetchNextGenerations.mockClear();
    queryState.fetchNextOwnerPosts.mockClear();
    queryState.fetchNextSavedMedia.mockClear();
    queryState.setQueryData.mockClear();
    authState.api.getSavedMedia.mockClear();
  });

  it('routes to /viewer with correct source and initialId for Saved tiles', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    // Saved tab is selected by default. Find the tile.
    const tile = tree!.root.findByProps({
      accessibilityLabel: 'Saved, Saved Title, 5 likes',
    });

    // The tile hands its rectangle to the viewer before navigating, which is
    // one microtask; the route it lands on is what matters here.
    await renderer.act(async () => {
      tile.props.onPress();
      await Promise.resolve();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/viewer',
      params: {
        source: 'profile-saved',
        initialId: 'saved-1',
      },
    });
  });

  it('opens a saved text-only post in the same dedicated viewer as Home', () => {
    queryState.savedItems = [{
      id: 'saved-text',
      mediaUrl: null,
      mediaKind: null,
      mediaItems: [],
      title: 'Saved text',
      body: 'A saved written post.',
      category: 'text',
      postFormat: 'text',
      creator: { name: 'Luna', username: 'luna' },
      isSaved: true,
      saveCount: 7,
    }];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    const tile = tree!.root.findByProps({
      accessibilityLabel: 'Saved, Saved text, 7 likes',
    });
    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith('/post/saved-text?source=profile-saved');
  });

  it('opens an owner text-only post in the shared viewer through the owner source', () => {
    queryState.ownerPosts = [{
      id: 'private-text',
      title: 'Private note',
      createdAt: '2026-06-10T00:00:00Z',
      visibility: 'private',
      mediaUrl: null,
      mediaKind: null,
      mediaItems: [],
      body: 'A private written post.',
      category: 'text',
      postFormat: 'text',
      bundle: null,
      commentCount: 0,
    }];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Posts" />);
    });

    const tile = tree!.root.findByProps({
      accessibilityLabel: 'Post, Private note',
    });
    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith('/post/private-text?source=profile-posts');
  });

  it('opens the Credits purchase screen from the Credits card', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    const creditsCard = findPressableByText(tree!.root, 'Credits');
    expect(creditsCard.props.accessibilityRole).toBe('button');
    expect(creditsCard.findAll((node) => String(node.type) === 'chevron-right-icon')).toHaveLength(1);

    renderer.act(() => {
      creditsCard.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith('/pricing');
  });

  it('opens Seller Dashboard from the Wallet card', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    const walletCard = findPressableByText(tree!.root, 'Wallet');
    expect(walletCard.props.accessibilityRole).toBe('button');
    expect(walletCard.findAll((node) => String(node.type) === 'chevron-right-icon')).toHaveLength(1);

    renderer.act(() => {
      walletCard.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith('/seller-dashboard');
  });

  it('keeps Seller Dashboard routed to the seller earnings screen', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    const sellerDashboard = findPressableByText(tree!.root, 'Seller Dashboard');
    renderer.act(() => {
      sellerDashboard.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith('/seller-dashboard');
  });

  it('routes to the profile card feed with correct source and initialId for Creations tiles', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    // Select Creations tab
    const creationsTab = findPressableByText(tree!.root, 'Creations');
    renderer.act(() => {
      creationsTab.props.onPress();
    });

    // Find the Creations tile.
    const tile = tree!.root.findByProps({
      accessibilityLabel: 'Creation, Cre, Linked post',
    });

    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/profile-media-feed',
      params: {
        source: 'profile-creations',
        initialId: 'gen-1',
      },
    });
  });

  it('requests active non-archived generations for the Profile Creations grid', () => {
    renderer.act(() => {
      renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    expect(authState.api.listGenerations).toHaveBeenCalledWith(false, { limit: 24 });
  });

  it('requests active non-archived owner posts for the Profile Posts grid', () => {
    renderer.act(() => {
      renderer.create(<ProfileDashboard initialTab="Posts" />);
    });

    expect(authState.api.listOwnerPosts).toHaveBeenCalledWith({
      includeArchived: false,
      includeSummary: true,
      limit: 24,
      offset: 0,
      visibility: 'all',
    });
  });

  it('renders every grid-ready creation instead of capping the grid', () => {
    queryState.generations = Array.from({ length: 20 }, (_, index) => ({
      id: `gen-${index}`,
      status: 'succeeded',
      output_url: 'gen.mp4',
      preview_url: 'gen-poster.webp',
      previewUrl: 'gen-poster.webp',
      category: 'video',
      title: 'Cre',
      prompt: 'Prompt',
    }));

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    const list = tree!.root.find((node) => String(node.type) === 'flash-list');
    expect(list.props.data).toHaveLength(20);
  });

  it('pages each tab with the cursor or offset the previous page reported', () => {
    queryState.generationsPageParam = '24';
    queryState.ownerPostsPageParam = 24;
    queryState.savedMediaPageParam = 24;
    // Lets the two background tabs turn on so all three queryFns run.
    queryState.generationsIsFetched = true;

    renderer.act(() => {
      renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    expect(authState.api.listGenerations).toHaveBeenCalledWith(false, { cursor: '24', limit: 24 });
    expect(authState.api.listOwnerPosts).toHaveBeenCalledWith({
      includeArchived: false,
      includeSummary: false,
      limit: 24,
      offset: 24,
      visibility: 'all',
    });
    expect(authState.api.getSavedMedia).toHaveBeenCalledWith({ limit: 24, offset: 24 });
  });

  it('asks for the next page when the grid reaches its end', () => {
    queryState.generationsHasNextPage = true;

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    const list = tree!.root.find((node) => String(node.type) === 'flash-list');
    expect(list.props.onEndReachedThreshold).toBe(0.32);

    renderer.act(() => {
      list.props.onEndReached();
    });

    expect(queryState.fetchNextGenerations).toHaveBeenCalledTimes(1);
  });

  it('collapses repeated end-of-grid events into a single page request', () => {
    queryState.generationsHasNextPage = true;

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    const list = tree!.root.find((node) => String(node.type) === 'flash-list');
    renderer.act(() => {
      list.props.onEndReached();
      list.props.onEndReached();
      list.props.onEndReached();
    });

    expect(queryState.fetchNextGenerations).toHaveBeenCalledTimes(1);
  });

  it('keeps paging after a page that adds no grid-ready tiles', async () => {
    // The server filters rows after cutting the page, so a page can arrive with nothing
    // renderable. Paging must not latch shut when the tile count fails to move — guarding on
    // item count instead of page count would deadlock here.
    const startedAt = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt);

    try {
      queryState.generationsHasNextPage = true;
      queryState.generationPages = [{ generations: [] }];

      let tree: renderer.ReactTestRenderer | undefined;
      // Async act so the in-flight guard's promise settles before the next attempt.
      await renderer.act(async () => {
        tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
      });

      const callsAfterMount = queryState.fetchNextGenerations.mock.calls.length;
      expect(callsAfterMount).toBeGreaterThan(0);

      // A second page landed and still produced zero tiles.
      queryState.generationPages = [{ generations: [] }, { generations: [] }];
      nowSpy.mockReturnValue(startedAt + 5000);
      await renderer.act(async () => {
        tree!.update(<ProfileDashboard initialTab="Creations" />);
      });

      const list = tree!.root.find((node) => String(node.type) === 'flash-list');
      await renderer.act(async () => {
        list.props.onEndReached();
      });

      expect(queryState.fetchNextGenerations.mock.calls.length).toBeGreaterThan(callsAfterMount);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('shows a footer loader only while another page is in flight', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });
    expect(tree!.root.find((node) => String(node.type) === 'flash-list').props.ListFooterComponent).toBeNull();

    queryState.generationsIsFetchingNextPage = true;
    renderer.act(() => {
      tree!.update(<ProfileDashboard initialTab="Creations" />);
    });
    expect(tree!.root.find((node) => String(node.type) === 'flash-list').props.ListFooterComponent).not.toBeNull();
  });

  it('marks a hero stat as partial while more pages remain', () => {
    queryState.savedMediaHasNextPage = true;

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    expect(tree!.root.findAllByProps({ children: '1+' }).length).toBeGreaterThan(0);
  });

  it('collapses a tab back to one page before refreshing it', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    const refresh = tree!.root.findByProps({ accessibilityLabel: 'Refresh media' });
    renderer.act(() => {
      refresh.props.onPress();
    });

    expect(queryState.setQueryData).toHaveBeenCalledWith(
      ['profile-saved-media', 'user-123'],
      expect.any(Function)
    );
    expect(queryState.refetchSavedMedia).toHaveBeenCalled();
  });

  it('does not refetch fresh Profile media just because the tab is focused', () => {
    renderer.act(() => {
      renderer.create(<ProfileDashboard />);
    });

    expect(queryState.refetchGenerations).not.toHaveBeenCalled();
    expect(queryState.refetchOwnerPosts).not.toHaveBeenCalled();
    expect(queryState.refetchSavedMedia).not.toHaveBeenCalled();
  });

  it('refreshes only the visible stale Profile media tab', () => {
    queryState.savedMediaIsStale = true;

    renderer.act(() => {
      renderer.create(<ProfileDashboard />);
    });

    expect(queryState.refetchGenerations).not.toHaveBeenCalled();
    expect(queryState.refetchOwnerPosts).not.toHaveBeenCalled();
    expect(queryState.refetchSavedMedia).toHaveBeenCalledOnce();
  });

  it('defers inactive Profile datasets until the visible dataset settles', () => {
    renderer.act(() => {
      renderer.create(<ProfileDashboard />);
    });

    expect(authState.api.listGenerations).not.toHaveBeenCalled();
    expect(authState.api.listOwnerPosts).not.toHaveBeenCalled();
  });

  it('starts on the Posts tab when requested by route params', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Posts" />);
    });

    expect(tree!.root.findByProps({
      accessibilityLabel: 'Post, Post Title',
    })).toBeTruthy();
    expect(findViewByTestId(tree!.root, 'profile-saved-overlay')).toHaveLength(0);
    expect(findViewByTestId(tree!.root, 'profile-minimal-overlay')).toHaveLength(1);
  });

  it('highlights the newly created post tile on the Posts tab', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Posts" highlightedPostId="post-1" />);
    });

    const highlightedTiles = tree!.root.findAll(
      (node) => String(node.type) === 'view' && node.props.testID === 'profile-highlighted-post-tile'
    );
    expect(highlightedTiles).toHaveLength(1);
  });

  it('uses a virtualized three-column grid without autoplaying profile videos', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    const creationsTab = findPressableByText(tree!.root, 'Creations');
    renderer.act(() => {
      creationsTab.props.onPress();
    });

    const list = tree!.root.find((node) => String(node.type) === 'flash-list');
    expect(list.props.numColumns).toBe(3);
    expect(list.props.removeClippedSubviews).toBe(false);
    expect(tree!.root.findAll((node) => String(node.type) === 'feed-video-preview')).toHaveLength(0);
  });

  it('renders creation videos as stable poster images without mounting a player', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    const creationsTab = findPressableByText(tree!.root, 'Creations');
    renderer.act(() => {
      creationsTab.props.onPress();
    });

    const posterImages = tree!.root.findAll((node) =>
      String(node.type) === 'stable-media-image' && node.props.url === 'gen-poster.webp'
    );
    expect(posterImages).toHaveLength(1);
    expect(findViewByTestId(tree!.root, 'profile-video-preview-fallback')).toHaveLength(0);
    expect(tree!.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(0);
  });

  it('renders motion workflow outputs as stable video posters', () => {
    queryState.generations = [
      {
        id: 'motion-with-poster',
        status: 'succeeded',
        output_url: 'motion.mp4',
        preview_url: 'motion-poster.webp',
        previewUrl: 'motion-poster.webp',
        category: 'video',
        creationMode: 'motion',
        media: {
          id: 'motion-with-poster',
          kind: 'video',
          url: 'motion.mp4',
          previewUrl: 'motion-poster.webp',
          thumbhash: 'motion-thumbhash',
          cacheKey: 'motion.preview.hash.webp',
          expiresAt: null,
          width: null,
          height: null,
          durationSeconds: 5,
          status: 'ready',
          gridReady: true,
        },
        title: 'Motion one',
        prompt: 'Motion prompt',
      },
    ];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    expect(findViewByTestId(tree!.root, 'profile-video-preview-fallback')).toHaveLength(0);
    expect(tree!.root.findAll((node) =>
      String(node.type) === 'stable-media-image' && node.props.url === 'motion-poster.webp'
    )).toHaveLength(1);
  });

  it('hides creation images while their derivative is pending', () => {
    queryState.generations = [
      {
        id: 'slow-image',
        status: 'succeeded',
        output_url: 'slow-image.jpg',
        preview_url: null,
        category: 'image',
        title: 'Slow image',
        prompt: 'Slow image prompt',
      },
    ];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    expect(findViewByTestId(tree!.root, 'profile-art-preview-fallback')).toHaveLength(0);
    expect(tree!.root.findAll((node) =>
      String(node.type) === 'stable-media-image' && node.props.url === 'slow-image.jpg'
    )).toHaveLength(0);
  });

  it('hides non-ready creations from the Profile grid', () => {
    queryState.generations = [
      {
        id: 'ready-image',
        status: 'succeeded',
        output_url: 'ready-image.jpg',
        preview_url: 'ready-image.preview.webp',
        category: 'image',
        title: 'Ready image',
        prompt: 'Ready image prompt',
      },
      {
        id: 'processing-video',
        status: 'processing',
        output_url: 'processing.mp4',
        category: 'video',
        title: 'Processing video',
        prompt: 'Still rendering',
      },
      {
        id: 'failed-image',
        status: 'failed',
        output_url: 'failed.jpg',
        category: 'image',
        title: 'Failed image',
        prompt: 'Failed prompt',
      },
      {
        id: 'archived-image',
        status: 'succeeded',
        output_url: 'archived.jpg',
        category: 'image',
        title: 'Archived image',
        prompt: 'Archived prompt',
        archived_at: '2026-06-11T00:00:00Z',
      },
      {
        id: 'missing-media',
        status: 'succeeded',
        output_url: null,
        category: 'image',
        title: 'Missing media',
        prompt: 'Missing prompt',
      },
    ];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    expect(tree!.root.findByProps({ accessibilityLabel: 'Creation, Ready image, Not posted' })).toBeTruthy();
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Creation, Processing video, Not posted' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Creation, Failed image, Not posted' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Creation, Archived image, Not posted' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Creation, Missing media, Not posted' })).toHaveLength(0);
  });

  it('hides creation videos until a poster is ready', () => {
    queryState.generations = [
      {
        id: 'video-without-poster',
        status: 'succeeded',
        output_url: 'video-without-poster.mp4',
        preview_url: null,
        previewUrl: null,
        category: 'video',
        title: 'Video without poster',
        prompt: 'Video prompt',
      },
    ];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    expect(findViewByTestId(tree!.root, 'profile-video-preview-fallback')).toHaveLength(0);
    expect(tree!.root.findAll((node) => String(node.type) === 'feed-video-preview')).toHaveLength(0);
    expect(tree!.root.findAll((node) =>
      String(node.type) === 'image' && node.props.source?.uri === 'video-without-poster.mp4'
    )).toHaveLength(0);
  });

  it('renders ready text creations in the Profile grid', () => {
    queryState.generations = [
      {
        id: 'text-ready',
        status: 'succeeded',
        output_url: null,
        category: 'text',
        title: 'Caption set',
        prompt: 'Write three captions for a product launch.',
      },
    ];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    expect(tree!.root.findByProps({ accessibilityLabel: 'Creation, Caption set, Not posted' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: 'Write three captions for a product launch.' })).toBeTruthy();
  });

  it('hides archived and media-less non-text posts from the Profile grid', () => {
    queryState.ownerPosts = [
      {
        id: 'ready-post',
        title: 'Ready media post',
        createdAt: '2026-06-10T00:00:00Z',
        visibility: 'public',
        mediaUrl: 'ready-post.png',
        mediaKind: 'image',
        mediaItems: [{
          id: 'ready-post-media',
          url: 'ready-post.png',
          previewUrl: 'ready-post.preview.webp',
          mediaKind: 'image',
          gridReady: true,
        }],
        body: 'Post body',
        category: 'image',
        postFormat: 'media',
      },
      {
        id: 'text-post',
        title: 'Reusable note',
        createdAt: '2026-06-10T00:00:00Z',
        visibility: 'public',
        mediaUrl: null,
        mediaKind: null,
        body: 'A reusable note for framing a product post.',
        category: 'text',
        postFormat: 'text',
      },
      {
        id: 'empty-media-post',
        title: 'Empty media post',
        createdAt: '2026-06-10T00:00:00Z',
        visibility: 'public',
        mediaUrl: null,
        mediaKind: null,
        body: '',
        prompt: '',
        description: '',
        category: 'image',
        postFormat: 'media',
      },
      {
        id: 'archived-post',
        title: 'Archived post',
        createdAt: '2026-06-10T00:00:00Z',
        visibility: 'public',
        mediaUrl: 'archived-post.png',
        mediaKind: 'image',
        body: 'Archived body',
        category: 'image',
        postFormat: 'media',
        archivedAt: '2026-06-11T00:00:00Z',
      },
    ];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Posts" />);
    });

    expect(tree!.root.findByProps({ accessibilityLabel: 'Post, Ready media post' })).toBeTruthy();
    expect(tree!.root.findByProps({ accessibilityLabel: 'Post, Reusable note' })).toBeTruthy();
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Post, Empty media post' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Post, Archived post' })).toHaveLength(0);
  });

  it('renders text posts as intentional text preview tiles', () => {
    queryState.ownerPosts = [
      {
        id: 'text-post',
        title: 'Reusable note',
        createdAt: '2026-06-10T00:00:00Z',
        visibility: 'public',
        mediaUrl: null,
        mediaKind: null,
        body: 'A reusable note for framing a product post.',
        category: 'text',
        postFormat: 'text',
      },
    ];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Posts" />);
    });

    expect(findViewByTestId(tree!.root, 'profile-text-preview')).toHaveLength(1);
    expect(tree!.root.findByProps({ children: 'Text post' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: 'A reusable note for framing a product post.' })).toBeTruthy();
  });

  it('keeps Saved feed cards but makes Creations and Posts grid tiles minimal', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    expect(findViewByTestId(tree!.root, 'profile-saved-overlay')).toHaveLength(1);

    const creationsTab = findPressableByText(tree!.root, 'Creations');
    renderer.act(() => {
      creationsTab.props.onPress();
    });
    expect(findViewByTestId(tree!.root, 'profile-minimal-overlay')).toHaveLength(1);
    expect(tree!.root.findAllByProps({ children: 'Cre' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ children: 'Ready' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ children: 'Public post' })).toHaveLength(0);

    const postsTab = findPressableByText(tree!.root, 'Posts');
    renderer.act(() => {
      postsTab.props.onPress();
    });
    expect(findViewByTestId(tree!.root, 'profile-minimal-overlay')).toHaveLength(1);
    expect(tree!.root.findAllByProps({ children: 'Post Title' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ children: 'Public' })).toHaveLength(0);
  });

  it('routes to the profile card feed with correct source and initialId for Posts tiles', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    // Select Posts tab
    const postsTab = findPressableByText(tree!.root, 'Posts');
    renderer.act(() => {
      postsTab.props.onPress();
    });

    // Find the Posts tile.
    const tile = tree!.root.findByProps({
      accessibilityLabel: 'Post, Post Title',
    });

    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/profile-media-feed',
      params: {
        source: 'profile-posts',
        initialId: 'post-1',
      },
    });
  });

  it('does not show the profile error banner when cached profile data is available', () => {
    queryState.profileError = new Error('Unauthorized');

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    expect(tree!.root.findAllByProps({ children: 'Could not load profile' })).toHaveLength(0);
    expect(tree!.root.findByProps({ children: 'Luna Dreams' })).toBeTruthy();
  });

  it('shows the profile error banner when no profile data is available', () => {
    queryState.profileData = null;
    queryState.profileError = new Error('Unauthorized');

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    expect(tree!.root.findByProps({ children: 'Could not load profile' })).toBeTruthy();
  });
});
