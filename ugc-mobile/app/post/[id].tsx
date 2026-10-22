import { NsfwPostNotice } from '@/components/nsfw-post-notice';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { FileText, Heart, MessageCircle, MoreVertical, Repeat2 } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  Share,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PostComments, type PostCommentsHandle } from '@/components/comments-sheet';
import { CreatorAvatar } from '@/components/ui';
import { FeedCardAction } from '@/components/feed-card-shell';
import { PostDetailsPage } from '@/components/post-details-page';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { ViewerActionsMenu, ViewerActionsMenuProvider } from '@/components/viewer-actions-menu';
import { ApiError } from '@/lib/api-client';
import { env } from '@/lib/env';
import { useAuth } from '@/lib/auth';
import {
  buildImmersiveOwnerPostItems,
  buildImmersiveShowcaseItems,
  hasImmersiveDetailsPage,
  immersiveViewerHref,
  textPostViewerHref,
} from '@/lib/immersive-preview-view-model';
import { readCachedImmersiveSourceData, readCachedProfile } from '@/lib/immersive-preview-source-data';
import { getCommentCountLabel } from '@/lib/comments-view-model';
import { canRevealNsfwInApp } from '@/lib/nsfw-reveal-policy';
import { BackGlyph, ShareGlyph } from '@/lib/platform-glyphs';
import { getProfileHandle } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { createShowcasePostQueryKey } from '@/lib/showcase-feed-query';
import { buildTextPostPage } from '@/lib/text-post-page-view-model';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { ShowcasePostResponse } from '@/lib/types';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { useShowcaseSaveMutation } from '@/lib/use-showcase-save-mutation';
import { getThemedSaveHeartIconProps, getViewerActionSlots, getViewerShareIntent, getViewerStateChip } from '@/lib/viewer-actions';
import { verticalHitSlop } from '@/lib/hit-target';

/** The creator byline reads as a single line of text; its reach is widened rather than its height. */
const CREATOR_ROW_HEIGHT = 32;

/**
 * A written post, read as a page.
 *
 * The immersive viewer is the showcase reel — a vertical swipe there pages
 * through other people's media — which is the wrong home for something whose
 * payload is prose. This screen keeps the one gesture that reel got right:
 * page 0 is the post, and a swipe left reaches the same details page media
 * posts have. There is no vertical reel, so the body simply scrolls.
 */
