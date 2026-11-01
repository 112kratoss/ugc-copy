// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Router mock
const routerState = vi.hoisted(() => ({
  push: vi.fn(),
}));

const shareState = vi.hoisted(() => ({
  share: vi.fn(async () => ({ action: 'sharedAction' })),
}));

vi.mock('expo-router', () => ({
  router: routerState,
}));

// Profile is out of focus while a screen it opened (the reel) is in front.
const navigationState = vi.hoisted(() => ({ focused: true }));

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => navigationState.focused,
  useScrollToTop: vi.fn(),
}));

// The run this device started and is still watching for, if any.
const activeRunState = vi.hoisted(() => ({
  record: null as null | { generationId: string | null; tool: 'image' | 'video' | 'motion' },
}));

vi.mock('@/lib/active-generation-record', () => ({
  loadActiveGenerationRecord: vi.fn(async () => activeRunState.record),
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
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => undefined }),
  },
  Platform: {
    OS: 'ios',
    select: (obj: Record<string, unknown>) => obj.ios || obj.default,
  },
  Share: {
    share: (...args: unknown[]) => shareState.share(...(args as [])),
    sharedAction: 'sharedAction',
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
      : props.ListEmptyComponent,
    props.ListFooterComponent as React.ReactNode
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
  AtSign: (props: Record<string, unknown>) => React.createElement('at-sign-icon', props),
  ChevronRight: (props: Record<string, unknown>) => React.createElement('chevron-right-icon', props),
  CircleAlert: (props: Record<string, unknown>) => React.createElement('circle-alert-icon', props),
  Crown: (props: Record<string, unknown>) => React.createElement('crown-icon', props),
  Gift: (props: Record<string, unknown>) => React.createElement('gift-icon', props),
  Globe: (props: Record<string, unknown>) => React.createElement('globe-icon', props),
  Heart: (props: Record<string, unknown>) => React.createElement('heart-icon', props),
  ImageIcon: (props: Record<string, unknown>) => React.createElement('image-icon', props),
  Images: (props: Record<string, unknown>) => React.createElement('images-icon', props),
  LockKeyhole: (props: Record<string, unknown>) => React.createElement('lock-keyhole-icon', props),
  Pencil: (props: Record<string, unknown>) => React.createElement('pencil-icon', props),
  Play: (props: Record<string, unknown>) => React.createElement('play-icon', props),
  RefreshCw: (props: Record<string, unknown>) => React.createElement('refresh-cw-icon', props),
  Sparkles: (props: Record<string, unknown>) => React.createElement('sparkles-icon', props),
  UserRound: (props: Record<string, unknown>) => React.createElement('user-round-icon', props),
  Wallet: (props: Record<string, unknown>) => React.createElement('wallet-icon', props),
}));

vi.mock('@/components/feed-video-preview', () => ({
  FeedVideoPreview: (props: MockProps) => React.createElement('feed-video-preview', props),
}));

vi.mock('@/components/media-preview', () => ({
  StableMediaImage: (props: MockProps) => React.createElement('stable-media-image', props),
}));

// Auth mock
const authState = vi.hoisted(() => ({
  // Nullable: the signed-out suite below clears it.
  user: { id: 'user-123', email: 'user@example.com' } as null | { id: string; email: string },
  identityUserId: 'user-123' as string | null,
  // A guest holds an identity and no account: `user` stays null for it.
  isGuest: false,
  credits: 100 as number | null,
  // When this run last set `credits` (epoch ms); null when it never has.
  creditsUpdatedAt: null as number | null,
  api: {
    getProfile: vi.fn(),
    listGenerations: vi.fn(),
    listOwnerPosts: vi.fn(),
    getSavedMedia: vi.fn(),
    getShowcaseFeed: vi.fn(),
    shareCreatorProfile: vi.fn(async () => ({ success: true })),
    getCreatorPayoutState: vi.fn(),
  },
}));

type PayoutQueryState = {
  data: undefined | { availableUsd: string };
  isError: boolean;
  isPending: boolean;
};

// The payout state before it answers: what every suite sees unless it says otherwise.
const PAYOUT_PENDING: PayoutQueryState = { data: undefined, isError: false, isPending: true };

const queryState = vi.hoisted(() => ({
  profileData: { id: 'user-123', username: 'luna-dreams', displayName: 'Luna Dreams', avatarUrl: 'avatar.png' } as null | {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
  },
  profileError: null as Error | null,
  // React Query's `dataUpdatedAt` for the profile: when it last answered.
  profileDataUpdatedAt: 0,
  // The Creations query as the screen last asked for it.
  generationsQuery: null as null | { queryKey: unknown[]; enabled: boolean },
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
  generationsIsFetchNextPageError: false,
  ownerPostsIsFetchNextPageError: false,
  savedMediaIsFetchNextPageError: false,
  generationsIsFetched: false,
  generationsIsFetching: false,
  generationsIsStale: false,
  generationsDataUpdatedAt: 0,
  ownerPostsIsFetched: false,
  ownerPostsIsFetching: false,
  ownerPostsIsStale: false,
  savedMediaIsFetched: false,
  savedMediaIsFetching: false,
  savedMediaIsStale: false,
  refetchGenerations: vi.fn(() => Promise.resolve()),
  refetchOwnerPosts: vi.fn(() => Promise.resolve()),
  refetchSavedMedia: vi.fn(() => Promise.resolve()),
  fetchNextGenerations: vi.fn(() => Promise.resolve()),
  fetchNextOwnerPosts: vi.fn(() => Promise.resolve()),
  fetchNextSavedMedia: vi.fn(() => Promise.resolve()),
  // The Failed scope's own query (`status=failed`) as the screen last asked for
  // it, and its pages: null until it has answered.
  failedQuery: null as null | { queryKey: unknown[]; enabled: boolean; queryFn?: (context: { pageParam: unknown }) => unknown },
  failedPages: null as Array<Record<string, unknown>> | null,
  // Every render's ask, so a query turned on for a single render shows up.
  failedQueryRenders: [] as Array<{ queryKey: unknown[]; enabled: boolean }>,
  failedHasNextPage: false,
  failedIsLoading: false,
  failedIsStale: false,
  fetchNextFailed: vi.fn(() => Promise.resolve()),
  refetchFailed: vi.fn(() => Promise.resolve()),
  invalidateQueries: vi.fn(() => Promise.resolve()),
  getQueryData: vi.fn((): unknown => undefined),
  setQueryData: vi.fn(),
  // The payout state as the Wallet card last asked for it, and its answer.
  payoutQueryOptions: null as null | { queryKey: unknown[]; enabled?: boolean; queryFn?: unknown },
  payoutQuery: { data: undefined, isError: false, isPending: true } as PayoutQueryState,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

// The offer's own behaviour is covered with a real query client in
// media-creation-screen.test.tsx; here only where the dashboard places it.
vi.mock('@/components/push-offer-card', () => ({
  PushOfferCard: (props: Record<string, unknown>) => React.createElement('push-offer-card', props),
}));

// react-query mock
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean; queryFn?: unknown }) => {
    const { queryKey } = options;
    if (queryKey[0] === 'profile') {
      return {
        data: queryState.profileData,
        dataUpdatedAt: queryState.profileDataUpdatedAt,
        error: queryState.profileError,
        isLoading: false,
      };
    }
    if (queryKey[0] === 'creator-payouts') {
      queryState.payoutQueryOptions = options;
      return queryState.payoutQuery;
    }
    return { data: null, isLoading: false };
  },
  useQueryClient: () => ({
    setQueryData: queryState.setQueryData,
    invalidateQueries: queryState.invalidateQueries,
    getQueryData: queryState.getQueryData,
  }),
  useInfiniteQuery: ({ enabled = true, queryKey, queryFn, initialPageParam }: {
    enabled?: boolean;
    queryKey: string[];
    queryFn?: (context: { pageParam: unknown }) => unknown;
    initialPageParam?: unknown;
  }) => {
    if (queryKey[0] === 'profile-generations') {
      queryState.generationsQuery = { queryKey, enabled };
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
        isFetchNextPageError: queryState.generationsIsFetchNextPageError,
        isFetchingNextPage: queryState.generationsIsFetchingNextPage,
        isFetched: queryState.generationsIsFetched,
        isFetching: queryState.generationsIsFetching,
        isLoading: false,
        isStale: queryState.generationsIsStale,
        dataUpdatedAt: queryState.generationsDataUpdatedAt,
        refetch: queryState.refetchGenerations,
      };
    }
    if (queryKey[0] === 'profile-failed-generations') {
      // Its request is left to the test that asks about it (`failedQuery.queryFn`).
      queryState.failedQuery = { queryKey, enabled, queryFn };
      queryState.failedQueryRenders.push({ queryKey, enabled });
      return {
        data: queryState.failedPages ? { pages: queryState.failedPages, pageParams: [initialPageParam] } : undefined,
        fetchNextPage: queryState.fetchNextFailed,
        hasNextPage: queryState.failedHasNextPage,
        isFetchNextPageError: false,
        isFetchingNextPage: false,
        isFetched: Boolean(queryState.failedPages),
        isFetching: false,
        isLoading: queryState.failedIsLoading,
        isStale: queryState.failedIsStale,
        refetch: queryState.refetchFailed,
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
        isFetchNextPageError: queryState.ownerPostsIsFetchNextPageError,
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
        isFetchNextPageError: queryState.savedMediaIsFetchNextPageError,
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
import { resetMediaZoomTransitions } from '../lib/media-zoom-transition';
import { DEFAULT_PROFILE_MEDIA_TAB, PROFILE_MEDIA_TABS } from '../lib/profile-view-model';
import { PROFILE_MEDIA_MIN_FILL_COUNT } from '../lib/profile-media-query';

// A tile's open holds every other tile off until the screen it opened can be
// touched (`beginTileOpen`), and that state is module-wide: each test starts
// with no open under way, as the reader does after landing on the screen.
afterEach(() => {
  resetMediaZoomTransitions();
  queryState.payoutQuery = PAYOUT_PENDING;
  queryState.payoutQueryOptions = null;
});

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

/**
 * The signed-out profile had no coverage at all before S13/S14, and that pass
 * changed three things it renders: the page title, the segmented control, and
 * the refresh button (which the signed-out list mounts with no handler).
 */
describe('ProfileDashboard signed out', () => {
  beforeEach(() => {
    routerState.push.mockClear();
    authState.user = null;
  });

  afterEach(() => {
    authState.user = { id: 'user-123', email: 'user@example.com' };
    authState.identityUserId = 'user-123';
    authState.isGuest = false;
  });

  // 02-1: only a guest's own creations open up; a device that holds no
  // identity at all (the guest session never started) still has nothing to show.
  it('keeps every tab behind sign-in on a device with no identity, and reads nothing', () => {
    authState.identityUserId = null;
    authState.isGuest = false;
    authState.api.listGenerations.mockClear();
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    expect(queryState.generationsQuery).toMatchObject({ enabled: false });
    expect(authState.api.listGenerations).not.toHaveBeenCalled();
    // The wall's one placeholder tile, under the sign-in card, and no offer.
    expect(tree!.root.findAll((node) => String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Creation, Crystal Portal, Not posted')).toHaveLength(1);
    expect(findPressableByText(tree!.root, 'Sign in')).toBeTruthy();
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Create an account to keep these on every device' })).toHaveLength(0);
  });

  it('offers a sign-in card instead of a hero card', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    expect(findPressableByText(tree!.root, 'Sign in')).toBeTruthy();
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Edit profile' })).toHaveLength(0);
  });

  // Sign-in used to end on Home, away from the profile it was asked from (audit 01-12).
  it('comes back to Profile once signed in', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    renderer.act(() => { findPressableByText(tree!.root, 'Sign in').props.onPress(); });

    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/profile' } });
  });

  it('still titles and announces the page', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    expect(tree!.root.findAllByProps({ children: 'Profile', accessibilityRole: 'header' }).length)
      .toBeGreaterThan(0);
  });

  it('shows the segmented control with its refresh disabled', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    // The tab it opens on, named in the refresh control the way it is when
    // signed in -- but with nothing to refresh, so the control is disabled.
    const refresh = tree!.root.findByProps({
      accessibilityLabel: `Refresh ${DEFAULT_PROFILE_MEDIA_TAB}`,
    });
    expect(refresh.props.accessibilityState).toMatchObject({ disabled: true });

    for (const tab of PROFILE_MEDIA_TABS) {
      expect(findPressableByText(tree!.root, tab)).toBeTruthy();
    }
  });

  // Below the cut of audit 03: the sample Post tile opened Your Sales.
  it('opens the post composer from the sample Post tile, never Your Sales', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Posts" />);
    });

    const sample = tree!.root.find((node) => String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Post, Cyber Shot, Private');
    renderer.act(() => {
      sample.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith('/post/new');
    expect(routerState.push).not.toHaveBeenCalledWith('/seller-dashboard');
  });

  /**
   * The grid teases one placeholder tile per tab rather than going empty, which
   * means the `emptyTitle` the signed-out branch passes ("Sign in to view saved
   * media") can never render -- `signedOutPreviewCards` is never empty. The
   * prompt people actually see is `SignedOutCard` above the grid. Pinned as the
   * behaviour, so whoever removes the placeholder notices the copy behind it.
   */
  it('teases one placeholder tile rather than an empty grid', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Saved" />);
    });

    expect(tree!.root.findByProps({
      accessibilityLabel: 'Saved, Saved Island, 0 likes',
    })).toBeTruthy();
    expect(tree!.root.findAllByProps({ children: 'Sign in to view saved media' })).toHaveLength(0);
  });
});

