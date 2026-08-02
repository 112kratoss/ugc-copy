import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Heart,
  MessageCircle,
  MoreVertical,
  Repeat2,
  Share2,
} from 'lucide-react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  Share,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CommentsSheet } from '@/components/comments-sheet';
import { CreatorAvatar } from '@/components/ui';
import { FeedCardAction } from '@/components/feed-card-shell';
import { PostDetailsPage } from '@/components/post-details-page';
import { ViewerActionSheet } from '@/components/viewer-action-sheet';
import { env } from '@/lib/env';
import { useAuth } from '@/lib/auth';
import { buildImmersiveShowcaseItems, hasImmersiveDetailsPage } from '@/lib/immersive-preview-view-model';
import { getImmersiveSlideHint } from '@/lib/immersive-slide-pages';
import { createShowcasePostQueryKey } from '@/lib/showcase-feed-query';
import { buildTextPostPage } from '@/lib/text-post-page-view-model';
import { appTheme } from '@/lib/theme';
import type { ShowcasePostResponse } from '@/lib/types';
import { useShowcaseSaveMutation } from '@/lib/use-showcase-save-mutation';
import { getSaveHeartIconProps, getViewerActionSlots, getViewerStateChip } from '@/lib/viewer-actions';

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
  const params = useLocalSearchParams<{ id: string }>();
  const postId = Array.isArray(params.id) ? params.id[0] : params.id;
  const { api, user } = useAuth();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const pagerRef = useRef<FlatList<'post' | 'details'>>(null);

  const [commentsVisible, setCommentsVisible] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);

  const postQuery = useQuery({
    queryKey: createShowcasePostQueryKey(postId, user?.id),
    enabled: Boolean(postId),
    queryFn: () => api.getShowcasePost(postId!) as Promise<ShowcasePostResponse>,
    staleTime: 1000 * 45,
  });

  // The feed seeds this query before navigating, so a tap paints from cache;
  // a deep link falls through to the fetch above.
  const item = useMemo(() => {
    const post = postQuery.data?.item;
    if (!post) return null;
    return buildImmersiveShowcaseItems('showcase-feed', [post])[0] ?? null;
  }, [postQuery.data]);

  const { toggleSave, isSaving } = useShowcaseSaveMutation({ sourceSurface: 'mobile-post-page' });

  const pages = useMemo<Array<'post' | 'details'>>(
    () => (item && hasImmersiveDetailsPage(item) ? ['post', 'details'] : ['post']),
    [item]
  );

  const goToPage = useCallback((index: number) => {
    pagerRef.current?.scrollToOffset({ offset: index * width, animated: true });
  }, [width]);

  const shareItem = useCallback(async () => {
    if (!item?.canShare) return;
    const url = item.sharePath ? `${env.siteUrl}${item.sharePath}` : null;
    const result = await Share.share({
      title: item.title,
      message: url ? `${item.title}\n${url}` : `${item.title}\n${item.displayText}`,
      url: url ?? undefined,
    });
    if (result.action === Share.sharedAction && item.showcasePostId) {
      await api.shareShowcasePost(item.showcasePostId, 'native-share').catch(() => null);
    }
  }, [api, item]);

  if (!item) {
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.app, alignItems: 'center', justifyContent: 'center' }}>
        {postQuery.isError ? (
          <Text style={{ color: appTheme.colors.muted, ...appTheme.type.body }}>
            This post could not be loaded.
          </Text>
        ) : (
          <ActivityIndicator color={appTheme.colors.primary} />
        )}
      </View>
    );
  }

  const hint = getImmersiveSlideHint({
    item,
    pages: pages.map((page) => (page === 'post' ? { type: 'text' } : { type: 'details' })),
    currentHorizontalIndex: pageIndex,
  });

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.app }}>
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
            <TextPostPage
              item={item}
              width={width}
              topInset={insets.top}
              bottomInset={insets.bottom}
              saving={isSaving}
              onActionsOpen={() => setActionsVisible(true)}
              onComments={() => setCommentsVisible(true)}
              onCreatorOpen={() => {
                if (item.creatorUsername) {
                  router.push(`/creators/${encodeURIComponent(item.creatorUsername)}` as never);
                }
              }}
              onDetails={() => goToPage(1)}
              onSave={() => {
                if (!item.showcasePostId) return;
                toggleSave({
                  postId: item.showcasePostId,
                  isSaved: item.isSaved,
                  saveCount: item.details?.saveCount ?? 0,
                });
              }}
              onShare={() => void shareItem()}
            />
          ) : (
            <PostDetailsPage
              active={pageIndex === 1}
              bottomInset={insets.bottom}
              height={height}
              item={item}
              onRecreate={() => undefined}
              onSave={() => {
                if (!item.showcasePostId) return;
                toggleSave({
                  postId: item.showcasePostId,
                  isSaved: item.isSaved,
                  saveCount: item.details?.saveCount ?? 0,
                });
              }}
              onShare={() => void shareItem()}
              onUnlockRemix={() => undefined}
              saveLoading={isSaving}
              topInset={insets.top}
              width={width}
            />
          )
        )}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={() => router.back()}
        hitSlop={8}
        style={({ pressed }) => ({
          position: 'absolute',
          left: appTheme.spacing.gap,
          top: insets.top + 10,
          height: 44,
          width: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: appTheme.colors.surfaceStrong,
          opacity: pressed ? appTheme.opacity.pressed : 1,
        })}
      >
        <ArrowLeft size={20} color={appTheme.colors.text} />
      </Pressable>

      {hint ? (
        <Text
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: insets.bottom + 14,
            textAlign: 'center',
            color: appTheme.colors.faint,
            ...appTheme.type.caption,
          }}
        >
          {hint}
        </Text>
      ) : null}

      {item.canComment && item.showcasePostId ? (
        <CommentsSheet
          postId={item.showcasePostId}
          postCreatorId={item.creatorId ?? null}
          postTitle={item.title}
          commentCount={item.commentCount}
          authReturnTo={`/post/${item.id}`}
          visible={commentsVisible}
          onClose={() => setCommentsVisible(false)}
        />
      ) : null}

      <ViewerActionSheet
        item={item}
        visible={actionsVisible}
        onClose={() => setActionsVisible(false)}
        onComments={() => setCommentsVisible(true)}
        onDetails={() => goToPage(1)}
        onRecreate={() => undefined}
        onShare={() => void shareItem()}
        onSourceRefresh={() => void postQuery.refetch()}
        onDeleted={() => router.back()}
      />
    </View>
  );
}

