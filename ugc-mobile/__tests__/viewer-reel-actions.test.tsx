(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(global as unknown as { requestAnimationFrame: (callback: (time: number) => void) => number })
  .requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
(global as unknown as { cancelAnimationFrame: (handle: number) => void }).cancelAnimationFrame = () => undefined;

import { QueryClient, QueryClientProvider, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import React from 'react';
import { AccessibilityInfo, Share } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reel screen rendered over a real query cache, with the native parts
 * (slides, players, the zoom, sheets) as doubles. What it hands each item's
 * actions (`callbacksFor`), the list it draws and the post it tells its zoom
 * the reader is on are what these tests read. The actions run through the
 * real `useViewerActionHandlers`, as the ••• menu and its sheet run them.
 */

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

// One router object for every render: a new one per render hangs these suites.
const routerState = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  back: vi.fn(),
  canGoBack: vi.fn(() => true),
  push: vi.fn(),
  replace: vi.fn(),
  setParams: vi.fn(),
}));

const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

// One object for every render, as the real context provides.
const authState = vi.hoisted(() => ({
  api: {
    blockUser: vi.fn(),
    deleteGeneration: vi.fn(),
    getCreatorProfile: vi.fn(),
    listGenerations: vi.fn(),
    listOwnerPosts: vi.fn(async () => ({ success: true, posts: [], pageInfo: { hasMore: false, nextOffset: null } })),
    getProfile: vi.fn(() => new Promise<never>(() => undefined)),
    getShowcaseFeed: vi.fn(),
    getShowcasePost: vi.fn(),
    saveShowcasePost: vi.fn(),
    recordShowcaseFeedEvent: vi.fn((_request: { eventType: string; deliveryId?: string; postId?: string }) => Promise.resolve()),
    shareShowcasePost: vi.fn((_postId: string, _options: { sourceSurface: string }) => Promise.resolve()),
    undoFeedFeedback: vi.fn((_request: { feedbackType: string; postId?: string; creatorId?: string }) => (
      Promise.resolve({ ok: true, removed: true })
    )),
  },
  identityUserId: 'viewer-1' as string | null,
  user: { id: 'viewer-1', email: 'viewer@example.com' } as { id: string; email: string } | null,
}));

const dialogs = vi.hoisted(() => ({
  confirm: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}));

// The notice module stands in as an account that has already been told,
// unless a case hands the tap to the real one.
const saverNotice = vi.hoisted(() => {
  const state = {
    real: null as null | typeof import('@/lib/saver-notice'),
    useReal: false,
    fields: vi.fn((accountId: string | null | undefined, shouldSave: boolean): { creatorSeesSaver?: true; saverNotYetTold?: true } => {
      if (state.useReal) return state.real!.creatorSeesSaverFields(accountId, shouldSave);
      return accountId && shouldSave ? { creatorSeesSaver: true as const } : {};
    }),
  };
  return state;
});

// What the screen hands its actions menu and its zoom stage, render by render.
const screenState = vi.hoisted(() => ({
  callbacksFor: null as null | ((item: unknown) => Record<string, unknown>),
  zoomOptions: null as null | { activeItemId: string | null; activePost: unknown },
  zoom: {
    chromeDrawn: false,
    dismiss: vi.fn(),
    drawn: false,
    landed: false,
    lentVideo: null,
    opened: true,
    reportChromeDrawn: vi.fn(),
    reportNeighbourDrawn: vi.fn(),
    veil: null,
  },
}));

const passThrough = vi.hoisted(() => ({ children }: { children?: unknown }) => children ?? null);
const nothing = vi.hoisted(() => () => null);

vi.mock('expo-router', () => ({
  router: routerState,
  Stack: { Screen: nothing },
  useLocalSearchParams: () => routerState.params,
}));

vi.mock('expo-status-bar', () => ({ StatusBar: nothing }));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(), announceForAccessibilityWithOptions: vi.fn() },
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Animated: { View: passThrough, Value: class { setValue() {} } },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  Easing: { bezier: () => (value: number) => value, out: (value: unknown) => value, ease: (value: number) => value },
  FlatList: (props: MockProps) => React.createElement('flat-list', props),
  Linking: { openURL: vi.fn() },
  Platform: {
    get OS() {
      return platformState.os;
    },
    Version: 0,
    select: (options: Record<string, unknown>) => options[platformState.os] ?? options.default,
  },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  Share: {
    dismissedAction: 'dismissedAction',
    share: vi.fn(),
    sharedAction: 'sharedAction',
  },
  StatusBar: { currentHeight: 0 },
  StyleSheet: { absoluteFill: {}, absoluteFillObject: {}, create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  AudioLines: nothing,
  ImageOff: nothing,
  Play: nothing,
  Volume2: nothing,
  VolumeX: nothing,
}));

vi.mock('@/components/viewer-actions-menu', () => ({
  ViewerActionsMenuProvider: ({ callbacksFor, children }: { callbacksFor: (item: unknown) => Record<string, unknown>; children?: unknown }) => {
    screenState.callbacksFor = callbacksFor;
    return children ?? null;
  },
}));

vi.mock('@/components/media-zoom', () => ({
  MediaZoomChrome: passThrough,
  MediaZoomStage: passThrough,
  peekOpeningPost: () => null,
  peekOpeningPreview: () => null,
  useMediaZoomLanded: () => true,
  useMediaZoomLentVideo: () => null,
  useMediaZoomOpened: () => true,
  useMediaZoomPaintReport: () => () => undefined,
  useMediaZoomStage: (options: { activeItemId: string | null; activePost: unknown }) => {
    screenState.zoomOptions = options;
    return screenState.zoom;
  },
  useMediaZoomUncovering: () => false,
}));