/**
 * 02-1: a guest's creations were walled ("Sign in to view your creations")
 * although the server serves a guest its library, so a guest lost sight of
 * what it paid for the moment it left the result. Home's render count opens
 * this tab, and the Rendering strip on it.
 */
describe('ProfileDashboard for a guest', () => {
  const guestCreation = {
    id: 'guest-gen-1',
    status: 'succeeded',
    output_url: 'guest.png',
    preview_url: 'guest.preview.webp',
    previewUrl: 'guest.preview.webp',
    category: 'image',
    title: 'Guest shot',
    prompt: 'Prompt',
  };

  beforeEach(() => {
    routerState.push.mockClear();
    authState.api.listGenerations.mockClear();
    authState.api.listOwnerPosts.mockClear();
    authState.api.getSavedMedia.mockClear();
    authState.user = null;
    authState.isGuest = true;
    authState.identityUserId = 'guest-1';
    queryState.generationsQuery = null;
    queryState.generationPages = null;
    queryState.generations = [guestCreation];
  });

  afterEach(() => {
    authState.user = { id: 'user-123', email: 'user@example.com' };
    authState.isGuest = false;
    authState.identityUserId = 'user-123';
    queryState.generations = [];
  });

  function renderProfile(props: React.ComponentProps<typeof ProfileDashboard> = {}) {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard {...props} />);
    });
    return tree!;
  }

  it('lists its own creations under its identity, below the sign-in card', () => {
    const tree = renderProfile();

    expect(queryState.generationsQuery).toEqual({ queryKey: ['profile-generations', 'guest-1'], enabled: true });
    expect(authState.api.listGenerations).toHaveBeenCalledWith(true, { limit: 24 });
    expect(tree.root.findAll((node) => String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Creation, Guest shot, Not posted')).toHaveLength(1);
    // The wall's placeholder is gone; the account's own parts stay out.
    expect(tree.root.findAll((node) => node.props.accessibilityLabel === 'Creation, Crystal Portal, Not posted')).toHaveLength(0);
    expect(findPressableByText(tree.root, 'Sign in')).toBeTruthy();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Edit profile' })).toHaveLength(0);
    expect(authState.api.listOwnerPosts).not.toHaveBeenCalled();
    expect(authState.api.getSavedMedia).not.toHaveBeenCalled();
  });

  it('opens a creation in the card feed of its library', () => {
    const tree = renderProfile();

    const tile = tree.root.find((node) => String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Creation, Guest shot, Not posted');
    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/profile-media-feed',
      params: { source: 'profile-creations', initialId: 'guest-gen-1' },
    });
  });

  it('offers an account above the grid, opening sign-up and coming back to Profile', () => {
    const tree = renderProfile();

    const offer = tree.root.find((node) => String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Create an account to keep these on every device');
    expect(offer.props.accessibilityHint).toBe('Opens sign-up');
    renderer.act(() => {
      offer.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { mode: 'signup', returnTo: '/profile' } });
  });

  it('says nothing about keeping creations it does not have', () => {
    queryState.generations = [];
    const tree = renderProfile();

    expect(tree.root.findAllByProps({ accessibilityLabel: 'Create an account to keep these on every device' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ children: 'No creations yet' }).length).toBeGreaterThan(0);
  });

  it('keeps the offer to its creations, off the Failed scope, and opens a fresh guest on Active', () => {
    queryState.generations = [
      guestCreation,
      { id: 'guest-failed', status: 'failed', output_url: null, category: 'image', title: 'Guest try', prompt: 'Prompt' },
    ];
    const tree = renderProfile();
    const offer = () => tree.root.findAll((node) => String(node.type) === 'pressable'
      && node.props.accessibilityLabel === 'Create an account to keep these on every device');
    const failedTiles = () => tree.root.findAll((node) => String(node.type) === 'pressable'
      && typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.includes(', failed, '));
    expect(offer()).toHaveLength(1);

    renderer.act(() => { findPressableByText(tree.root, 'Failed (1)').props.onPress(); });
    expect(failedTiles()).toHaveLength(1);
    expect(offer()).toHaveLength(0);

    // A refused session or deleted guest data hands the tab a new guest identity.
    authState.identityUserId = 'guest-2';
    renderer.act(() => { tree.update(<ProfileDashboard />); });
    expect(failedTiles()).toHaveLength(0);
    expect(offer()).toHaveLength(1);
  });

  it('says nothing about keeping runs that only failed, which wait under their own chip', () => {
    queryState.generations = [{ id: 'guest-failed', status: 'failed', output_url: null, category: 'image', title: 'Guest try', prompt: 'Prompt' }];
    const tree = renderProfile();

    expect(tree.root.findAllByProps({ accessibilityLabel: 'Create an account to keep these on every device' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ children: 'No creations yet' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Failed (1)' }).length).toBeGreaterThan(0);
  });

  it('shows the runs still rendering, where Home’s render count lands', () => {
    queryState.generations = [{
      id: 'guest-run',
      status: 'processing',
      category: 'image',
      created_at: '2026-10-15T07:00:00.000Z',
      title: 'Guest run',
      prompt: 'Prompt',
    }];
    const tree = renderProfile({ initialTab: 'Creations' });

    expect(tree.root.findAllByProps({ children: 'Rendering (1)' }).length).toBeGreaterThan(0);
  });

  it('keeps Posts and Saved behind sign-in, and reads neither', () => {
    for (const tab of ['Posts', 'Saved'] as const) {
      const tree = renderProfile({ initialTab: tab });
      expect(tree.root.findAllByProps({ accessibilityLabel: 'Create an account to keep these on every device' })).toHaveLength(0);
      expect(tree.root.findAll((node) => String(node.type) === 'pressable'
        && node.props.accessibilityLabel === 'Creation, Guest shot, Not posted')).toHaveLength(0);
      expect(findPressableByText(tree.root, 'Sign in')).toBeTruthy();
    }
    expect(authState.api.listOwnerPosts).not.toHaveBeenCalled();
    expect(authState.api.getSavedMedia).not.toHaveBeenCalled();
  });
});

/**
 * 03-4: the card preferred the auth context's balance however old it was, so
 * a purchase push that opened Profile showed the balance from before the
 * purchase over the profile it had just read.
 */
describe('ProfileDashboard Credits card', () => {
  const creditsValue = (root: renderer.ReactTestInstance) => findPressableByText(root, 'Credits')
    .findAll((node) => node.type === 'text' && typeof node.props.children === 'string')
    .map((node) => node.props.children as string);

  const baseProfile = queryState.profileData;

  beforeEach(() => {
    queryState.profileData = { ...baseProfile!, credits: 40 } as typeof queryState.profileData;
    queryState.profileDataUpdatedAt = 1_000;
    authState.credits = 100;
  });

  afterEach(() => {
    queryState.profileData = baseProfile;
    queryState.profileDataUpdatedAt = 0;
    authState.credits = 100;
    authState.creditsUpdatedAt = null;
  });

  function renderCard() {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });
    return creditsValue(tree!.root);
  }

  it('shows the balance the app set after the profile was read', () => {
    authState.creditsUpdatedAt = 2_000;
    expect(renderCard()).toContain('100');
  });

  it('shows the profile’s balance when the profile was read after it', () => {
    authState.creditsUpdatedAt = 500;
    expect(renderCard()).toContain('40');
  });

  it('shows the profile’s balance when this run never set one', () => {
    authState.creditsUpdatedAt = null;
    expect(renderCard()).toContain('40');
  });

  it('shows the app’s balance while the profile carries none', () => {
    queryState.profileData = baseProfile;
    authState.creditsUpdatedAt = null;
    expect(renderCard()).toContain('100');
  });
});

/**
 * 03-2: the card labelled "Wallet" drew lifetime tracked earnings, a figure a
 * payout request never lowers, so after the first request it claimed money Your
 * Sales no longer held. It reads the payout state, which the delete-account
 * warning and Your Sales read too.
 */
describe('ProfileDashboard Wallet card', () => {
  const baseProfile = queryState.profileData;

  beforeEach(() => {
    routerState.push.mockClear();
    // A lifetime total on the profile that the Wallet must not draw.
    (queryState as { profileData: unknown }).profileData = {
      ...baseProfile,
      sales: { earningsUsdCents: 1250, listingCount: 3, salesCount: 4 },
    };
  });

  afterEach(() => {
    queryState.profileData = baseProfile;
  });

  function renderWallet() {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });
    const card = findPressableByText(tree.root, 'Wallet');
    const texts = card
      .findAll((node) => node.type === 'text' && typeof node.props.children === 'string')
      .map((node) => node.props.children as string);
    return { card, texts };
  }

  it("reads the signed-in account's own payout state", () => {
    renderWallet();

    expect(queryState.payoutQueryOptions).toMatchObject({ queryKey: ['creator-payouts', 'user-123'], enabled: true });
    expect(queryState.payoutQueryOptions?.queryFn).toBe(authState.api.getCreatorPayoutState);
  });

  it('shows what can be withdrawn, never the lifetime earnings', () => {
    queryState.payoutQuery = { data: { availableUsd: '$4.25' }, isError: false, isPending: false };
    const { card, texts } = renderWallet();

    expect(texts).toEqual(expect.arrayContaining(['$4.25', 'Available to withdraw']));
    expect(texts).not.toContain('$12.50');
    expect(card.props.accessibilityLabel).toBe('Wallet, $4.25 available to withdraw');
  });

  it('says the balance is unavailable when the read fails, even over a balance read before', () => {
    queryState.payoutQuery = { data: { availableUsd: '$40.00' }, isError: true, isPending: false };
    const { card, texts } = renderWallet();

    expect(texts).toEqual(expect.arrayContaining(['–', 'Balance unavailable']));
    expect(texts).not.toContain('$40.00');
    expect(texts).not.toContain('Available to withdraw');
    expect(card.props.accessibilityLabel).toBe('Wallet, balance unavailable');

    // Your Sales is still a tap away.
    renderer.act(() => { card.props.onPress(); });
    expect(routerState.push).toHaveBeenCalledWith('/seller-dashboard');
  });

  it('draws the dash, never $0, while the payout state is on its way', () => {
    const { card, texts } = renderWallet();

    expect(texts).toEqual(expect.arrayContaining(['–', 'Available to withdraw']));
    expect(texts.some((text) => text.startsWith('$'))).toBe(false);
    expect(card.props.accessibilityLabel).toBe('Wallet, balance loading');
  });
});

