import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer } from 'expo-video';
import { ArrowLeft, Copy, FileText, Globe, Heart, ImageOff, Images, Lock, LockKeyhole, MessageCircle, MoreHorizontal, Play, Repeat2, Share2, Wand2 } from 'lucide-react-native';
import { useIsFocused } from '@react-navigation/native';
import { cloneElement, useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactElement } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Animated, AppState, Easing, FlatList, Linking, Platform, Pressable, ScrollView, Share, Text, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Path, Stop } from 'react-native-svg';

import { DoubleTapPressable } from '@/components/double-tap-pressable';
import { FeedMediaFrame } from '@/components/feed-media-frame';
import { FeedVideoPreview } from '@/components/feed-video-preview';
import { PostDetailsPage } from '@/components/post-details-page';
import { Pill, SecondaryButton, StatusBlock } from '@/components/ui';
import { UnlockRemixPrompt } from '@/components/unlock-remix-prompt';
import { CommentsSheet } from '@/components/comments-sheet';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { useAuth } from '@/lib/auth';
import { applyCommentCountToSourceData } from '@/lib/comments-view-model';
import { env } from '@/lib/env';
import {
  getImmersiveInitialIndex,
  hasImmersiveDetailsPage,
  immersiveViewerReturnPath,
  selectActiveImmersiveVideoId,
  type ImmersivePreviewItem,
} from '@/lib/immersive-preview-view-model';
import { createShowcaseFeedViewerQueryKey } from '@/lib/showcase-feed-query';
import {
  buildImmersiveSlidePages,
  getImmersiveVideoBlockerId,
  isImmersiveDetailsSlidePageIndex,
  type ImmersiveSlidePage,
} from '@/lib/immersive-slide-pages';
import { formatCompactCount } from '@/lib/home-view-model';
import { buildReelCaption, getRailCountLabel, getReelFollowTarget } from '@/lib/reel-overlay-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { useCreatorFollow } from '@/lib/use-creator-follow';
import { useHardwareBack } from '@/lib/use-hardware-back';
import {
  buildViewerItems,
  type ImmersiveSourceData,
  loadImmersiveSourceData,
  normalizeParam,
  normalizeViewerSource,
  readCachedImmersiveSourceData,
  readCachedProfile,
} from '@/lib/immersive-preview-source-data';
import { getProfileHandle } from '@/lib/profile-view-model';
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
import { getShowcasePlaybackUrl } from '@/lib/showcase-media';
import {
  createShowcaseMediaProgressTracker,
  reportShowcaseMediaProgress,
  setShowcaseMediaProgressSink,
} from '@/lib/showcase-media-progress';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import type { PostResourceKind, ShowcaseFeedEventType, ShowcaseFeedResponse, ShowcaseMediaItem, ShowcasePostResponse } from '@/lib/types';
import { canSaveViewerItemOnDoubleTap, getDoubleTapSaveHeartAnimationSpec, getDoubleTapSaveHeartPalette, getDoubleTapSaveHeartPosition, getNativeRemixCreateHref, getRailActionOpacity, getSaveHeartIconProps, getSaveHeartTapAnimationSpec, getViewerActionSlots, getViewerShareIntent, getViewerShareSourceSurface, getViewerStateChip, type SaveHeartTapAnimationSpec, type ViewerStateTone } from '@/lib/viewer-actions';
import {
  changePostVisibility,
  pickPostVisibility,
  toPostLifecyclePost,
  type PostLifecyclePost,
} from '@/lib/post-lifecycle';
import type { PostLifecycleVisibility } from '@/lib/post-lifecycle-policy';
import { refreshViewerMediaCaches } from '@/lib/viewer-media-cache';

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
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const listRef = useRef<FlatList<ImmersivePreviewItem>>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [initialPositionReady, setInitialPositionReady] = useState(false);
  const [detailsPageOpenItemId, setDetailsPageOpenItemId] = useState<string | null>(null);
  // The slide under the finger. Only it is ever driven from up here — back
  // and the ⋮ sheet act on what the reader is looking at, never on a neighbour
  // the list keeps mounted off-screen.
  const activeSlideRef = useRef<ImmersiveSlideHandle | null>(null);
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

  const sourceQuery = useQuery({
    queryKey: sourceQueryKey,
    enabled: Boolean(source),
    initialData: () => readCachedImmersiveSourceData(queryClient, source, user?.id, initialId, routeFeedSessionId),
    queryFn: () => loadImmersiveSourceData({ api, source, initialId, creatorUsername }),
    staleTime: 1000 * 45,
  });

  useEffect(() => {
    if (!isFocused) return;
    if (source === 'showcase-feed' && skipInitialRankedFeedRefreshRef.current) {
      skipInitialRankedFeedRefreshRef.current = false;
      return;
    }
    void sourceQuery.refetch?.();
  }, [isFocused, source, sourceQuery.refetch]);

  const ownerInfo = useMemo(() => ({
    creatorLabel: user ? getProfileHandle(profileQuery.data, user.email) : '@creator',
    creatorAvatar: profileQuery.data?.avatarUrl ?? null,
    creatorId: user?.id ?? null,
  }), [profileQuery.data, user]);

  const items = useMemo(() => {
    const builtItems = buildViewerItems(source, sourceQuery.data, ownerInfo);
    if (user || source !== 'showcase-feed') return builtItems;

    const visiblePostIds = new Set(
      filterAnonymousSessionShowcaseFeedItems(sourceQuery.data?.showcaseItems ?? [])
        .map((item) => item.id)
    );
    return builtItems.filter((item) => (
      !item.showcasePostId || visiblePostIds.has(item.showcasePostId)
    ));
  }, [source, sourceQuery.data, ownerInfo, user]);
  const openCreatorProfile = useCallback((item: ImmersivePreviewItem) => {
    if (!item.creatorUsername) return;
    router.push(`/creators/${encodeURIComponent(item.creatorUsername)}` as never);
  }, []);
  const initialIndex = useMemo(() => getImmersiveInitialIndex(items, initialId), [items, initialId]);
  const overlayOpenItemId = getImmersiveVideoBlockerId({
    actionsOpenItemId,
    commentsOpenItemId,
    detailsPageOpenItemId,
    unlockRemixOpenItemId,
  });
  const activeVideoId = isFocused
    ? selectActiveImmersiveVideoId(items, activeIndex, overlayOpenItemId)
    : null;
  const activeItem = items[activeIndex];
  const detailsOpenForActive = Boolean(activeItem) && detailsPageOpenItemId === activeItem.id;
  const showMediaForActive = useCallback(() => {
    activeSlideRef.current?.showMedia();
  }, []);
  // Back from the details page is back to the media, not out of the reel.
  // Gated on focus: the listener would otherwise outlive a push to a creator
  // profile or the sign-in screen and swallow their back key.
  useHardwareBack(isFocused && detailsOpenForActive, showMediaForActive);
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
  // so an open sheet always has content to render.
  const lastUnlockRemixItemRef = useRef<ImmersivePreviewItem | null>(null);
  useEffect(() => {
    if (unlockRemixItem) {
      lastUnlockRemixItemRef.current = unlockRemixItem;
    } else if (!unlockRemixOpenItemId) {
      lastUnlockRemixItemRef.current = null;
    }
  }, [unlockRemixItem, unlockRemixOpenItemId]);
  const unlockRemixSheetItem = unlockRemixOpenItemId
    ? unlockRemixItem ?? lastUnlockRemixItemRef.current
    : null;

  useEffect(() => {
    if (!items.length || initialPositionReady) return;
    const frame = requestAnimationFrame(() => {
      setActiveIndex(initialIndex);
      listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
      setInitialPositionReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [initialIndex, initialPositionReady, items.length]);

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
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
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
      router.push('/auth');
      return;
    }

    if (item.sourceType === 'showcase' && item.showcasePostId) {
      setRemixingItemId(item.id);
      try {
        const response = await api.remixShowcasePost(item.showcasePostId);
        if (source === 'showcase-feed') {
          recordViewerFeedEvent(item, 'remix_start');
        }
        const nativeHref = getNativeRemixCreateHref({
          redirectTo: response.redirectTo,
          recreateTool: item.recreateTool,
          prompt: response.prefill?.prompt ?? item.recreatePrompt,
        });
        if (nativeHref) {
          router.push(nativeHref as never);
          return;
        }
        if (response.redirectTo) {
          await Linking.openURL(`${env.siteUrl}${response.redirectTo}`);
          return;
        }
      } catch (error) {
        Alert.alert('Could not start remix', error instanceof Error ? error.message : 'Please try again.');
        return;
      } finally {
        setRemixingItemId(null);
      }
    }

    const fallbackHref = getNativeRemixCreateHref({
      recreateTool: item.recreateTool,
      prompt: item.recreatePrompt,
    });
    router.push((fallbackHref ?? `/create/${item.recreateTool}`) as never);
  };

  const applyPostVisibility = async (
    post: PostLifecyclePost,
    visibility: PostLifecycleVisibility,
    action: string
  ) => {
    setOwnerActionPending(action);
    try {
      const outcome = await changePostVisibility({ api, post, visibility });
      if (outcome === 'done') {
        await refreshViewerMediaCaches(queryClient, user?.id);
        await sourceQuery.refetch();
        void AccessibilityInfo.announceForAccessibility(`This post is now ${visibility}.`);
      }
    } finally {
      setOwnerActionPending(null);
    }
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
      const post = toPostLifecyclePost({
        id: item.linkedPostId,
        visibility: item.linkedPostVisibility,
        archivedAt: item.linkedPostArchivedAt,
        bundle: item.linkedPostBundle ?? null,
      });
      pickPostVisibility(post.visibility, (next) => void applyPostVisibility(post, next, action));
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
            ? `${item.creatorLabel} hidden from your Showcase.`
            : `${item.creatorLabel} hidden for this visit.`
          : user
            ? 'Post removed. Your Showcase will adapt.'
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
        Alert.alert(
          'Couldn’t update your Showcase',
          'The post was restored. Check your connection and try again.'
        );
        void AccessibilityInfo.announceForAccessibility(
          'Couldn’t update your Showcase. The post was restored.'
        );
      });
  };

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
    <View style={{ flex: 1, backgroundColor: '#000' }}>
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
          setActiveIndex(clampedIndex);
          setDetailsPageOpenItemId(null);
          setActionsOpenItemId(null);
          setUnlockRemixOpenItemId(null);
        }}
        onScrollToIndexFailed={({ index }) => {
          requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset: height * index, animated: false });
          });
        }}
        pagingEnabled
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item, index }) => (
          <ImmersiveSlide
            active={index === activeIndex}
            activeSlideRef={activeSlideRef}
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
            onDetailsPageOpenChange={(open) => setDetailsPageOpenItemId(open ? item.id : null)}
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
        windowSize={IMMERSIVE_VERTICAL_LIST_TUNING.windowSize}
      />
      {/* The details page draws its own header with its own way back; the
          reel's arrow would be a second back button that leaves the reel. */}
      {detailsOpenForActive ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={leaveViewer}
          style={({ pressed }) => ({
            position: 'absolute',
            left: 16,
            top: topInset + 10,
            width: 48,
            height: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 24,
            backgroundColor: 'rgba(0,0,0,0.3)',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <IconShadow><ArrowLeft size={30} color="#ffffff" strokeWidth={2.4} /></IconShadow>
        </Pressable>
      )}
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
          onBlocked={() => leaveViewer()}
          onSourceRefresh={() => void sourceQuery.refetch()}
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
        bottomInset={bottomInset}
        item={unlockRemixSheetItem}
        onClose={() => setUnlockRemixOpenItemId(null)}
        onUnlocked={(item) => recreateItem(item)}
        visible={Boolean(unlockRemixOpenItemId)}
      />
      {sourceQuery.isFetching && activeItem ? (
        <View style={{ position: 'absolute', top: topInset + 24, right: 20 }}>
          <ActivityIndicator color="rgba(255,255,255,0.72)" />
        </View>
      ) : null}
    </View>
  );
}

function ViewerShell({ topInset, bottomInset, children }: { topInset: number; bottomInset: number; children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', paddingTop: topInset, paddingBottom: bottomInset, paddingHorizontal: 24 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={leaveViewer}
        style={{ position: 'absolute', left: 16, top: topInset + 10, width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)' }}
      >
        <IconShadow><ArrowLeft size={30} color="#ffffff" strokeWidth={2.4} /></IconShadow>
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
  activeSlideRef,
  activeVideoId,
  authReturnTo,
  bottomInset,
  height,
  item,
  onActionsOpen,
  onComments,
  onCreatorOpen,
  onDetailsPageOpenChange,
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
  activeSlideRef: MutableRefObject<ImmersiveSlideHandle | null>;
  activeVideoId: string | null;
  /** Where sign-in should land the viewer back: this reel, on this item. */
  authReturnTo: string;
  bottomInset: number;
  height: number;
  item: ImmersivePreviewItem;
  onActionsOpen: () => void;
  onComments?: () => void;
  onCreatorOpen: (item: ImmersivePreviewItem) => void;
  onDetailsPageOpenChange: (open: boolean) => void;
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
  const [currentHorizontalIndex, setCurrentHorizontalIndex] = useState(0);
  const [saveHeartPopTrigger, setSaveHeartPopTrigger] = useState(0);
  const prevActiveRef = useRef(active);
  const doubleTapHeart = useDoubleTapSaveHeartAnimation({ height, width });
  const { user } = useAuth();
  const followTarget = getReelFollowTarget(item, user?.id ?? null);
  const follow = useCreatorFollow({ creatorId: followTarget?.creatorId ?? null, enabled: active && Boolean(followTarget) });
  const reelCaption = useMemo(() => buildReelCaption(item), [item]);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  // The bottom scrim is sized to the text it protects, so it is measured.
  const [captionBlockHeight, setCaptionBlockHeight] = useState(0);
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
  const currentPageIsDetails = isImmersiveDetailsSlidePageIndex(pages, currentHorizontalIndex);
  const canOpenCreator = Boolean(item.creatorUsername);
  const updateCurrentHorizontalIndex = useCallback((pageIndex: number) => {
    setCurrentHorizontalIndex(pageIndex);
    onDetailsPageOpenChange(isImmersiveDetailsSlidePageIndex(pages, pageIndex));
  }, [onDetailsPageOpenChange, pages]);

  const openDetailsPage = useCallback(() => {
    const detailsIndex = pages.findIndex((page) => page.type === 'details');
    if (detailsIndex < 0) return;

    updateCurrentHorizontalIndex(detailsIndex);
    horizontalRef.current?.scrollToIndex({ index: detailsIndex, animated: true });
  }, [pages, updateCurrentHorizontalIndex]);

  const showMediaPage = useCallback(() => {
    updateCurrentHorizontalIndex(0);
    horizontalRef.current?.scrollToIndex({ index: 0, animated: true });
  }, [updateCurrentHorizontalIndex]);

  // Only the active slide answers the reel. A neighbour that the list keeps
  // mounted must never be scrolled from outside: its native views may be
  // clipped on Android, and activation snaps it back to page 0 anyway.
  useEffect(() => {
    if (!active) return;
    const handle: ImmersiveSlideHandle = { openDetails: openDetailsPage, showMedia: showMediaPage };
    activeSlideRef.current = handle;
    return () => {
      if (activeSlideRef.current === handle) activeSlideRef.current = null;
    };
  }, [active, activeSlideRef, openDetailsPage, showMediaPage]);

  useEffect(() => {
    if (!active) {
      prevActiveRef.current = active;
      return;
    }

    const becameActive = !prevActiveRef.current;
    prevActiveRef.current = active;

    if (becameActive && currentHorizontalIndex !== 0) {
      const frame = requestAnimationFrame(() => {
        updateCurrentHorizontalIndex(0);
        horizontalRef.current?.scrollToIndex({ index: 0, animated: false });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [active, currentHorizontalIndex, updateCurrentHorizontalIndex]);

  const mediaCount = item.mediaItems?.length ?? 0;
  const isTextPost = item.previewKind === 'text';
  const railSlots = useMemo(() => getViewerActionSlots(item), [item]);
  const stateChip = useMemo(() => getViewerStateChip(item), [item]);
  const videoPlaybackActive = active && activeVideoId === item.id && !currentPageIsDetails;
  const saveFromDoubleTap = useCallback((position: DoubleTapSavePosition) => {
    doubleTapHeart.play(position);
    setSaveHeartPopTrigger((current) => current + 1);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    if (!canSaveViewerItemOnDoubleTap({
      canSave: item.canSave,
      isSaved: item.isSaved,
      saveLoading,
    })) return;
    onSave(item, 'double-tap');
  }, [doubleTapHeart, item, onSave, saveLoading]);

  const renderOverlays = () => {
    if (currentPageIsDetails) {
      return null;
    }

    // Only the text needs a scrim. It runs from just above the caption block
    // to the bottom edge and no further — the picture above it is the point.
    const scrimHeight = Math.max(220, captionBlockHeight + bottomInset + 120);
    const showFollowPill = Boolean(followTarget) && (!user || !follow.loading);

    return (
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          inset: 0,
        }}
      >
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.42)', 'rgba(0,0,0,0.84)']}
          locations={[0, 0.42, 1]}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: scrimHeight }}
        />

        {/* Media count indicator */}
        {!isTextPost && mediaCount > 1 ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              right: 18,
              top: 68,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.14)',
              backgroundColor: 'rgba(3,3,6,0.68)',
              paddingHorizontal: 10,
              paddingVertical: 5,
            }}
          >
            <Images size={14} color="#ffffff" />
            <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '800' }}>
              {Math.min(currentHorizontalIndex + 1, mediaCount)} / {mediaCount}
            </Text>
          </View>
        ) : null}

        {/* Right rail. The universal actions are bare icons with a count for a
            label, the way every reel app draws them; only what is ours — Remix,
            Details, the owner's publish controls — keeps a button and a word. */}
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            right: 14,
            bottom: bottomInset + 96,
            alignItems: 'center',
            gap: 14,
          }}
        >
          {railSlots.map((slot) => {
            if (slot.id === 'save') {
              const saveCountLabel = getRailCountLabel(item.saveCount, formatCompactCount);
              return (
                <RailActionButton
                  key={slot.id}
                  accessibilityLabel={item.isSaved
                    ? 'Saved'
                    : saveCountLabel
                      ? `Save, ${item.saveCount} ${item.saveCount === 1 ? 'save' : 'saves'}`
                      : 'Save'}
                  disabled={!item.canSave}
                  icon={<Heart size={30} {...getSaveHeartIconProps({ isSaved: item.isSaved, enabled: item.canSave })} />}
                  label={saveCountLabel}
                  loading={saveLoading}
                  onPress={() => onSave(item)}
                  preserveIconWhileLoading
                  showDisabledAsActive={item.isSaved && !item.canSave}
                  tapAnimationSpec={getSaveHeartTapAnimationSpec({ willSave: !item.isSaved, enabled: item.canSave })}
                  externalPopTrigger={saveHeartPopTrigger}
                  variant="bare"
                />
              );
            }
            if (slot.id === 'comment') {
              return onComments ? (
                <RailActionButton
                  key={slot.id}
                  accessibilityLabel={item.commentCount > 0
                    ? `${item.commentCount} ${item.commentCount === 1 ? 'comment' : 'comments'}`
                    : 'Comment'}
                  icon={<MessageCircle size={30} color="#ffffff" fill="transparent" strokeWidth={2.2} />}
                  iconShadow={false}
                  label={getRailCountLabel(item.commentCount, formatCompactCount)}
                  onPress={onComments}
                  variant="bare"
                />
              ) : null;
            }
            if (slot.id === 'share') {
              return (
                <RailActionButton
                  key={slot.id}
                  accessibilityLabel="Share"
                  icon={<Share2 size={28} color="#ffffff" strokeWidth={2.2} />}
                  label={null}
                  onPress={() => void onShare(item)}
                  variant="bare"
                />
              );
            }
            if (slot.id === 'details') {
              return hasImmersiveDetailsPage(item) ? (
                <RailActionButton
                  key={slot.id}
                  icon={<FileText size={26} color="#ffffff" strokeWidth={2.4} />}
                  label={slot.label}
                  onPress={openDetailsPage}
                />
              ) : null;
            }
            if (slot.id === 'create') {
              return (
                <RailActionButton
                  key={slot.id}
                  primary
                  icon={<Repeat2 size={26} color="#050505" strokeWidth={2.8} />}
                  label={slot.label}
                  loading={slot.action === 'unlock-remix' ? false : remixLoading}
                  onPress={slot.action === 'unlock-remix' ? () => onUnlockRemix(item) : () => void onRecreate(item)}
                />
              );
            }

            // Ownership slots — publish, visibility, unlock — all delegate to the
            // same action ids the More sheet uses, so there is one code path per action.
            const ownerIcon = slot.id === 'publish'
              ? <Globe size={26} color="#050505" strokeWidth={2.6} />
              : slot.id === 'unlock'
                ? <Wand2 size={26} color={appTheme.colors.success} strokeWidth={2.5} />
                : (item.visibility ?? item.linkedPostVisibility) === 'private' || (item.visibility ?? item.linkedPostVisibility) === 'unlisted'
                  ? <LockKeyhole size={26} color={appTheme.colors.warning} strokeWidth={2.5} />
                  : <Globe size={26} color="#ffffff" strokeWidth={2.4} />;

            return (
              <RailActionButton
                key={slot.id}
                accessibilityLabel={slot.a11yLabel ?? slot.label}
                icon={ownerIcon}
                label={slot.label}
                loading={ownerActionPending === slot.action}
                primary={slot.tone === 'primary'}
                onPress={() => slot.action && onOwnerAction?.(slot.action)}
              />
            );
          })}
          <RailActionButton
            accessibilityLabel="More options"
            icon={<MoreHorizontal size={28} color="#ffffff" strokeWidth={2.4} />}
            label={null}
            onPress={onActionsOpen}
            variant="bare"
          />
        </View>

        {/* Bottom text: who, then what — identity beside the caption, the way a
            reader expects to find it, with the whole block one tap from its
            full length. */}
        <View
          pointerEvents="box-none"
          onLayout={(event) => setCaptionBlockHeight(event.nativeEvent.layout.height)}
          style={{
            position: 'absolute',
            left: 18,
            right: 88,
            bottom: bottomInset + 24,
            gap: 8,
          }}
        >
          {/* A text slide already prints its own badge, title and body, so the
              overlay would say all three a second time. */}
          {isTextPost ? null : (
          <>
          <View pointerEvents="none" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <View style={{ borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 10, paddingVertical: 6 }}>
              <Text numberOfLines={1} style={{ color: '#fff', fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
                {item.badge}
              </Text>
            </View>
            {/* Owned media leads with its publish state — for a creation that is the
                single most important fact on the slide. */}
            {stateChip ? (
              <View
                style={{
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: viewerStateChipStyle(stateChip.tone).border,
                  backgroundColor: viewerStateChipStyle(stateChip.tone).background,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              >
                <Text numberOfLines={1} style={{ color: viewerStateChipStyle(stateChip.tone).foreground, fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
                  {stateChip.label}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.creatorLabel} profile`}
              disabled={!canOpenCreator}
              onPress={() => onCreatorOpen(item)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 9,
                flexShrink: 1,
                opacity: pressed ? 0.72 : canOpenCreator ? 1 : 0.86,
              })}
            >
              <ViewerCreatorAvatar item={item} size={34} />
              <Text numberOfLines={1} style={{ flexShrink: 1, color: '#fff', fontSize: 15, lineHeight: 19, fontWeight: '700', ...REEL_TEXT_SHADOW }}>
                {item.creatorLabel}
              </Text>
            </Pressable>
            {showFollowPill ? (
              <FollowPill
                following={Boolean(user) && follow.following}
                pending={follow.pending}
                onPress={onFollowPress}
              />
            ) : null}
          </View>
          {reelCaption.title || reelCaption.caption ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={captionExpanded ? 'Collapse caption' : 'Expand caption'}
              onPress={() => setCaptionExpanded((current) => !current)}
              style={{ gap: 3 }}
            >
              {reelCaption.title ? (
                <Text numberOfLines={captionExpanded ? 4 : 1} style={{ color: '#fff', fontSize: 16, lineHeight: 21, fontWeight: '700', ...REEL_TEXT_SHADOW }}>
                  {reelCaption.title}
                </Text>
              ) : null}
              {reelCaption.caption ? (
                <Text numberOfLines={captionExpanded ? 8 : 1} style={{ color: 'rgba(255,255,255,0.88)', fontSize: 14, lineHeight: 19, fontWeight: '400', ...REEL_TEXT_SHADOW }}>
                  {reelCaption.caption}
                </Text>
              ) : null}
            </Pressable>
          ) : null}
          </>
          )}
        </View>
      </View>
    );
  };

  if (pages.length <= 1) {
    return (
      <View style={{ width, height }}>
        <MediaSlidePage
          active={videoPlaybackActive}
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
        {renderOverlays()}
        <DoubleTapSaveHeart
          opacity={doubleTapHeart.opacity}
          palette={doubleTapHeart.palette}
          position={doubleTapHeart.position}
          scale={doubleTapHeart.scale}
        />
      </View>
    );
  }

  return (
    <View style={{ width, height, backgroundColor: '#000' }}>
      <FlatList
        ref={horizontalRef}
        data={pages}
        decelerationRate="fast"
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        horizontal
        initialNumToRender={IMMERSIVE_HORIZONTAL_LIST_TUNING.initialNumToRender}
        initialScrollIndex={0}
        keyExtractor={(page, index) => page.type === 'media' ? `media-${page.mediaItem.id}` : `${page.type}-${index}`}
        maxToRenderPerBatch={IMMERSIVE_HORIZONTAL_LIST_TUNING.maxToRenderPerBatch}
        onScrollBeginDrag={() => onHorizontalScrollToggle?.(true)}
        onScrollEndDrag={() => onHorizontalScrollToggle?.(false)}
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
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item: page, index: pageIndex }) => (
          <MediaSlidePage
            active={active && currentHorizontalIndex === pageIndex && (page.type !== 'media' || videoPlaybackActive)}
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
        )}
        scrollEnabled={active}
        showsHorizontalScrollIndicator={false}
        style={{ width, height, backgroundColor: '#000' }}
        windowSize={IMMERSIVE_HORIZONTAL_LIST_TUNING.windowSize}
      />
      {renderOverlays()}
      <DoubleTapSaveHeart
        opacity={doubleTapHeart.opacity}
        palette={doubleTapHeart.palette}
        position={doubleTapHeart.position}
        scale={doubleTapHeart.scale}
      />
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
      ) : (
        <ImmersiveMedia
          mediaItem={page.mediaItem}
          active={active}
          onDoubleTapSave={onDoubleTapSave}
          width={width}
          height={height}
        />
      )}
    </View>
  );
}


function viewerStateChipStyle(tone: ViewerStateTone) {
  const semantic = tone === 'neutral' ? appTheme.semantic.neutral : appTheme.semantic[tone];
  return {
    foreground: semantic.foreground,
    // The semantic tints are tuned for app surfaces and wash out over media, so the
    // chip keeps a dark fill and lets the semantic border carry the signal.
    background: 'rgba(8,8,10,0.62)',
    border: semantic.border,
  };
}


function ImmersiveMedia({
  mediaItem,
  active,
  onDoubleTapSave,
  width,
  height,
}: {
  mediaItem: ShowcaseMediaItem;
  active: boolean;
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

  if (mediaItem.mediaKind === 'video') {
    if (active && mediaItem.url) {
      return <ActiveVideo
        url={getShowcasePlaybackUrl(mediaItem)}
        previewUrl={mediaItem.previewUrl}
        previewCacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
        previewThumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
        onDoublePress={handleDoublePress}
        width={width}
        height={height}
      />;
    }

    if (mediaItem.previewUrl) {
      return (
        <DoubleTapPressable
          accessible={false}
          onDoublePress={handleDoublePress}
          style={{ width, height }}
        >
          <FeedMediaFrame
            kind="image"
            url={mediaItem.previewUrl}
            backdropUrl={mediaItem.previewUrl}
            cacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
            thumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
            recyclingKey={`viewer:${mediaItem.id}`}
            style={{ width, height }}
          />
          <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.42)' }}>
              <Play size={34} color="#fff" fill="#fff" strokeWidth={2.4} />
            </View>
          </View>
        </DoubleTapPressable>
      );
    }

    return mediaItem.url ? (
      <DoubleTapPressable
        accessible={false}
        onDoublePress={handleDoublePress}
        style={{ width, height, backgroundColor: '#020203' }}
      >
        <FeedVideoPreview
          url={getShowcasePlaybackUrl(mediaItem)}
          active={false}
          height={height}
          radius={0}
          accent="#ffffff"
        />
        <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <Play size={34} color="#fff" fill="#fff" strokeWidth={2.4} />
          </View>
        </View>
      </DoubleTapPressable>
    ) : (
      <DoubleTapPressable
        accessible={false}
        onDoublePress={handleDoublePress}
        style={{ width, height, alignItems: 'center', justifyContent: 'center', backgroundColor: '#020203' }}
      >
        <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' }}>
          <Play size={34} color="#fff" fill="#fff" strokeWidth={2.4} />
        </View>
      </DoubleTapPressable>
    );
  }

  if (mediaItem.url) {
    return (
      <DoubleTapPressable
        accessible={false}
        onDoublePress={handleDoublePress}
        style={{ width, height }}
      >
        <FeedMediaFrame
          kind="image"
          url={mediaItem.url}
          backdropUrl={mediaItem.previewUrl}
          cacheKey={mediaItem.preview?.cacheKey ?? mediaItem.previewCacheKey}
          thumbhash={mediaItem.preview?.thumbhash ?? mediaItem.previewThumbhash}
          transition={120}
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

function ActiveVideo({
  url,
  previewUrl,
  previewCacheKey,
  previewThumbhash,
  onDoublePress,
  width,
  height,
}: {
  url: string;
  previewUrl?: string | null;
  previewCacheKey?: string;
  previewThumbhash?: string | null;
  onDoublePress: (event: GestureResponderEvent) => void;
  width: number;
  height: number;
}) {
  const [hasFrame, setHasFrame] = useState(false);
  const [hasError, setHasError] = useState(false);
  const reducedMotion = useReducedMotion();
  const player = useVideoPlayer({ uri: url, useCaching: true }, (instance) => {
    instance.loop = true;
    instance.muted = false;
    instance.volume = 1.0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
    instance.timeUpdateEventInterval = 0.25;
  });

  // Optimistic: playback is requested below, and the native player reports
  // `playing` only once it is actually rendering — often a frame or two after
  // the first frame has already been drawn. Reading `player.playing` here
  // would flash the paused badge over that first frame; `playingChange` still
  // corrects this the moment the player really is paused.
  const [isPlaying, setIsPlaying] = useState(!reducedMotion);

  useEffect(() => {
    if (reducedMotion) player.pause();
    else player.play();
  }, [player, reducedMotion]);

  useEffect(() => {
    setHasFrame(false);
    setHasError(false);
  }, [url]);

  useEffect(() => {
    const subscription = player.addListener('playingChange', (event) => {
      setIsPlaying(event.isPlaying);
    });
    return () => {
      subscription.remove();
    };
  }, [player]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', (event) => {
      setHasError(event.status === 'error');
    });
    return () => {
      subscription.remove();
    };
  }, [player]);

  useEffect(() => {
    const subscription = player.addListener('timeUpdate', (event) => {
      const durationSeconds = player.duration;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
      reportShowcaseMediaProgress(event.currentTime / durationSeconds, durationSeconds * 1000);
    });
    return () => {
      subscription.remove();
    };
  }, [player]);

  const togglePlayback = () => {
    if (player.playing) {
      player.pause();
    } else {
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
        <FeedMediaFrame
          kind="video"
          player={player}
          backdropUrl={previewUrl}
          posterUrl={previewUrl}
          posterVisible={Boolean(previewUrl && (!hasFrame || hasError))}
          cacheKey={previewCacheKey}
          thumbhash={previewThumbhash}
          onFirstFrameRender={() => {
            setHasFrame(true);
            setHasError(false);
          }}
          style={{ width, height }}
        />
        {!isPlaying && hasFrame && !hasError ? (
          <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
              <Play size={34} color="#fff" fill="#fff" strokeWidth={2.4} style={{ marginLeft: 4 }} />
            </View>
          </View>
        ) : null}
      </DoubleTapPressable>
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

function ViewerCreatorAvatar({
  item,
  onPress,
  size = 40,
}: {
  item: ImmersivePreviewItem;
  onPress?: () => void;
  size?: number;
}) {
  const initial = item.creatorLabel.replace(/^@/, '').trim()[0]?.toUpperCase() || 'C';
  const innerSize = size - 3;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.creatorLabel} profile`}
      disabled={!onPress}
      onPress={onPress}
      hitSlop={Math.max(0, (appTheme.touch.compact - size) / 2)}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        padding: 1.5,
        backgroundColor: 'rgba(255,255,255,0.9)',
        opacity: pressed ? 0.76 : onPress ? 1 : 0.9,
      })}
    >
      <View style={{ flex: 1, overflow: 'hidden', borderRadius: innerSize / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: '#27272a' }}>
        {item.creatorAvatar ? (
          <Image source={{ uri: item.creatorAvatar }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <Text style={{ color: '#fff', fontSize: size > 44 ? 20 : 15, fontWeight: '800' }}>{initial}</Text>
        )}
      </View>
    </Pressable>
  );
}

const REEL_TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.55)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 5,
} as const;

type ShadowableIconProps = { color?: string; fill?: string; strokeWidth?: number };

/**
 * A bare icon over a photograph needs an edge. Native shadows cannot follow a
 * glyph on Android, so the icon is drawn twice: a darker, slightly thicker
 * copy a pixel below, then the icon itself — a soft halo that reads over
 * both a pale sky and a black dress.
 */
function IconShadow({ children }: { children: ReactElement<ShadowableIconProps> }) {
  const hasFill = Boolean(children.props.fill) && children.props.fill !== 'none' && children.props.fill !== 'transparent';
  const shadow = cloneElement(children, {
    color: 'rgba(0,0,0,0.55)',
    fill: hasFill ? 'rgba(0,0,0,0.55)' : children.props.fill,
    strokeWidth: (children.props.strokeWidth ?? 2) + 1.4,
  });

  return (
    <View>
      <View pointerEvents="none" style={{ position: 'absolute', top: 1.5, left: 0 }}>{shadow}</View>
      {children}
    </View>
  );
}

function FollowPill({ following, pending, onPress }: { following: boolean; pending: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={following ? 'Following' : 'Follow'}
      accessibilityState={{ selected: following, busy: pending }}
      disabled={pending}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 30,
        justifyContent: 'center',
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: following ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.92)',
        backgroundColor: 'rgba(0,0,0,0.18)',
        paddingHorizontal: 12,
        opacity: pending ? 0.6 : pressed ? 0.72 : 1,
      })}
    >
      <Text style={{ color: following ? 'rgba(255,255,255,0.8)' : '#fff', fontSize: 13, lineHeight: 16, fontWeight: '700' }}>
        {following ? 'Following' : 'Follow'}
      </Text>
    </Pressable>
  );
}