vi.mock('@/components/apple-zoom', () => ({
  AppleZoomTarget: nothing,
  useAppleZoomRetarget: () => undefined,
  useAppleZoomSourceId: () => null,
}));
vi.mock('@/components/apple-zoom-progress', () => ({ AppleZoomProgress: nothing }));
vi.mock('@/components/app-scheme-scope', () => ({ AppSchemeScope: passThrough }));
vi.mock('@/components/audio-creation-player', () => ({ AudioCreationPlayer: nothing }));
vi.mock('@/components/comments-sheet', () => ({ CommentsSheet: nothing }));
vi.mock('@/components/double-tap-pressable', () => ({ DoubleTapPressable: passThrough }));
vi.mock('@/components/feed-media-frame', () => ({ FeedMediaFrame: nothing }));
// Its props are what the tests read: the notice it shows, and its Undo.
vi.mock('@/components/feed-undo-notice', () => ({
  FeedUndoNotice: (props: MockProps) => React.createElement('feed-undo-notice', props),
}));
vi.mock('@/components/letterbox-bands', () => ({ LetterboxBands: nothing }));
vi.mock('@/components/post-details-page', () => ({ PostDetailsPage: nothing }));
vi.mock('@/components/reel-chrome', () => ({ IconShadow: passThrough, ReelSlideChrome: nothing }));
vi.mock('@/components/top-scrim', () => ({ TopScrim: nothing }));
vi.mock('@/components/ui', () => ({ SecondaryButton: nothing, StatusBlock: nothing }));
vi.mock('@/components/unlock-remix-prompt', () => ({ UnlockRemixPrompt: nothing }));
vi.mock('@/components/viewer-action-sheet', () => ({ ViewerActionSheet: nothing }));
vi.mock('@/components/viewer-top-control', () => ({ ViewerTopControl: nothing }));
vi.mock('@/components/zoom-post-chrome', () => ({ ZoomPostChrome: nothing }));

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://magicbooklet.com' } }));
vi.mock('@/lib/dialog', () => ({
  showConfirmDialog: dialogs.confirm,
  showErrorDialog: dialogs.error,
  showMessageDialog: dialogs.message,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('@/lib/saver-notice', async (importOriginal) => {
  saverNotice.real = await importOriginal<typeof import('@/lib/saver-notice')>();
  return { creatorSeesSaverFields: saverNotice.fields };
});
vi.mock('@/lib/action-sheet', () => ({ showActionSheet: vi.fn() }));
vi.mock('@/lib/haptics', () => ({
  haptic: { error: vi.fn(), light: vi.fn(), select: vi.fn(), soft: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/feed-event-queue', () => ({
  enqueueShowcaseFeedEvent: vi.fn(() => Promise.resolve()),
  flushShowcaseFeedEvents: vi.fn(() => Promise.resolve()),
  isBatchedShowcaseFeedEventType: (eventType: string) => (
    ['impression', 'open', 'dwell', 'media_progress', 'quick_skip', 'resource_open'].includes(eventType)
  ),
}));
vi.mock('@/lib/post-lifecycle', () => ({
  archivePost: vi.fn(),
  changePostVisibility: vi.fn(),
  deletePost: vi.fn(),
  pickPostVisibility: vi.fn(),
  resolveLinkedLifecyclePost: vi.fn(),
  restorePost: vi.fn(),
  toPostLifecyclePost: (post: unknown) => post,
}));
vi.mock('@/lib/use-profile-library-source', () => ({
  isProfileLibrarySource: (source: string) => source === 'profile-creations' || source === 'profile-posts',
  useProfileLibrarySource: () => ({
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    items: null,
    refetch: vi.fn(),
    retrySelection: vi.fn(),
    selection: 'none',
  }),
}));
vi.mock('@/lib/media-zoom-transition', () => ({
  mediaItemAspectRatio: () => null,
  mediaRectInScreen: () => ({ x: 0, y: 0, width: 390, height: 844 }),
  showcaseMediaZoomPreview: () => null,
  showcaseViewerMediaPicture: () => null,
}));
vi.mock('@/lib/viewer-playback-handoff', () => ({
  createViewerPlaybackHandoff: () => ({ handoff: vi.fn(), playerFor: vi.fn(), setAutoplayAllowed: vi.fn() }),
}));
vi.mock('@/lib/video-player-loans', () => ({ isVideoPlayerHandedBack: () => false }));
vi.mock('@/lib/use-viewer-video-player', () => ({ useViewerVideoPlayer: () => null }));
vi.mock('@/lib/use-decoded-image-aspect-ratio', () => ({ useDecodedImageAspectRatio: () => null }));
vi.mock('@/lib/use-media-source', () => ({ useMediaSource: () => null }));
vi.mock('@/lib/use-video-load-deadline', () => ({ useVideoLoadDeadline: () => undefined }));
vi.mock('@/lib/video-playback-continuity', () => ({ restoreVideoPlayback: vi.fn() }));
vi.mock('@/lib/reel-backdrop', () => ({ useReelBackdrop: () => undefined }));
vi.mock('@/lib/viewer-audio', () => ({
  hydrateViewerAudioMuted: vi.fn(() => Promise.resolve()),
  isViewerAudioMuted: () => true,
  toggleViewerAudioMuted: vi.fn(),
  useViewerAudioMuted: () => true,
}));
vi.mock('@/lib/viewer-refresh-indicator', () => ({ useViewerRefreshSpinner: () => false }));
vi.mock('@/lib/platform-glyphs', () => ({ BackGlyph: nothing }));
vi.mock('@/lib/use-creator-follow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-creator-follow')>()),
  useCreatorFollow: () => ({}),
}));
vi.mock('@/lib/use-hardware-back', () => ({ useHardwareBack: () => undefined }));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => false }));
vi.mock('@/lib/system-bars', () => ({ useNavigationBarSurface: () => undefined }));
vi.mock('@/lib/theme-context', () => ({
  ThemeScope: passThrough,
  useAppTheme: () => ({ colors: { primary: '#ff6b5a' } }),
}));
vi.mock('@/lib/safe-area', () => ({
  resolvedBottomInset: (inset: number) => inset,
  resolvedTopInset: (inset: number) => inset,
}));
vi.mock('@/lib/use-screen-leaving', () => ({ useScreenLeaving: () => false }));
vi.mock('@/lib/use-viewer-playback-gate', () => ({ useViewerPlaybackGate: () => ({}) }));
vi.mock('@/lib/use-stable-signed-url', () => ({ useStableSignedUrl: (url: unknown) => url }));
vi.mock('@/lib/unlock-cache', () => ({ refreshUnlockedBundleCaches: vi.fn() }));
vi.mock('@/lib/remix-start', () => ({ startShowcaseRemix: vi.fn() }));

import ImmersivePreviewViewerScreen from '@/app/viewer';
import type { FeedUndoNoticeModel } from '@/components/feed-undo-notice';
import { haptic } from '@/lib/haptics';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import {
  filterAnonymousSessionShowcaseFeedItems,
  resetAnonymousShowcaseFeedRemovalsForTests,
  resetFeedFeedbackRequestsForTests,
} from '@/lib/showcase-feed-events';
import { serializeShowcaseFeedLane, showcaseFeedLaneQueryOptions } from '@/lib/showcase-feed-lane';
import type { CreatorProfileResponse, ShowcaseFeedItem, ShowcaseFeedResponse } from '@/lib/types';
import { useViewerActionHandlers } from '@/lib/use-viewer-action-handlers';

const LANE = { sort: 'for-you' } as const;
const maya = { id: 'creator-maya', username: 'maya' };
const luna = { id: 'creator-luna', username: 'luna' };
const nova = { id: 'creator-nova', username: 'nova' };

function feedItem(id: string, creator: { id: string; username: string }, deliveryId: string): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: `https://cdn.example.com/${id}.jpg`,
    mediaKind: 'image',
    model: 'manual',
    title: `Post ${id}`,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-01T10:00:00.000Z',
    creator: { id: creator.id, username: creator.username, name: creator.username, avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    recommendation: { deliveryId, position: 0, algorithmVersion: 'for-you-rules-v4' },
  } as ShowcaseFeedItem;
}

/** Luna's two posts sit between Maya's and Nova's; the reel opens on Luna's first. */
const lanePosts = () => [
  feedItem('post-a', maya, 'delivery-a'),
  feedItem('post-b', luna, 'delivery-b'),
  feedItem('post-c', luna, 'delivery-c'),
  feedItem('post-d', nova, 'delivery-d'),
];

let queryClient: QueryClient;
const trees: renderer.ReactTestRenderer[] = [];

