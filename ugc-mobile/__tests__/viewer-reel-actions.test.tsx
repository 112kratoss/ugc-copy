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
    getProfile: vi.fn(() => new Promise<never>(() => undefined)),
    getShowcaseFeed: vi.fn(),
    getShowcasePost: vi.fn(),
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
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
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
vi.mock('@/lib/use-creator-follow', () => ({ useCreatorFollow: () => ({}) }));
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
import type { ShowcaseFeedItem, ShowcaseFeedResponse } from '@/lib/types';
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

async function renderReel(initialId = 'post-b') {
  routerState.params = { source: 'showcase-feed', initialId, lane: serializeShowcaseFeedLane(LANE) };
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
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).toEqual([['creator-profile'], ['profile-saved-media', 'viewer-1'], ['profile', 'viewer-1']]);
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
