import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { FileText, Heart, MessageCircle, MoreVertical, Repeat2 } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
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
import { BackGlyph, ShareGlyph } from '@/lib/platform-glyphs';
import { getProfileHandle } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { createShowcasePostQueryKey } from '@/lib/showcase-feed-query';
import { buildTextPostPage } from '@/lib/text-post-page-view-model';
import { appTheme } from '@/lib/theme';
import type { ShowcasePostResponse } from '@/lib/types';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { useShowcaseSaveMutation } from '@/lib/use-showcase-save-mutation';
import { getSaveHeartIconProps, getViewerActionSlots, getViewerShareIntent, getViewerStateChip } from '@/lib/viewer-actions';
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
  const params = useLocalSearchParams<{ id: string; source?: string; comments?: string; replyTo?: string }>();
  const postId = Array.isArray(params.id) ? params.id[0] : params.id;
  const source = Array.isArray(params.source) ? params.source[0] : params.source;
  const requestedCommentsPostId = Array.isArray(params.comments) ? params.comments[0] : params.comments;
  const requestedReplyToId = Array.isArray(params.replyTo) ? params.replyTo[0] : params.replyTo;
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

  const [actionsVisible, setActionsVisible] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [commentCountOverride, setCommentCountOverride] = useState<number | null>(null);
  const [restoredReplyToId, setRestoredReplyToId] = useState<string | null>(null);

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
    return buildImmersiveShowcaseItems(showcaseSource, [post])[0] ?? null;
  }, [isOwnerPost, ownerPostQuery.data, profileQuery.data, showcasePostQuery.data, showcaseSource, user]);

  const postQueryIsError = isOwnerPost ? ownerPostQuery.isError : showcasePostQuery.isError;
  const refetchPost = isOwnerPost ? ownerPostQuery.refetch : showcasePostQuery.refetch;

  useEffect(() => {
    setCommentCountOverride(null);
    setRestoredReplyToId(null);
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

  const { toggleSave, isSaving } = useShowcaseSaveMutation({ sourceSurface: 'mobile-post-page' });

  const pages = useMemo<Array<'post' | 'details'>>(
    () => (item && hasImmersiveDetailsPage(item) ? ['post', 'details'] : ['post']),
    [item]
  );

  const goToPage = useCallback((index: number) => {
    setPageIndex(index);
    pagerRef.current?.scrollToOffset({ offset: index * width, animated: true });
  }, [width]);
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

    const result = await Share.share({ ...intent.content });
    if (result.action === Share.sharedAction && item.showcasePostId) {
      await api.shareShowcasePost(item.showcasePostId, { sourceSurface: 'detail-page' }).catch(() => null);
    }
  }, [api, item]);

  if (!item) {
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.app }}>
        <BackControl topInset={topInset} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: appTheme.spacing.panel, gap: appTheme.spacing.gap }}>
          {postQueryIsError ? (
            <>
              <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800', textAlign: 'center' }}>
                This post isn&apos;t available
              </Text>
              <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm, textAlign: 'center' }}>
                It may have been deleted or made private. Check your connection and try again.
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
                  backgroundColor: appTheme.colors.surfaceStrong,
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                  paddingHorizontal: 22,
                })}
              >
                <Text style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>Try again</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator color={appTheme.colors.primary} />
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
  const authReturnTo = textPostViewerHref({
    postId: resolvedItem.id,
    source: isOwnerPost
      ? 'profile-posts'
      : showcaseSource === 'profile-saved'
        ? 'profile-saved'
        : undefined,
  });

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.app }}>
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
                contentHeader={(
                  <TextPostContent
                    item={resolvedItem}
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
                enabled={resolvedItem.canComment && Boolean(resolvedItem.showcasePostId)}
                initialReplyToId={restoredReplyToId}
                onCommentCountChange={setCommentCountOverride}
                postCreatorId={resolvedItem.creatorId ?? null}
                postId={resolvedItem.showcasePostId ?? resolvedItem.id}
                postTitle={resolvedItem.title}
                presentation="inline"
                unavailableMessage={resolvedItem.canComment
                  ? null
                  : resolvedItem.archivedAt
                    ? 'Comments are unavailable while this post is archived.'
                    : 'Comments become available when this post is public.'}
              />
            </View>
          ) : (
            <PostDetailsPage
              active={pageIndex === 1}
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
        onComments={openComments}
        onDetails={() => goToPage(1)}
        onRecreate={() => undefined}
        onShare={() => void shareItem()}
        onSourceRefresh={() => void refetchPost()}
        onDeleted={leavePost}
      />
    </View>
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
        backgroundColor: appTheme.colors.surfaceStrong,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <BackGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
    </Pressable>
  );
}