function seedLane(identity: string | null, items: ShowcaseFeedItem[]): QueryKey {
  const { queryKey } = showcaseFeedLaneQueryOptions(authState.api as never, LANE, identity);
  queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(queryKey, {
    pages: [{
      items,
      feedSessionId: 'session-1',
      algorithmVersion: 'for-you-rules-v4',
      nextCursor: null,
      pageInfo: { hasMore: false, nextOffset: null },
    }],
    pageParams: [{ offset: 0 }],
  });
  return queryKey;
}

function laneIds(queryKey: QueryKey) {
  return queryClient.getQueryData<InfiniteData<ShowcaseFeedResponse>>(queryKey)?.pages
    .flatMap((page) => page.items.map((item) => item.id));
}

/** Lets the cache's notifications and the screen's renders land. */
async function settle() {
  await act(async () => {
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** The route a lane's tile opens: the reel reads and pages that lane. */
const LANE_ROUTE = { source: 'showcase-feed', lane: serializeShowcaseFeedLane(LANE) };

async function renderReel(initialId = 'post-b', route: Record<string, string> = LANE_ROUTE) {
  routerState.params = { ...route, initialId };
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <QueryClientProvider client={queryClient}>
        <ImmersivePreviewViewerScreen />
      </QueryClientProvider>
    );
  });
  trees.push(tree);
  await settle();
  return tree;
}

function reelIds(tree: renderer.ReactTestRenderer) {
  return (tree.root.findByType('flat-list' as never).props.data as ImmersivePreviewItem[]).map((item) => item.id);
}

const activeId = () => screenState.zoomOptions?.activeItemId ?? null;
const activeItem = () => screenState.zoomOptions?.activePost as ImmersivePreviewItem;

/** The item's ••• actions as the menu runs them: the real handlers over the screen's callbacks. */
function actionsFor(item: ImmersivePreviewItem) {
  let handlers!: ReturnType<typeof useViewerActionHandlers>;
  function Probe() {
    handlers = useViewerActionHandlers({ item, ...screenState.callbacksFor!(item) } as never);
    return null;
  }
  act(() => {
    trees.push(renderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    ));
  });
  return handlers;
}

const sentEventTypes = () => authState.api.recordShowcaseFeedEvent.mock.calls.map(([request]) => request.eventType);

type UndoNoticeProps = { notice: FeedUndoNoticeModel | null; onDismiss: (id: string) => void; bottomOffset: number };
const undoNoticeProps = (tree: renderer.ReactTestRenderer) => (
  tree.root.findByType('feed-undo-notice' as never).props as UndoNoticeProps
);

/** Undo pressed on the notice showing, as the notice runs it: the choice, then its own dismissal. */
async function pressUndo(tree: renderer.ReactTestRenderer) {
  const { notice, onDismiss } = undoNoticeProps(tree);
  expect(notice).not.toBeNull();
  await act(async () => {
    notice!.onUndo();
    onDismiss(notice!.id);
  });
  await settle();
}

async function chooseNotInterested() {
  await act(async () => {
    (screenState.callbacksFor!(activeItem()).onNotInterested as () => void)();
  });
  await settle();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settleWith, failWith) => {
    resolve = settleWith;
    reject = failWith;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  platformState.os = 'ios';
  authState.user = { id: 'viewer-1', email: 'viewer@example.com' };
  authState.identityUserId = 'viewer-1';
  routerState.canGoBack.mockReturnValue(true);
  // A post looked up on its own is not found, unless a test says otherwise.
  authState.api.getShowcasePost.mockRejectedValue(Object.assign(new Error('Post not found.'), { status: 404 }));
  // Choices are sent and taken back, unless a test says otherwise.
  authState.api.recordShowcaseFeedEvent.mockReset().mockImplementation(() => Promise.resolve());
  authState.api.undoFeedFeedback.mockReset().mockImplementation(() => Promise.resolve({ ok: true, removed: true }));
  screenState.callbacksFor = null;
  screenState.zoomOptions = null;
});

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
  queryClient.clear();
  resetAnonymousShowcaseFeedRemovalsForTests();
  resetFeedFeedbackRequestsForTests();
});

describe('Block user from the reel', () => {
  // It used to refresh every feed and close the reel: Home's and Explore's
  // loaded pages were read again behind it as new ranked sessions (audit 02-4).
  it('stays open on the next post by someone else, takes the creator out of the reel and its lane, and reads no lane again', async () => {
    const laneKey = seedLane('viewer-1', lanePosts());
    const tree = await renderReel('post-b');
    expect(activeId()).toBe('post-b');
    expect(reelIds(tree)).toEqual(['post-a', 'post-b', 'post-c', 'post-d']);

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    dialogs.confirm.mockResolvedValue(true);
    authState.api.blockUser.mockResolvedValue({ success: true });
    // The post the reel was opened on leaves its lane. The lane source does
    // not ask for it again: a post the lane held and the reader took out stays
    // out (`useShowcaseLaneSource`).
    const actions = actionsFor(activeItem());
    expect(actions.actions).toContain('block-user');

    await act(async () => {
      actions.handleAction('block-user');
    });
    await settle();

    expect(authState.api.blockUser).toHaveBeenCalledWith('creator-luna');
    // Luna's next post is skipped too: the reader lands on Nova's.
    expect(activeId()).toBe('post-d');
    expect(authState.api.getShowcasePost).not.toHaveBeenCalled();
    expect(reelIds(tree)).toEqual(['post-a', 'post-d']);
    // The grid behind the reel reads the same pages, without Luna's posts.
    expect(laneIds(laneKey)).toEqual(['post-a', 'post-d']);
    // No creator's grid is read again: Luna's cached pages say she is blocked
    // instead (audit 02-8), and only the Saved list and its count are read.
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    // Home's shelf is marked stale (no read); the Saved list and its count are read again.
    expect(invalidated).toEqual([['home-shelf'], ['profile-saved-media', 'viewer-1'], ['profile', 'viewer-1']]);
    expect(authState.api.getShowcaseFeed).not.toHaveBeenCalled();
    expect(screenState.zoom.dismiss).not.toHaveBeenCalled();
    expect(routerState.back).not.toHaveBeenCalled();
    expect(dialogs.error).not.toHaveBeenCalled();
  });

  it('leaves the reel when every post in it was by the blocked creator', async () => {
    seedLane('viewer-1', [feedItem('post-b', luna, 'delivery-b'), feedItem('post-c', luna, 'delivery-c')]);
    await renderReel('post-b');

    dialogs.confirm.mockResolvedValue(true);
    authState.api.blockUser.mockResolvedValue({ success: true });
    const actions = actionsFor(activeItem());
    await act(async () => {
      actions.handleAction('block-user');
    });
    await settle();

    expect(routerState.back).toHaveBeenCalledTimes(1);
    expect(screenState.zoom.dismiss).not.toHaveBeenCalled();
  });
});