export default function PostScreen() {
  const theme = useAppTheme();
  const params = useLocalSearchParams<{ id: string; source?: string; comments?: string; replyTo?: string; deliveryId?: string; s?: string }>();
  const postId = Array.isArray(params.id) ? params.id[0] : params.id;
  const source = Array.isArray(params.source) ? params.source[0] : params.source;
  const requestedCommentsPostId = Array.isArray(params.comments) ? params.comments[0] : params.comments;
  const requestedReplyToId = Array.isArray(params.replyTo) ? params.replyTo[0] : params.replyTo;
  // The feed delivery a Home card opened this post from: its comments are credited to it.
  const deliveryId = (Array.isArray(params.deliveryId) ? params.deliveryId[0] : params.deliveryId) || null;
  // A shared URL carries `?s=<surface>` and in-app links never do, so its
  // presence is what makes this open a share visit, as on the web post page
  // (`src/app/showcase/[id]/page.tsx`). Sent as it came: the server counts a
  // surface it does not know as the detail page.
  const shareVisitSurface = (Array.isArray(params.s) ? params.s[0] : params.s)?.trim() || null;
  const isOwnerPost = source === 'profile-posts';
  const showcaseSource = source === 'profile-saved' ? 'profile-saved' : 'showcase-feed';
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const isFocused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const pagerRef = useRef<FlatList<'post' | 'details'>>(null);
  const commentsRef = useRef<PostCommentsHandle>(null);
  const restoredCommentContextRef = useRef<string | null>(null);
  const recordedShareVisitRef = useRef<string | null>(null);
  const followedPostIdRef = useRef<string | null>(null);

  const [actionsVisible, setActionsVisible] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [commentCountOverride, setCommentCountOverride] = useState<number | null>(null);
  const [restoredReplyToId, setRestoredReplyToId] = useState<string | null>(null);
  // Whether `NsfwPostNotice` is showing a covered post's original right now:
  // the thread waits for it.
  const [nsfwRevealed, setNsfwRevealed] = useState(false);

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: isOwnerPost && Boolean(user),
    initialData: () => readCachedProfile(queryClient, user?.id),
    queryFn: api.getProfile,
    staleTime: 1000 * 60 * 5,
  });

  const showcasePostQuery = useQuery({
    queryKey: createShowcasePostQueryKey(postId, user?.id),
    enabled: Boolean(postId) && !isOwnerPost,
    initialData: () => {
      if (!postId || showcaseSource !== 'profile-saved') return undefined;
      const post = readCachedImmersiveSourceData(
        queryClient,
        showcaseSource,
        user?.id,
        postId
      )?.showcaseItems?.find((candidate) => candidate.id === postId);
      return post ? { success: true, item: post } : undefined;
    },
    queryFn: () => api.getShowcasePost(postId!) as Promise<ShowcasePostResponse>,
    staleTime: 1000 * 45,
  });

  const ownerPostQuery = useQuery({
    queryKey: ['owner-text-post', postId, user?.id],
    enabled: Boolean(postId) && isOwnerPost && Boolean(user),
    initialData: () => {
      if (!postId || !user) return undefined;
      const post = readCachedImmersiveSourceData(
        queryClient,
        'profile-posts',
        user.id,
        postId
      )?.ownerPosts?.find((candidate) => candidate.id === postId);
      return post ? { success: true, post } : undefined;
    },
    queryFn: () => api.getOwnerPost(postId!),
    staleTime: 1000 * 45,
  });

  // Home seeds the public showcase query before navigating. Profile-owned posts
  // use the authenticated owner endpoint so private text posts can share this UI.
  const item = useMemo(() => {
    if (isOwnerPost) {
      const post = ownerPostQuery.data?.post;
      if (!post) return null;
      return buildImmersiveOwnerPostItems('profile-posts', [post], {
        creatorLabel: getProfileHandle(profileQuery.data, user?.email),
        creatorAvatar: profileQuery.data?.avatarUrl ?? null,
        creatorId: user?.id ?? null,
      })[0] ?? null;
    }

    const post = showcasePostQuery.data?.item;
    if (!post) return null;
    // With the viewer's id, as the reel builds it: the creator gets Edit post
    // on their own post wherever they opened it from.
    return buildImmersiveShowcaseItems(showcaseSource, [post], user?.id ?? null)[0] ?? null;
  }, [isOwnerPost, ownerPostQuery.data, profileQuery.data, showcasePostQuery.data, showcaseSource, user]);

  const postQueryIsError = isOwnerPost ? ownerPostQuery.isError : showcasePostQuery.isError;
  const postQueryError = isOwnerPost ? ownerPostQuery.error : showcasePostQuery.error;
  // A 404 is the post being gone: deleted, made private, or behind a block.
  // Anything else (offline, a timeout, a 429, a 5xx) may answer next time.
  const postIsGone = postQueryError instanceof ApiError && postQueryError.status === 404;
  const refetchPost = isOwnerPost ? ownerPostQuery.refetch : showcasePostQuery.refetch;

  // An old link names a generation, which the by-id read does not find; the
  // web's post page has always followed one to its post, and the server's
  // resolver does the same for the app. Asked only after that 404: it names a
  // post (a post id answers with itself) and checks no block, so the by-id read
  // of the post it names still decides what is shown.
  const resolvedPostQuery = useQuery({
    queryKey: ['showcase-post-resolve', postId],
    enabled: Boolean(postId) && !isOwnerPost && postIsGone,
    queryFn: () => api.resolveShowcasePost(postId!),
    // A second 404 is the same answer; the by-id read already reached the server.
    retry: false,
  });
  const resolvedPostId = postIsGone && !isOwnerPost ? resolvedPostQuery.data?.postId ?? null : null;
  const followsResolvedPost = Boolean(resolvedPostId && resolvedPostId !== postId);
  // Waiting on the resolver, or on the page it names: no verdict to show yet.
  const resolvingPost = postIsGone && !isOwnerPost && (
    followsResolvedPost || (!resolvedPostQuery.data && !resolvedPostQuery.isError)
  );

  useEffect(() => {
    if (!followsResolvedPost || !resolvedPostId || followedPostIdRef.current === resolvedPostId) return;
    followedPostIdRef.current = resolvedPostId;
    // In place of this page, with the link's own params (its `s` included).
    router.replace({ pathname: '/post/[id]', params: { ...params, id: resolvedPostId } } as never);
  }, [followsResolvedPost, params, resolvedPostId]);

  // One visit per open of a shared link, for a public post (the server counts
  // nothing else); a media post's open counts too, before the reel takes it.
  const sharedPost = isOwnerPost ? null : showcasePostQuery.data?.item ?? null;
  const sharedPostId = sharedPost?.id ?? null;
  const sharedPostIsPublic = Boolean(sharedPost) && sharedPost?.visibility !== 'unlisted';
  useEffect(() => {
    if (!shareVisitSurface || !sharedPostId || !sharedPostIsPublic) return;
    const visit = `${sharedPostId}:${shareVisitSurface}`;
    if (recordedShareVisitRef.current === visit) return;
    recordedShareVisitRef.current = visit;
    // Fire and forget: nothing on the page waits for a count.
    void api.recordShareVisit(sharedPostId, shareVisitSurface).catch(() => undefined);
  }, [api, shareVisitSurface, sharedPostId, sharedPostIsPublic]);

  useEffect(() => {
    setCommentCountOverride(null);
    setRestoredReplyToId(null);
    setNsfwRevealed(false);
    restoredCommentContextRef.current = null;
  }, [item?.id]);

  const displayItem = useMemo(() => {
    if (!item || commentCountOverride == null) return item;
    return {
      ...item,
      commentCount: commentCountOverride,
      commentLabel: getCommentCountLabel(commentCountOverride),
    };
  }, [commentCountOverride, item]);

  // Where sign-in comes back to from every action on this screen (save,
  // comment, report, block, unlock): this post, opened the way it was.
  const authReturnTo = postId
    ? textPostViewerHref({
        postId,
        source: isOwnerPost
          ? 'profile-posts'
          : showcaseSource === 'profile-saved'
            ? 'profile-saved'
            : undefined,
      })
    : undefined;

  const { toggleSave, isSaving } = useShowcaseSaveMutation({ sourceSurface: 'mobile-post-page', authReturnTo });

  // A covered NSFW post has no details page: everything one would show is
  // what the cover leaves out.
  const pages = useMemo<Array<'post' | 'details'>>(
    () => (item && hasImmersiveDetailsPage(item) && !isCoveredNsfwPost(item) ? ['post', 'details'] : ['post']),
    [item]
  );

  const goToPage = useCallback((index: number) => {
    if (index >= pages.length) return;
    // A turn the finger does not drag never reaches the pager's on-drag: TalkBack's double tap on
    // Details opened the details page under the comment keyboard (Pixel_9a, 2026-10-22), and so
    // would the ••• menu's View details. The keyboard goes here instead.
    if (index > 0) Keyboard.dismiss();
    setPageIndex(index);
    pagerRef.current?.scrollToOffset({ offset: index * width, animated: true });
  }, [pages.length, width]);
  const showPost = useCallback(() => goToPage(0), [goToPage]);
  const onDetailsPage = pageIndex === 1;
  // Back from the details page returns to the post; only from the post does it
  // leave the screen. Focus-gated so a pushed profile keeps its own back key.
  useHardwareBack(isFocused && onDetailsPage, showPost);

  const openComments = useCallback(() => {
    if (pageIndex !== 0) {
      goToPage(0);
      requestAnimationFrame(() => commentsRef.current?.scrollToComments());
      return;
    }
    commentsRef.current?.scrollToComments();
  }, [goToPage, pageIndex]);

  useEffect(() => {
    if (!displayItem?.showcasePostId || requestedCommentsPostId !== displayItem.showcasePostId) return;
    const restoreKey = `${requestedCommentsPostId}:${requestedReplyToId ?? ''}`;
    if (restoredCommentContextRef.current === restoreKey) return;
    restoredCommentContextRef.current = restoreKey;
    setRestoredReplyToId(requestedReplyToId ?? null);
    const frame = requestAnimationFrame(() => {
      openComments();
      router.setParams({ comments: undefined, replyTo: undefined } as never);
    });
    return () => cancelAnimationFrame(frame);
  }, [displayItem?.showcasePostId, openComments, requestedCommentsPostId, requestedReplyToId]);

  const shareItem = useCallback(async () => {
    if (!item) return;
    // The link names this page, as the click recorded below does.
    const intent = getViewerShareIntent(item, env.siteUrl, 'detail-page');
    if (intent.kind === 'unavailable') return;

    if (intent.kind === 'publish') {
      router.push({ pathname: '/post/new', params: { generationId: intent.generationId, shareAfterPublish: '1' } } as never);
      return;
    }
    if (intent.kind === 'make-public') {
      router.push({ pathname: '/post/new', params: { postId: intent.postId, shareAfterPublish: '1' } } as never);
      return;
    }

    const result = await Share.share({ ...intent.content });
    if (result.action === Share.sharedAction && item.showcasePostId) {
      await api.shareShowcasePost(item.showcasePostId, { sourceSurface: 'detail-page' }).catch(() => null);
    }
  }, [api, item]);

  if (!item) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.app }}>
        <BackControl topInset={topInset} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: appTheme.spacing.panel, gap: appTheme.spacing.gap }}>
          {postQueryIsError && postIsGone && !resolvingPost ? (
            <>
              <Text style={{ color: theme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800', textAlign: 'center' }}>
                This post isn&apos;t available
              </Text>
              <Text style={{ color: theme.colors.muted, ...appTheme.type.bodySm, textAlign: 'center' }}>
                It may have been deleted or made private.
              </Text>
            </>
          ) : postQueryIsError && !postIsGone ? (
            <>
              <Text style={{ color: theme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800', textAlign: 'center' }}>
                Couldn&apos;t load this post
              </Text>
              <Text style={{ color: theme.colors.muted, ...appTheme.type.bodySm, textAlign: 'center' }}>
                Check your connection and try again.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Try again"
                onPress={() => void refetchPost()}
                style={({ pressed }) => ({
                  minHeight: appTheme.touch.compact,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 22,
                  backgroundColor: theme.colors.surfaceStrong,
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                  paddingHorizontal: 22,
                })}
              >
                <Text style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>Try again</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator color={theme.colors.primary} />
          )}
        </View>
      </View>
    );
  }

  // This route is the canonical post resolver — shared links land here without
  // knowing the post's kind. Prose stays; media belongs to the reel.
  if (item.previewKind !== 'text') {
    return (
      <Redirect
        href={immersiveViewerHref({
          source: isOwnerPost ? 'profile-posts' : showcaseSource,
          initialId: item.id,
        }) as never}
      />
    );
  }

  const resolvedItem = displayItem ?? item;
  // Gate the content, not the page: a covered NSFW post keeps its byline, the
  // ⋮ (Report, Block, owner tools), save and share, with the notice where its
  // text would be. Its thread stays hidden until the notice reveals it.
  const nsfwCovered = isCoveredNsfwPost(resolvedItem);
  const commentsHidden = nsfwCovered && !nsfwRevealed;
  const commentsHiddenMessage = canRevealNsfwInApp(Platform.OS)
    ? 'Comments appear once you reveal this post.'
    : 'Comments stay hidden on mature posts in this app.';

  // The screen's side of the post's actions, for the native menu on its ⋮
  // (`components/viewer-actions-menu.tsx`) and for the sheet below, which
  // stands in for it where native menus are missing.
  const actionCallbacks = {
    authReturnTo,
    onComments: openComments,
    onDetails: () => goToPage(1),
    onRecreate: () => undefined,
    onShare: () => void shareItem(),
    onSourceRefresh: () => void refetchPost(),
    onDeleted: leavePost,
  };

  return (
    <ViewerActionsMenuProvider callbacksFor={() => actionCallbacks}>
    <View style={{ flex: 1, backgroundColor: theme.colors.app }}>
      {/* First in the tree, on top by z-order. VoiceOver reads a screen in
          hierarchy order, and behind the pager this arrow — the only visible
          way off the screen — came after the post and every one of its
          comments. The details page carries its own header and its own way
          back to the post, so the arrow steps aside there. */}
      <Stack.Screen options={{ gestureEnabled: !onDetailsPage, fullScreenGestureEnabled: false }} />
      {onDetailsPage ? null : <BackControl topInset={topInset} />}

      <FlatList
        ref={pagerRef}
        data={pages}
        keyExtractor={(page) => page}
        horizontal
        // The pager holds the comment field, and at the default its first tap with that keyboard up
        // only put the keyboard away, wherever it landed: Cancel reply, in the composer row with Post
        // comment, did on the Pixel_9a (2026-10-22). What a tap in the post or its thread does is
        // the comments list's to say (`PostComments`). A swipe puts the keyboard away as it begins,
        // and `goToPage` a turn it was not dragged to, so neither opens the details page under it.
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) => {
          setPageIndex(Math.round(event.nativeEvent.contentOffset.x / width));
        }}
        renderItem={({ item: page }) => (
          page === 'post' ? (
            <View style={{ width, height }}>
              <PostComments
                ref={commentsRef}
                authReturnTo={authReturnTo}
                commentCount={resolvedItem.commentCount}
                deliveryId={deliveryId}
                contentHeader={(
                  <TextPostContent
                    item={resolvedItem}
                    commentsHidden={commentsHidden}
                    nsfwNotice={nsfwCovered ? (
                      <NsfwPostNotice
                        key={resolvedItem.id}
                        postId={resolvedItem.id}
                        width={width - appTheme.spacing.panel * 2}
                        onRevealedChange={setNsfwRevealed}
                      />
                    ) : null}
                    topInset={topInset}
                    saving={isSaving}
                    onActionsOpen={() => setActionsVisible(true)}
                    onComments={openComments}
                    onCreatorOpen={() => {
                      if (resolvedItem.creatorUsername) {
                        router.push(`/creators/${encodeURIComponent(resolvedItem.creatorUsername)}` as never);
                      }
                    }}
                    onDetails={() => goToPage(1)}
                    onSave={() => {
                      if (!resolvedItem.showcasePostId) return;
                      toggleSave({
                        postId: resolvedItem.showcasePostId,
                        isSaved: resolvedItem.isSaved,
                        saveCount: resolvedItem.details?.saveCount ?? 0,
                      });
                    }}
                    onShare={() => void shareItem()}
                  />
                )}
                enabled={resolvedItem.canComment && Boolean(resolvedItem.showcasePostId) && !commentsHidden}
                initialReplyToId={restoredReplyToId}
                onCommentCountChange={setCommentCountOverride}
                postCreatorId={resolvedItem.creatorId ?? null}
                postId={resolvedItem.showcasePostId ?? resolvedItem.id}
                postTitle={resolvedItem.title}
                presentation="inline"
                unavailableMessage={resolvedItem.canComment
                  ? commentsHidden ? commentsHiddenMessage : null
                  : resolvedItem.archivedAt
                    ? 'Comments are unavailable while this post is archived.'
                    : 'Comments become available when this post is public.'}
              />
            </View>
          ) : (
            <PostDetailsPage
              active={pageIndex === 1}
              authReturnTo={authReturnTo}
              bottomInset={bottomInset}
              height={height}
              hostRendersPostText
              item={resolvedItem}
              onActionsOpen={() => setActionsVisible(true)}
              onBack={showPost}
              onComments={openComments}
              onCreatorOpen={() => {
                if (resolvedItem.creatorUsername) {
                  router.push(`/creators/${encodeURIComponent(resolvedItem.creatorUsername)}` as never);
                }
              }}
              onRecreate={() => undefined}
              onSave={() => {
                if (!resolvedItem.showcasePostId) return;
                toggleSave({
                  postId: resolvedItem.showcasePostId,
                  isSaved: resolvedItem.isSaved,
                  saveCount: resolvedItem.details?.saveCount ?? 0,
                });
              }}
              onShare={() => void shareItem()}
              saveLoading={isSaving}
              topInset={topInset}
              width={width}
            />
          )
        )}
      />

      <ViewerActionSheet
        item={resolvedItem}
        visible={actionsVisible}
        onClose={() => setActionsVisible(false)}
        {...actionCallbacks}
      />
    </View>
    </ViewerActionsMenuProvider>
  );
}