describe('ProfileDashboard media tiles routing', () => {
  beforeEach(() => {
    routerState.push.mockClear();
    authState.api.listGenerations.mockClear();
    authState.api.listOwnerPosts.mockClear();
    queryState.profileData = { id: 'user-123', username: 'luna-dreams', displayName: 'Luna Dreams', avatarUrl: 'avatar.png' };
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
        // The feed always sends both, and the reel reads them for its caption.
        prompt: '',
        body: '',
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
    queryState.generationsIsFetchNextPageError = false;
    queryState.ownerPostsIsFetchNextPageError = false;
    queryState.savedMediaIsFetchNextPageError = false;
    queryState.fetchNextGenerations.mockClear();
    queryState.fetchNextOwnerPosts.mockClear();
    queryState.fetchNextSavedMedia.mockClear();
    queryState.setQueryData.mockClear();
    queryState.failedQuery = null;
    queryState.failedPages = null;
    queryState.failedQueryRenders = [];
    queryState.failedHasNextPage = false;
    queryState.failedIsLoading = false;
    queryState.failedIsStale = false;
    queryState.fetchNextFailed.mockClear();
    queryState.refetchFailed.mockClear();
    queryState.invalidateQueries.mockClear();
    queryState.getQueryData.mockReset();
    authState.api.getSavedMedia.mockClear();
  });

  it('routes to /viewer with correct source and initialId for Saved tiles', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Saved" />);
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
      prompt: '',
      body: 'A saved written post.',
      category: 'text',
      postFormat: 'text',
      creator: { name: 'Luna', username: 'luna' },
      isSaved: true,
      saveCount: 7,
    }];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Saved" />);
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
      accessibilityLabel: 'Post, Private note, Private',
    });
    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith('/post/private-text?source=profile-posts');
  });

  // D6 (finding 03-11): the balance opens what moved it, as the Wallet opens
  // Your Sales; the history offers the credit packs from its own balance.
  it('opens the credit history from the Credits card, saying the balance and where it goes', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    const creditsCard = findPressableByText(tree!.root, 'Credits');
    expect(creditsCard.props.accessibilityRole).toBe('button');
    expect(creditsCard.props.accessibilityLabel).toBe('Credits, 100');
    expect(creditsCard.props.accessibilityHint).toBe('Opens your credit history');
    expect(creditsCard.findAll((node) => String(node.type) === 'chevron-right-icon')).toHaveLength(1);

    renderer.act(() => {
      creditsCard.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith('/credit-history');
    expect(routerState.push).not.toHaveBeenCalledWith('/pricing');
  });

  it('tells a screen reader the balance is loading rather than reading the dash', () => {
    const knownCredits = authState.credits;
    (authState as { credits: number | null }).credits = null;
    try {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<ProfileDashboard />);
      });
      expect(findPressableByText(tree!.root, 'Credits').props.accessibilityLabel).toBe('Credits, balance loading');
    } finally {
      authState.credits = knownCredits;
    }
  });

  it('draws a dash, never 0, while the balance is unknown', () => {
    const creditsValue = (root: renderer.ReactTestInstance) => findPressableByText(root, 'Credits')
      .findAll((node) => node.type === 'text' && typeof node.props.children === 'string')
      .map((node) => node.props.children as string);

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });
    expect(creditsValue(tree!.root)).toContain('100');

    const knownCredits = authState.credits;
    (authState as { credits: number | null }).credits = null;
    try {
      renderer.act(() => {
        tree = renderer.create(<ProfileDashboard />);
      });
      expect(creditsValue(tree!.root)).toContain('–');
      expect(creditsValue(tree!.root)).not.toContain('0');
    } finally {
      authState.credits = knownCredits;
    }
  });

  it('draws the server totals in the header, and keeps the lifetime earnings off the Wallet card', () => {
    const baseProfile = queryState.profileData;
    (queryState as { profileData: unknown }).profileData = {
      ...baseProfile,
      stats: { creations: 142, posts: 19, archivedPosts: 1, saved: 11 },
      sales: { earningsUsdCents: 1250, listingCount: 3, salesCount: 4 },
    };
    try {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<ProfileDashboard />);
      });
      const texts = tree!.root
        .findAll((node) => node.type === 'text' && typeof node.props.children === 'string')
        .map((node) => node.props.children as string);
      // Totals, not the empty libraries the mock pages in, and no plus sign.
      expect(texts).toEqual(expect.arrayContaining(['142', '19', '11']));
      expect(texts.some((text) => text.endsWith('+'))).toBe(false);
      // The profile's `sales` total is lifetime earnings: never the Wallet's figure (audit 03-2).
      expect(findPressableByText(tree!.root, 'Wallet')
        .findAll((node) => node.type === 'text' && node.props.children === '$12.50')).toHaveLength(0);
    } finally {
      queryState.profileData = baseProfile;
    }
  });

  it('falls back to the paged counts without totals, and draws a dash on the Wallet card until the payout state answers', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });
    const texts = tree!.root
      .findAll((node) => node.type === 'text' && typeof node.props.children === 'string')
      .map((node) => node.props.children as string);
    // Each library here has paged in one card and has no more, so the header
    // says 1 · 1 · 1 the old way; the unknown-library dash is pinned in
    // profile-view-model.test.ts, since this mock always answers.
    expect(texts.filter((text) => text === '1')).toHaveLength(3);
    expect(findPressableByText(tree!.root, 'Wallet')
      .findAll((node) => node.type === 'text' && node.props.children === '–')).toHaveLength(1);
  });

  it('opens Your Sales from the Wallet card', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard />);
    });

    const walletCard = findPressableByText(tree!.root, 'Wallet');
    expect(walletCard.props.accessibilityRole).toBe('button');
    expect(walletCard.findAll((node) => String(node.type) === 'chevron-right-icon')).toHaveLength(1);
    // The profile's one way to Recipe Sales, so it says where it goes: the row under it that
    // opened the same screen is gone, and the side menu has the other way (A4, 2026-10-21).
    expect(walletCard.props.accessibilityHint).toBe('Opens Recipe Sales');
    expect(tree!.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Open seller dashboard')).toHaveLength(0);

    renderer.act(() => {
      walletCard.props.onPress();
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

  it('requests generations including archived ones for the Profile Creations grid', () => {
    renderer.act(() => {
      renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    expect(authState.api.listGenerations).toHaveBeenCalledWith(true, { limit: 24 });
  });

  // Archived posts are fetched with the rest so the Posts tab can show them
  // under their own scope; the archive dialog promises they can be restored
  // from the profile, and before this there was nowhere to do it.
  it('requests owner posts including archived ones for the Profile Posts grid', () => {
    renderer.act(() => {
      renderer.create(<ProfileDashboard initialTab="Posts" />);
    });

    // No sales summary: nothing on the profile reads one (the Wallet reads the payout state).
    expect(authState.api.listOwnerPosts).toHaveBeenCalledWith({
      includeArchived: true,
      pagination: 'cursor',
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

    expect(authState.api.listGenerations).toHaveBeenCalledWith(true, { cursor: '24', limit: 24 });
    expect(authState.api.listOwnerPosts).toHaveBeenCalledWith({
      includeArchived: true,
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

  // The gate refuses a request inside the cooldown, and a page that lands inside
  // it is refused at the very render that brings it. Nothing renders again when
  // the cooldown runs out, so a short scope (Archived, Failed, a sparse Active
  // grid) stopped paging until a refocus or a stale refetch rendered it.
  it('asks again once the cooldown has passed for a page that landed inside it with no new tiles', async () => {
    vi.useFakeTimers();
    let tree: renderer.ReactTestRenderer | undefined;
    try {
      queryState.generationsHasNextPage = true;
      queryState.generationPages = [{ generations: [] }];
      await renderer.act(async () => {
        tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
      });
      expect(queryState.fetchNextGenerations).toHaveBeenCalledTimes(1);

      // Page two lands 400 ms after it was asked for, with nothing to draw.
      await renderer.act(async () => { vi.advanceTimersByTime(400); });
      queryState.generationPages = [{ generations: [] }, { generations: [] }];
      await renderer.act(async () => {
        tree!.update(<ProfileDashboard initialTab="Creations" />);
      });
      expect(queryState.fetchNextGenerations).toHaveBeenCalledTimes(1);

      // No render follows, and page three is asked for as the cooldown ends.
      await renderer.act(async () => { vi.advanceTimersByTime(399); });
      expect(queryState.fetchNextGenerations).toHaveBeenCalledTimes(1);
      await renderer.act(async () => { vi.advanceTimersByTime(1); });
      expect(queryState.fetchNextGenerations).toHaveBeenCalledTimes(2);
    } finally {
      renderer.act(() => { tree?.unmount(); });
      vi.useRealTimers();
    }
  });

  it('asks nothing more once no page is left, once the grid is full, or once it has gone', async () => {
    vi.useFakeTimers();
    const trees: renderer.ReactTestRenderer[] = [];
    // A page lands inside the cooldown with nothing to draw, then `change` happens before it ends.
    const landInsideTheCooldown = async (change: (tree: renderer.ReactTestRenderer) => void) => {
      queryState.generationsHasNextPage = true;
      queryState.generationPages = [{ generations: [] }];
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => {
        tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
      });
      trees.push(tree);
      await renderer.act(async () => { vi.advanceTimersByTime(400); });
      queryState.generationPages = [{ generations: [] }, { generations: [] }];
      await renderer.act(async () => { tree.update(<ProfileDashboard initialTab="Creations" />); });
      queryState.fetchNextGenerations.mockClear();
      await renderer.act(async () => { change(tree); });
      await renderer.act(async () => { vi.advanceTimersByTime(2_000); });
      return queryState.fetchNextGenerations.mock.calls.length;
    };
    const readyCreations = Array.from({ length: PROFILE_MEDIA_MIN_FILL_COUNT }, (_, index) => ({
      id: `ready-${index}`,
      status: 'succeeded',
      output_url: `ready-${index}.jpg`,
      preview_url: `ready-${index}.webp`,
      category: 'image',
      title: `Ready ${index}`,
    }));
    try {
      expect(await landInsideTheCooldown((tree) => {
        queryState.generationsHasNextPage = false;
        tree.update(<ProfileDashboard initialTab="Creations" />);
      })).toBe(0);
      expect(await landInsideTheCooldown((tree) => {
        queryState.generationPages = [{ generations: [] }, { generations: readyCreations }];
        tree.update(<ProfileDashboard initialTab="Creations" />);
      })).toBe(0);
      expect(await landInsideTheCooldown((tree) => { tree.unmount(); })).toBe(0);
    } finally {
      renderer.act(() => { trees.forEach((tree) => tree.unmount()); });
      vi.useRealTimers();
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

  it('shows a recoverable footer after a profile-media page fails', async () => {
    queryState.generationsHasNextPage = true;
    queryState.generationsIsFetchNextPageError = true;

    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
      await Promise.resolve();
    });
    const callsBeforeRetry = queryState.fetchNextGenerations.mock.calls.length;
    const retry = tree!.root.findByProps({ accessibilityLabel: "Couldn't load more. Retry" });

    await renderer.act(async () => {
      retry.props.onPress();
      await Promise.resolve();
    });

    expect(queryState.fetchNextGenerations.mock.calls.length).toBe(callsBeforeRetry + 1);
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
      tree = renderer.create(<ProfileDashboard initialTab="Saved" />);
    });

    // The control names the tab it refreshes now that the heading that used to
    // name it is gone (segmented controls need no introductory text).
    const refresh = tree!.root.findByProps({ accessibilityLabel: 'Refresh Saved' });
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

  it('refreshes only the first page of the visible stale Profile media tab', async () => {
    queryState.savedMediaIsStale = true;
    queryState.setQueryData.mockClear();
    authState.api.getSavedMedia.mockImplementation(async () => ({ items: [], pageInfo: { hasMore: false } }));

    await renderer.act(async () => {
      renderer.create(<ProfileDashboard initialTab="Saved" />);
    });

    // One page merged into the loaded library, never a refetch of every page.
    expect(queryState.refetchGenerations).not.toHaveBeenCalled();
    expect(queryState.refetchOwnerPosts).not.toHaveBeenCalled();
    expect(queryState.refetchSavedMedia).not.toHaveBeenCalled();
    expect(queryState.setQueryData.mock.calls.map(([key]) => key)).toEqual([['profile-saved-media', 'user-123']]);
    authState.api.getSavedMedia.mockReset();
    // Saved has no scope totals to read again.
    expect(queryState.invalidateQueries).not.toHaveBeenCalled();
  });

  it('reads the Creations scope totals again with a stale library, for a run that failed while the reader was away', async () => {
    queryState.generationsIsStale = true;
    authState.api.listGenerations.mockImplementation(async () => ({ generations: [], pagination: { limit: 24, hasMore: false, nextCursor: null } }));
    try {
      await renderer.act(async () => {
        renderer.create(<ProfileDashboard initialTab="Creations" />);
      });

      expect(authState.api.listGenerations).toHaveBeenCalledWith(true, { limit: 24 });
      expect(queryState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['profile', 'user-123'] });
    } finally {
      queryState.generationsIsStale = false;
      authState.api.listGenerations.mockReset();
    }
  });

  it('defers inactive Profile datasets until the visible dataset settles', () => {
    renderer.act(() => {
      renderer.create(<ProfileDashboard initialTab="Saved" />);
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
      accessibilityLabel: 'Post, Post Title, Public',
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

  it('draws a plate for a creation image whose derivative is not ready, without loading the source', () => {
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

    expect(findViewByTestId(tree!.root, 'profile-art-preview-fallback')).toHaveLength(1);
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
    renderer.act(() => { findPressableByText(tree!.root, 'Archived (1)').props.onPress(); });
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Creation, Ready image, Not posted' })).toHaveLength(0);
    const archivedTile = tree!.root.findByProps({ accessibilityLabel: 'Creation, Archived image, Not posted' });
    renderer.act(() => { archivedTile.props.onPress(); });
    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/profile-media-feed',
      params: { source: 'profile-creations', initialId: 'archived-image', scope: 'archived' },
    });

  });

  it('draws a play plate for a creation video with no poster, without streaming the clip', () => {
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

    expect(findViewByTestId(tree!.root, 'profile-video-preview-fallback')).toHaveLength(1);
    expect(tree!.root.findAll((node) => String(node.type) === 'feed-video-preview')).toHaveLength(0);
    expect(tree!.root.findAll((node) =>
      String(node.type) === 'image' && node.props.source?.uri === 'video-without-poster.mp4'
    )).toHaveLength(0);
  });

  // The library sends a run's first file only, so the others were out of reach (audit 01-2).
  it('marks a creation that made several files with how many, and says it in words', () => {
    queryState.generations = [
      {
        id: 'takes',
        status: 'succeeded',
        output_url: 'takes-0.jpg',
        preview_url: 'takes-0.preview.webp',
        previewUrl: 'takes-0.preview.webp',
        output_count: 4,
        category: 'image',
        title: 'Four takes',
        prompt: 'A lighthouse at dusk',
      },
      {
        id: 'single',
        status: 'succeeded',
        output_url: 'single.jpg',
        preview_url: 'single.preview.webp',
        previewUrl: 'single.preview.webp',
        output_count: 1,
        category: 'image',
        title: 'One take',
        prompt: 'A harbour at dawn',
      },
    ];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
    });

    const takes = tree!.root.findByProps({ accessibilityLabel: 'Creation, Four takes, Not posted, 4 outputs' });
    const [badge] = findViewByTestId(takes, 'profile-tile-outputs-badge');
    expect(badge.findAllByType('images-icon' as never)).toHaveLength(1);
    expect(badge.findAllByType('text' as never).map((node) => node.props.children)).toEqual([4]);
    const single = tree!.root.findByProps({ accessibilityLabel: 'Creation, One take, Not posted' });
    expect(findViewByTestId(single, 'profile-tile-outputs-badge')).toHaveLength(0);
    expect(findViewByTestId(tree!.root, 'profile-tile-outputs-badge')).toHaveLength(1);
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

  it('keeps archived and media-less non-text posts out of the active Posts grid, and lists archived ones under their own scope', () => {
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

    expect(tree!.root.findByProps({ accessibilityLabel: 'Post, Ready media post, Public' })).toBeTruthy();
    expect(tree!.root.findByProps({ accessibilityLabel: 'Post, Reusable note, Public' })).toBeTruthy();
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Post, Empty media post, Public' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Post, Archived post, Public' })).toHaveLength(0);

    // The scope control counts what each scope holds and swaps the grid.
    const archivedScope = tree!.root.findByProps({ accessibilityLabel: 'Archived (1)' });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Active (2)' })).toBeTruthy();
    renderer.act(() => {
      archivedScope.props.onPress();
    });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Post, Archived post, Public' })).toBeTruthy();
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Post, Ready media post, Public' })).toHaveLength(0);
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
      tree = renderer.create(<ProfileDashboard initialTab="Saved" />);
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
      accessibilityLabel: 'Post, Post Title, Public',
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

  it('keeps archived Posts in their scoped management feed', () => {
    queryState.ownerPosts = [{
      id: 'archived-post',
      title: 'Archived post',
      createdAt: '2026-06-10T00:00:00Z',
      visibility: 'public',
      mediaUrl: 'archived.png',
      mediaKind: 'image',
      mediaItems: [],
      archivedAt: '2026-06-11T00:00:00Z',
      bundle: null,
      commentCount: 0,
    }];

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab="Posts" />);
    });

    const archivedTab = findPressableByText(tree!.root, 'Archived (1)');
    renderer.act(() => {
      archivedTab.props.onPress();
    });

    const tile = tree!.root.findByProps({
      accessibilityLabel: 'Post, Archived post, Public',
    });
    renderer.act(() => {
      tile.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith({
      pathname: '/profile-media-feed',
      params: {
        source: 'profile-posts',
        initialId: 'archived-post',
        scope: 'archived',
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

  describe('notifications offer after a publish', () => {
    const offers = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'push-offer-card');

    it('offers notifications above the grid for the post just published', () => {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<ProfileDashboard initialTab="Posts" highlightedPostId="post-1" justPublishedPostId="post-1" />);
      });

      expect(offers(tree!)).toHaveLength(1);
      expect(offers(tree!)[0].props).toMatchObject({ moment: 'post', occasion: 'post:post-1' });
    });

    it('does not offer on an ordinary visit to a post', () => {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<ProfileDashboard initialTab="Posts" highlightedPostId="post-1" />);
      });

      expect(offers(tree!)).toHaveLength(0);
    });

    it('offers only on the Posts tab', () => {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<ProfileDashboard initialTab="Creations" justPublishedPostId="post-1" />);
      });

      expect(offers(tree!)).toHaveLength(0);
    });
  });

  // A run still rendering is not a library member (the viewers' rule), so it
  // appeared nowhere on Profile until it finished, and Home's "render in
  // progress" opened a list without it.
  describe('the Rendering strip', () => {
    const readAt = Date.parse('2026-10-13T10:00:00Z');
    const minutesBefore = (minutes: number) => new Date(readAt - minutes * 60_000).toISOString();
    const renderingRuns = () => [
      {
        id: 'ready-image',
        status: 'succeeded',
        output_url: 'ready-image.jpg',
        preview_url: 'ready-image.preview.webp',
        category: 'image',
        title: 'Ready image',
        created_at: minutesBefore(30),
      },
      { id: 'video-run', status: 'processing', output_url: null, category: 'video', title: 'Video run', created_at: minutesBefore(3) },
      { id: 'motion-run', status: 'pending', output_url: null, category: 'video', creationMode: 'motion', title: 'Motion run', created_at: minutesBefore(0.5) },
      { id: 'sound-run', status: 'waiting', output_url: null, category: 'audio', audioKind: 'voiceover', title: 'Sound run', created_at: minutesBefore(125) },
      { id: 'failed-run', status: 'failed', output_url: null, category: 'image', title: 'Failed run', created_at: minutesBefore(5) },
      { id: 'archived-run', status: 'processing', output_url: null, category: 'image', title: 'Archived run', created_at: minutesBefore(5), archived_at: minutesBefore(1) },
    ];
    const renderDashboard = (initialTab: 'Creations' | 'Posts' = 'Creations') => {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<ProfileDashboard initialTab={initialTab} />);
      });
      return tree!;
    };
    const stripTitles = (tree: renderer.ReactTestRenderer) => tree.root.findAllByProps({ children: 'Rendering (3)' });
    const listCalls = () => authState.api.listGenerations.mock.calls.length;

    beforeEach(() => {
      queryState.generations = renderingRuns();
      queryState.generationsDataUpdatedAt = readAt;
    });

    afterEach(() => {
      queryState.generationsDataUpdatedAt = 0;
      navigationState.focused = true;
      activeRunState.record = null;
      vi.useRealTimers();
    });

    it('shows each run still rendering above the grid, with its kind and how long ago it started', () => {
      const tree = renderDashboard();

      expect(stripTitles(tree).length).toBeGreaterThan(0);
      expect(tree.root.findByProps({ accessibilityLabel: 'Video, rendering, started 3 min ago' })).toBeTruthy();
      expect(tree.root.findByProps({ accessibilityLabel: 'Motion, rendering, started just now' })).toBeTruthy();
      expect(tree.root.findByProps({ accessibilityLabel: 'Voiceover, rendering, started 2 h ago' })).toBeTruthy();
      // The finished image, the failed run and the archived one are all images:
      // none of them is on the strip.
      expect(tree.root.findAll((node) => typeof node.props.accessibilityLabel === 'string'
        && node.props.accessibilityLabel.startsWith('Image, rendering'))).toHaveLength(0);
    });

    it('keeps the library rule: the grid still holds only finished creations', () => {
      const tree = renderDashboard();

      expect(tree.root.findByProps({ accessibilityLabel: 'Creation, Ready image, Not posted' })).toBeTruthy();
      expect(tree.root.findAllByProps({ accessibilityLabel: 'Creation, Video run, Not posted' })).toHaveLength(0);
      expect(tree.root.findAllByProps({ accessibilityLabel: 'Creation, Motion run, Not posted' })).toHaveLength(0);
    });

    const tile = (tree: renderer.ReactTestRenderer, label: string) => tree.root.findAll((node) => (
      String(node.type) === 'pressable' && node.props.accessibilityLabel === label
    ));
    const resumeControls = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => (
      String(node.type) === 'pressable'
      && typeof node.props.accessibilityLabel === 'string'
      && node.props.accessibilityLabel.startsWith('Resume in the')
    ));

    // The creator resumes a run only from the record this device keeps, so a
    // tile for any other run opened a blank creator ready to charge again (02-8).
    it("opens each run's status page in the reel, whatever its kind", () => {
      const tree = renderDashboard();

      renderer.act(() => { tile(tree, 'Video, rendering, started 3 min ago')[0].props.onPress(); });
      renderer.act(() => { tile(tree, 'Voiceover, rendering, started 2 h ago')[0].props.onPress(); });

      expect(routerState.push.mock.calls).toEqual([
        [{ pathname: '/viewer', params: { source: 'profile-creations', initialId: 'video-run' } }],
        [{ pathname: '/viewer', params: { source: 'profile-creations', initialId: 'sound-run' } }],
      ]);
    });

    it('offers Resume in the creator only for the run this device started', async () => {
      activeRunState.record = { generationId: 'video-run', tool: 'video' };
      let tree!: renderer.ReactTestRenderer;
      await renderer.act(async () => {
        tree = renderer.create(<ProfileDashboard initialTab="Creations" />);
      });

      expect(resumeControls(tree).map((node) => node.props.accessibilityLabel)).toEqual(['Resume in the video creator']);
      renderer.act(() => { resumeControls(tree)[0].props.onPress(); });
      expect(routerState.push).toHaveBeenLastCalledWith('/create/video');

      // A record of a run the server no longer lists as rendering offers nothing.
      activeRunState.record = { generationId: 'finished-elsewhere', tool: 'image' };
      let other!: renderer.ReactTestRenderer;
      await renderer.act(async () => {
        other = renderer.create(<ProfileDashboard initialTab="Creations" />);
      });
      expect(resumeControls(other)).toHaveLength(0);
    });

    // The reel reads this library: Profile, under it, keeps the run's status
    // page following the run to its end.
    it('keeps reading the first page under the reel while the run it opened renders, and only then', () => {
      vi.useFakeTimers();
      const tree = renderDashboard();
      renderer.act(() => { tile(tree, 'Video, rendering, started 3 min ago')[0].props.onPress(); });
      navigationState.focused = false;
      renderer.act(() => { tree.update(<ProfileDashboard initialTab="Creations" />); });
      const before = listCalls();

      renderer.act(() => { vi.advanceTimersByTime(15_000); });
      expect(listCalls()).toBe(before + 1);
      expect(authState.api.listGenerations).toHaveBeenLastCalledWith(true, { limit: 24 });

      // The run finished: nothing on the strip is being watched any more.
      queryState.generations = renderingRuns().map((run) => (
        run.id === 'video-run' ? { ...run, status: 'succeeded', output_url: 'video-run.mp4' } : run
      ));
      renderer.act(() => { tree.update(<ProfileDashboard initialTab="Creations" />); });
      const settled = listCalls();
      renderer.act(() => { vi.advanceTimersByTime(30_000); });
      expect(listCalls()).toBe(settled);
      renderer.act(() => { tree.unmount(); });
    });

    it('reads nothing while out of focus when no tile was opened', () => {
      vi.useFakeTimers();
      const tree = renderDashboard();
      navigationState.focused = false;
      renderer.act(() => { tree.update(<ProfileDashboard initialTab="Creations" />); });
      const before = listCalls();

      renderer.act(() => { vi.advanceTimersByTime(30_000); });

      expect(listCalls()).toBe(before);
      renderer.act(() => { tree.unmount(); });
    });

    it('is absent from the Archived scope, from the other tabs, and when nothing is rendering', () => {
      const tree = renderDashboard();
      renderer.act(() => { findPressableByText(tree.root, 'Archived (0)').props.onPress(); });
      expect(stripTitles(tree)).toHaveLength(0);

      expect(stripTitles(renderDashboard('Posts'))).toHaveLength(0);

      queryState.generations = renderingRuns().filter((run) => run.status === 'succeeded');
      const idle = renderDashboard();
      expect(idle.root.findAll((node) => typeof node.props.children === 'string'
        && node.props.children.startsWith('Rendering ('))).toHaveLength(0);
    });

    it('reads the first page again every 15 seconds while a run is rendering', () => {
      vi.useFakeTimers();
      const tree = renderDashboard();
      const before = listCalls();

      renderer.act(() => { vi.advanceTimersByTime(14_999); });
      expect(listCalls()).toBe(before);
      renderer.act(() => { vi.advanceTimersByTime(1); });
      expect(listCalls()).toBe(before + 1);
      // The head of the library, merged, never a refetch of every page.
      expect(authState.api.listGenerations).toHaveBeenLastCalledWith(true, { limit: 24 });
      expect(queryState.refetchGenerations).not.toHaveBeenCalled();
      renderer.act(() => { vi.advanceTimersByTime(15_000); });
      expect(listCalls()).toBe(before + 2);

      renderer.act(() => { tree.unmount(); });
      renderer.act(() => { vi.advanceTimersByTime(30_000); });
      expect(listCalls()).toBe(before + 2);
    });

    it('does not poll when nothing is rendering, or on another tab', () => {
      vi.useFakeTimers();
      queryState.generations = renderingRuns().filter((run) => run.status === 'succeeded');
      const idle = renderDashboard();
      queryState.generations = renderingRuns();
      const posts = renderDashboard('Posts');
      const before = listCalls();

      renderer.act(() => { vi.advanceTimersByTime(60_000); });

      expect(listCalls()).toBe(before);
      renderer.act(() => {
        idle.unmount();
        posts.unmount();
      });
    });
  });

  // A failed run is not a library member, so it left the Rendering strip for
  // nowhere and could be found again only through its alert (audit 01-9). The
  // failures have a chip of their own beside Active: as a strip above the grid
  // they stood in front of every creation.
  describe('the Failed scope', () => {
    const runs = () => [
      { id: 'ready-image', status: 'succeeded', output_url: 'ready.jpg', preview_url: 'ready.webp', category: 'image', title: 'Ready image', created_at: '2026-10-13T09:00:00Z' },
      { id: 'failed-video', status: 'failed', output_url: null, category: 'video', title: null, prompt: 'A slow push-in', created_at: '2026-10-13T08:00:00Z' },
      { id: 'failed-image', status: 'failed', output_url: null, category: 'image', title: 'Poster try', created_at: '2026-10-13T07:00:00Z' },
      { id: 'tidied', status: 'failed', output_url: null, category: 'image', title: 'Archived failure', created_at: '2026-10-13T06:00:00Z', archived_at: '2026-10-13T06:30:00Z' },
      { id: 'running', status: 'processing', output_url: null, category: 'video', title: 'Still going', created_at: '2026-10-13T09:30:00Z' },
    ];
    const renderDashboard = (initialTab: 'Creations' | 'Posts' = 'Creations') => {
      let tree: renderer.ReactTestRenderer | undefined;
      renderer.act(() => {
        tree = renderer.create(<ProfileDashboard initialTab={initialTab} />);
      });
      return tree!;
    };
    const failedTiles = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => (
      String(node.type) === 'pressable'
      && typeof node.props.accessibilityLabel === 'string'
      && node.props.accessibilityLabel.includes(', failed, ')
    ));
    const scopeChips = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => (
      String(node.type) === 'pressable' && node.props.accessibilityRole === 'radio'
    )).map((node) => node.props.accessibilityLabel);
    const stripHeadings = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => (
      String(node.type) === 'text'
      && node.props.accessibilityRole === 'header'
      && typeof node.props.children === 'string'
      && /^(Rendering|Failed) \(/.test(node.props.children)
    )).map((node) => node.props.children);
    const readyRuns = (count: number) => Array.from({ length: count }, (_, index) => ({
      id: `ready-${index}`, status: 'succeeded', output_url: `ready-${index}.jpg`, preview_url: `ready-${index}.webp`, category: 'image', title: `Ready ${index}`, created_at: '2026-10-13T09:00:00Z',
    }));
    const failedRuns = (count: number) => Array.from({ length: count }, (_, index) => ({
      id: `failed-${index}`, status: 'failed', output_url: null, category: 'image', title: `Failure ${index}`, created_at: '2026-10-13T08:00:00Z',
    }));
    // The profile every test here starts from: no totals, so the chips count what has loaded.
    const profileWithoutTotals = () => ({ id: 'user-123', username: 'luna-dreams', displayName: 'Luna Dreams', avatarUrl: 'avatar.png' });

    const tabSegment = (tree: renderer.ReactTestRenderer, tab: 'Creations' | 'Posts') => tree.root.find((node) => (
      String(node.type) === 'pressable' && node.props.accessibilityRole === 'tab' && node.props.accessibilityLabel === tab
    ));

    beforeEach(() => {
      queryState.generations = runs();
    });

    afterEach(() => {
      vi.useRealTimers();
      // The describes after this one do not reset these.
      queryState.generationsHasNextPage = false;
      queryState.ownerPosts = [];
    });

    it('keeps failed runs off the Active grid, under a Failed chip between Active and Archived', () => {
      const tree = renderDashboard();

      expect(scopeChips(tree)).toEqual(['Active (1)', 'Failed (2)', 'Archived (0)']);
      expect(failedTiles(tree)).toHaveLength(0);
      expect(tree.root.findByProps({ accessibilityLabel: 'Creation, Ready image, Not posted' })).toBeTruthy();
      // The Rendering strip stays with the Active grid, and no Failed strip joins it.
      expect(stripHeadings(tree)).toEqual(['Rendering (1)']);
    });

    it('lists every failed run that is not archived as the list rows, with its title, under the Rendering strip', () => {
      const tree = renderDashboard();

      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });

      expect(failedTiles(tree).map((node) => node.props.accessibilityLabel)).toEqual([
        'Video, failed, A slow push-in',
        'Image, failed, Poster try',
      ]);
      // They are the list's own rows, so it pages, windows and recycles them as
      // it does tiles: drawn in its header, they left FlashList's end-of-list
      // check armed only once, and nothing but the fill paged on.
      const list = tree.root.find((node) => String(node.type) === 'flash-list');
      expect(list.props.data.map((card: { sourceId: string }) => card.sourceId)).toEqual(['failed-video', 'failed-image']);
      // Each draws as a failed run, never as a grid tile; the finished creation
      // stays under Active; and the Rendering strip stays above them, where a
      // run tried again from its failure is watched.
      expect(tree.root.findAllByProps({ accessibilityLabel: 'Creation, Poster try, Not posted' })).toHaveLength(0);
      expect(tree.root.findAllByProps({ accessibilityLabel: 'Creation, Ready image, Not posted' })).toHaveLength(0);
      expect(stripHeadings(tree)).toEqual(['Rendering (1)']);
      expect(tree.root.findAllByProps({ children: 'No failed creations' })).toHaveLength(0);
    });

    it('reads the first page again every 15 seconds over Failed while a run renders, so one that fails joins it', () => {
      vi.useFakeTimers();
      const tree = renderDashboard();
      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });
      const before = authState.api.listGenerations.mock.calls.length;

      renderer.act(() => { vi.advanceTimersByTime(15_000); });

      expect(authState.api.listGenerations.mock.calls.length).toBe(before + 1);
      renderer.act(() => { tree.unmount(); });
    });

    it("opens a failed run's status page, where its alert lands: Try again, Archive and Delete are there", () => {
      const tree = renderDashboard();
      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });

      renderer.act(() => { failedTiles(tree)[0].props.onPress(); });

      expect(routerState.push).toHaveBeenCalledWith({
        pathname: '/viewer',
        params: { source: 'studio-creations', initialId: 'failed-video' },
      });
    });

    it('offers no Failed chip when nothing failed, for an archived failure, or over Posts', () => {
      queryState.generations = runs().filter((run) => run.status !== 'failed' || run.archived_at);
      const tree = renderDashboard();
      expect(scopeChips(tree)).toEqual(['Active (1)', 'Archived (0)']);
      renderer.act(() => { findPressableByText(tree.root, 'Archived (0)').props.onPress(); });
      expect(failedTiles(tree)).toHaveLength(0);

      queryState.generations = runs();
      const posts = renderDashboard('Posts');
      expect(scopeChips(posts).filter((label) => label.startsWith('Failed'))).toEqual([]);
      expect(failedTiles(posts)).toHaveLength(0);
    });

    it('keeps failed runs out of Archived while they exist, which says it is empty', () => {
      const tree = renderDashboard();

      renderer.act(() => { findPressableByText(tree.root, 'Archived (0)').props.onPress(); });

      expect(failedTiles(tree)).toHaveLength(0);
      expect(tree.root.findAllByProps({ children: 'No archived creations' }).length).toBeGreaterThan(0);
      expect(scopeChips(tree)).toEqual(['Active (1)', 'Failed (2)', 'Archived (0)']);
    });

    it('opens another account on Active, though Failed stays while chosen', () => {
      const tree = renderDashboard();
      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });
      expect(failedTiles(tree)).toHaveLength(2);

      const signedIn = authState.user;
      try {
        // A token refresh: a new session, so a new user object, with the same id.
        authState.user = { ...signedIn! };
        renderer.act(() => { tree.update(<ProfileDashboard initialTab="Creations" />); });
        expect(failedTiles(tree)).toHaveLength(2);

        authState.user = { id: 'user-456', email: 'other@example.com' };
        renderer.act(() => { tree.update(<ProfileDashboard initialTab="Creations" />); });

        expect(failedTiles(tree)).toHaveLength(0);
        expect(tree.root.findByProps({ accessibilityLabel: 'Creation, Ready image, Not posted' })).toBeTruthy();
      } finally {
        authState.user = signedIn;
      }
    });

    it('keeps Archived through a token refresh, and opens another account’s Posts on Active', () => {
      queryState.ownerPosts = [
        {
          id: 'ready-post', title: 'Ready media post', createdAt: '2026-06-10T00:00:00Z', visibility: 'public',
          mediaUrl: 'ready-post.png', mediaKind: 'image', body: 'Post body', category: 'image', postFormat: 'media',
          mediaItems: [{ id: 'ready-post-media', url: 'ready-post.png', previewUrl: 'ready-post.preview.webp', mediaKind: 'image', gridReady: true }],
        },
        {
          id: 'archived-post', title: 'Archived post', createdAt: '2026-06-10T00:00:00Z', visibility: 'public',
          mediaUrl: 'archived-post.png', mediaKind: 'image', body: 'Archived body', category: 'image', postFormat: 'media',
          archivedAt: '2026-06-11T00:00:00Z',
        },
      ];
      const selectedChips = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => (
        String(node.type) === 'pressable' && node.props.accessibilityRole === 'radio' && node.props.accessibilityState?.selected
      )).map((node) => node.props.accessibilityLabel);
      const tree = renderDashboard('Posts');
      renderer.act(() => { findPressableByText(tree.root, 'Archived (1)').props.onPress(); });
      expect(selectedChips(tree)).toEqual(['Archived (1)']);

      const signedIn = authState.user;
      try {
        // A token refresh: a new session, so a new user object, with the same id.
        authState.user = { ...signedIn! };
        renderer.act(() => { tree.update(<ProfileDashboard initialTab="Posts" />); });
        expect(selectedChips(tree)).toEqual(['Archived (1)']);

        authState.user = { id: 'user-456', email: 'other@example.com' };
        renderer.act(() => { tree.update(<ProfileDashboard initialTab="Posts" />); });

        expect(selectedChips(tree)).toEqual(['Active (1)']);
        expect(tree.root.findByProps({ accessibilityLabel: 'Post, Ready media post, Public' })).toBeTruthy();
        expect(tree.root.findAllByProps({ accessibilityLabel: 'Post, Archived post, Public' })).toHaveLength(0);
      } finally {
        authState.user = signedIn;
      }
    });

    it('sets the scope of the tab it is pressed on, and each tab keeps its own', () => {
      queryState.ownerPosts = [
        {
          id: 'ready-post', title: 'Ready media post', createdAt: '2026-06-10T00:00:00Z', visibility: 'public',
          mediaUrl: 'ready-post.png', mediaKind: 'image', body: 'Post body', category: 'image', postFormat: 'media',
          mediaItems: [{ id: 'ready-post-media', url: 'ready-post.png', previewUrl: 'ready-post.preview.webp', mediaKind: 'image', gridReady: true }],
        },
        {
          id: 'archived-post', title: 'Archived post', createdAt: '2026-06-10T00:00:00Z', visibility: 'public',
          mediaUrl: 'archived-post.png', mediaKind: 'image', body: 'Archived body', category: 'image', postFormat: 'media',
          archivedAt: '2026-06-11T00:00:00Z',
        },
      ];
      const tree = renderDashboard();
      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });

      renderer.act(() => { tabSegment(tree, 'Posts').props.onPress(); });
      expect(scopeChips(tree)).toEqual(['Active (1)', 'Archived (1)']);
      renderer.act(() => { findPressableByText(tree.root, 'Archived (1)').props.onPress(); });
      expect(tree.root.findByProps({ accessibilityLabel: 'Post, Archived post, Public' })).toBeTruthy();

      renderer.act(() => { tabSegment(tree, 'Creations').props.onPress(); });
      expect(failedTiles(tree)).toHaveLength(2);
      expect(scopeChips(tree)).toEqual(['Active (1)', 'Failed (2)', 'Archived (0)']);
    });

    it("names each tab's chips as that tab's filter, and gives Saved none", () => {
      const tree = renderDashboard();
      const chipGroups = () => tree.root.findAll((node) => (
        String(node.type) === 'view' && node.props.accessibilityRole === 'radiogroup'
      )).map((node) => node.props.accessibilityLabel);
      expect(chipGroups()).toEqual(['Filter creations']);

      renderer.act(() => { tabSegment(tree, 'Posts').props.onPress(); });
      expect(chipGroups()).toEqual(['Filter posts']);

      const savedTab = tree.root.find((node) => (
        String(node.type) === 'pressable' && node.props.accessibilityRole === 'tab' && node.props.accessibilityLabel === 'Saved'
      ));
      renderer.act(() => { savedTab.props.onPress(); });
      expect(chipGroups()).toEqual([]);
    });

    // The dashboard picks each tab's empty state and chosen chip itself, so a
    // value wired to the wrong tab type-checks; these read what each tab draws.
    it('names an empty Posts or Saved tab after itself, under each Posts chip', () => {
      queryState.ownerPosts = [];
      queryState.savedItems = [];
      const tree = renderDashboard('Posts');
      const shows = (title: string) => tree.root.findAllByProps({ children: title }).length > 0;

      expect(shows('No posts yet')).toBe(true);
      renderer.act(() => { findPressableByText(tree.root, 'Archived (0)').props.onPress(); });
      expect(shows('No archived posts')).toBe(true);
      expect(shows('No archived creations')).toBe(false);

      const savedTab = tree.root.find((node) => (
        String(node.type) === 'pressable' && node.props.accessibilityRole === 'tab' && node.props.accessibilityLabel === 'Saved'
      ));
      renderer.act(() => { savedTab.props.onPress(); });
      expect(shows('No saved media yet')).toBe(true);
      expect(shows('No posts yet')).toBe(false);
    });

    it("checks the chosen chip on each tab, and each tab's choice stays its own", () => {
      queryState.ownerPosts = [
        {
          id: 'ready-post', title: 'Ready media post', createdAt: '2026-06-10T00:00:00Z', visibility: 'public',
          mediaUrl: 'ready-post.png', mediaKind: 'image', body: 'Post body', category: 'image', postFormat: 'media',
          mediaItems: [{ id: 'ready-post-media', url: 'ready-post.png', previewUrl: 'ready-post.preview.webp', mediaKind: 'image', gridReady: true }],
        },
        {
          id: 'archived-post', title: 'Archived post', createdAt: '2026-06-10T00:00:00Z', visibility: 'public',
          mediaUrl: 'archived-post.png', mediaKind: 'image', body: 'Archived body', category: 'image', postFormat: 'media',
          archivedAt: '2026-06-11T00:00:00Z',
        },
      ];
      const tree = renderDashboard();
      // What VoiceOver reads as checked, with the highlight that goes with it.
      const chosenChips = () => tree.root.findAll((node) => (
        String(node.type) === 'pressable' && node.props.accessibilityRole === 'radio' && node.props.accessibilityState?.checked
      )).map((node) => [node.props.accessibilityLabel, node.props.accessibilityState.selected]);

      expect(chosenChips()).toEqual([['Active (1)', true]]);
      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });
      expect(chosenChips()).toEqual([['Failed (2)', true]]);

      renderer.act(() => { tabSegment(tree, 'Posts').props.onPress(); });
      expect(chosenChips()).toEqual([['Active (1)', true]]);
      renderer.act(() => { findPressableByText(tree.root, 'Archived (1)').props.onPress(); });
      expect(chosenChips()).toEqual([['Archived (1)', true]]);

      renderer.act(() => { tabSegment(tree, 'Creations').props.onPress(); });
      expect(chosenChips()).toEqual([['Failed (2)', true]]);
      renderer.act(() => { tabSegment(tree, 'Posts').props.onPress(); });
      expect(chosenChips()).toEqual([['Archived (1)', true]]);
    });

    it('stays on Failed, empty, once its last run is cleared, and its chip goes when another is chosen', () => {
      const tree = renderDashboard();
      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });

      // Tried again, archived or deleted from the status page, and read back.
      queryState.generations = runs().filter((run) => run.status !== 'failed');
      renderer.act(() => { tree.update(<ProfileDashboard initialTab="Creations" />); });

      expect(scopeChips(tree)).toEqual(['Active (1)', 'Failed (0)', 'Archived (0)']);
      expect(failedTiles(tree)).toHaveLength(0);
      expect(tree.root.findAllByProps({ children: 'No failed creations' }).length).toBeGreaterThan(0);
      // An empty Failed scope is the good case: it never promises to fill.
      expect(tree.root.findAllByProps({ children: 'A run that fails shows here. Open it to see what went wrong.' }).length).toBeGreaterThan(0);

      renderer.act(() => { findPressableByText(tree.root, 'Active (1)').props.onPress(); });
      expect(scopeChips(tree)).toEqual(['Active (1)', 'Archived (0)']);
      expect(tree.root.findByProps({ accessibilityLabel: 'Creation, Ready image, Not posted' })).toBeTruthy();
    });

    it('asks for failed runs alone, and only once the scope is opened', async () => {
      const tree = renderDashboard();
      expect(queryState.failedQuery).toMatchObject({ queryKey: ['profile-failed-generations', 'user-123'], enabled: false });

      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });
      expect(queryState.failedQuery?.enabled).toBe(true);

      authState.api.listGenerations.mockClear();
      await queryState.failedQuery?.queryFn?.({ pageParam: null });
      expect(authState.api.listGenerations).toHaveBeenCalledWith(false, { cursor: undefined, limit: 24, status: 'failed' });
    });

    it('lists the failed runs its own pages bring, the ones the library has not reached included', () => {
      // A large library: its first page holds no failure at all.
      queryState.generationsHasNextPage = true;
      queryState.generations = readyRuns(24);
      queryState.profileData = { ...profileWithoutTotals(), stats: { creations: 46, failedCreations: 3, archivedCreations: 0, posts: 0, archivedPosts: 0, saved: 0 } } as never;
      const tree = renderDashboard();

      renderer.act(() => { findPressableByText(tree.root, 'Failed (3)').props.onPress(); });
      queryState.failedPages = [{ generations: failedRuns(3), pagination: { limit: 24, hasMore: false, nextCursor: null } }];
      renderer.act(() => { tree.update(<ProfileDashboard initialTab="Creations" />); });

      expect(failedTiles(tree)).toHaveLength(3);
      // Not one page of the library was read to find them.
      expect(queryState.fetchNextGenerations).not.toHaveBeenCalled();
    });

    it("counts every scope from the profile's totals, whatever has loaded", () => {
      queryState.generationsHasNextPage = true;
      queryState.profileData = { ...profileWithoutTotals(), stats: { creations: 46, failedCreations: 17, archivedCreations: 3, posts: 0, archivedPosts: 0, saved: 0 } } as never;
      const tree = renderDashboard();

      expect(scopeChips(tree)).toEqual(['Active (46)', 'Failed (17)', 'Archived (3)']);
    });

    it('waits on its first page only while it has nothing to draw', () => {
      queryState.failedIsLoading = true;
      const tree = renderDashboard();
      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });
      // The failures the library already holds are drawn while it comes.
      expect(failedTiles(tree)).toHaveLength(2);

      queryState.generations = runs().filter((run) => run.status !== 'failed');
      queryState.profileData = { ...profileWithoutTotals(), stats: { creations: 1, failedCreations: 2, archivedCreations: 0, posts: 0, archivedPosts: 0, saved: 0 } } as never;
      renderer.act(() => { tree.update(<ProfileDashboard initialTab="Creations" />); });
      expect(failedTiles(tree)).toHaveLength(0);
      expect(tree.root.findAllByProps({ children: 'No failed creations' })).toHaveLength(0);
    });

    it('reads further pages of failed runs alone while they are too few to fill the screen', () => {
      queryState.generationsHasNextPage = true;
      queryState.generations = [...readyRuns(PROFILE_MEDIA_MIN_FILL_COUNT), ...failedRuns(2)];
      queryState.failedPages = [{ generations: failedRuns(2), pagination: { limit: 24, hasMore: true, nextCursor: '24' } }];
      queryState.failedHasNextPage = true;
      const tree = renderDashboard();
      // A screenful of tiles fills the Active grid, so nothing more is read for it.
      expect(queryState.fetchNextGenerations).not.toHaveBeenCalled();

      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });

      expect(queryState.fetchNextFailed).toHaveBeenCalledTimes(1);
      expect(queryState.fetchNextGenerations).not.toHaveBeenCalled();
    });

    it('leaves further pages to the end of the list once its failed runs fill the screen', () => {
      queryState.generationsHasNextPage = true;
      queryState.generations = [...readyRuns(PROFILE_MEDIA_MIN_FILL_COUNT), ...failedRuns(PROFILE_MEDIA_MIN_FILL_COUNT)];
      queryState.failedPages = [{
        generations: failedRuns(PROFILE_MEDIA_MIN_FILL_COUNT),
        pagination: { limit: 24, hasMore: true, nextCursor: '24' },
      }];
      queryState.failedHasNextPage = true;
      const tree = renderDashboard();

      renderer.act(() => { findPressableByText(tree.root, `Failed (${PROFILE_MEDIA_MIN_FILL_COUNT})`).props.onPress(); });

      expect(failedTiles(tree)).toHaveLength(PROFILE_MEDIA_MIN_FILL_COUNT);
      expect(queryState.fetchNextFailed).not.toHaveBeenCalled();
      const list = tree.root.find((node) => String(node.type) === 'flash-list');
      renderer.act(() => { list.props.onEndReached(); });
      expect(queryState.fetchNextFailed).toHaveBeenCalledTimes(1);
      expect(queryState.fetchNextGenerations).not.toHaveBeenCalled();
    });

    it('pages Failed after Active has paged, whose last request says nothing about it', () => {
      vi.useFakeTimers();
      queryState.generationsHasNextPage = true;
      queryState.generationPages = [{ generations: readyRuns(3) }];
      queryState.profileData = { ...profileWithoutTotals(), stats: { creations: 3, failedCreations: 2, archivedCreations: 0, posts: 0, archivedPosts: 0, saved: 0 } } as never;
      queryState.failedPages = [{ generations: failedRuns(2), pagination: { limit: 24, hasMore: true, nextCursor: '24' } }];
      queryState.failedHasNextPage = true;
      const tree = renderDashboard();
      // Active, with one page and too few tiles, asked for its second.
      expect(queryState.fetchNextGenerations).toHaveBeenCalledTimes(1);

      renderer.act(() => { vi.advanceTimersByTime(1_000); });
      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });

      expect(queryState.fetchNextFailed).toHaveBeenCalledTimes(1);
      renderer.act(() => { tree.unmount(); });
    });

    it('collapses and reads its own pages again on a pull, and the totals with them', async () => {
      queryState.failedPages = [{ generations: failedRuns(2) }];
      const tree = renderDashboard();
      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });
      queryState.setQueryData.mockClear();

      authState.api.listGenerations.mockImplementation(async () => ({ generations: [], pagination: { limit: 24, hasMore: false, nextCursor: null } }));
      try {
        await renderer.act(async () => { tree.root.findByProps({ accessibilityLabel: 'Refresh Creations' }).props.onPress(); });

        // Its own pages collapse to the first and are read again; the library's
        // first page is merged for the Rendering strip above the list, never
        // refetched page by page.
        expect(queryState.setQueryData.mock.calls.map(([key]) => key)).toEqual([
          ['profile-failed-generations', 'user-123'],
          ['profile-generations', 'user-123'],
        ]);
        expect(queryState.refetchFailed).toHaveBeenCalledTimes(1);
        expect(queryState.refetchGenerations).not.toHaveBeenCalled();
        expect(queryState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['profile', 'user-123'] });
      } finally {
        authState.api.listGenerations.mockReset();
      }
    });

    it("reads the library's first page with its own when it revalidates, so a run tried again shows on the strip", async () => {
      queryState.failedPages = [{ generations: failedRuns(2) }];
      queryState.failedIsStale = true;
      queryState.getQueryData.mockImplementation(() => ({ pages: queryState.failedPages, pageParams: [null] }));
      authState.api.listGenerations.mockImplementation(async () => ({ generations: [], pagination: { limit: 24, hasMore: false, nextCursor: null } }));
      try {
        const tree = renderDashboard();
        queryState.setQueryData.mockClear();

        // Back from a creator where a failed run was tried again: both lists are stale.
        await renderer.act(async () => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });

        // Each first page is merged into its own cache.
        expect(queryState.setQueryData.mock.calls.map(([key]) => key)).toEqual(expect.arrayContaining([
          ['profile-generations', 'user-123'],
          ['profile-failed-generations', 'user-123'],
        ]));
        expect(authState.api.listGenerations).toHaveBeenCalledWith(false, { limit: 24, status: 'failed' });
      } finally {
        authState.api.listGenerations.mockReset();
      }
    });

    it('keeps its query on once opened, which a stale query turned back on would read again page by page', () => {
      const tree = renderDashboard();
      expect(queryState.failedQuery?.enabled).toBe(false);

      renderer.act(() => { findPressableByText(tree.root, 'Failed (2)').props.onPress(); });
      renderer.act(() => { findPressableByText(tree.root, 'Active (1)').props.onPress(); });
      expect(queryState.failedQuery?.enabled).toBe(true);
      renderer.act(() => { tabSegment(tree, 'Posts').props.onPress(); });
      expect(queryState.failedQuery?.enabled).toBe(true);

      // Another library has not opened its Failed scope: its query is off from
      // the very render in which it takes over, so nothing is read for it.
      const signedIn = authState.user;
      try {
        authState.user = { id: 'user-456', email: 'other@example.com' };
        renderer.act(() => { tree.update(<ProfileDashboard initialTab="Creations" />); });
        expect(queryState.failedQuery).toMatchObject({ queryKey: ['profile-failed-generations', 'user-456'], enabled: false });
        const otherLibrary = queryState.failedQueryRenders.filter((render) => render.queryKey[1] === 'user-456');
        expect(otherLibrary.length).toBeGreaterThan(0);
        expect(otherLibrary.every((render) => !render.enabled)).toBe(true);
      } finally {
        authState.user = signedIn;
      }
    });

    it('reads the totals again, and its own first page, when a run leaves the Rendering strip', async () => {
      queryState.failedPages = [{ generations: failedRuns(2) }];
      queryState.getQueryData.mockImplementation(() => ({ pages: queryState.failedPages, pageParams: [null] }));
      const tree = renderDashboard();
      expect(queryState.invalidateQueries).not.toHaveBeenCalled();

      // The run that was rendering has failed.
      queryState.generations = runs().map((run) => (run.id === 'running' ? { ...run, status: 'failed' } : run));
      authState.api.listGenerations.mockClear();
      await renderer.act(async () => { tree.update(<ProfileDashboard initialTab="Creations" />); });

      expect(queryState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['profile', 'user-123'] });
      expect(authState.api.listGenerations).toHaveBeenCalledWith(false, { limit: 24, status: 'failed' });
    });
  });
});