describe("the reel's Share", () => {
  // Android's share intent answers "shared" whether or not anything was sent
  // (`invite.tsx`), so only iOS can count a share (audit 04-4).
  it.each([
    ['android', 'sharedAction', false],
    ['ios', 'sharedAction', true],
    ['ios', 'dismissedAction', false],
  ] as const)('on %s, a sheet that answers %s counts a share: %s', async (os, action, counted) => {
    platformState.os = os;
    seedLane('viewer-1', lanePosts());
    await renderReel('post-b');
    vi.mocked(Share.share).mockResolvedValueOnce({ action: Share[action] } as never);

    await act(async () => {
      (screenState.callbacksFor!(activeItem()).onShare as () => void)();
    });
    await settle();

    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/showcase/post-b'),
    }));
    expect(authState.api.shareShowcasePost.mock.calls).toEqual(
      counted ? [['post-b', { sourceSurface: 'showcase-reel' }]] : []
    );
    expect(sentEventTypes().filter((type) => type === 'share')).toHaveLength(counted ? 1 : 0);
  });

  it('counts nothing and throws nothing when the sheet fails to open', async () => {
    seedLane('viewer-1', lanePosts());
    await renderReel('post-b');
    vi.mocked(Share.share).mockRejectedValueOnce(new Error('No activity found to handle Intent'));

    await act(async () => {
      (screenState.callbacksFor!(activeItem()).onShare as () => void)();
    });
    await settle();

    expect(authState.api.shareShowcasePost).not.toHaveBeenCalled();
    expect(sentEventTypes()).not.toContain('share');
  });
});

describe("a guest's reel", () => {
  // The grids key a guest's lanes by the guest's identity (audit 04-3); a reel
  // keyed by the registered id read the installation's lane instead, missed the
  // grid's pages and asked for a page of its own.
  it("reads the grid's own pages under the guest's identity, and takes a dismissed post out of them", async () => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    const laneKey = seedLane('guest-1', lanePosts());
    const tree = await renderReel('post-b');

    expect(activeId()).toBe('post-b');
    expect(reelIds(tree)).toEqual(['post-a', 'post-b', 'post-c', 'post-d']);
    expect(authState.api.getShowcaseFeed).not.toHaveBeenCalled();

    await act(async () => {
      (screenState.callbacksFor!(activeItem()).onNotInterested as () => void)();
    });
    await settle();

    expect(activeId()).toBe('post-c');
    expect(laneIds(laneKey)).toEqual(['post-a', 'post-c', 'post-d']);
    expect(sentEventTypes()).toContain('not_interested');
  });
});

// A guest can generate, so the reel's Recreate opens a guest's own creation in
// the creator, as it does an account's; anyone else's post still asks the guest
// to sign in first.
describe("the reel's Recreate for a guest", () => {
  const creation = (id: string) => ({
    id,
    output_url: `https://cdn.example.com/${id}.png`,
    status: 'succeeded',
    created_at: '2026-10-01T10:00:00.000Z',
    model: 'image-model',
    category: 'image',
    title: `Creation ${id}`,
    prompt: 'A product still',
  });
  const recreateActive = () => act(async () => {
    (screenState.callbacksFor!(activeItem()).onRecreate as () => void)();
  });

  beforeEach(() => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
  });

  it('opens its own creation in the creator, with no sign-in first', async () => {
    authState.api.listGenerations.mockResolvedValue({ generations: [creation('gen-a'), creation('gen-b')] });
    await renderReel('gen-b', { source: 'studio-creations' });
    expect(activeId()).toBe('gen-b');

    await recreateActive();

    expect(routerState.push).toHaveBeenCalledTimes(1);
    expect(routerState.push.mock.calls[0][0]).toMatch(/^\/create\/image\?remix=gen-b&prompt=A\+product\+still&/);
  });

  it('asks it to sign in before recreating a post from the feed', async () => {
    seedLane('guest-1', lanePosts());
    await renderReel('post-b');

    await recreateActive();

    expect(routerState.push).toHaveBeenCalledTimes(1);
    expect(routerState.push.mock.calls[0][0]).toMatchObject({ pathname: '/auth', params: { returnTo: expect.any(String) } });
  });

  it('asks a device with no identity at all to sign in, even for a creation', async () => {
    authState.identityUserId = null;
    authState.api.listGenerations.mockResolvedValue({ generations: [creation('gen-b')] });
    await renderReel('gen-b', { source: 'studio-creations' });

    await recreateActive();

    expect(routerState.push.mock.calls[0][0]).toMatchObject({ pathname: '/auth' });
  });
});