function TextPostPage({
  item,
  width,
  topInset,
  bottomInset,
  saving,
  onActionsOpen,
  onComments,
  onCreatorOpen,
  onDetails,
  onSave,
  onShare,
}: {
  item: Parameters<typeof buildTextPostPage>[0];
  width: number;
  topInset: number;
  bottomInset: number;
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
    <ScrollView
      style={{ width }}
      contentContainerStyle={{
        paddingTop: topInset + 66,
        paddingBottom: bottomInset + 56,
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
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }}
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
          <MoreVertical size={17} color={appTheme.colors.faint} />
        </Pressable>
      </View>

      <Text selectable style={{ color: appTheme.colors.text, fontSize: 25, lineHeight: 31, fontWeight: '800' }}>
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
                icon={<Heart size={19} color={heart.color} fill={heart.fill} strokeWidth={2.2} />}
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
                icon={<MessageCircle size={19} color={appTheme.colors.faint} strokeWidth={2.2} />}
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
                icon={<Share2 size={18} color={appTheme.colors.faint} strokeWidth={2.2} />}
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
                icon={<FileText size={18} color={appTheme.colors.faint} strokeWidth={2.2} />}
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
                icon={<Repeat2 size={19} color={appTheme.colors.primary} strokeWidth={2.2} />}
                label={slot.label}
                onPress={onActionsOpen}
                tone="primary"
              />
            );
          }
          return null;
        })}
      </View>

      {item.canComment ? (
        <>
          <View style={{ height: 1, backgroundColor: appTheme.colors.borderSubtle }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open comments on ${content.title}`}
            onPress={onComments}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: appTheme.spacing.compact,
              minHeight: 48,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <MessageCircle size={18} color={appTheme.colors.faint} strokeWidth={2.2} />
            <Text style={{ flex: 1, color: appTheme.colors.textSecondary, ...appTheme.type.body }}>
              {content.commentLabel}
            </Text>
            <ChevronRight size={18} color={appTheme.colors.faint} />
          </Pressable>
        </>
      ) : null}
    </ScrollView>
  );
}
