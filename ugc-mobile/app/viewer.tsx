import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, type VideoPlayer, type VideoPlayerStatus } from 'expo-video';
import { MEDIA_PLAYER_OPTIONS } from '@/lib/video-player-options';
import { Copy, ImageOff, Lock, Play, Volume2, VolumeX } from 'lucide-react-native';
import { useIsFocused } from '@react-navigation/native';
import { createContext, useContext, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, AppState, Easing, FlatList, Linking, Platform, Pressable, ScrollView, Share, Text, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Path, Stop } from 'react-native-svg';

import { DoubleTapPressable } from '@/components/double-tap-pressable';
import { MediaZoomChrome, MediaZoomStage, useMediaZoomLanded, useMediaZoomLentVideo, useMediaZoomOpened, useMediaZoomPaintReport, useMediaZoomStage } from '@/components/media-zoom';
import { mediaItemAspectRatio, showcaseViewerMediaPicture } from '@/lib/media-zoom-transition';
import { useMediaSource } from '@/lib/use-media-source';
import { useVideoLoadDeadline } from '@/lib/use-video-load-deadline';
import { restoreVideoPlayback } from '@/lib/video-playback-continuity';
import { createViewerPlaybackHandoff } from '@/lib/viewer-playback-handoff';
import { isVideoPlayerHandedBack } from '@/lib/video-player-loans';
import { FeedMediaFrame } from '@/components/feed-media-frame';
import { LetterboxBands } from '@/components/letterbox-bands';
import { PostDetailsPage } from '@/components/post-details-page';
import { Pill, SecondaryButton, StatusBlock } from '@/components/ui';
import { UnlockRemixPrompt } from '@/components/unlock-remix-prompt';
import { CommentsSheet } from '@/components/comments-sheet';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { useAuth } from '@/lib/auth';
import { applyCommentCountToSourceData } from '@/lib/comments-view-model';
import { env } from '@/lib/env';
import { TopScrim } from '@/components/top-scrim';
import { IconShadow, ReelSlideChrome } from '@/components/reel-chrome';
import {
  getImmersiveInitialIndex,
  getImmersiveStatusSlide,
  hasImmersiveAudibleMedia,
  immersiveViewerReturnPath,
  isImmersiveSelectionMissing,
  selectActiveImmersiveVideoId,
  type ImmersivePreviewItem,
} from '@/lib/immersive-preview-view-model';
import { hydrateViewerAudioMuted, isViewerAudioMuted, toggleViewerAudioMuted, useViewerAudioMuted } from '@/lib/viewer-audio';
import { viewerTopBadgeTop, viewerTopControlTop, VIEWER_TOP_CONTROL_SIZE } from '@/lib/viewer-chrome';
import { useViewerRefreshSpinner } from '@/lib/viewer-refresh-indicator';
import { BackGlyph } from '@/lib/platform-glyphs';
import { createShowcaseFeedViewerQueryKey } from '@/lib/showcase-feed-query';
import {
  buildImmersiveSlidePages,
  getImmersiveVideoBlockerId,
  isImmersiveDetailsSlidePageIndex,
  type ImmersiveSlidePage,
} from '@/lib/immersive-slide-pages';
import { getReelFollowTarget } from '@/lib/reel-overlay-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { useCreatorFollow } from '@/lib/use-creator-follow';
import { useHardwareBack } from '@/lib/use-hardware-back';
import {
  buildViewerItems,
  type ImmersiveSourceData,
  isGenerationSource,
  loadImmersiveSourceData,
  normalizeParam,
  normalizeViewerSource,
  readCachedImmersiveSourceSnapshot,
  readCachedProfile,
} from '@/lib/immersive-preview-source-data';
import { getProfileHandle } from '@/lib/profile-view-model';
import { showConfirmDialog, showErrorDialog, showMessageDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { useReducedMotion } from '@/lib/motion';
import {
  applyShowcaseSaveStateToFeedResponse,
  applyShowcaseSaveStateToInfiniteFeed,
  applyShowcaseSaveStateToPostResponse,
  applyShowcaseSaveStateToSourceData,
  scheduleShowcaseSaveCompletionEffects,
  type ShowcaseSaveStateResult,
} from '@/lib/showcase-save-cache';
import { SHOWCASE_SAVE_MUTATION_SCOPE, showcaseSaveIntents } from '@/lib/showcase-save-intent';
import { IMMERSIVE_HORIZONTAL_LIST_TUNING, IMMERSIVE_VERTICAL_LIST_TUNING } from '@/lib/media-performance';
import {
  SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY,
  buildShowcaseFeedEventRequest,
  canRecordShowcaseFeedEvent,
  filterAnonymousSessionShowcaseFeedItems,
  forgetAnonymousShowcaseFeedRemoval,
  getQualifiedImpressionKey,
  rememberAnonymousShowcaseFeedRemoval,
  removeShowcaseFeedItems,
  removeShowcaseFeedItemsFromInfiniteData,
  type ShowcaseFeedEventDetails,
} from '@/lib/showcase-feed-events';
import {
  enqueueShowcaseFeedEvent,
  flushShowcaseFeedEvents,
  isBatchedShowcaseFeedEventType,
} from '@/lib/feed-event-queue';
import {
  getShowcasePlaybackUrl,
  resolveShowcaseViewerImageSource,
} from '@/lib/showcase-media';
import {
  createShowcaseMediaProgressTracker,
  reportShowcaseMediaProgress,
  setShowcaseMediaProgressSink,
} from '@/lib/showcase-media-progress';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import type { PostResourceKind, ShowcaseFeedEventType, ShowcaseFeedResponse, ShowcaseMediaItem, ShowcasePostResponse } from '@/lib/types';
import { REMIX_NEEDS_WEB_BODY, REMIX_NEEDS_WEB_TITLE, canSaveViewerItemOnDoubleTap, getDoubleTapSaveHeartAnimationSpec, getDoubleTapSaveHeartPalette, getDoubleTapSaveHeartPosition, getNativeRemixCreateHref, getViewerShareIntent, getViewerShareSourceSurface } from '@/lib/viewer-actions';
import {
  changePostVisibility,
  pickPostVisibility,
  resolveLinkedLifecyclePost,
  toPostLifecyclePost,
  type PostLifecyclePost,
} from '@/lib/post-lifecycle';
import type { PostLifecycleVisibility } from '@/lib/post-lifecycle-policy';
import { flattenProfileOwnerPostPages, profileOwnerPostsQueryOptions } from '@/lib/profile-media-query';
import { isProfileLibrarySource, useProfileLibrarySource } from '@/lib/use-profile-library-source';
import { applyPostVisibilityToCaches } from '@/lib/viewer-media-cache';
import { useViewerPlaybackGate } from '@/lib/use-viewer-playback-gate';
import { useStableSignedUrl } from '@/lib/use-stable-signed-url';
import { verticalHitSlop } from '@/lib/hit-target';
import { changeViewerPage, isDetailsPageCovering, resolveViewerPosition, settleViewerItem, slidePageKey, type ViewerPosition } from '@/lib/viewer-position';

type ViewerParams = {
  algorithmVersion?: string | string[];
  comments?: string | string[];
  creatorUsername?: string | string[];
  feedSessionId?: string | string[];
  source?: string | string[];
  initialId?: string | string[];
  replyTo?: string | string[];
};

type SaveMutationVariables = {
  item: ImmersivePreviewItem;
  postId: string;
  previousSaveCount: number;
  shouldSave: boolean;
  sourceSurface: string;
  trigger: 'double-tap' | 'rail';
  /** Which tap this was, per post. See `showcaseSaveIntents`. */
  intentSeq: number;
};

type SaveItemHandler = (
  item: ImmersivePreviewItem,
  trigger?: SaveMutationVariables['trigger']
) => void;

type DoubleTapSavePosition = {
  x: number;
  y: number;
};

const DOUBLE_TAP_SAVE_HEART_SIZE = 90;
const VIEWER_PLAY_BADGE_SIZE = 72;
/** How long after a zoom has uncovered the reel its neighbours' players are made. */
const NEIGHBOUR_PLAYERS_DELAY_MS = 400;

const ViewerPlaybackContext = createContext<ReturnType<typeof createViewerPlaybackHandoff> | null>(null);

export default function ImmersivePreviewViewerScreen() {
  const params = useLocalSearchParams<ViewerParams>();
  const source = normalizeViewerSource(params.source);
  const initialId = normalizeParam(params.initialId);
  const creatorUsername = normalizeParam(params.creatorUsername) || null;
  const routeFeedSessionId = normalizeParam(params.feedSessionId) || null;
  const routeAlgorithmVersion = normalizeParam(params.algorithmVersion) || null;
  const requestedCommentsPostId = normalizeParam(params.comments) || null;
  const requestedReplyToId = normalizeParam(params.replyTo) || null;
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const [playbackHandoff] = useState(createViewerPlaybackHandoff);
  const reducedMotion = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const audioMuted = useViewerAudioMuted();
  useEffect(() => {
    void hydrateViewerAudioMuted();
  }, []);
  const listRef = useRef<FlatList<ImmersivePreviewItem>>(null);
  const [savedPosition, setSavedPosition] = useState<ViewerPosition | null>(null);
  const [initialPositionReady, setInitialPositionReady] = useState(false);
  // The slide under the finger. Only it is ever driven from up here — back
  // and the ⋮ sheet act on what the reader is looking at, never on a neighbour
  // the list keeps mounted off-screen.
  const activeSlideRef = useRef<ImmersiveSlideHandle | null>(null);
  // The page whose video was last handed playback by the scroll handlers.
  // Tracks activeIndex, but leads it during a fling (see onScroll below).
  const handoffPageRef = useRef<number | null>(null);
  const [actionsOpenItemId, setActionsOpenItemId] = useState<string | null>(null);
  const [commentsOpenItemId, setCommentsOpenItemId] = useState<string | null>(null);
  const [commentsReplyToId, setCommentsReplyToId] = useState<string | null>(null);
  const [unlockRemixOpenItemId, setUnlockRemixOpenItemId] = useState<string | null>(null);
  // Remixing is two round trips — this endpoint, then the restore on the
  // create screen — and the tap has to look like it landed for both.
  const [remixingItemId, setRemixingItemId] = useState<string | null>(null);
  const [ownerActionPending, setOwnerActionPending] = useState<string | null>(null);
  const [isHorizontalScrolling, setIsHorizontalScrolling] = useState(false);
  const qualifiedImpressionsRef = useRef(new Set<string>());
  const skipInitialRankedFeedRefreshRef = useRef(Boolean(routeFeedSessionId));
  const restoredCommentContextRef = useRef<string | null>(null);

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    initialData: () => readCachedProfile(queryClient, user?.id),
    queryFn: api.getProfile,
    staleTime: 1000 * 60 * 5,
  });

  const sourceQueryKey = useMemo(
    () => ['immersive-preview-source', source, user?.id ?? 'guest', initialId, creatorUsername ?? '', routeFeedSessionId ?? ''] as const,
    [creatorUsername, initialId, routeFeedSessionId, source, user?.id]
  );
  const viewerFeedQueryKey = useMemo(
    () => createShowcaseFeedViewerQueryKey(user?.id),
    [user?.id]
  );

  const ownerInfo = useMemo(() => ({
    creatorLabel: user ? getProfileHandle(profileQuery.data, user.email) : '@creator',
    creatorAvatar: profileQuery.data?.avatarUrl ?? null,
    creatorId: user?.id ?? null,
  }), [profileQuery.data, user]);

  // Owned libraries read the Profile grid's own pages, so a reel opened from a
  // card holds the grid's items in the grid's order and pages on through its
  // cursor (audit C3, C8). Every other source loads its own window below.
  const libraryBacked = isProfileLibrarySource(source);
  const library = useProfileLibrarySource({
    api,
    userId: user?.id,
    source,
    initialId,
    owner: ownerInfo,
    enabled: libraryBacked,
  });

  const loaderQuery = useQuery({
    queryKey: sourceQueryKey,
    enabled: Boolean(source) && !libraryBacked,
    // Cached data opens the viewer at once and keeps the age of the caches it
    // came from, so an hour-old snapshot refetches straight away instead of
    // passing for fresh (audit C4).
    initialData: () => (libraryBacked
      ? undefined
      : readCachedImmersiveSourceSnapshot(queryClient, source, user?.id, initialId, routeFeedSessionId)?.data),
    initialDataUpdatedAt: () => (libraryBacked
      ? undefined
      : readCachedImmersiveSourceSnapshot(queryClient, source, user?.id, initialId, routeFeedSessionId)?.updatedAt),
    queryFn: () => loadImmersiveSourceData({ api, source, initialId, creatorUsername }),
    staleTime: 1000 * 45,
  });

  // Linked-post details for the creations a loader window holds. Enrichment
  // only: when it fails the creations still show (audit C5).
  const postEnrichmentQuery = useInfiniteQuery({
    ...profileOwnerPostsQueryOptions(api, user?.id),
    enabled: Boolean(user) && !libraryBacked && isGenerationSource(source),
  });
  const enrichmentPosts = useMemo(
    () => flattenProfileOwnerPostPages(postEnrichmentQuery.data?.pages),
    [postEnrichmentQuery.data]
  );

  const sourceQuery = libraryBacked
    ? {
      data: undefined as ImmersiveSourceData | undefined,
      isLoading: library.isLoading || library.selection === 'loading',
      isError: library.isError || library.selection === 'error',
      isFetching: library.isFetching,
      refetch: library.selection === 'error' && !library.isError ? library.retrySelection : library.refetch,
    }
    : loaderQuery;

  const refetchLoader = loaderQuery.refetch;
  useEffect(() => {
    if (!isFocused || libraryBacked) return;
    if (source === 'showcase-feed' && skipInitialRankedFeedRefreshRef.current) {
      skipInitialRankedFeedRefreshRef.current = false;
      return;
    }
    // Only data that has gone stale: a viewer returned to with fresh data does
    // not ask again, and a first load already under way is not restarted (C4).
    const state = queryClient.getQueryState(sourceQueryKey);
    if (!state || state.status === 'pending' || state.fetchStatus === 'fetching') return;
    if (!state.isInvalidated && Date.now() - state.dataUpdatedAt < 1000 * 45) return;
    void refetchLoader?.();
  }, [isFocused, libraryBacked, queryClient, refetchLoader, source, sourceQueryKey]);

  // A warm library is not proof that the requested item exists. Keep unrelated
  // pages out of the renderer and position/playback effects until selection
  // resolves. After landing, the reader's own position continues to own the reel.
  const awaitingLibrarySelection = libraryBacked && !initialPositionReady
    && library.selection !== 'none' && library.selection !== 'found';
  const items = useMemo(() => {
    if (libraryBacked) return awaitingLibrarySelection ? [] : library.items;
    const data = isGenerationSource(source) && loaderQuery.data
      ? { ...loaderQuery.data, ownerPosts: enrichmentPosts }
      : loaderQuery.data;
    const builtItems = buildViewerItems(source, data, ownerInfo, initialId);
    if (user || source !== 'showcase-feed') return builtItems;

    const visiblePostIds = new Set(
      filterAnonymousSessionShowcaseFeedItems(loaderQuery.data?.showcaseItems ?? [])
        .map((item) => item.id)
    );
    return builtItems.filter((item) => (
      !item.showcasePostId || visiblePostIds.has(item.showcasePostId)
    ));
  }, [awaitingLibrarySelection, enrichmentPosts, initialId, library.items, libraryBacked, loaderQuery.data, ownerInfo, source, user]);
  // The item the route named did not load: deleted, archived elsewhere, or no
  // longer the reader's. Shown as that, never replaced by the first item (C1).
  const selectionMissing = libraryBacked
    ? library.selection === 'missing'
    : loaderQuery.data !== undefined && isImmersiveSelectionMissing(items, initialId);
  const openCreatorProfile = useCallback((item: ImmersivePreviewItem) => {
    if (!item.creatorUsername) return;
    router.push(`/creators/${encodeURIComponent(item.creatorUsername)}` as never);
  }, []);
  const initialIndex = useMemo(() => getImmersiveInitialIndex(items, initialId), [items, initialId]);
  const position = useMemo(
    () => resolveViewerPosition(items, savedPosition, initialId),
    [items, savedPosition, initialId]
  );
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === position?.itemId));
  // ExoPlayer creation can block Android's handoff commit for hundreds of ms.
  // First activate the already-prepared player; refresh the neighbouring player
  // range in a lower-priority render. iOS keeps its existing preparation timing.
  const deferredVideoIndex = useDeferredValue(activeIndex);
  const preparedVideoIndex = Platform.OS === 'android' ? deferredVideoIndex : activeIndex;
  const detailsPageOpenItemId = isDetailsPageCovering(items[activeIndex], position) ? position?.itemId ?? null : null;
  const setActiveIndex = useCallback((next: number | ((current: number) => number)) => {
    setSavedPosition((saved) => {
      const current = resolveViewerPosition(items, saved, initialId);
      const index = Math.max(0, items.findIndex((item) => item.id === current?.itemId));
      const target = items[typeof next === 'function' ? next(index) : next];
      return target ? settleViewerItem(current, target) : current;
    });
  }, [items, initialId]);
  const changePage = useCallback((itemId: string, pageKey: string) => {
    setSavedPosition((saved) => {
      const current = resolveViewerPosition(items, saved, initialId);
      return current ? changeViewerPage(current, itemId, pageKey) : current;
    });
  }, [items, initialId]);
  // Returning from a pushed screen may refresh/reorder the feed. Follow the
  // post's identity, including its Details page, rather than the old row index.
  // Where the native list already sits, so a page the reader just landed on
  // themselves is never re-scrolled — a second flick that starts inside the
  // same frame would otherwise be yanked back to the page they just left.
  const nativeRowRef = useRef<{ index: number; height: number } | null>(null);
  useEffect(() => {
    handoffPageRef.current = activeIndex;
  }, [activeIndex]);
  useEffect(() => {
    if (!initialPositionReady) return;
    if (nativeRowRef.current?.index === activeIndex && nativeRowRef.current.height === height) return;
    const frame = requestAnimationFrame(() => {
      nativeRowRef.current = { index: activeIndex, height };
      listRef.current?.scrollToOffset({ offset: height * activeIndex, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, height, initialPositionReady]);

  const overlayOpenItemId = getImmersiveVideoBlockerId({
    actionsOpenItemId,
    commentsOpenItemId,
    detailsPageOpenItemId,
    unlockRemixOpenItemId,
  });
  const activeVideoId = isFocused
    ? selectActiveImmersiveVideoId(items, activeIndex, overlayOpenItemId)
    : null;
  const handoffAutoplayAllowed = isFocused && !reducedMotion && !overlayOpenItemId;
  useLayoutEffect(() => {
    playbackHandoff.setAutoplayAllowed(handoffAutoplayAllowed);
    return () => playbackHandoff.setAutoplayAllowed(false);
  }, [handoffAutoplayAllowed, playbackHandoff]);
  const activeItem = items[activeIndex];
  const detailsOpenForActive = Boolean(activeItem) && detailsPageOpenItemId === activeItem.id;
  // The shape of the picture on screen, so a reel growing out of a tile — or
  // shrinking back into one — lines up with the media rather than beside it;
  // and the picture itself, for a close that has to shrink a copy of it.
  const activeMedia = useMemo(() => {
    if (!activeItem) return { aspectRatio: null, picture: null, playbackUrl: null };
    const pages = buildImmersiveSlidePages(activeItem);
    const page = pages.find((candidate) => slidePageKey(candidate) === position?.mediaPageKey) ?? pages[0];
    if (page?.type !== 'media') return { aspectRatio: null, picture: null, playbackUrl: null };
    return {
      aspectRatio: mediaItemAspectRatio(page.mediaItem),
      picture: showcaseViewerMediaPicture(page.mediaItem),
      playbackUrl: page.mediaItem.mediaKind === 'video' ? getShowcasePlaybackUrl(page.mediaItem) : null,
    };
  }, [activeItem, position?.mediaPageKey]);
  const zoom = useMediaZoomStage({
    screen: { width, height },
    initialItemId: initialId,
    activeItemId: activeItem?.id ?? null,
    aspectRatio: activeMedia.aspectRatio,
    activePicture: activeMedia.picture,
    // What a close shrinks: this post, rail and caption included.
    activePost: activeItem ?? null,
    reducedMotion,
    ready: items.length > 0 && initialPositionReady,
    expectsNeighbours: items.length > 1,
    // A close into the tile this video came from hands the tile its player back.
    activeVideoUrl: activeMedia.playbackUrl,
    playerFor: playbackHandoff.playerFor,
    onExit: leaveViewer,
  });
  // A zoom into the reel lands in steps, each a frame or two of the UI thread
  // rather than one long hold — traced on an S24, doing it all at once held one
  // 59 ms frame, two frames of a video still playing in the landed picture: the
  // slide's own rail and caption as it lands (`useMediaZoomLanded`), the
  // neighbouring slides once those are drawn, and the neighbours' players a
  // moment after the reel is uncovered. By then its own video is playing, and a
  // player's view created during playback costs a display frame, not a video one.
  const neighbourSlidesAllowed = zoom.landed && zoom.chromeDrawn;
  const [neighbourPlayersAllowed, setNeighbourPlayersAllowed] = useState(zoom.opened);
  useEffect(() => {
    if (neighbourPlayersAllowed || !zoom.opened) return undefined;
    const timer = setTimeout(() => setNeighbourPlayersAllowed(true), NEIGHBOUR_PLAYERS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [neighbourPlayersAllowed, zoom.opened]);
  // The source's refetch spinner waits for a fetch to have lasted a while
  // (`lib/viewer-refresh-indicator`), unless the reader asked for the refresh.
  const [manualRefreshes, setManualRefreshes] = useState(0);
  const refreshSpinnerDue = useViewerRefreshSpinner({ fetching: sourceQuery.isFetching, manualRefreshes });
  const showMediaForActive = useCallback(() => {
    activeSlideRef.current?.showMedia();
  }, []);
  // Back from the details page is back to the media, not out of the reel.
  // Gated on focus: the listener would otherwise outlive a push to a creator
  // profile or the sign-in screen and swallow their back key.
  useHardwareBack(isFocused && detailsOpenForActive, showMediaForActive);
  // Android's back key leaves the reel the way its own Back control does, so
  // the post shrinks into the tile it came from instead of being cut away. A
  // sheet or the details page answers the key first and keeps this switched off.
  useHardwareBack(
    isFocused && !detailsOpenForActive && !overlayOpenItemId,
    zoom.dismiss
  );
  const feedSessionId = sourceQuery.data?.feedSessionId ?? routeFeedSessionId ?? null;
  const algorithmVersion = sourceQuery.data?.algorithmVersion ?? routeAlgorithmVersion ?? null;
  const submitViewerFeedEvent = useCallback((
    item: ImmersivePreviewItem,
    eventType: ShowcaseFeedEventType,
    details: ShowcaseFeedEventDetails = {}
  ) => {
    if (!item.showcasePostId) return Promise.resolve();
    if (!canRecordShowcaseFeedEvent({
      postId: item.showcasePostId,
      recommendation: item.recommendation,
    }, eventType)) return Promise.resolve();
    const request = buildShowcaseFeedEventRequest({
      postId: item.showcasePostId,
      recommendation: item.recommendation,
    }, eventType, {
      feedSessionId,
      algorithmVersion: item.recommendation?.algorithmVersion ?? algorithmVersion,
      sourceSurface: 'showcase-reel',
    }, details);
    return isBatchedShowcaseFeedEventType(eventType)
      ? enqueueShowcaseFeedEvent(request).then(() => undefined)
      : api.recordShowcaseFeedEvent(request).then(() => undefined);
  }, [algorithmVersion, api, feedSessionId]);
  useEffect(() => {
    if (!isFocused) void flushShowcaseFeedEvents();
  }, [isFocused]);
  const recordViewerFeedEvent = useCallback((
    item: ImmersivePreviewItem,
    eventType: ShowcaseFeedEventType,
    details: ShowcaseFeedEventDetails = {}
  ) => {
    void submitViewerFeedEvent(item, eventType, details).catch(() => null);
  }, [submitViewerFeedEvent]);
  const unlockRemixItem = useMemo(
    () => items.find((item) => item.id === unlockRemixOpenItemId) ?? null,
    [items, unlockRemixOpenItemId]
  );
  // A feed refetch can drop the item from `items` while the sheet is open,
  // which would blank the sheet mid-interaction. Keep the last resolved item
  // so an open sheet always has content to render. State rather than a ref,
  // because render reads it.
  const [lastUnlockRemixItem, setLastUnlockRemixItem] = useState<ImmersivePreviewItem | null>(null);
  useEffect(() => {
    if (unlockRemixItem) {
      setLastUnlockRemixItem(unlockRemixItem);
    } else if (!unlockRemixOpenItemId) {
      setLastUnlockRemixItem(null);
    }
  }, [unlockRemixItem, unlockRemixOpenItemId]);
  const unlockRemixSheetItem = unlockRemixOpenItemId
    ? unlockRemixItem ?? lastUnlockRemixItem
    : null;

  useEffect(() => {
    // A missing selection has no position to settle on; settling on item 0
    // would put the reader on an item they never opened.
    if (!items.length || initialPositionReady || selectionMissing) return;
    const frame = requestAnimationFrame(() => {
      setActiveIndex(initialIndex);
      listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
      setInitialPositionReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [initialIndex, initialPositionReady, items.length, selectionMissing]);

  useEffect(() => {
    if (!requestedCommentsPostId || !items.length) return;
    const restoreKey = `${requestedCommentsPostId}:${requestedReplyToId ?? ''}`;
    if (restoredCommentContextRef.current === restoreKey) return;
    const targetIndex = items.findIndex(
      (item) => item.showcasePostId === requestedCommentsPostId && item.canComment
    );
    if (targetIndex < 0) return;

    const target = items[targetIndex];
    restoredCommentContextRef.current = restoreKey;
    setActiveIndex(targetIndex);
    setCommentsReplyToId(requestedReplyToId);
    setCommentsOpenItemId(target.id);
    requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: targetIndex, animated: false });
    });
    router.setParams({ comments: undefined, replyTo: undefined } as never);
  }, [items, requestedCommentsPostId, requestedReplyToId]);

  useEffect(() => {
    if (!initialPositionReady || !isFocused || source !== 'showcase-feed' || !activeItem?.showcasePostId) return;
    const item = activeItem;
    const postId = activeItem.showcasePostId;
    const impressionKey = getQualifiedImpressionKey({
      postId,
      recommendation: item.recommendation,
    }, feedSessionId);
    const startedAt = Date.now();
    const recordQualifiedImpression = () => {
      if (qualifiedImpressionsRef.current.has(impressionKey)) return;
      qualifiedImpressionsRef.current.add(impressionKey);
      recordViewerFeedEvent(item, 'impression', {
        durationMs: SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime,
        metadata: {
          visiblePercentThreshold: SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.itemVisiblePercentThreshold,
          qualification: 'active-reel',
        },
      });
    };
    const timer = setTimeout(
      recordQualifiedImpression,
      SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime
    );

    // Max playback progress for this delivery: flushed at milestone crossings,
    // on app-background (app kills would lose an exit-only flush), and on item
    // exit. The server upserts with GREATEST, so repeats are harmless.
    const mediaProgressTracker = createShowcaseMediaProgressTracker();
    const flushMediaProgress = () => {
      const flush = mediaProgressTracker.takeFlush();
      if (!flush) return;
      recordViewerFeedEvent(item, 'media_progress', {
        progress: flush.progress,
        ...(flush.durationMs !== null ? { durationMs: flush.durationMs } : {}),
      });
    };
    setShowcaseMediaProgressSink((progress, durationMs) => {
      if (mediaProgressTracker.record(progress, durationMs)) {
        flushMediaProgress();
      }
    });
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        flushMediaProgress();
      }
    });

    return () => {
      clearTimeout(timer);
      appStateSubscription.remove();
      setShowcaseMediaProgressSink(null);
      flushMediaProgress();
      const durationMs = Date.now() - startedAt;
      if (durationMs >= SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime) {
        recordQualifiedImpression();
      }
      recordViewerFeedEvent(
        item,
        durationMs < SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime ? 'quick_skip' : 'dwell',
        { durationMs }
      );
    };
  }, [activeItem?.id, feedSessionId, initialPositionReady, isFocused, recordViewerFeedEvent, source]);

  const reconcileShowcaseSave = useCallback((
    result: ShowcaseSaveStateResult,
    options: { removeWhenUnsaved?: boolean } = {}
  ) => {
    queryClient.setQueryData<ImmersiveSourceData>(sourceQueryKey, (data) =>
      applyShowcaseSaveStateToSourceData(data, result, options)
    );
    queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>({ queryKey: viewerFeedQueryKey }, (data) =>
      applyShowcaseSaveStateToInfiniteFeed(data, result)
    );
    queryClient.setQueriesData<ShowcasePostResponse>({ queryKey: ['showcase-post', result.postId] }, (data) =>
      applyShowcaseSaveStateToPostResponse(data, result)
    );
    queryClient.setQueryData<InfiniteData<ShowcaseFeedResponse>>(['profile-saved-media', user?.id], (data) =>
      applyShowcaseSaveStateToInfiniteFeed(data, result, {
        removeWhenUnsaved: true,
      })
    );
  }, [queryClient, sourceQueryKey, user?.id, viewerFeedQueryKey]);

  // The rail and the details button already refuse a second tap while one is in
  // flight, so the viewer never raced itself. It raced the *feed*: a card saved
  // on the way in can still be on the wire when the viewer it opened into is
  // tapped, and those are two mutations with two independent pending flags. The
  // shared scope puts both surfaces in one queue; the shared ledger keeps the
  // overtaken one from reconciling a truth the viewer has already replaced.
  const saveMutation = useMutation({
    scope: SHOWCASE_SAVE_MUTATION_SCOPE,
    mutationFn: ({ postId, shouldSave, sourceSurface }: SaveMutationVariables) =>
      api.saveShowcasePost(postId, { shouldSave, sourceSurface }),
    onMutate: async (variables) => {
      const optimisticSaveCount = Math.max(
        0,
        variables.previousSaveCount + (variables.shouldSave ? 1 : -1)
      );
      reconcileShowcaseSave({
        postId: variables.postId,
        isSaved: variables.shouldSave,
        saveCount: optimisticSaveCount,
      });
    },
    onError: (_error, variables) => {
      if (showcaseSaveIntents.isOvertaken(variables.postId, variables.intentSeq)) return;
      reconcileShowcaseSave({
        postId: variables.postId,
        isSaved: !variables.shouldSave,
        saveCount: variables.previousSaveCount,
      });
      haptic.error();
      void AccessibilityInfo.announceForAccessibility(
        variables.shouldSave
          ? 'Could not save. Please try again.'
          : 'Could not remove from saved. Please try again.'
      );
    },
    onSuccess: (result, variables) => {
      // Guards the feed event and the saved-collection removal too: an overtaken
      // tap should neither report itself to ranking nor pull a card out from
      // under a viewer who has since put it back.
      if (showcaseSaveIntents.isOvertaken(variables.postId, variables.intentSeq)) return;
      reconcileShowcaseSave({
        postId: variables.postId,
        isSaved: result.isSaved,
        saveCount: result.saveCount,
      }, {
        removeWhenUnsaved: source === 'profile-saved' && !result.isSaved,
      });
      scheduleShowcaseSaveCompletionEffects({
        postId: variables.postId,
        userId: user?.id,
        invalidateQueries: (filters) => queryClient.invalidateQueries(filters),
      });
      void AccessibilityInfo.announceForAccessibility(
        result.isSaved ? 'Saved' : 'Removed from saved'
      );
      if (source === 'showcase-feed') {
        recordViewerFeedEvent(variables.item, result.isSaved ? 'save' : 'unsave');
      }
    },
    onSettled: (_result, _error, variables) => {
      showcaseSaveIntents.close(variables.postId, variables.intentSeq);
    },
  });

  const saveItem: SaveItemHandler = (item, trigger = 'rail') => {
    if (!item.canSave || !item.showcasePostId) return;
    if (!user) {
      router.push('/auth');
      return;
    }
    // The rail button owns its tick the way the double-tap gesture already
    // does — at the tap, not a round trip later.
    if (trigger !== 'double-tap') haptic.light();
    saveMutation.mutate({
      item,
      postId: item.showcasePostId,
      previousSaveCount: item.saveCount,
      shouldSave: !item.isSaved,
      sourceSurface: source === 'profile-saved' ? 'mobile-profile-saved' : 'mobile-viewer',
      trigger,
      intentSeq: showcaseSaveIntents.open(item.showcasePostId),
    });
  };

  const shareItem = async (item: ImmersivePreviewItem) => {
    const intent = getViewerShareIntent(item, env.siteUrl);
    if (intent.kind === 'unavailable') return;

    if (intent.kind === 'publish') {
      router.push({ pathname: '/post/new', params: { generationId: intent.generationId, shareAfterPublish: '1' } } as never);
      return;
    }
    if (intent.kind === 'make-public') {
      router.push({ pathname: '/post/new', params: { postId: intent.postId, shareAfterPublish: '1' } } as never);
      return;
    }

    const shareResult = await Share.share({ ...intent.content });
    if (shareResult.action !== Share.sharedAction) return;
    if (item.showcasePostId) {
      await api
        .shareShowcasePost(item.showcasePostId, { sourceSurface: getViewerShareSourceSurface(source) })
        .catch(() => null);
      if (source === 'showcase-feed') {
        recordViewerFeedEvent(item, 'share');
      }
    }
  };

  const recreateItem = async (item: ImmersivePreviewItem) => {
    if (!user) {
      // Send them back to this exact item, so signing in does not cost them
      // their place in the reel and a second hunt for the post.
      router.push({
        pathname: '/auth',
        params: {
          returnTo: immersiveViewerReturnPath({
            source,
            initialId: item.id,
            feedSessionId,
            algorithmVersion,
            creatorUsername,
          }),
        },
      } as never);
      return;
    }

    const context = { postId: item.showcasePostId, title: item.title, creatorLabel: item.creatorLabel, thumbnailUrl: item.mediaKind === 'image' ? item.mediaUrl : null };
    const openCreateTool = () => {
      const fallbackHref = getNativeRemixCreateHref({
        generationId: item.sourceType !== 'showcase' ? item.generationId : null,
        recreateTool: item.recreateTool,
        prompt: item.recreatePrompt,
        context,
      });
      router.push((fallbackHref ?? `/create/${item.recreateTool}`) as never);
    };

    const showcasePostId = item.sourceType === 'showcase' ? item.showcasePostId : null;
    if (!showcasePostId) {
      openCreateTool();
      return;
    }

    const startRemix = async () => {
      const response = await api.remixShowcasePost(showcasePostId);
      if (source === 'showcase-feed') {
        recordViewerFeedEvent(item, 'remix_start');
      }
      const nativeHref = getNativeRemixCreateHref({
        redirectTo: response.redirectTo,
        recreateTool: item.recreateTool,
        prompt: response.prefill?.prompt ?? item.recreatePrompt,
        context,
      });
      if (nativeHref) {
        router.push(nativeHref as never);
        return;
      }
      if (response.redirectTo) {
        // Leaving the app is the viewer's call, not a silent hand-off.
        const webUrl = `${env.siteUrl}${response.redirectTo}`;
        void showConfirmDialog({
          title: REMIX_NEEDS_WEB_TITLE,
          message: REMIX_NEEDS_WEB_BODY,
          cancelLabel: 'Not now',
          confirmLabel: 'Open web',
        }).then((openWeb) => {
          if (openWeb) void Linking.openURL(webUrl);
        });
        return;
      }
      openCreateTool();
    };
    setRemixingItemId(item.id);
    // `.catch` and `.finally` rather than try…finally, which React Compiler
    // cannot compile; this screen re-renders on every swipe.
    void startRemix()
      .catch((error) => {
        haptic.error();
        showErrorDialog('Could not start remix', error);
      })
      .finally(() => setRemixingItemId(null));
  };

  const applyPostVisibility = (
    post: PostLifecyclePost,
    visibility: PostLifecycleVisibility,
    action: string
  ) => {
    const apply = async () => {
      const outcome = await changePostVisibility({ api, post, visibility });
      if (outcome !== 'done') return;
      // Patched into the loaded pages without collapsing them; the invalidation
      // inside refreshes a loader window that is showing.
      await applyPostVisibilityToCaches(queryClient, user?.id, post.id, visibility);
      void AccessibilityInfo.announceForAccessibility(`This post is now ${visibility}.`);
    };
    setOwnerActionPending(action);
    return apply().finally(() => setOwnerActionPending(null));
  };

  /**
   * The rail's ownership slots reuse the same action ids the More sheet dispatches,
   * so publishing from the rail and publishing from the sheet take one code path.
   */
  const runOwnerAction = (action: string, item: ImmersivePreviewItem) => {
    if (!user) {
      router.push('/auth');
      return;
    }

    if (action === 'publish') {
      router.push({ pathname: '/post/new', params: { generationId: item.id } } as never);
      return;
    }

    if (action === 'edit-linked-resources' && item.linkedPostId) {
      router.push({
        pathname: '/post/new',
        params: { postId: item.linkedPostId, focus: 'resources' },
      } as never);
      return;
    }

    if (action === 'change-visibility') {
      const post = toPostLifecyclePost({
        id: item.id,
        visibility: item.visibility,
        archivedAt: item.archivedAt,
        bundle: item.ownerPostBundle ?? null,
      });
      pickPostVisibility(post.visibility, (next) => void applyPostVisibility(post, next, action));
      return;
    }

    if (action === 'change-linked-visibility' && item.linkedPostId) {
      // Whether the change needs a confirmation depends on the linked post's
      // bundle; read the post first when its details never loaded (C5).
      void resolveLinkedLifecyclePost({ api, item }).then((post) => {
        if (post) pickPostVisibility(post.visibility, (next) => void applyPostVisibility(post, next, action));
      });
    }
  };

  const dismissRecommendation = (
    item: ImmersivePreviewItem,
    eventType: 'not_interested' | 'hide_creator'
  ) => {
    if (!item.showcasePostId) return;
    if (eventType === 'hide_creator' && (!item.creatorId || item.creatorId === user?.id)) return;
    const target = eventType === 'hide_creator' && item.creatorId
      ? { creatorId: item.creatorId }
      : { postId: item.showcasePostId };
    const remainingItems = removeShowcaseFeedItems(sourceQuery.data?.showcaseItems ?? [], target);
    const previousSourceData = queryClient.getQueryData<ImmersiveSourceData>(sourceQueryKey);
    const cachedFeeds = queryClient.getQueriesData<InfiniteData<ShowcaseFeedResponse>>({
      queryKey: viewerFeedQueryKey,
    });
    const previousActiveIndex = activeIndex;

    if (!user) rememberAnonymousShowcaseFeedRemoval(target);

    setActionsOpenItemId(null);
    queryClient.setQueryData<ImmersiveSourceData>(sourceQueryKey, (data) => data ? {
      ...data,
      showcaseItems: removeShowcaseFeedItems(data.showcaseItems ?? [], target),
    } : data);
    queryClient.setQueriesData<InfiniteData<ShowcaseFeedResponse>>(
      { queryKey: viewerFeedQueryKey },
      (data) => removeShowcaseFeedItemsFromInfiniteData(data, target)
    );
    if (remainingItems.length) {
      setActiveIndex((current) => Math.min(current, remainingItems.length - 1));
    }
    void submitViewerFeedEvent(item, eventType)
      .then(() => {
        void AccessibilityInfo.announceForAccessibility(eventType === 'hide_creator'
          ? user
            ? `${item.creatorLabel} hidden from your feed.`
            : `${item.creatorLabel} hidden for this visit.`
          : user
            ? 'Post removed. Your feed will adapt.'
            : 'Post removed for this visit.');
        if (!remainingItems.length) {
          requestAnimationFrame(leaveViewer);
        }
      })
      .catch(() => {
        if (!user) forgetAnonymousShowcaseFeedRemoval(target);
        queryClient.setQueryData(sourceQueryKey, previousSourceData);
        cachedFeeds.forEach(([cachedQueryKey, cachedData]) => {
          queryClient.setQueryData(cachedQueryKey, cachedData);
        });
        setActiveIndex(previousActiveIndex);
        showMessageDialog({
          title: 'Couldn’t update your feed',
          message: 'The post was restored. Check your connection and try again.',
        });
        void AccessibilityInfo.announceForAccessibility(
          'Couldn’t update your feed. The post was restored.'
        );
      });
  };

  if (selectionMissing && !savedPosition) {
    return (
      <ViewerShell topInset={topInset} bottomInset={bottomInset}>
        <View style={{ width: '100%', maxWidth: 420, gap: 12 }}>
          <StatusBlock
            title="This isn’t available anymore"
            body="It may have been deleted or archived, or it’s no longer shared with you."
          />
          <SecondaryButton label="Go back" onPress={leaveViewer} />
        </View>
      </ViewerShell>
    );
  }

  if (!items.length && sourceQuery.isLoading) {
    return (
      <ViewerShell topInset={topInset} bottomInset={bottomInset}>
        <ActivityIndicator accessibilityLabel="Loading preview" color={appTheme.colors.primary} />
      </ViewerShell>
    );
  }

  if (!items.length && sourceQuery.isError) {
    return (
      <ViewerShell topInset={topInset} bottomInset={bottomInset}>
        <View style={{ width: '100%', maxWidth: 420, gap: 12 }}>
          <StatusBlock
            tone="danger"
            title="Couldn't load this preview"
            body="Check your connection and try again."
          />
          <SecondaryButton
            label="Try again"
            onPress={() => void sourceQuery.refetch()}
          />
        </View>
      </ViewerShell>
    );
  }

  if (!items.length) {
    return (
      <ViewerShell topInset={topInset} bottomInset={bottomInset}>
        <Text selectable style={{ color: appTheme.colors.text, fontSize: 18, fontWeight: '800' }}>Preview unavailable</Text>
        <Text selectable style={{ color: appTheme.colors.muted, marginTop: 8 }}>This item may have been removed or is still loading.</Text>
      </ViewerShell>
    );
  }

  return (
    <ViewerPlaybackContext.Provider value={playbackHandoff}>
    {/* The reel is drawn inside a window that grows out of the tapped tile and
        shrinks back into it, so opening a post reads as that post getting
        bigger rather than as another screen arriving. */}
    <MediaZoomStage stage={zoom} screen={{ width, height }}>
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Pushed under a zoom that had already filled the screen, the reel came in
          with no animation (`viewerAnimation`, app/_layout.tsx); it still leaves
          under the fade — a plain pop, the back swipe. Put back once the reel is
          uncovered, well after the push: set as the push commits, it could be
          folded into the same native update and fade the push after all. */}
      <Stack.Screen
        options={{
          gestureEnabled: !detailsOpenForActive,
          fullScreenGestureEnabled: false,
          ...(Platform.OS === 'ios' && !reducedMotion && zoom.opened ? { animation: 'fade' as const } : null),
        }}
      />
      <FlatList
        ref={listRef}
        data={items}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
        initialNumToRender={IMMERSIVE_VERTICAL_LIST_TUNING.initialNumToRender}
        initialScrollIndex={initialIndex}
        keyExtractor={(item) => `${item.source}-${item.id}`}
        maxToRenderPerBatch={IMMERSIVE_VERTICAL_LIST_TUNING.maxToRenderPerBatch}
        onMomentumScrollEnd={(event) => {
          const nextIndex = Math.round(event.nativeEvent.contentOffset.y / height);
          const clampedIndex = Math.max(0, Math.min(items.length - 1, nextIndex));
          // A quiet tick as each page settles: the reel feels like it has
          // detents rather than sliding freely. Soft so it can repeat at
          // browsing speed without nagging.
          if (clampedIndex !== activeIndex) haptic.soft();
          // The reader put the list here, so the alignment effect has nothing
          // to correct.
          nativeRowRef.current = { index: clampedIndex, height };
          if (clampedIndex === activeIndex) return;
          // Swap playback now, on the scroll-end event, rather than after the
          // reel re-renders: on Android that render is a few hundred ms during
          // which the landed video would otherwise sit frozen on its first frame.
          playbackHandoff.handoff({
            from: items[handoffPageRef.current ?? activeIndex]?.id,
            to: items[clampedIndex]?.id,
          });
          handoffPageRef.current = clampedIndex;
          setActiveIndex(clampedIndex);
          setActionsOpenItemId(null);
          setUnlockRemixOpenItemId(null);
        }}
        onScrollToIndexFailed={({ index }) => {
          requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset: height * index, animated: false });
          });
        }}
        // An owned library continues through the grid's cursor instead of
        // stopping at whatever was loaded when the reel opened.
        onEndReached={libraryBacked && library.hasNextPage ? () => {
          if (!library.isFetchingNextPage) void library.fetchNextPage();
        } : undefined}
        onEndReachedThreshold={2}
        // Hand playback over as soon as the landing page owns most of the
        // screen, the moment Instagram and TikTok switch, rather than at
        // momentum end. On Android that event trails the visible stop by
        // ~150-200ms (the scroll view polls for stable frames). On iOS it is
        // prompt, but a phone still needs ~100-200ms to resume a paused player
        // and render, and that gap showed as the poster, then frame zero.
        // Paging on iOS and momentum-free interval snapping on Android both
        // stop at a neighbour, so the rounded page always has a prepared player.
        onScroll={(event) => {
          const page = Math.max(0, Math.min(items.length - 1, Math.round(event.nativeEvent.contentOffset.y / height)));
          const previous = handoffPageRef.current ?? activeIndex;
          if (page === previous) return;
          handoffPageRef.current = page;
          playbackHandoff.handoff({
            from: items[previous]?.id,
            to: items[page]?.id,
          });
        }}
        scrollEventThrottle={16}
        // Android's default paging restarts a fixed-duration animation at release.
        // Interval snapping uses its native fling and limits momentum to the next page.
        pagingEnabled={Platform.OS !== 'android'}
        snapToInterval={Platform.OS === 'android' ? height : undefined}
        disableIntervalMomentum={Platform.OS === 'android'}
        // Detaching a TextureView discards the frame we prepared offscreen.
        // Virtualization still bounds mounted rows through windowSize.
        removeClippedSubviews={false}
        renderItem={({ item, index }) => (
          <ImmersiveSlide
            active={index === activeIndex}
            /* Creating a player is the most expensive thing the reel mounts, so
               while the reel is still growing out of a tile the neighbours'
               players wait (see `neighbourPlayersAllowed`). The slide it opens on
               cannot wait at all: a player made only once the reel had opened left
               the landed picture standing still for as long as that player took to
               load. It loads under the tile's picture instead, held on its first
               frame until the reel opens (`ImmersiveMedia`) — and a slide the tile
               lent its playing video to has nothing to create at all. */
            prepareVideo={(index === activeIndex || neighbourPlayersAllowed) && Math.abs(index - activeIndex) <= 1 && (index === activeIndex || Math.abs(index - preparedVideoIndex) <= 1)}
            activeSlideRef={activeSlideRef}
            onLayoutAsNeighbour={index === activeIndex ? undefined : zoom.reportNeighbourDrawn}
            onChromeLayout={index === activeIndex ? zoom.reportChromeDrawn : undefined}
            activeVideoId={activeVideoId}
            authReturnTo={immersiveViewerReturnPath({
              source,
              initialId: item.id,
              feedSessionId,
              algorithmVersion,
              creatorUsername,
            })}
            bottomInset={bottomInset}
            height={height}
            item={item}
            onActionsOpen={() => setActionsOpenItemId(item.id)}
            onComments={item.canComment ? () => {
              setCommentsReplyToId(null);
              setCommentsOpenItemId(item.id);
            } : undefined}
            onCreatorOpen={openCreatorProfile}
            pageKey={index === activeIndex ? position?.pageKey : undefined}
            mediaPageKey={index === activeIndex ? position?.mediaPageKey : undefined}
            onPageChange={changePage}
            onHorizontalScrollToggle={setIsHorizontalScrolling}
            onOwnerAction={(action) => runOwnerAction(action, item)}
            onRecreate={recreateItem}
            onSave={saveItem}
            onShare={shareItem}
            onUnlockRemix={(nextItem) => setUnlockRemixOpenItemId(nextItem.id)}
            ownerActionPending={index === activeIndex ? ownerActionPending : null}
            remixLoading={remixingItemId === item.id}
            saveLoading={saveMutation.isPending && saveMutation.variables?.postId === item.showcasePostId}
            topInset={topInset}
            width={width}
          />
        )}
        scrollEnabled={!overlayOpenItemId && !isHorizontalScrolling}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: '#000' }}
        // Neighbouring slides mount on the UI thread, and a reel that is still
        // growing out of a tile cannot afford that thread: they wait for it to
        // land and for the slide's own rail to be drawn (`neighbourSlidesAllowed`),
        // by which time the reader has seen one page and no more.
        windowSize={neighbourSlidesAllowed ? IMMERSIVE_VERTICAL_LIST_TUNING.windowSize : 1}
      />
      {/* Status bars: "Obscure content under the status bar ... Be sure to keep
          the status bar readable." The reel is the app's one full-bleed screen,
          and the strip behind the clock is a blurred *cover* crop of the media,
          so on bright media it is white on white. Same scrim the four scrolling
          screens draw, in the same place in the tree: after the scroller, before
          any sheet. */}
      <MediaZoomChrome>
      <TopScrim topInset={topInset} over="media" />
      {/* Both buttons, like the slides' rails, mount once a zoom into the reel
          has landed (`useMediaZoomLanded`); the shade above is part of the
          picture the flight shows. */}
      {zoom.landed && zoom.drawn ? (
      <>
      {/* The details page draws its own header with its own way back; the
          reel's arrow would be a second back button that leaves the reel. */}
      {detailsOpenForActive ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={zoom.dismiss}
          style={({ pressed }) => ({
            position: 'absolute',
            left: 16,
            top: viewerTopControlTop(topInset),
            width: VIEWER_TOP_CONTROL_SIZE,
            height: VIEWER_TOP_CONTROL_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: VIEWER_TOP_CONTROL_SIZE / 2,
            backgroundColor: 'rgba(0,0,0,0.3)',
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <IconShadow><BackGlyph size={appTheme.icon.feature} color="#ffffff" /></IconShadow>
        </Pressable>
      )}
      {/* Going full screen: "Continue to provide access to essential features and
          controls so people can complete their task without exiting full-screen
          mode." The reel is entered from a silent grid and is the only surface
          that makes a sound, so silencing it must not mean leaving it. */}
      {detailsOpenForActive || !hasImmersiveAudibleMedia(activeItem) ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={audioMuted ? 'Unmute video' : 'Mute video'}
          accessibilityState={{ selected: audioMuted }}
          onPress={() => {
            haptic.select();
            toggleViewerAudioMuted();
          }}
          style={({ pressed }) => ({
            position: 'absolute',
            right: 16,
            top: viewerTopControlTop(topInset),
            width: VIEWER_TOP_CONTROL_SIZE,
            height: VIEWER_TOP_CONTROL_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: VIEWER_TOP_CONTROL_SIZE / 2,
            backgroundColor: 'rgba(0,0,0,0.3)',
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <IconShadow>
            {audioMuted
              ? <VolumeX size={appTheme.icon.feature} color="#ffffff" />
              : <Volume2 size={appTheme.icon.feature} color="#ffffff" />}
          </IconShadow>
        </Pressable>
      )}
      </>
      ) : null}
      </MediaZoomChrome>
      {activeItem ? (
        <ViewerActionSheet
          item={activeItem}
          onClose={() => setActionsOpenItemId(null)}
          onComments={activeItem.canComment ? () => {
            setActionsOpenItemId(null);
            setCommentsReplyToId(null);
            setCommentsOpenItemId(activeItem.id);
          } : undefined}
          onDetails={() => {
            setActionsOpenItemId(null);
            activeSlideRef.current?.openDetails();
          }}
          onRecreate={() => void recreateItem(activeItem)}
          onNotInterested={source === 'showcase-feed' && activeItem.sourceType === 'showcase'
            ? () => dismissRecommendation(activeItem, 'not_interested')
            : undefined}
          onHideCreator={source === 'showcase-feed'
            && activeItem.sourceType === 'showcase'
            && Boolean(activeItem.creatorId)
            && activeItem.creatorId !== user?.id
            ? () => dismissRecommendation(activeItem, 'hide_creator')
            : undefined}
          onShare={() => void shareItem(activeItem)}
          onUnlockRemix={() => {
            setActionsOpenItemId(null);
            setUnlockRemixOpenItemId(activeItem.id);
          }}
          onDeleted={() => {
            setActionsOpenItemId(null);
            router.replace({
              pathname: '/(tabs)/profile',
              params: { tab: 'posts' },
            } as never);
          }}
          onBlocked={() => zoom.dismiss()}
          onSourceRefresh={() => {
            setManualRefreshes((count) => count + 1);
            void sourceQuery.refetch();
          }}
          visible={actionsOpenItemId === activeItem.id}
        />
      ) : null}
      {activeItem?.canComment && activeItem.showcasePostId ? (
        <CommentsSheet
          key={activeItem.showcasePostId}
          authReturnTo={immersiveViewerReturnPath({
            source,
            initialId: activeItem.id,
            feedSessionId,
            algorithmVersion,
            creatorUsername,
          })}
          postId={activeItem.showcasePostId}
          postCreatorId={activeItem.creatorId ?? null}
          commentCount={activeItem.commentCount}
          initialReplyToId={commentsReplyToId}
          onClose={() => {
            setCommentsReplyToId(null);
            setCommentsOpenItemId(null);
          }}
          onCommentCountChange={(commentCount) => {
            queryClient.setQueryData<ImmersiveSourceData>(
              sourceQueryKey,
              (current) => applyCommentCountToSourceData(current, {
                postId: activeItem.showcasePostId!,
                commentCount,
              })
            );
          }}
          visible={commentsOpenItemId === activeItem.id}
        />
      ) : null}
      <UnlockRemixPrompt
        authReturnTo={unlockRemixSheetItem ? immersiveViewerReturnPath({
          source,
          initialId: unlockRemixSheetItem.id,
          feedSessionId,
          algorithmVersion,
          creatorUsername,
        }) : undefined}
        bottomInset={bottomInset}
        item={unlockRemixSheetItem}
        onClose={() => setUnlockRemixOpenItemId(null)}
        onUnlocked={(item) => recreateItem(item)}
        visible={Boolean(unlockRemixOpenItemId)}
      />
      {/* Leading side, under Back: the trailing side of the badge row belongs to
          the slide's media counter, and the two used to be drawn on top of each
          other — the spinner from `topInset + 24`, the counter from a flat 68. */}
      {sourceQuery.isFetching && activeItem && refreshSpinnerDue ? (
        <MediaZoomChrome pointerEvents="none">
          <View style={{ position: 'absolute', top: viewerTopBadgeTop(topInset), left: 30 }}>
            <ActivityIndicator color="rgba(255,255,255,0.72)" />
          </View>
        </MediaZoomChrome>
      ) : null}
    </View>
    </MediaZoomStage>
    </ViewerPlaybackContext.Provider>
  );
}

function ViewerShell({ topInset, bottomInset, children }: { topInset: number; bottomInset: number; children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', paddingTop: topInset, paddingBottom: bottomInset, paddingHorizontal: 24 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={leaveViewer}
        style={({ pressed }) => ({ position: 'absolute', left: 16, top: viewerTopControlTop(topInset), width: VIEWER_TOP_CONTROL_SIZE, height: VIEWER_TOP_CONTROL_SIZE, borderRadius: VIEWER_TOP_CONTROL_SIZE / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)', opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <IconShadow><BackGlyph size={appTheme.icon.feature} color="#ffffff" /></IconShadow>
      </Pressable>
      {children}
    </View>
  );
}

function leaveViewer() {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/(tabs)/showcase' as never);
}

/** What the reel can ask of the slide the reader is on. */
interface ImmersiveSlideHandle {
  openDetails: () => void;
  showMedia: () => void;
}

function ImmersiveSlide({
  active,
  prepareVideo,
  activeSlideRef,
  onLayoutAsNeighbour,
  onChromeLayout,
  activeVideoId,
  authReturnTo,
  bottomInset,
  height,
  item,
  onActionsOpen,
  onComments,
  onCreatorOpen,
  pageKey,
  mediaPageKey,
  onPageChange,
  onOwnerAction,
  onRecreate,
  onSave,
  onShare,
  onUnlockRemix,
  ownerActionPending,
  remixLoading,
  saveLoading,
  topInset,
  width,
  onHorizontalScrollToggle,
}: {
  active: boolean;
  prepareVideo: boolean;
  activeSlideRef: MutableRefObject<ImmersiveSlideHandle | null>;
  /**
   * For a slide beside the one on screen: laid out means mounted and drawn,
   * which a reel growing out of a tile waits for before it is uncovered.
   */
  onLayoutAsNeighbour?: () => void;
  /**
   * For the slide on screen: its rail and caption, mounted once a zoom into the
   * reel has landed, have been laid out — the reel fades in with them.
   */
  onChromeLayout?: () => void;
  activeVideoId: string | null;
  /** Where sign-in should land the viewer back: this reel, on this item. */
  authReturnTo: string;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onActionsOpen: () => void;
  onComments?: () => void;
  onCreatorOpen: (item: ImmersivePreviewItem) => void;
  pageKey?: string;
  mediaPageKey?: string;
  onPageChange: (itemId: string, pageKey: string) => void;
  onOwnerAction?: (action: string) => void;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onSave: SaveItemHandler;
  onShare: (item: ImmersivePreviewItem) => void;
  onUnlockRemix: (item: ImmersivePreviewItem) => void;
  ownerActionPending?: string | null;
  remixLoading: boolean;
  saveLoading: boolean;
  topInset: number;
  width: number;
  onHorizontalScrollToggle?: (scrolling: boolean) => void;
}) {
  const horizontalRef = useRef<FlatList<ImmersiveSlidePage>>(null);
  const reducedMotion = useReducedMotion();
  // The rail, caption and double-tap heart are no part of the picture a zoom
  // into the reel flies, yet each of their views — the rail's icons alone are a
  // few dozen SVG views, drawn twice for their shadow — is created on the thread
  // that moves that picture: traced on an S24, mounting them with the reel cost
  // 15–29 ms frames in the flight's last stretch. They mount once it has landed,
  // under the still picture, and the reel is uncovered once they are laid out.
  const zoomLanded = useMediaZoomLanded();

  // The settled index drives what the *reel* believes — which page blocks video,
  // which one hardware back returns from — so it may only move once a page has
  // landed. The counter is feedback for the finger and has to answer sooner;
  // Gestures asks for feedback that "helps them predict its results".
  const [draggedPageIndex, setDraggedPageIndex] = useState(0);
  const [saveHeartPopTrigger, setSaveHeartPopTrigger] = useState(0);
  const nativePageRef = useRef<{ index: number; width: number } | null>(null);
  const doubleTapHeart = useDoubleTapSaveHeartAnimation({ height, width });
  const { user } = useAuth();
  const followTarget = getReelFollowTarget(item, user?.id ?? null);
  const follow = useCreatorFollow({ creatorId: followTarget?.creatorId ?? null, enabled: active && Boolean(followTarget) });
  const [captionExpanded, setCaptionExpanded] = useState(false);
  useEffect(() => {
    setCaptionExpanded(false);
  }, [active, item.id]);
  const { toggle: toggleFollow } = follow;
  const onFollowPress = useCallback(() => {
    if (!user) {
      router.push({ pathname: '/auth', params: { returnTo: authReturnTo } } as never);
      return;
    }
    toggleFollow();
  }, [authReturnTo, toggleFollow, user]);

  const pages = useMemo(() => buildImmersiveSlidePages(item), [item]);
  const currentHorizontalIndex = Math.max(0, pages.findIndex((page) => slidePageKey(page) === pageKey));
  const currentPageIsDetails = isImmersiveDetailsSlidePageIndex(pages, currentHorizontalIndex);
  // Details pauses the remembered media page without discarding its frame.
  const preparedMediaIndex = currentPageIsDetails
    ? Math.max(0, pages.findIndex((page) => slidePageKey(page) === mediaPageKey))
    : currentHorizontalIndex;
  const updateCurrentHorizontalIndex = useCallback((pageIndex: number) => {
    if (!active || !pages[pageIndex]) return;
    nativePageRef.current = { index: pageIndex, width };
    setDraggedPageIndex(pageIndex);
    onPageChange(item.id, slidePageKey(pages[pageIndex]));
  }, [active, item.id, onPageChange, pages, width]);

  const openDetailsPage = useCallback(() => {
    const detailsIndex = pages.findIndex((page) => page.type === 'details');
    if (detailsIndex < 0) return;

    updateCurrentHorizontalIndex(detailsIndex);
    horizontalRef.current?.scrollToIndex({ index: detailsIndex, animated: !reducedMotion });
  }, [pages, reducedMotion, updateCurrentHorizontalIndex]);

  const showMediaPage = useCallback(() => {
    const index = Math.max(0, pages.findIndex((page) => slidePageKey(page) === mediaPageKey));
    updateCurrentHorizontalIndex(index);
    horizontalRef.current?.scrollToIndex({ index, animated: !reducedMotion });
  }, [mediaPageKey, pages, reducedMotion, updateCurrentHorizontalIndex]);

  // Only the active slide answers the reel. A neighbour that the list keeps
  // mounted must never be scrolled from outside: activation resets its page
  // position, and only the active row owns the viewer navigation handle.
  useEffect(() => {
    if (!active) return;
    const handle: ImmersiveSlideHandle = { openDetails: openDetailsPage, showMedia: showMediaPage };
    activeSlideRef.current = handle;
    return () => {
      if (activeSlideRef.current === handle) activeSlideRef.current = null;
    };
  }, [active, activeSlideRef, openDetailsPage, showMediaPage]);

  useEffect(() => {
    if (nativePageRef.current?.index === currentHorizontalIndex && nativePageRef.current.width === width) return;
    const frame = requestAnimationFrame(() => {
      nativePageRef.current = { index: currentHorizontalIndex, width };
      setDraggedPageIndex(currentHorizontalIndex);
      horizontalRef.current?.scrollToIndex({ index: currentHorizontalIndex, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, currentHorizontalIndex, width]);

  const videoPlaybackActive = active && activeVideoId === item.id && !currentPageIsDetails;
  const saveFromDoubleTap = useCallback((position: DoubleTapSavePosition) => {
    doubleTapHeart.play(position);
    setSaveHeartPopTrigger((current) => current + 1);
    haptic.light();
    if (!canSaveViewerItemOnDoubleTap({
      canSave: item.canSave,
      isSaved: item.isSaved,
      saveLoading,
    })) return;
    onSave(item, 'double-tap');
  }, [doubleTapHeart, item, onSave, saveLoading]);

  const renderChrome = () => (zoomLanded ? (
    <View pointerEvents="box-none" onLayout={onChromeLayout} style={{ position: 'absolute', inset: 0 }}>
      {renderOverlays()}
      <DoubleTapSaveHeart
        opacity={doubleTapHeart.opacity}
        palette={doubleTapHeart.palette}
        position={doubleTapHeart.position}
        scale={doubleTapHeart.scale}
      />
    </View>
  ) : null);

  const renderOverlays = () => {
    if (currentPageIsDetails) {
      return null;
    }

    const showFollowPill = Boolean(followTarget) && (!user || !follow.loading);

    // Rail, caption and scrims ride inside the zoom window with the media, so
    // they are revealed as it opens instead of arriving after it.
    return (
      <MediaZoomChrome>
        <ReelSlideChrome
          item={item}
          topInset={topInset}
          bottomInset={bottomInset}
          pageIndex={draggedPageIndex}
          follow={showFollowPill
            ? { following: Boolean(user) && follow.following, pending: follow.pending, onPress: onFollowPress }
            : null}
          captionExpanded={captionExpanded}
          onToggleCaption={() => setCaptionExpanded((current) => !current)}
          saveLoading={saveLoading}
          saveHeartPopTrigger={saveHeartPopTrigger}
          remixLoading={remixLoading}
          ownerActionPending={ownerActionPending}
          onSave={onSave}
          onComments={onComments}
          onShare={onShare}
          onOpenDetails={openDetailsPage}
          onUnlockRemix={onUnlockRemix}
          onRecreate={onRecreate}
          onOwnerAction={onOwnerAction}
          onActionsOpen={onActionsOpen}
          onCreatorOpen={onCreatorOpen}
        />
      </MediaZoomChrome>
    );
  };

  if (pages.length <= 1) {
    return (
      <View collapsable={false} onLayout={onLayoutAsNeighbour} accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'} style={{ width, height }}>
        <MediaSlidePage
          active={videoPlaybackActive}
          slideActive={active}
          prepareVideo={prepareVideo}
          bottomInset={bottomInset}
          height={height}
          item={item}
          onRecreate={onRecreate}
          onSave={onSave}
          onDoubleTapSave={saveFromDoubleTap}
          onShare={onShare}
          page={pages[0] ?? { type: 'text' }}
          remixLoading={remixLoading}
          saveLoading={saveLoading}
          topInset={topInset}
          width={width}
        />
        {renderChrome()}
      </View>
    );
  }

  return (
    <View collapsable={false} onLayout={onLayoutAsNeighbour} accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'} style={{ width, height, backgroundColor: '#000' }}>
      <FlatList
        ref={horizontalRef}
        data={pages}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        horizontal
        initialNumToRender={IMMERSIVE_HORIZONTAL_LIST_TUNING.initialNumToRender}
        initialScrollIndex={currentHorizontalIndex}
        keyExtractor={slidePageKey}
        maxToRenderPerBatch={IMMERSIVE_HORIZONTAL_LIST_TUNING.maxToRenderPerBatch}
        onScroll={(event) => {
          const page = Math.round(event.nativeEvent.contentOffset.x / width);
          setDraggedPageIndex(Math.max(0, Math.min(pages.length - 1, page)));
        }}
        onScrollBeginDrag={() => onHorizontalScrollToggle?.(true)}
        onScrollEndDrag={() => onHorizontalScrollToggle?.(false)}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(event) => {
          const page = Math.round(event.nativeEvent.contentOffset.x / width);
          updateCurrentHorizontalIndex(Math.max(0, Math.min(pages.length - 1, page)));
          onHorizontalScrollToggle?.(false);
        }}
        onScrollToIndexFailed={({ index }) => {
          requestAnimationFrame(() => {
            horizontalRef.current?.scrollToOffset({ offset: width * index, animated: false });
          });
        }}
        pagingEnabled
        removeClippedSubviews={false}
        renderItem={({ item: page, index: pageIndex }) => (
          <View collapsable={false} accessibilityElementsHidden={!active || currentHorizontalIndex !== pageIndex} importantForAccessibility={active && currentHorizontalIndex === pageIndex ? 'auto' : 'no-hide-descendants'} style={{ width, height }}>
          <MediaSlidePage
            active={active && currentHorizontalIndex === pageIndex && (page.type !== 'media' || videoPlaybackActive)}
            slideActive={active}
            prepareVideo={prepareVideo && preparedMediaIndex === pageIndex}
            bottomInset={bottomInset}
            height={height}
            item={item}
            onActionsOpen={onActionsOpen}
            onComments={onComments}
            onCreatorOpen={onCreatorOpen}
            onRecreate={onRecreate}
            onSave={onSave}
            onDoubleTapSave={saveFromDoubleTap}
            onShare={onShare}
            onShowMedia={showMediaPage}
            page={page}
            remixLoading={remixLoading}
            saveLoading={saveLoading}
            topInset={topInset}
            width={width}
          />
          </View>
        )}
        scrollEnabled={active}
        showsHorizontalScrollIndicator={false}
        style={{ width, height, backgroundColor: '#000' }}
        windowSize={IMMERSIVE_HORIZONTAL_LIST_TUNING.windowSize}
      />
      {renderChrome()}
    </View>
  );
}

function useDoubleTapSaveHeartAnimation({
  height,
  width,
}: {
  height: number;
  width: number;
}) {
  const reducedMotion = useReducedMotion();
  const [playCount, setPlayCount] = useState(0);
  const nextPlayCountRef = useRef(0);
  const opacity = useRef(new Animated.Value(0)).current;
  const position = useRef(new Animated.ValueXY({
    x: width / 2,
    y: height / 2,
  })).current;
  const scale = useRef(new Animated.Value(1)).current;
  const animationRef = useRef<ReturnType<typeof Animated.sequence> | null>(null);

  useEffect(() => () => {
    animationRef.current?.stop();
  }, []);

  const play = useCallback((tapPosition: DoubleTapSavePosition) => {
    const spec = getDoubleTapSaveHeartAnimationSpec(reducedMotion);
    position.setValue(getDoubleTapSaveHeartPosition({
      ...tapPosition,
      width,
      height,
      heartSize: DOUBLE_TAP_SAVE_HEART_SIZE,
    }));
    const currentPlayCount = nextPlayCountRef.current;
    setPlayCount(currentPlayCount);
    nextPlayCountRef.current = currentPlayCount + 1;
    animationRef.current?.stop();
    opacity.setValue(0);
    scale.setValue(spec.startScale);

    const animation = Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: spec.entryDurationMs,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: spec.peakScale,
          duration: spec.entryDurationMs,
          easing: reducedMotion ? Easing.linear : Easing.out(Easing.back(1.35)),
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(scale, {
        toValue: spec.settleScale,
        duration: spec.settleDurationMs,
        easing: reducedMotion ? Easing.linear : Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: spec.restingScale,
        duration: spec.reboundDurationMs,
        easing: reducedMotion ? Easing.linear : Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.delay(spec.holdDurationMs),
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: spec.exitDurationMs,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: spec.exitScale,
          duration: spec.exitDurationMs,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    ]);

    animationRef.current = animation;
    animation.start(() => {
      if (animationRef.current === animation) {
        animationRef.current = null;
      }
    });
  }, [height, opacity, position, reducedMotion, scale, width]);

  return useMemo(() => ({
    opacity,
    palette: getDoubleTapSaveHeartPalette(playCount),
    play,
    position,
    scale,
  }), [opacity, play, playCount, position, scale]);
}

function DoubleTapSaveHeart({
  opacity,
  palette,
  position,
  scale,
}: {
  opacity: Animated.Value;
  palette: ReturnType<typeof getDoubleTapSaveHeartPalette>;
  position: Animated.ValueXY;
  scale: Animated.Value;
}) {
  const gradientId = useId().replace(/:/g, '');

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', inset: 0 }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          left: -DOUBLE_TAP_SAVE_HEART_SIZE / 2,
          top: -DOUBLE_TAP_SAVE_HEART_SIZE / 2,
          width: DOUBLE_TAP_SAVE_HEART_SIZE,
          height: DOUBLE_TAP_SAVE_HEART_SIZE,
          opacity,
          transform: [
            { translateX: position.x },
            { translateY: position.y },
            { scale },
          ],
          shadowColor: '#000000',
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.22,
          shadowRadius: 6,
          elevation: 7,
        }}
      >
        <Svg height={DOUBLE_TAP_SAVE_HEART_SIZE} viewBox="0 0 24 24" width={DOUBLE_TAP_SAVE_HEART_SIZE}>
          <Defs>
            <SvgLinearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <Stop offset="0" stopColor={palette.startColor} />
              <Stop offset="1" stopColor={palette.endColor} />
            </SvgLinearGradient>
          </Defs>
          <Path
            d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78a5.5 5.5 0 0 0 1.06-8.84Z"
            fill={`url(#${gradientId})`}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

function MediaSlidePage({
  active,
  slideActive,
  prepareVideo,
  bottomInset,
  height,
  item,
  onActionsOpen,
  onComments,
  onCreatorOpen,
  onDoubleTapSave,
  onRecreate,
  onSave,
  onShare,
  onShowMedia,
  page,
  remixLoading,
  saveLoading,
  topInset,
  width,
}: {
  active: boolean;
  /** The reader is on this slide, overlays included -- see ActiveVideo's rewind. */
  slideActive: boolean;
  prepareVideo: boolean;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onActionsOpen?: () => void;
  onComments?: () => void;
  onCreatorOpen?: (item: ImmersivePreviewItem) => void;
  onDoubleTapSave: (position: DoubleTapSavePosition) => void;
  onRecreate: (item: ImmersivePreviewItem) => void;
  onSave: (item: ImmersivePreviewItem) => void;
  onShare: (item: ImmersivePreviewItem) => void;
  /** The details page's way back: the media page of the same slide. */
  onShowMedia?: () => void;
  page: ImmersiveSlidePage;
  remixLoading: boolean;
  saveLoading: boolean;
  topInset: number;
  width: number;
}) {
  return (
    <View style={{ width, height, backgroundColor: '#000' }}>
      {page.type === 'details' ? (
        <PostDetailsPage
          active={active}
          bottomInset={bottomInset}
          height={height}
          item={item}
          onActionsOpen={onActionsOpen}
          onBack={onShowMedia}
          onComments={onComments}
          onCreatorOpen={onCreatorOpen}
          onRecreate={onRecreate}
          onSave={onSave}
          onShare={onShare}
          remixLoading={remixLoading}
          saveLoading={saveLoading}
          topInset={topInset}
          width={width}
        />
      ) : page.type === 'text' ? (
        <TextSlide item={item} width={width} height={height} />
      ) : page.type === 'status' ? (
        <StatusSlide item={item} width={width} height={height} />
      ) : (
        <ImmersiveMedia
          postId={item.id}
          mediaItem={page.mediaItem}
          active={active}
          slideActive={slideActive}
          prepareVideo={prepareVideo}
          onDoubleTapSave={onDoubleTapSave}
          width={width}
          height={height}
        />
      )}
    </View>
  );
}


/**
 * The reel's "this is not playing" mark. It was drawn inline four times in this
 * file at three different treatments — with a hairline border and without, and
 * with an optical nudge on one of them — which Icons rules out: "all interface
 * icons in your app need to use a consistent size, level of detail, stroke
 * thickness (or weight), and perspective". The glyph is centred optically here,
 * once, because a triangle's visual centre is left of its bounding box.
 */
function ViewerPlayBadge() {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: VIEWER_PLAY_BADGE_SIZE,
          height: VIEWER_PLAY_BADGE_SIZE,
          borderRadius: VIEWER_PLAY_BADGE_SIZE / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.42)',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.15)',
        }}
      >
        <Play size={appTheme.icon.hero} color="#fff" fill="#fff" style={{ marginLeft: 3 }} />
      </View>
    </View>
  );
}

function ImmersiveMedia({
  postId,
  mediaItem,
  active,
  slideActive,
  prepareVideo,
  onDoubleTapSave,
  width,
  height,
}: {
  postId: string;
  mediaItem: ShowcaseMediaItem;
  active: boolean;
  slideActive: boolean;
  prepareVideo: boolean;
  onDoubleTapSave: (position: DoubleTapSavePosition) => void;
  width: number;
  height: number;
}) {
  const handleDoublePress = useCallback((event: GestureResponderEvent) => {
    onDoubleTapSave({
      x: event.nativeEvent.locationX,
      y: event.nativeEvent.locationY,
    });
  }, [onDoubleTapSave]);
  // A display rendition that will not load falls back to the original rather
  // than leaving the slide on a retry tile (audit C2).
  const [failedDisplayUrl, setFailedDisplayUrl] = useState<string | null>(null);
  const isFocused = useIsFocused();
  // While the reel is growing out of a tile it carries that tile's picture;
  // this is the slide saying it has drawn its own, so the copy can go.
  const reportPainted = useMediaZoomPaintReport();
  const zoomOpened = useMediaZoomOpened();
  const reportSlidePainted = useCallback(() => {
    if (slideActive) reportPainted();
  }, [reportPainted, slideActive]);
  // While the reel grows out of a tile, this slide's player loads under the
  // tile's picture and holds its first frame — the frame the poster is — so the
  // landing uncovers the same picture, which then starts moving. Played any
  // earlier it would be some frames on by then, and the tile's copy fading over
  // it would show the clip twice. A player the tile lent is moving already, and
  // carries on.
  const playbackUrl = getShowcasePlaybackUrl(mediaItem);
  const lentVideo = useMediaZoomLentVideo(playbackUrl);
  // Nor does it start on the render that opens the reel: that render mounts the
  // neighbouring slides and their players, which holds the UI thread (833 ms on
  // the emulator), and a clip started into it stalls on its first frames. It
  // starts two frames later, once that work has been drawn, so the wait is spent
  // on a still picture rather than a frozen one. A slide mounted after the reel
  // opened has nothing to wait for.
  const [openingDrawn, setOpeningDrawn] = useState(zoomOpened);
  const holdsItsPlayer = mediaItem.mediaKind === 'video' && lentVideo === null;
  useEffect(() => {
    // Only a slide holding its own player waits: rendering every slide again
    // two frames after the reel opens would land in the very stretch it avoids.
    if (!holdsItsPlayer || !zoomOpened || openingDrawn) return undefined;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setOpeningDrawn(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [holdsItsPlayer, openingDrawn, zoomOpened]);
  const videoActive = active && (openingDrawn || lentVideo !== null);

  // The bands around a picture that does not fill the slide show the picture's
  // own edge mirrored outward and blurred, shaded darkest at the screen's edge
  // and not at all where the picture begins, so the band meets the picture
  // without an edge (lib/letterbox.ts). They take the frame's backdrop slot, under
  // the picture. A picture of unknown shape keeps the plain blurred backdrop.
  const mediaAspectRatio = mediaItemAspectRatio(mediaItem);
  const bandThumbhash = mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash ?? null;
  const bandSource = mediaItem.previewUrl
    ? { uri: mediaItem.previewUrl, cacheKey: mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey, thumbhash: bandThumbhash }
    : { uri: mediaItem.url, cacheKey: null, thumbhash: bandThumbhash };
  const letterboxBands = mediaAspectRatio ? (
    <LetterboxBands frame={{ width, height }} aspectRatio={mediaAspectRatio} source={bandSource} />
  ) : null;

  if (mediaItem.mediaKind === 'video') {
    return (
      <View style={{ width, height, backgroundColor: '#020203' }}>
        {/* This image stays mounted while players enter and leave the prepared
            range. Even a fast swipe that outruns decoding keeps a sharp poster
            under the transparent video surface instead of flashing its backdrop. */}
        {mediaItem.previewUrl ? (
          <FeedMediaFrame
            kind="image"
            onImageDisplay={reportSlidePainted}
            url={mediaItem.previewUrl}
            backdropUrl={mediaItem.previewUrl}
            imageBackdropContent={letterboxBands}
            cacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
            thumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
            transition={0}
            recyclingKey={`viewer:${mediaItem.id}`}
            style={{ position: 'absolute', width, height }}
          />
        ) : null}
        {prepareVideo && mediaItem.url ? (
          <ActiveVideo
            key={mediaItem.id}
            postId={postId}
            active={videoActive}
            slideActive={slideActive}
            url={playbackUrl}
            onDoublePress={handleDoublePress}
            width={width}
            height={height}
          />
        ) : (
          <DoubleTapPressable
            accessible={false}
            onDoublePress={handleDoublePress}
            style={{ width, height }}
          >
            {/* No badge over a reel that is still growing: its player is on the
                way, and a paused mark there reads as a stalled video. */}
            {zoomOpened ? <ViewerPlayBadge /> : null}
          </DoubleTapPressable>
        )}
      </View>
    );
  }

  if (mediaItem.url) {
    const image = resolveShowcaseViewerImageSource(mediaItem, failedDisplayUrl);
    return (
      <DoubleTapPressable
        accessible={false}
        onDoublePress={handleDoublePress}
        style={{ width, height }}
      >
        <FeedMediaFrame
          kind="image"
          onImageDisplay={reportSlidePainted}
          url={image.url}
          backdropUrl={mediaItem.previewUrl}
          backdropCacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
          imageBackdropContent={letterboxBands}
          cacheKey={image.cacheKey}
          thumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
          onImageError={image.rendition === 'display' ? () => setFailedDisplayUrl(image.url) : undefined}
          // The page on screen, on a focused reel: a covered screen's views are
          // detached and cannot start loading, so they are not timed.
          watchdog={active && isFocused}
          diagnosticsSurface="viewer"
          // The zoom stage owns the reveal. onDisplay fires when the native
          // fade starts, so another fade here exposes a partly transparent
          // image as the carried preview disappears.
          transition={0}
          recyclingKey={`viewer:${mediaItem.id}`}
          style={{ width, height }}
        />
      </DoubleTapPressable>
    );
  }

  return (
    <DoubleTapPressable
      accessible={false}
      onDoublePress={handleDoublePress}
      style={{ width, height, backgroundColor: '#07070c' }}
    >
      <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
        <ImageOff size={34} color="rgba(255,255,255,0.68)" />
      </View>
    </DoubleTapPressable>
  );
}

type ActiveVideoProps = {
  postId: string;
  active: boolean;
  slideActive: boolean;
  url: string;
  onDoublePress: (event: GestureResponderEvent) => void;
  width: number;
  height: number;
};

function ActiveVideo(props: ActiveVideoProps) {
  const [attempt, setAttempt] = useState(0);
  // play() cannot revive a failed native source. A new attempt releases the
  // failed player and resolves the URL again, including an expired signature.
  return (
    <ActiveVideoAttempt
      {...props}
      // A refreshed signature is still the same media. Keep this component's
      // previous-player ref so URL renewal preserves pause and position.
      key={attempt}
      attempt={attempt}
      onRetry={() => setAttempt(value => value + 1)}
    />
  );
}

function ActiveVideoAttempt({
  postId,
  active,
  slideActive,
  url,
  onDoublePress,
  width,
  height,
  onRetry,
  attempt,
}: ActiveVideoProps & { onRetry: () => void; attempt: number }) {
  const [hasFrame, setHasFrame] = useState(false);
  const zoomLanded = useMediaZoomLanded();
  const [hasError, setHasError] = useState(false);
  const reducedMotion = useReducedMotion();
  const audioMuted = useViewerAudioMuted();
  // A refetch re-signing the same object must not restart the download.
  const playbackUrl = useStableSignedUrl(url);
  const { source, requestKey } = useMediaSource(playbackUrl);
  // Optimistic: playback is requested below, and the native player reports
  // `playing` only once it is actually rendering — often a frame or two after
  // the first frame has already been drawn. Reading `player.playing` here
  // would flash the paused badge over that first frame; `playingChange` still
  // corrects this the moment the player really is paused. A gate revoke and a
  // player replacement are the two pauses the native player never reports for
  // a source that has not started, so both update this state directly.
  const [isPlaying, setIsPlaying] = useState(active && !reducedMotion);
  // The paused badge must not flash when a slide becomes active. The native
  // playingChange event arrives only after the activation render has painted,
  // and correcting the state from the activation effect costs a second render
  // of the whole reel, so on a phone the badge sat over the first frames of
  // every video. Adjust the state during render instead: the first frame the
  // reader sees of the active slide already reads as playing, and
  // playingChange still corrects it if the player really stays paused.
  const [activeSeen, setActiveSeen] = useState(active);
  if (active !== activeSeen) {
    setActiveSeen(active);
    setIsPlaying(active && !reducedMotion && (!AppState.currentState || AppState.currentState === 'active'));
  }
  const previousPlayer = useRef<VideoPlayer | null>(null);
  const playbackAllowed = useViewerPlaybackGate(previousPlayer, () => setIsPlaying(false));
  const playbackRequested = useRef(active);
  // The feed tile this reel grew out of lent the player it was already playing
  // this file on (lib/video-player-loans.ts). Using it instead of building one
  // is what keeps the picture moving through the zoom: nothing reloads, and the
  // clip carries on from the frame the reader was watching. Only a first
  // attempt adopts — a retry wants a fresh player, as it always did.
  const lentVideo = useMediaZoomLentVideo(url);
  const lentPlayer = attempt === 0 ? lentVideo?.video.player ?? null : null;
  const lentPlayerRef = useRef<VideoPlayer | null>(null);
  if (lentPlayer) lentPlayerRef.current = lentPlayer;
  const ownPlayer = useVideoPlayer(lentPlayer ? null : { ...source, useCaching: true }, (instance) => {
    instance.loop = true;
    instance.muted = !active || isViewerAudioMuted();
    instance.volume = 1.0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
    instance.timeUpdateEventInterval = 0.25;
    // Playing audio: "don't make people stop listening to music from another app
    // if you don't need to." `auto` holds the session only while a player is
    // actually outputting sound; expo-video's iOS default is `doNotMix`, which
    // takes it the moment anything plays — muted previews included — while its
    // Android default is already `auto`. Setting it makes the platforms agree.
    instance.audioMixingMode = 'auto';
    // A neighbour is prepared paused; only the active slide may resume, and
    // a replaced player on the active slide carries the previous decision over.
    // A lent player that could not be kept is not one to carry on from: by now
    // it is back with its tile or released.
    const previous = previousPlayer.current === lentPlayerRef.current ? null : previousPlayer.current;
    playbackRequested.current = restoreVideoPlayback(instance, previous, active && !reducedMotion,
      active && playbackAllowed.current && !reducedMotion && (!AppState.currentState || AppState.currentState === 'active'));
  }, MEDIA_PLAYER_OPTIONS);
  const player = lentPlayer ?? ownPlayer;
  previousPlayer.current = player;
  const [status, setStatus] = useState<VideoPlayerStatus>(player.status);
  const timedOut = useVideoLoadDeadline(player, status);
  const playbackFailed = hasError || timedOut;

  useEffect(() => {
    player.muted = !active || audioMuted;
  }, [active, audioMuted, player]);

  // Lets the reel's scroll-end handler start this player before the
  // activation render reaches it (see lib/viewer-playback-handoff.ts).
  const playbackHandoff = useContext(ViewerPlaybackContext);
  // A lent player joins the reel's register once the reel has taken it: until
  // then it is still the flight's picture, and the register stops every player
  // it holds whenever autoplay is disallowed, even for a moment.
  const awaitingLentPlayer = Boolean(lentPlayer) && !lentVideo?.attached;
  useEffect(() => (
    awaitingLentPlayer ? undefined : playbackHandoff?.register(postId, player, url)
  ), [awaitingLentPlayer, playbackHandoff, player, postId, url]);

  // A post the reader scrolled away from starts over when they come back, as
  // it does in Instagram and TikTok. Rewind on leaving rather than on return,
  // so the frame the prepared player shows while scrolling back is the clip's
  // real first frame. Keyed to the slide, not to playback: the details page,
  // comments and the actions sheet pause but must not restart. This effect
  // runs after the activation commit, so the slide is already off-screen and
  // the seek is invisible. A fresh neighbour is at zero already, so only a
  // player that was on-screen is rewound.
  const wasOnSlideRef = useRef(false);
  useEffect(() => {
    if (slideActive) {
      wasOnSlideRef.current = true;
      return;
    }
    if (!wasOnSlideRef.current) return;
    wasOnSlideRef.current = false;
    player.currentTime = 0;
  }, [player, slideActive]);

  // Reduce Motion turning on while the slide is active stops the video and
  // keeps it stopped until the reader presses Play.
  useEffect(() => {
    if (!reducedMotion) return;
    player.pause();
    setIsPlaying(false);
  }, [player, reducedMotion]);

  // Preparing a neighbour decodes its first frame without playing audio or
  // advancing its timeline. Activation resumes that same player and surface,
  // and counts as a fresh intent: it re-arms the background gate that may have
  // been revoked while this player waited as a neighbour, the way a fresh
  // mount would. A player replaced on the same slide (a re-signed source)
  // already carried the previous pause/position decision over in its setup
  // callback; a replaced player that stays paused reports no playingChange,
  // so the badge follows that decision instead of the optimistic state.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!active) {
      setIsPlaying(false);
      // Handed back to the tile a close landed in, it plays on there.
      if (!isVideoPlayerHandedBack(player)) player.pause();
      return;
    }
    if (!becameActive) {
      setIsPlaying(playbackRequested.current);
      return;
    }
    playbackAllowed.current = !AppState.currentState || AppState.currentState === 'active';
    const play = playbackAllowed.current && !reducedMotion;
    setIsPlaying(play);
    if (play) player.play();
  }, [active, player]);

  useEffect(() => {
    setHasFrame(false);
    setHasError(false);
  }, [player, playbackUrl, requestKey]);

  // The surface reveals itself with a short fade on its first frame rather
  // than a cut, the way Instagram brings a reel in over its cover. A prepared
  // neighbour fades while it is still off-screen, so a swipe lands on a fully
  // shown surface; the fade is only ever seen on a cold open, or when a
  // source is still loading as its page arrives, and there it turns the
  // poster-to-video moment into a dissolve. A new native player (a re-signed
  // source, a retry) starts hidden again; a loop restart re-fires the first
  // frame event and must not blink, so the reveal runs once per player.
  const surfaceOpacity = useRef(new Animated.Value(0)).current;
  const revealedPlayerRef = useRef<VideoPlayer | null>(null);
  useEffect(() => {
    if (revealedPlayerRef.current !== player) surfaceOpacity.setValue(0);
  }, [player, surfaceOpacity]);
  // A lent player drew its first frame long ago, in the tile, and reports none
  // to a view that takes it now. The layer still covers this slide at that
  // moment, so the surface is simply shown rather than faded in.
  const lentAttached = Boolean(lentPlayer && lentVideo?.attached);
  useEffect(() => {
    if (!lentAttached || !lentPlayer) return;
    lentPlayer.volume = 1.0;
    lentPlayer.timeUpdateEventInterval = 0.25;
    setHasFrame(true);
    setHasError(false);
    revealedPlayerRef.current = lentPlayer;
    surfaceOpacity.setValue(1);
  }, [lentAttached, lentPlayer, surfaceOpacity]);

  const revealSurface = () => {
    if (revealedPlayerRef.current === player) return;
    revealedPlayerRef.current = player;
    if (reducedMotion) {
      surfaceOpacity.setValue(1);
      return;
    }
    Animated.timing(surfaceOpacity, {
      toValue: 1,
      duration: 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  useEffect(() => {
    const subscription = player.addListener('playingChange', (event) => {
      // Handed back to a feed tile, it plays or pauses as that tile says.
      if (isVideoPlayerHandedBack(player)) return;
      // The gate polices the active slide only: the reel's scroll handoff
      // starts a neighbour before its active prop flips, and activation
      // re-arms a gate that neighbour may still hold from a background trip.
      if (event.isPlaying && active && !playbackAllowed.current) {
        player.pause();
        setIsPlaying(false);
        return;
      }
      setIsPlaying(event.isPlaying);
    });
    return () => {
      subscription.remove();
    };
  }, [active, playbackAllowed, player]);

  useEffect(() => {
    // A cached/native failure can arrive before this effect subscribes.
    setHasError(player.status === 'error');
    setStatus(player.status);
    const subscription = player.addListener('statusChange', (event) => {
      setHasError(event.status === 'error');
      setStatus(event.status);
    });
    return () => {
      subscription.remove();
    };
  }, [player]);

  useEffect(() => {
    if (!active) return;
    const subscription = player.addListener('timeUpdate', (event) => {
      const durationSeconds = player.duration;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
      reportShowcaseMediaProgress(event.currentTime / durationSeconds, durationSeconds * 1000);
    });
    return () => {
      subscription.remove();
    };
  }, [active, player]);

  const togglePlayback = () => {
    if (!active) return;
    if (player.playing) {
      playbackAllowed.current = false;
      player.pause();
    } else {
      playbackAllowed.current = !AppState.currentState || AppState.currentState === 'active';
      if (!playbackAllowed.current) return;
      player.play();
    }
  };

  return (
    <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
      <DoubleTapPressable
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
        accessibilityHint={reducedMotion ? 'Playback is paused because reduced motion is enabled' : 'Toggles video playback'}
        accessibilityState={{ selected: isPlaying }}
        onDoublePress={onDoublePress}
        onSinglePress={togglePlayback}
        style={{ width, height, alignItems: 'center', justifyContent: 'center' }}
      >
        {/* The video's own view — the priciest view the reel creates, some
            10 ms on an S24 — waits for a zoom into the reel to land. The player
            is loading without it, and draws its frame into it the moment it
            mounts, still under the landed picture. */}
        {zoomLanded ? (
          <Animated.View
            // The native texture and its container must fade as one surface;
            // applying alpha through the hierarchy darkens the poster beneath
            // it just as playback takes over.
            needsOffscreenAlphaCompositing
            renderToHardwareTextureAndroid
            style={{ width, height, opacity: surfaceOpacity }}
          >
            <FeedMediaFrame
              kind="video"
              // A lent player stays out of this view until the hand-off: taking it
              // earlier would move its surface out from under the growing picture.
              player={lentPlayer && !lentVideo?.attached ? null : player}
              backgroundColor="transparent"
              videoBackdrop="none"
              onFirstFrameRender={() => {
                setHasFrame(true);
                setHasError(false);
                revealSurface();
              }}
              style={{ width, height }}
            />
          </Animated.View>
        ) : null}
        {active && !isPlaying && hasFrame && !playbackFailed ? <ViewerPlayBadge /> : null}
      </DoubleTapPressable>
      {zoomLanded && !playbackFailed && (status === 'loading' || status === 'idle') ? (
        <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator accessibilityLabel="Loading video" color={appTheme.colors.primary} />
        </View>
      ) : null}
      {playbackFailed ? (
        <View style={{ position: 'absolute', left: 32, right: 80, alignItems: 'center' }}>
          <View style={{ backgroundColor: appTheme.colors.panel, padding: 20, borderRadius: 20, gap: 12 }}>
            <Text accessibilityRole="alert" style={{ color: appTheme.colors.text, fontSize: 16, textAlign: 'center' }}>
              Video couldn’t load
            </Text>
            <SecondaryButton label="Retry video" onPress={onRetry} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The page a creation with nothing to play sits on. Same plate as `TextSlide`
 * -- this is the reel's way of drawing a slide that is words rather than media
 * -- tinted by whether the run failed or is simply not finished.
 */
function StatusSlide({ item, width, height }: { item: ImmersivePreviewItem; width: number; height: number }) {
  const { title, body } = getImmersiveStatusSlide(item);
  const tone = item.runStatus === 'failed' ? appTheme.semantic.danger : appTheme.semantic.info;

  return (
    <View
      style={{ width, height, justifyContent: 'center', paddingLeft: 22, paddingRight: 90, paddingBottom: 120, backgroundColor: appTheme.colors.app }}
    >
      <View style={{ borderRadius: 28, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.border, backgroundColor: appTheme.colors.panel, padding: 20, gap: 13, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: tone.foreground }} />
        <View
          style={{
            alignSelf: 'flex-start',
            borderRadius: 999,
            backgroundColor: tone.background,
            borderWidth: 1,
            borderColor: tone.border,
            paddingHorizontal: 11,
            paddingVertical: 6,
          }}
        >
          <Text numberOfLines={1} style={{ color: tone.foreground, fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
            {item.badge}
          </Text>
        </View>
        <Text numberOfLines={3} style={{ color: '#fff', fontSize: 25, lineHeight: 31, fontWeight: '800' }}>
          {title}
        </Text>
        <Text numberOfLines={6} style={{ color: appTheme.colors.textSecondary, fontSize: 16, lineHeight: 23 }}>
          {body}
        </Text>
      </View>
    </View>
  );
}

function TextSlide({ item, width, height }: { item: ImmersivePreviewItem; width: number; height: number }) {
  return (
    <View
      style={{ width, height, justifyContent: 'center', paddingLeft: 22, paddingRight: 90, paddingBottom: 120, backgroundColor: appTheme.colors.app }}
    >
      <View style={{ borderRadius: 28, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.border, backgroundColor: appTheme.colors.panel, padding: 20, gap: 13, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: appTheme.colors.primary }} />
        <View style={{ alignSelf: 'flex-start', borderRadius: 999, backgroundColor: appTheme.colors.surfaceStrong, paddingHorizontal: 11, paddingVertical: 6 }}>
          <Text numberOfLines={1} style={{ color: '#fff', fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
            {item.badge}
          </Text>
        </View>
        <Text numberOfLines={3} style={{ color: '#fff', fontSize: 25, lineHeight: 31, fontWeight: '800' }}>
          {item.title}
        </Text>
        <Text numberOfLines={8} style={{ color: appTheme.colors.textSecondary, fontSize: 16, lineHeight: 23 }}>
          {item.displayText}
        </Text>
        {/* The slide clamps; the post page does not. A reel encounter with a
            long note needs a way out to actually read it. */}
        {item.showcasePostId ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Read the full post ${item.title}`}
            onPress={() => router.push(`/post/${item.showcasePostId}` as never)}
            hitSlop={verticalHitSlop(32)}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              minHeight: 32,
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
              Read full post
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