// Product decision D7 (2026-10-14): Undo is a preference delete, offered for
// five seconds, and the post returns to the index it left.
describe('Undo after Not interested or Hide in the reel', () => {
  const ALL = ['post-a', 'post-b', 'post-c', 'post-d'];
  const postB = () => feedItem('post-b', luna, 'delivery-b');

  it('offers Undo above the safe area, and puts the post back at its index and the reel on it once the server took the choice back', async () => {
    const laneKey = seedLane('viewer-1', lanePosts());
    const tree = await renderReel('post-b');
    const undo = deferred<{ ok: boolean; removed: boolean }>();
    authState.api.undoFeedFeedback.mockReturnValueOnce(undo.promise);

    await chooseNotInterested();

    expect(activeId()).toBe('post-c');
    expect(reelIds(tree)).toEqual(['post-a', 'post-c', 'post-d']);
    const { notice, bottomOffset } = undoNoticeProps(tree);
    expect(notice).toMatchObject({ id: expect.stringMatching(/^showcase:/), message: 'Post hidden' });
    // Above the safe area (24 here), below the rail (which starts 96 above it).
    expect(bottomOffset).toBeGreaterThan(24);
    expect(bottomOffset).toBeLessThan(24 + 96);
    // The notice speaks for the choice; the reel announces nothing of its own.
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();

    await pressUndo(tree);

    expect(authState.api.undoFeedFeedback.mock.calls).toEqual([[{ feedbackType: 'not_interested', postId: 'post-b' }]]);
    expect(undoNoticeProps(tree).notice).toBeNull();
    // Nothing comes back before the server has answered.
    expect(reelIds(tree)).toEqual(['post-a', 'post-c', 'post-d']);
    expect(laneIds(laneKey)).toEqual(['post-a', 'post-c', 'post-d']);
    expect(activeId()).toBe('post-c');

    await act(async () => {
      undo.resolve({ ok: true, removed: true });
    });
    await settle();

    expect(reelIds(tree)).toEqual(ALL);
    expect(laneIds(laneKey)).toEqual(ALL);
    expect(activeId()).toBe('post-b');
    expect(dialogs.message).not.toHaveBeenCalled();
    expect(haptic.error).not.toHaveBeenCalled();
    expect(routerState.back).not.toHaveBeenCalled();
    // A preference delete, not a feed event: the only event is the choice.
    expect(sentEventTypes()).toEqual(['not_interested']);
  });

  it("brings back every post Hide took, each at its index, and the reel to the one the reader was on", async () => {
    const laneKey = seedLane('viewer-1', lanePosts());
    const tree = await renderReel('post-b');

    await act(async () => {
      (screenState.callbacksFor!(activeItem()).onHideCreator as () => void)();
    });
    await settle();

    expect(activeId()).toBe('post-d');
    expect(reelIds(tree)).toEqual(['post-a', 'post-d']);
    expect(undoNoticeProps(tree).notice?.message).toBe('Creator hidden');

    await pressUndo(tree);

    expect(authState.api.undoFeedFeedback.mock.calls).toEqual([[{ feedbackType: 'hide_creator', creatorId: 'creator-luna' }]]);
    expect(reelIds(tree)).toEqual(ALL);
    expect(laneIds(laneKey)).toEqual(ALL);
    expect(activeId()).toBe('post-b');
  });

  it('keeps a page the lane loaded while the notice was up', async () => {
    const laneKey = seedLane('viewer-1', lanePosts());
    const tree = await renderReel('post-b');

    await chooseNotInterested();
    // The reader pages on under the notice: the lane's next page lands.
    act(() => {
      queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(laneKey, (data) => data && {
        pages: [...data.pages, { ...data.pages[0], items: [feedItem('post-e', nova, 'delivery-e')] }],
        pageParams: [...data.pageParams, { offset: 4 }],
      });
    });
    await settle();
    expect(reelIds(tree)).toEqual(['post-a', 'post-c', 'post-d', 'post-e']);

    await pressUndo(tree);

    expect(laneIds(laneKey)).toEqual([...ALL, 'post-e']);
    expect(reelIds(tree)).toEqual([...ALL, 'post-e']);
    expect(activeId()).toBe('post-b');
  });

  it('keeps the post hidden, and says so, when the server refuses the undo', async () => {
    const laneKey = seedLane('viewer-1', lanePosts());
    const tree = await renderReel('post-b');
    authState.api.undoFeedFeedback.mockRejectedValueOnce(new Error('Network request failed'));

    await chooseNotInterested();
    await pressUndo(tree);

    expect(reelIds(tree)).toEqual(['post-a', 'post-c', 'post-d']);
    expect(laneIds(laneKey)).toEqual(['post-a', 'post-c', 'post-d']);
    expect(activeId()).toBe('post-c');
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(dialogs.message.mock.calls).toEqual([[{
      title: 'Couldn’t undo',
      message: 'The post is still hidden. Check your connection and try again.',
    }]]);
  });

  it('waits for its own choice to reach the server before taking it back', async () => {
    seedLane('viewer-1', lanePosts());
    const tree = await renderReel('post-b');
    const sent = deferred<void>();
    authState.api.recordShowcaseFeedEvent.mockImplementation((request) => (
      request.eventType === 'not_interested' ? sent.promise : Promise.resolve()
    ));

    await chooseNotInterested();
    await pressUndo(tree);
    // Sent first, the delete could land before the row it deletes.
    expect(authState.api.undoFeedFeedback).not.toHaveBeenCalled();

    await act(async () => {
      sent.resolve();
    });
    await settle();

    expect(authState.api.undoFeedFeedback).toHaveBeenCalledTimes(1);
    expect(reelIds(tree)).toEqual(ALL);
    expect(activeId()).toBe('post-b');
  });

  it('takes the notice down, puts the post back and says so when the choice fails to send', async () => {
    const laneKey = seedLane('viewer-1', lanePosts());
    const tree = await renderReel('post-b');
    authState.api.recordShowcaseFeedEvent.mockImplementation((request) => (
      request.eventType === 'not_interested' ? Promise.reject(new Error('Network request failed')) : Promise.resolve()
    ));

    await chooseNotInterested();

    expect(undoNoticeProps(tree).notice).toBeNull();
    expect(reelIds(tree)).toEqual(ALL);
    expect(laneIds(laneKey)).toEqual(ALL);
    expect(activeId()).toBe('post-b');
    expect(dialogs.message.mock.calls).toEqual([[{
      title: 'Couldn’t update your feed',
      message: 'The post was restored. Check your connection and try again.',
    }]]);
  });

  it('says one thing when the choice fails to send while its Undo waits for it', async () => {
    seedLane('viewer-1', lanePosts());
    const tree = await renderReel('post-b');
    const sent = deferred<void>();
    authState.api.recordShowcaseFeedEvent.mockImplementation((request) => (
      request.eventType === 'not_interested' ? sent.promise : Promise.resolve()
    ));
    authState.api.undoFeedFeedback.mockRejectedValueOnce(new Error('Network request failed'));

    await chooseNotInterested();
    await pressUndo(tree);
    await act(async () => {
      sent.reject(new Error('Network request failed'));
    });
    await settle();

    // A failed send may still have written the row, so the undo still goes out.
    expect(authState.api.undoFeedFeedback).toHaveBeenCalledTimes(1);
    // The failed send already put the post back and said so; "still hidden" would be wrong.
    expect(reelIds(tree)).toEqual(ALL);
    expect(activeId()).toBe('post-b');
    expect(dialogs.message.mock.calls.map(([options]) => options.title)).toEqual(['Couldn’t update your feed']);
    expect(haptic.error).not.toHaveBeenCalled();
  });

  it('sends nothing for a device with no session, and clears its memory of the removal', async () => {
    authState.user = null;
    authState.identityUserId = null;
    const laneKey = seedLane(null, lanePosts());
    const tree = await renderReel('post-b');

    await chooseNotInterested();
    expect(filterAnonymousSessionShowcaseFeedItems([postB()])).toEqual([]);
    expect(reelIds(tree)).toEqual(['post-a', 'post-c', 'post-d']);

    await pressUndo(tree);

    expect(authState.api.undoFeedFeedback).not.toHaveBeenCalled();
    expect(filterAnonymousSessionShowcaseFeedItems([postB()]).map((item) => item.id)).toEqual(['post-b']);
    expect(reelIds(tree)).toEqual(ALL);
    expect(laneIds(laneKey)).toEqual(ALL);
    expect(activeId()).toBe('post-b');
  });

  // D1: an app guest's anonymous session is a user to the feed; its choice is
  // stored under that id, so its Undo goes to the server too.
  it("takes a guest's choice back under the guest's session, and clears the device's memory once the server answered", async () => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    const laneKey = seedLane('guest-1', lanePosts());
    const tree = await renderReel('post-b');
    const undo = deferred<{ ok: boolean; removed: boolean }>();
    authState.api.undoFeedFeedback.mockReturnValueOnce(undo.promise);

    await chooseNotInterested();
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
    await pressUndo(tree);

    expect(authState.api.undoFeedFeedback.mock.calls).toEqual([[{ feedbackType: 'not_interested', postId: 'post-b' }]]);
    expect(filterAnonymousSessionShowcaseFeedItems([postB()])).toEqual([]);

    await act(async () => {
      undo.resolve({ ok: true, removed: true });
    });
    await settle();

    expect(filterAnonymousSessionShowcaseFeedItems([postB()]).map((item) => item.id)).toEqual(['post-b']);
    expect(reelIds(tree)).toEqual(ALL);
    expect(laneIds(laneKey)).toEqual(ALL);
    expect(activeId()).toBe('post-b');
  });

  it('leaves a reel the choice empties once it is sent, as before, with no Undo', async () => {
    seedLane('viewer-1', [feedItem('post-b', luna, 'delivery-b')]);
    const tree = await renderReel('post-b');

    await chooseNotInterested();

    expect(routerState.back).toHaveBeenCalledTimes(1);
    expect(screenState.zoom.dismiss).not.toHaveBeenCalled();
    expect(tree.root.findAllByType('feed-undo-notice' as never)).toHaveLength(0);
    expect(dialogs.message).not.toHaveBeenCalled();
  });

  it('drops a notice still showing when a later choice empties the reel; that earlier choice stands', async () => {
    const laneKey = seedLane('viewer-1', [feedItem('post-b', luna, 'delivery-b'), feedItem('post-d', nova, 'delivery-d')]);
    const tree = await renderReel('post-b');
    await chooseNotInterested();
    expect(activeId()).toBe('post-d');
    expect(undoNoticeProps(tree).notice?.message).toBe('Post hidden');

    // The second choice empties the reel, and fails to send: post-d comes back.
    authState.api.recordShowcaseFeedEvent.mockImplementation((request) => (
      request.postId === 'post-d' ? Promise.reject(new Error('Network request failed')) : Promise.resolve()
    ));
    await chooseNotInterested();

    expect(reelIds(tree)).toEqual(['post-d']);
    expect(laneIds(laneKey)).toEqual(['post-d']);
    expect(undoNoticeProps(tree).notice).toBeNull();
    expect(routerState.back).not.toHaveBeenCalled();
  });
});