function TextPostContent({
  item,
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
  topInset: number;
  saving: boolean;
  onActionsOpen: () => void;
  onComments: () => void;
  onCreatorOpen: () => void;
  onDetails: () => void;
  onSave: () => void;
  onShare: () => void;
}) {
  const content = buildTextPostPage(item);
  const stateChip = getViewerStateChip(item);
  const slots = getViewerActionSlots(item);
  const hasDetails = hasImmersiveDetailsPage(item);

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
        <Pressable
          accessibilityRole={item.creatorUsername ? 'button' : undefined}
          accessibilityLabel={item.creatorUsername ? `Open ${content.handle}` : undefined}
          disabled={!item.creatorUsername}
          onPress={onCreatorOpen}
          hitSlop={verticalHitSlop(CREATOR_ROW_HEIGHT)}
          style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: CREATOR_ROW_HEIGHT, opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <CreatorAvatar name={content.handle} uri={item.creatorAvatar} size={26} />
          <Text numberOfLines={1} style={{ color: appTheme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800' }}>
            {content.handle}
          </Text>
          {content.timeLabel ? (
            <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>
              {`· ${content.timeLabel}`}
            </Text>
          ) : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More options for ${content.title}`}
          hitSlop={10}
          onPress={onActionsOpen}
          style={({ pressed }) => ({
            height: 32,
            width: 28,
            alignItems: 'flex-end',
            justifyContent: 'center',
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <MoreVertical size={appTheme.icon.compact} color={appTheme.colors.faint} />
        </Pressable>
      </View>

      {/* The same size the details page gives the same post's title: 25/31 was
          a step the ramp does not have, and the two pages of one screen were
          setting one title two ways. */}
      <Text selectable style={{ color: appTheme.colors.text, ...appTheme.type.pageTitle, fontWeight: '800' }}>
        {content.title}
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <View
          style={{
            alignSelf: 'flex-start',
            borderRadius: appTheme.radii.pill,
            backgroundColor: appTheme.colors.surfaceStrong,
            paddingHorizontal: 10,
            paddingVertical: 5,
          }}
        >
          <Text style={{ color: appTheme.colors.textSecondary, fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
            {content.flairLabel}
          </Text>
        </View>
        {stateChip ? (
          <View
            style={{
              alignSelf: 'flex-start',
              borderRadius: appTheme.radii.pill,
              borderWidth: 1,
              borderColor: appTheme.semantic[stateChip.tone].border,
              backgroundColor: appTheme.semantic[stateChip.tone].background,
              paddingHorizontal: 10,
              paddingVertical: 5,
            }}
          >
            <Text style={{ color: appTheme.semantic[stateChip.tone].foreground, fontSize: 11, lineHeight: 13, fontWeight: '800' }}>
              {stateChip.label}
            </Text>
          </View>
        ) : null}
      </View>

      {content.body ? (
        <Text selectable style={{ color: appTheme.colors.text, ...appTheme.type.body, lineHeight: 26 }}>
          {content.body}
        </Text>
      ) : null}

      <View style={{ height: 1, backgroundColor: appTheme.colors.borderSubtle, marginTop: 4 }} />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
        {slots.map((slot) => {
          if (slot.id === 'save') {
            const heart = getSaveHeartIconProps({ isSaved: item.isSaved, enabled: item.canSave });
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
            return (
              <FeedCardAction
                key={slot.id}
                accessibilityLabel={slot.a11yLabel ?? slot.label}
                icon={<MessageCircle size={appTheme.icon.compact} color={appTheme.colors.faint} />}
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
                icon={<ShareGlyph size={appTheme.icon.compact} color={appTheme.colors.faint} />}
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
                icon={<FileText size={appTheme.icon.compact} color={appTheme.colors.faint} />}
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
                icon={<Repeat2 size={appTheme.icon.compact} color={appTheme.colors.primary} />}
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