function RailActionButton({
  accessibilityLabel: providedAccessibilityLabel,
  disabled,
  externalPopTrigger,
  icon,
  iconShadow = true,
  label,
  loading,
  onPress,
  primary,
  preserveIconWhileLoading,
  showDisabledAsActive,
  tapAnimationSpec,
  variant = 'circle',
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  externalPopTrigger?: number;
  icon: ReactElement<ShadowableIconProps>;
  /** Bare icons use the shared contrast halo unless a glyph should remain flat. */
  iconShadow?: boolean;
  /** Under the icon: a word for app-specific actions, a count for the rest, or nothing. */
  label: string | null;
  loading?: boolean;
  onPress: () => void;
  primary?: boolean;
  preserveIconWhileLoading?: boolean;
  showDisabledAsActive?: boolean;
  tapAnimationSpec?: SaveHeartTapAnimationSpec;
  /** `bare` draws the icon straight on the picture; `circle` gives it a button. */
  variant?: 'circle' | 'bare';
}) {
  const tapProgress = useRef(new Animated.Value(0)).current;
  const externalPopProgress = useRef(new Animated.Value(0)).current;
  const previousExternalPopTriggerRef = useRef(externalPopTrigger);
  const reducedMotion = useReducedMotion();
  const [activeTapAnimationSpec, setActiveTapAnimationSpec] = useState(tapAnimationSpec);
  const animationSpec = activeTapAnimationSpec ?? tapAnimationSpec;
  const bare = variant === 'bare';
  const accessibilityLabel = providedAccessibilityLabel ?? label ?? 'Action';
  const iconScale = tapProgress.interpolate({
    inputRange: [0, 0.32, 0.66, 1],
    outputRange: [
      1,
      animationSpec?.pressInScale ?? 1,
      animationSpec?.peakScale ?? 1,
      1,
    ],
  });
  const haloOpacity = tapProgress.interpolate({
    inputRange: [0, 0.36, 1],
    outputRange: [0, animationSpec?.haloPeakOpacity ?? 0, 0],
  });
  const haloScale = tapProgress.interpolate({
    inputRange: [0, 0.44, 1],
    outputRange: [0.92, animationSpec?.haloPeakScale ?? 1, (animationSpec?.haloPeakScale ?? 1) + 0.04],
  });
  const externalIconScale = externalPopProgress.interpolate({
    inputRange: [0, 0.42, 1],
    outputRange: [1, 1.13, 1],
  });

  const runTapAnimation = useCallback(() => {
    if (!tapAnimationSpec || reducedMotion) {
      return;
    }

    setActiveTapAnimationSpec(tapAnimationSpec);
    tapProgress.stopAnimation();
    tapProgress.setValue(0);
    Animated.sequence([
      Animated.timing(tapProgress, {
        toValue: 0.32,
        duration: tapAnimationSpec.pressInDurationMs,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(tapProgress, {
        toValue: 1,
        duration: tapAnimationSpec.settleDurationMs,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [reducedMotion, tapAnimationSpec, tapProgress]);

  useEffect(() => {
    if (
      externalPopTrigger === undefined
      || externalPopTrigger === previousExternalPopTriggerRef.current
    ) {
      return;
    }

    previousExternalPopTriggerRef.current = externalPopTrigger;
    externalPopProgress.stopAnimation();
    externalPopProgress.setValue(0);
    if (reducedMotion) return;

    Animated.sequence([
      Animated.timing(externalPopProgress, {
        toValue: 0.42,
        duration: 80,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(externalPopProgress, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [externalPopProgress, externalPopTrigger, reducedMotion]);

  useEffect(() => () => {
    externalPopProgress.stopAnimation();
  }, [externalPopProgress]);

  const handlePress = useCallback(() => {
    runTapAnimation();
    onPress();
  }, [onPress, runTapAnimation]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      disabled={disabled || loading}
      onPress={handlePress}
      style={({ pressed }) => ({
        alignItems: 'center',
        gap: 5,
        opacity: getRailActionOpacity({
          disabled: disabled || loading,
          pressed,
          showAsActive: showDisabledAsActive || (Boolean(loading) && Boolean(preserveIconWhileLoading)),
        }),
        minWidth: 64,
        // Without a ceiling a long label widens the button and drags the whole rail
        // out of its column, so labels truncate inside a fixed-width lane instead.
        maxWidth: 76,
      })}
    >
      <View
        style={{
          // The touch target keeps its size either way; only the button drawing
          // comes and goes with the variant.
          width: bare ? 48 : 54,
          height: bare ? 48 : 54,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 27,
          borderWidth: primary || bare ? 0 : 1,
          borderColor: 'rgba(255,255,255,0.16)',
          backgroundColor: bare ? 'transparent' : primary ? appTheme.colors.primary : 'rgba(12,12,16,0.42)',
        }}
      >
        {tapAnimationSpec && animationSpec ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: 54,
              height: 54,
              borderRadius: 27,
              backgroundColor: animationSpec.haloColor,
              opacity: haloOpacity,
              transform: [{ scale: haloScale }],
            }}
          />
        ) : null}
        {loading && !preserveIconWhileLoading ? (
          <ActivityIndicator color={primary ? '#050505' : '#fff'} />
        ) : (
          <Animated.View style={{ transform: [{ scale: iconScale }] }}>
            <Animated.View style={{ transform: [{ scale: externalIconScale }] }}>
              {bare && iconShadow ? <IconShadow>{icon}</IconShadow> : icon}
            </Animated.View>
          </Animated.View>
        )}
      </View>
      {label ? (
        <Text
          numberOfLines={1}
          style={{
            color: '#fff',
            fontSize: 12,
            lineHeight: 15,
            fontWeight: bare ? '700' : '800',
            marginTop: bare ? -2 : 0,
            textShadowColor: 'rgba(0,0,0,0.6)',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 6,
            fontVariant: ['tabular-nums'],
          }}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}