describe('Delete creation from the reel', () => {
  const creation = (id: string) => ({
    id,
    output_url: `https://cdn.example.com/${id}.png`,
    status: 'succeeded',
    created_at: '2026-10-01T10:00:00.000Z',
    model: 'image-model',
    category: 'image',
    title: `Creation ${id}`,
    prompt: 'A product still',
  });

  /** A reel a creation's alert opens: the recent library window, around that creation. */
  async function renderCreationsReel(initialId: string, generations: Array<ReturnType<typeof creation>>) {
    authState.api.listGenerations.mockResolvedValue({ generations });
    routerState.params = { source: 'studio-creations', initialId };
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <QueryClientProvider client={queryClient}>
          <ImmersivePreviewViewerScreen />
        </QueryClientProvider>
      );
    });
    trees.push(tree);
    await settle();
    return tree;
  }

  async function deleteActive() {
    dialogs.confirm.mockResolvedValue(true);
    authState.api.deleteGeneration.mockResolvedValue({ success: true, deleted: true, linkedPostRetained: false, message: '' });
    const actions = actionsFor(activeItem());
    expect(actions.actions).toContain('delete-creation');
    await act(async () => {
      actions.handleAction('delete-creation');
    });
    await settle();
  }

  // As a blocked creator's posts do: the reader moves on, the reel stays.
  it('moves on to the next creation and takes the deleted one out', async () => {
    const tree = await renderCreationsReel('gen-b', [creation('gen-a'), creation('gen-b'), creation('gen-c')]);
    expect(activeId()).toBe('gen-b');

    await deleteActive();

    expect(authState.api.deleteGeneration).toHaveBeenCalledWith('gen-b');
    expect(activeId()).toBe('gen-c');
    expect(reelIds(tree)).toEqual(['gen-a', 'gen-c']);
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(routerState.back).not.toHaveBeenCalled();
    // A deleted creation used to send the reader to Profile's Posts.
    expect(routerState.replace).not.toHaveBeenCalled();
  });

  it('leaves the reel when the creation was all it held', async () => {
    await renderCreationsReel('gen-b', [creation('gen-b')]);

    await deleteActive();

    expect(routerState.back).toHaveBeenCalledTimes(1);
    expect(routerState.replace).not.toHaveBeenCalled();
  });
});