/**
 * The way off this screen, wherever the screen happens to be — loaded, loading
 * or unable to load. A shared link lands here without knowing whether the post
 * still exists, so the states that show no post still show the way back.
 *
 * A cold launch from that link may leave nothing behind this screen, and
 * `router.back()` on an empty stack does nothing at all — which would make the
 * one visible exit a control that answers a press by not moving. The viewer's
 * `leaveViewer` settled the fallback: go where the post came from.
 */
function leavePost() {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/(tabs)/showcase' as never);
}

function BackControl({ topInset }: { topInset: number }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Go back"
      onPress={leavePost}
      hitSlop={8}
      style={({ pressed }) => ({
        position: 'absolute',
        zIndex: 2,
        left: appTheme.spacing.gap,
        top: topInset + 10,
        height: 44,
        width: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceStrong,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <BackGlyph size={appTheme.icon.feature} color={theme.colors.text} />
    </Pressable>
  );
}

/**
 * A post its creator marked NSFW, as the server sends it before a reveal: the
 * creator, the counts and the post's own actions, none of its content.
 */
function isCoveredNsfwPost(item: { isNsfw?: boolean; nsfwRevealed?: boolean }) {
  return Boolean(item.isNsfw && !item.nsfwRevealed);
}

function TextPostContent({
  item,
  commentsHidden = false,
  nsfwNotice,
  topInset,
  saving,
  onActionsOpen,
  onComments,
  onCreatorOpen,
  onDetails,
  onSave,
  onShare,
}: {
  item: Parameters<typeof buildTextPostPage>[0];
  /** The thread is held back, so nothing here offers to open it. */
  commentsHidden?: boolean;
  /**
   * Drawn in place of the title and body while the post is an NSFW cover. The
   * cover has no details page, so Details goes with them.
   */
  nsfwNotice?: React.ReactNode;
  topInset: number;
  saving: boolean;
  onActionsOpen: () => void;
  onComments: () => void;
  onCreatorOpen: () => void;
  onDetails: () => void;
  onSave: () => void;
  onShare: () => void;
}) {
  const theme = useAppTheme();
  const content = buildTextPostPage(item);
  const stateChip = getViewerStateChip(item);
  const slots = getViewerActionSlots(item);
  const hasDetails = !nsfwNotice && hasImmersiveDetailsPage(item);
  // Menu rows for what the page is not showing: a details page it does not
  // have, a thread it is holding back.
  const excludeActions = [
    ...(hasDetails ? [] : ['view-details']),
    ...(commentsHidden ? ['comment'] : []),
  ];

  return (
    <View
      style={{
        paddingTop: topInset + 66,
        paddingBottom: appTheme.spacing.panel,
        paddingHorizontal: appTheme.spacing.panel,
        gap: appTheme.spacing.gap,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
        {/* Labelled in both states: Android never clears a label that goes
            back to undefined, so "Open …" would outlive the link. */}
        <Pressable
          accessibilityRole={item.creatorUsername ? 'button' : undefined}
          accessibilityLabel={item.creatorUsername
            ? `Open ${content.handle}`
            : [content.handle, content.timeLabel].filter(Boolean).join(' · ')}
          disabled={!item.creatorUsername}
          onPress={onCreatorOpen}
          hitSlop={verticalHitSlop(CREATOR_ROW_HEIGHT)}
          style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: CREATOR_ROW_HEIGHT, opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <CreatorAvatar name={content.handle} uri={item.creatorAvatar} size={26} />
          <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800' }}>
            {content.handle}
          </Text>
          {content.timeLabel ? (
            <Text style={{ color: theme.colors.faint, ...appTheme.type.caption }}>
              {`· ${content.timeLabel}`}
            </Text>
          ) : null}
        </Pressable>
        <ViewerActionsMenu
          item={item}
          excludeActions={excludeActions}
          accessibilityLabel={`More options for ${content.title}`}
          trigger={{
            width: 28,
            height: 32,
            iconSize: appTheme.icon.compact,
            iconColor: theme.colors.faint,
            vertical: true,
            alignment: 'trailing',
            hitSlop: 10,
          }}
          onFallbackPress={onActionsOpen}
          renderButton={(onPress) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`More options for ${content.title}`}
              hitSlop={10}
              onPress={onPress}
              style={({ pressed }) => ({
                height: 32,
                width: 28,
                alignItems: 'flex-end',
                justifyContent: 'center',
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <MoreVertical size={appTheme.icon.compact} color={theme.colors.faint} />
            </Pressable>
          )}
        />
      </View>

      {nsfwNotice ?? (
        <>
          {/* The same size the details page gives the same post's title: 25/31 was
              a step the ramp does not have, and the two pages of one screen were
              setting one title two ways. */}
          <Text selectable style={{ color: theme.colors.text, ...appTheme.type.pageTitle, fontWeight: '800' }}>
            {content.title}
          </Text>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <View
              style={{
                alignSelf: 'flex-start',
                borderRadius: appTheme.radii.pill,
                backgroundColor: theme.colors.surfaceStrong,
                paddingHorizontal: 10,
                paddingVertical: 5,
              }}
            >
              <Text style={{ color: theme.colors.textSecondary, fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
                {content.flairLabel}
              </Text>
            </View>
            {stateChip ? (
              <View
                style={{
                  alignSelf: 'flex-start',
                  borderRadius: appTheme.radii.pill,
                  borderWidth: 1,
                  borderColor: theme.semantic[stateChip.tone].border,
                  backgroundColor: theme.semantic[stateChip.tone].background,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                }}
              >
                <Text style={{ color: theme.semantic[stateChip.tone].foreground, fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
                  {stateChip.label}
                </Text>
              </View>
            ) : null}
          </View>

          {content.body ? (
            <Text selectable style={{ color: theme.colors.text, ...appTheme.type.body, lineHeight: 26 }}>
              {content.body}
            </Text>
          ) : null}
        </>
      )}

      <View style={{ height: 1, backgroundColor: theme.colors.borderSubtle, marginTop: 4 }} />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
        {slots.map((slot) => {
          if (slot.id === 'save') {
            const heart = getThemedSaveHeartIconProps({ isSaved: item.isSaved, enabled: item.canSave, colors: theme.colors });
            return (
              <FeedCardAction
                key={slot.id}
                accessibilityLabel={slot.a11yLabel ?? slot.label}
                disabled={saving}
                icon={<Heart size={appTheme.icon.compact} color={heart.color} fill={heart.fill} />}
                label={slot.label}
                onPress={onSave}
              />
            );
          }
          if (slot.id === 'comment') {
            if (commentsHidden) return null;
            return (
              <FeedCardAction
                key={slot.id}
                accessibilityLabel={slot.a11yLabel ?? slot.label}
                icon={<MessageCircle size={appTheme.icon.compact} color={theme.colors.faint} />}
                label={slot.label}
                onPress={onComments}
              />
            );
          }
          if (slot.id === 'share') {
            return (
              <FeedCardAction
                key={slot.id}
                accessibilityLabel={slot.a11yLabel ?? slot.label}
                icon={<ShareGlyph size={appTheme.icon.compact} color={theme.colors.faint} />}
                label={slot.label}
                onPress={onShare}
              />
            );
          }
          if (slot.id === 'details' && hasDetails) {
            return (
              <FeedCardAction
                key={slot.id}
                accessibilityLabel={slot.a11yLabel ?? slot.label}
                icon={<FileText size={appTheme.icon.compact} color={theme.colors.faint} />}
                label={slot.label}
                onPress={onDetails}
              />
            );
          }
          if (slot.id === 'create') {
            return (
              <FeedCardAction
                key={slot.id}
                accessibilityLabel={slot.a11yLabel ?? slot.label}
                icon={<Repeat2 size={appTheme.icon.compact} color={theme.colors.primary} />}
                label={slot.label}
                onPress={onActionsOpen}
                tone="primary"
              />
            );
          }
          return null;
        })}
      </View>

    </View>
  );
}