/**
 * Every account starts on a `creator-xxxxxxxx` placeholder handle, whose page
 * stops resolving once a handle is claimed. The hero offers the public page and
 * its link only for a claimed handle, as the web does, and otherwise offers to
 * claim one.
 */
describe('ProfileDashboard public page and handle', () => {
  const claimedProfile = { id: 'user-123', username: 'luna-dreams', displayName: 'Luna Dreams', avatarUrl: 'avatar.png' };

  beforeEach(() => {
    routerState.push.mockClear();
    shareState.share.mockClear();
    authState.api.shareCreatorProfile.mockClear();
    queryState.profileData = claimedProfile;
    queryState.profileError = null;
    queryState.generations = [];
    queryState.ownerPosts = [];
    queryState.savedItems = [];
    queryState.generationPages = null;
    queryState.ownerPostPages = null;
    queryState.savedPages = null;
    queryState.generationsPageParam = undefined;
    queryState.ownerPostsPageParam = undefined;
    queryState.savedMediaPageParam = undefined;
  });

  function renderDashboard(initialTab?: 'Creations' | 'Posts' | 'Saved') {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ProfileDashboard initialTab={initialTab} />);
    });
    return tree;
  }

  it('offers the public page and its link for a claimed handle, filed as the owner’s own share', async () => {
    const tree = renderDashboard();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Claim your handle' })).toHaveLength(0);

    renderer.act(() => { findPressableByText(tree.root, 'View public profile').props.onPress(); });
    expect(routerState.push).toHaveBeenCalledWith('/creators/luna-dreams');

    await renderer.act(async () => {
      findPressableByText(tree.root, 'Share profile').props.onPress();
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    });
    expect(shareState.share).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringMatching(/\/creators\/luna-dreams\?s=profile$/),
    }));
    expect(authState.api.shareCreatorProfile).toHaveBeenCalledWith('luna-dreams', { sourceSurface: 'profile' });
  });

  it('offers to claim a handle instead, on the signup placeholder', () => {
    queryState.profileData = { ...claimedProfile, username: 'creator-1a2b3c4d' };
    const tree = renderDashboard();

    expect(tree.root.findAllByProps({ accessibilityLabel: 'View public profile' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Share profile' })).toHaveLength(0);
    const claim = tree.root.findByProps({ accessibilityLabel: 'Claim your handle' });
    expect(claim.props.accessibilityRole).toBe('button');
    renderer.act(() => { claim.props.onPress(); });
    expect(routerState.push).toHaveBeenCalledWith('/edit-profile');
  });

  it('offers neither while the profile has not answered', () => {
    queryState.profileData = null;
    const tree = renderDashboard();

    expect(tree.root.findAllByProps({ accessibilityLabel: 'Claim your handle' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'View public profile' })).toHaveLength(0);
  });

  it('counts Active and Archived posts from the server’s totals, as the Posts stat does', () => {
    (queryState as { profileData: unknown }).profileData = {
      ...claimedProfile,
      stats: { creations: 3, posts: 19, archivedPosts: 4, saved: 2 },
    };
    const tree = renderDashboard('Posts');

    expect(tree.root.findByProps({ accessibilityLabel: 'Active (19)' })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: 'Archived (4)' })).toBeTruthy();
  });

  it('reads the Wallet from the payout state alone, never from a Posts page', () => {
    queryState.ownerPostPages = [{ posts: [], summary: { earningsUsdCents: 999, listingCount: 1, salesCount: 1 } }];
    const tree = renderDashboard('Posts');
    const wallet = findPressableByText(tree.root, 'Wallet');

    expect(wallet.findAll((node) => node.type === 'text' && node.props.children === '–')).toHaveLength(1);
    expect(wallet.findAll((node) => node.type === 'text' && node.props.children === '$9.99')).toHaveLength(0);
  });
});