// Audit 02-6, 02-5, 02-8: a reel opened on a creator's page reads and pages
// the page's own grid, leaves for Explore after a Block, and reads no
// creator's grid again for a Block.
describe("a reel opened on a creator's page", () => {
  const CREATOR_ROUTE = { source: 'creator-profile', creatorUsername: 'luna' };
  const GRID_KEY = ['creator-profile', 'infinite', 'luna'] as const;
  const lunaPost = (id: string) => feedItem(id, luna, `unused-${id}`);

  function creatorPage(items: ShowcaseFeedItem[], { offset = 0, hasMore = false } = {}): CreatorProfileResponse {
    return {
      profile: {
        id: luna.id,
        username: luna.username,
        displayName: 'Luna',
        bio: null,
        avatarUrl: null,
        coverUrl: null,
        websiteUrl: null,
        twitterHandle: null,
        instagramHandle: null,
        tiktokHandle: null,
        location: null,
      },
      items,
      pageInfo: { hasMore, nextOffset: hasMore ? offset + 24 : null, nextLimit: null, limit: 24, offset },
      viewer: { isOwner: false, isFollowing: true, blockedByViewer: false },
    };
  }

  function seedGrid(pages: CreatorProfileResponse[]) {
    queryClient.setQueryData<InfiniteData<CreatorProfileResponse>>(GRID_KEY, {
      pages,
      pageParams: pages.map((page) => page.pageInfo.offset),
    });
  }

  const gridPages = () => queryClient.getQueryData<InfiniteData<CreatorProfileResponse>>(GRID_KEY)?.pages;
  const gridIds = () => gridPages()?.flatMap((page) => page.items.map((item) => item.id));
  const listProps = (tree: renderer.ReactTestRenderer) => tree.root.findByType('flat-list' as never).props as {
    onEndReached?: () => void;
    ListFooterComponent: React.ReactElement<{ state: string }> | null;
  };

  it("opens on the page's grid, in its order, and reads nothing of its own", async () => {
    seedGrid([creatorPage([lunaPost('luna-1'), lunaPost('luna-2'), lunaPost('luna-3')], { hasMore: true })]);
    const tree = await renderReel('luna-2', CREATOR_ROUTE);

    expect(activeId()).toBe('luna-2');
    expect(reelIds(tree)).toEqual(['luna-1', 'luna-2', 'luna-3']);
    // The 48-post window the reel used to read for itself.
    expect(authState.api.getCreatorProfile).not.toHaveBeenCalled();
    expect(authState.api.getShowcasePost).not.toHaveBeenCalled();
    // More pages to come: no closing slide yet.
    expect(listProps(tree).ListFooterComponent).toBeNull();
  });

  it("pages on from its last post through the grid's offsets, and closes at the grid's end", async () => {
    seedGrid([creatorPage([lunaPost('luna-1'), lunaPost('luna-2')], { hasMore: true })]);
    authState.api.getCreatorProfile.mockResolvedValueOnce(creatorPage([lunaPost('luna-3')], { offset: 24 }));
    const tree = await renderReel('luna-2', CREATOR_ROUTE);

    await act(async () => {
      listProps(tree).onEndReached!();
    });
    await settle();

    expect(authState.api.getCreatorProfile.mock.calls).toEqual([['luna', { limit: 24, offset: 24 }]]);
    expect(reelIds(tree)).toEqual(['luna-1', 'luna-2', 'luna-3']);
    // The page under the reel holds the same pages.
    expect(gridIds()).toEqual(['luna-1', 'luna-2', 'luna-3']);
    expect(listProps(tree).onEndReached).toBeUndefined();
    expect(listProps(tree).ListFooterComponent?.props.state).toBe('end');
    expect(activeId()).toBe('luna-2');
  });

  it("goes on to Explore after a Block, leaves the page saying who was blocked, and reads no creator's grid again", async () => {
    seedGrid([creatorPage([lunaPost('luna-1'), lunaPost('luna-2')], { hasMore: true })]);
    const laneKey = seedLane('viewer-1', lanePosts());
    queryClient.setQueryData(['creator-follow-state', luna.id], { following: true });
    await renderReel('luna-2', CREATOR_ROUTE);

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    dialogs.confirm.mockResolvedValue(true);
    authState.api.blockUser.mockResolvedValue({ success: true });
    const actions = actionsFor(activeItem());
    await act(async () => {
      actions.handleAction('block-user');
    });
    await settle();

    expect(authState.api.blockUser).toHaveBeenCalledWith('creator-luna');
    // Back would have landed on the page of the person just blocked.
    expect(routerState.replace.mock.calls).toEqual([['/(tabs)/showcase']]);
    expect(routerState.back).not.toHaveBeenCalled();
    expect(screenState.zoom.dismiss).not.toHaveBeenCalled();
    // The page left behind says "You blocked @luna", from its cache.
    expect(gridPages()).toEqual([expect.objectContaining({
      items: [],
      viewer: expect.objectContaining({ blockedByViewer: true, isFollowing: false }),
      pageInfo: expect.objectContaining({ hasMore: false }),
    })]);
    expect(queryClient.getQueryData(['creator-follow-state', luna.id])).toEqual({ following: false });
    // Her posts leave the lanes too, and nothing is read again but the Saved list and its count.
    expect(laneIds(laneKey)).toEqual(['post-a', 'post-d']);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey))
      .toEqual([['home-shelf'], ['profile-saved-media', 'viewer-1'], ['profile', 'viewer-1']]);
    expect(authState.api.getCreatorProfile).not.toHaveBeenCalled();
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('@luna blocked.');
  });

  it("fills the heart from the grid's pages, and the tile under the reel counts the save", async () => {
    seedGrid([creatorPage([lunaPost('luna-1'), lunaPost('luna-2')])]);
    authState.api.saveShowcasePost.mockResolvedValue({ success: true, isSaved: true, saveCount: 1, changed: true });
    await renderReel('luna-2', CREATOR_ROUTE);
    expect(activeItem().isSaved).toBe(false);

    await act(async () => {
      (screenState.callbacksFor!(activeItem()).onSave as (item: ImmersivePreviewItem) => void)(activeItem());
    });
    await settle();

    // Through the saver notice, for the signed-in account.
    expect(saverNotice.fields).toHaveBeenCalledWith('viewer-1', true);
    expect(authState.api.saveShowcasePost).toHaveBeenCalledWith('luna-2', {
      shouldSave: true,
      sourceSurface: 'mobile-viewer',
      creatorSeesSaver: true,
    });
    expect(activeItem()).toMatchObject({ id: 'luna-2', isSaved: true, saveCount: 1 });
    expect(gridPages()?.[0].items[1]).toMatchObject({ id: 'luna-2', isSaved: true, saveCount: 1 });
    expect(gridPages()?.[0].profile.id).toBe(luna.id);
  });

  it('sends a reel save by a viewer the notice is still telling as one the creator hears nothing of', async () => {
    seedGrid([creatorPage([lunaPost('luna-1'), lunaPost('luna-2')])]);
    authState.api.saveShowcasePost.mockResolvedValue({ success: true, isSaved: true, saveCount: 1, changed: true });
    saverNotice.fields.mockReturnValueOnce({ saverNotYetTold: true });
    await renderReel('luna-2', CREATOR_ROUTE);

    await act(async () => {
      (screenState.callbacksFor!(activeItem()).onSave as (item: ImmersivePreviewItem) => void)(activeItem());
    });
    await settle();

    expect(authState.api.saveShowcasePost).toHaveBeenCalledWith('luna-2', {
      shouldSave: true,
      sourceSurface: 'mobile-viewer',
      saverNotYetTold: true,
    });
  });

  it('counts a comment written in the reel on the post the grid holds', async () => {
    seedGrid([creatorPage([lunaPost('luna-1'), lunaPost('luna-2')])]);
    const tree = await renderReel('luna-2', CREATOR_ROUTE);
    const sheet = tree.root.find((node) => typeof node.props.onCommentCountChange === 'function');

    await act(async () => {
      (sheet.props.onCommentCountChange as (count: number) => void)(3);
    });
    await settle();

    expect(gridPages()?.[0].items[1]).toMatchObject({ id: 'luna-2', commentCount: 3 });
    expect(activeItem()).toMatchObject({ id: 'luna-2', commentCount: 3 });
  });

  it('takes a reported post out of the reel and the grid, so the next page does not bring it back', async () => {
    seedGrid([creatorPage([lunaPost('luna-1'), lunaPost('luna-2'), lunaPost('luna-3')], { hasMore: true })]);
    authState.api.getCreatorProfile.mockResolvedValueOnce(creatorPage([lunaPost('luna-4')], { offset: 24 }));
    const tree = await renderReel('luna-2', CREATOR_ROUTE);

    await act(async () => {
      (screenState.callbacksFor!(activeItem()).onReported as (item: ImmersivePreviewItem) => void)(activeItem());
    });
    await settle();

    expect(activeId()).toBe('luna-3');
    expect(reelIds(tree)).toEqual(['luna-1', 'luna-3']);
    expect(gridIds()).toEqual(['luna-1', 'luna-3']);

    await act(async () => {
      listProps(tree).onEndReached!();
    });
    await settle();

    expect(reelIds(tree)).toEqual(['luna-1', 'luna-3', 'luna-4']);
    expect(authState.api.getShowcasePost).not.toHaveBeenCalled();
    expect(routerState.back).not.toHaveBeenCalled();
  });
});

describe("the reel's save", () => {
  type SaveHandler = (item: ImmersivePreviewItem) => void;
  type SaveAnswer = { success: boolean; isSaved: boolean; saveCount: number; changed: boolean };

  const reelItem = (tree: renderer.ReactTestRenderer, id: string) => {
    const item = (tree.root.findByType('flat-list' as never).props.data as ImmersivePreviewItem[]).find((candidate) => candidate.id === id);
    expect(item).toBeDefined();
    return item!;
  };

  async function tapSave(tree: renderer.ReactTestRenderer, id: string) {
    await act(async () => {
      (screenState.callbacksFor!(reelItem(tree, id)).onSave as SaveHandler)(reelItem(tree, id));
    });
    await settle();
  }

  function answerEveryTap() {
    authState.api.saveShowcasePost.mockImplementation(async (_postId: string, options: { shouldSave: boolean }) => ({
      success: true,
      isSaved: options.shouldSave,
      saveCount: options.shouldSave ? 1 : 0,
      changed: true,
    }));
  }

  afterEach(() => {
    authState.api.saveShowcasePost.mockReset();
  });

  // Review finding #11: the saver notice a save brings up is read first.
  it('queues "Saved" and "Removed from saved" behind what VoiceOver is reading, on iOS', async () => {
    seedLane('viewer-1', lanePosts());
    answerEveryTap();
    const tree = await renderReel('post-b');

    await tapSave(tree, 'post-b');
    await tapSave(tree, 'post-b');

    expect(vi.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls).toEqual([
      ['Saved', { queue: true }],
      ['Removed from saved', { queue: true }],
    ]);
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
  });

  it('announces them as before on Android, which has no queue', async () => {
    platformState.os = 'android';
    seedLane('viewer-1', lanePosts());
    answerEveryTap();
    const tree = await renderReel('post-b');

    await tapSave(tree, 'post-b');
    await tapSave(tree, 'post-b');

    expect(vi.mocked(AccessibilityInfo.announceForAccessibility).mock.calls).toEqual([['Saved'], ['Removed from saved']]);
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).not.toHaveBeenCalled();
  });

  // Review finding #21: decided at the tap, however long the request waits.
  describe('tapped while an earlier one is on the wire and the notice is up', () => {
    let unsubscribe = () => {};

    beforeEach(() => {
      saverNotice.useReal = true;
      // The root layout's bar, which draws the notice.
      unsubscribe = saverNotice.real!.subscribeToSaverNotice(() => {});
    });

    afterEach(() => {
      unsubscribe();
      saverNotice.real!.resetSaverNoticeForTests();
      saverNotice.useReal = false;
    });

    it('sends it telling the creator nothing after the notice was read, and the save tapped after that names the saver', async () => {
      const notice = saverNotice.real!;
      seedLane('viewer-1', lanePosts());
      const answers: Array<ReturnType<typeof deferred<SaveAnswer>>> = [];
      authState.api.saveShowcasePost.mockImplementation(() => {
        const answer = deferred<SaveAnswer>();
        answers.push(answer);
        return answer.promise;
      });
      const tree = await renderReel('post-b');

      await tapSave(tree, 'post-b');
      expect(notice.readSaverNotice()).toMatchObject({ accountId: 'viewer-1' });
      await tapSave(tree, 'post-c');
      // One request on the wire; the second waits behind it.
      expect(authState.api.saveShowcasePost).toHaveBeenCalledTimes(1);

      // OK on the notice while the second waits; then a third save.
      await act(async () => {
        notice.settleSaverNotice(notice.readSaverNotice()!.id, 'closed');
      });
      expect(notice.readSaverNotice()).toBeNull();
      await tapSave(tree, 'post-d');
      expect(authState.api.saveShowcasePost).toHaveBeenCalledTimes(1);

      await act(async () => {
        answers[0].resolve({ success: true, isSaved: true, saveCount: 1, changed: true });
      });
      await settle();
      await act(async () => {
        answers[1].resolve({ success: true, isSaved: true, saveCount: 1, changed: true });
      });
      await settle();

      expect(authState.api.saveShowcasePost.mock.calls).toEqual([
        ['post-b', { shouldSave: true, sourceSurface: 'mobile-viewer', saverNotYetTold: true }],
        ['post-c', { shouldSave: true, sourceSurface: 'mobile-viewer', saverNotYetTold: true }],
        ['post-d', { shouldSave: true, sourceSurface: 'mobile-viewer', creatorSeesSaver: true }],
      ]);
    });
  });
});

describe('a recipe opened from search', () => {
  // The route the search row pushes (`components/explore-search-overlay.tsx`).
  const SEARCH_ROUTE = { source: 'showcase-feed', initialPage: 'details', initialSection: 'resources' };
  // A post read on its own: its recipe rides on it, and no feed delivered it.
  const recipePost = (): ShowcaseFeedItem => ({
    ...feedItem('post-recipe', luna, 'unused'),
    recommendation: undefined,
    asset: {
      id: 'bundle-1',
      postId: 'post-recipe',
      title: 'Dusk grade',
      accessMode: 'paid',
      priceUsdCents: 900,
      previewText: '',
      allowRemix: false,
      resourceKinds: ['prompt'],
    },
  });

  /** The props the reel draws an item's slide with, from the list's own `renderItem`. */
  function slideProps(tree: renderer.ReactTestRenderer, id: string) {
    const list = tree.root.findByType('flat-list' as never).props as {
      data: ImmersivePreviewItem[];
      renderItem: (info: { item: ImmersivePreviewItem; index: number }) => React.ReactElement<{ initialSection?: string; pageKey?: string }>;
    };
    const index = list.data.findIndex((item) => item.id === id);
    expect(index).toBeGreaterThan(-1);
    return list.renderItem({ item: list.data[index]!, index }).props;
  }

  beforeEach(() => {
    authState.api.getShowcasePost.mockResolvedValue({ success: true, item: recipePost() });
    authState.api.getShowcaseFeed.mockResolvedValue({
      items: [feedItem('post-a', maya, 'delivery-a')],
      feedSessionId: 'session-1',
      algorithmVersion: 'for-you-rules-v4',
      nextCursor: null,
      pageInfo: { hasMore: false, nextOffset: null },
    });
  });

  it("opens the post on its Details page with the resources first, and only that post's", async () => {
    const tree = await renderReel('post-recipe', SEARCH_ROUTE);

    expect(authState.api.getShowcasePost).toHaveBeenCalledWith('post-recipe');
    expect(reelIds(tree)).toEqual(['post-recipe', 'post-a']);
    expect(activeId()).toBe('post-recipe');
    expect(activeItem().details?.unlock).toMatchObject({ resourceId: 'bundle-1', postId: 'post-recipe' });
    expect(slideProps(tree, 'post-recipe')).toMatchObject({ initialSection: 'resources', pageKey: 'details' });
    expect(slideProps(tree, 'post-a').initialSection).toBeUndefined();
  });

  // "Sign in to unlock" comes back through `dismissTo`, which swaps this
  // route's params for the return path's: the post, with no page or section.
  it("keeps the resources first through a guest's sign-in from the card", async () => {
    authState.user = null;
    authState.identityUserId = 'guest-1';
    const tree = await renderReel('post-recipe', SEARCH_ROUTE);
    expect(slideProps(tree, 'post-recipe')).toMatchObject({ initialSection: 'resources', pageKey: 'details' });

    authState.user = { id: 'viewer-1', email: 'viewer@example.com' };
    authState.identityUserId = 'viewer-1';
    routerState.params = { source: 'showcase-feed', initialId: 'post-recipe' };
    act(() => {
      tree.update(
        <QueryClientProvider client={queryClient}>
          <ImmersivePreviewViewerScreen />
        </QueryClientProvider>
      );
    });
    await settle();

    expect(activeId()).toBe('post-recipe');
    expect(slideProps(tree, 'post-recipe')).toMatchObject({ initialSection: 'resources', pageKey: 'details' });
  });

  it('takes a section only with the Details page, and only one the page has', async () => {
    const withoutPage = await renderReel('post-recipe', { source: 'showcase-feed', initialSection: 'resources' });
    expect(slideProps(withoutPage, 'post-recipe').initialSection).toBeUndefined();
    expect(slideProps(withoutPage, 'post-recipe').pageKey).not.toBe('details');

    const unknown = await renderReel('post-recipe', { source: 'showcase-feed', initialPage: 'details', initialSection: 'comments' });
    expect(slideProps(unknown, 'post-recipe')).toMatchObject({ pageKey: 'details' });
    expect(slideProps(unknown, 'post-recipe').initialSection).toBeUndefined();
  });
});
