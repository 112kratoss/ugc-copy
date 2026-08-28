import { FlashList, type ViewToken } from '@shopify/flash-list';
import { useIsFocused } from '@react-navigation/native';
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, router } from 'expo-router';
import { ChevronRight, ExternalLink, FileText, Globe, Heart, ImageIcon, Layers3, Lock, MapPin, MoreVertical, Pencil, Play, Repeat2, UserCheck, UserPlus } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, Share, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { FeedLoadMoreErrorFooter } from '@/components/feed-pagination-footer';
import { AppText, SecondaryButton, StatusBlock } from '@/components/ui';
import { showActionSheet } from '@/lib/action-sheet';
import { canRequestNextFeedPage } from '@/lib/feed-pagination';
import { showConfirmDialog, showErrorDialog, showMessageDialog } from '@/lib/dialog';
import { haptic } from '@/lib/haptics';
import { useAuth } from '@/lib/auth';
import {
  CREATOR_PROFILE_TABS,
  creatorInitial,
  creatorProfileSocialLinks,
  creatorProfileTabItems,
  flattenCreatorProfilePages,
  getNextCreatorProfileOffset,
  type CreatorProfileTab,
} from '@/lib/creator-profile-view-model';
import { env } from '@/lib/env';
import { formatCompactCount } from '@/lib/home-view-model';
import { showcaseFeedItemOpenHref } from '@/lib/immersive-preview-view-model';
import { ShareGlyph } from '@/lib/platform-glyphs';
import { resolvedBottomInset } from '@/lib/safe-area';
import { getShowcasePreviewMediaItems, hasShowcasePreviewMedia, hasShowcaseVideoWithoutPreview } from '@/lib/showcase-media';
import { getShowcasePostDisplayText, isTextOnlyShowcasePost } from '@/lib/showcase-display';
import { createShowcasePostQueryKey } from '@/lib/showcase-feed-query';
import { CreatorProfileSkeleton } from '@/components/skeleton';
import { accentColor, appTheme } from '@/lib/theme';
import type { CreatorProfileResponse, ShowcaseFeedItem } from '@/lib/types';
import { buildShareUrl } from '@/lib/viewer-actions';

const PROFILE_PAGE_SIZE = 24;
const GRID_GAP = 10;
const LOAD_MORE_COOLDOWN_MS = 800;

type CreatorTool = CreatorProfileResponse['stats']['toolsUsed'][number];
type CreatorListItem =
  | { kind: 'header'; key: 'header' }
  | { kind: 'tabs'; key: 'tabs' }
  | { kind: 'post'; key: string; item: ShowcaseFeedItem }
  | { kind: 'tool'; key: string; tool: CreatorTool }
  | { kind: 'empty'; key: 'empty'; tab: CreatorProfileTab };

export function CreatorProfileScreen({
  initialTab = 'creations',
  username,
}: {
  initialTab?: CreatorProfileTab;
  username: string;
}) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const previousFocusRef = useRef(isFocused);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<CreatorProfileTab>(initialTab);
  const [activeVideoItemId, setActiveVideoItemId] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  const lastLoadMoreAtRef = useRef(0);
  const lastLoadMorePageCountRef = useRef<number | null>(null);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const contentWidth = Math.min(width, 430);
  const horizontalPadding = contentWidth < 390 ? 14 : 16;
  const tileWidth = Math.floor((contentWidth - horizontalPadding * 2 - GRID_GAP) / 2);
  const queryKey = useMemo(() => ['creator-profile', 'infinite', username] as const, [username]);
  const profileQuery = useInfiniteQuery({
    queryKey,
    enabled: Boolean(username),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.getCreatorProfile(username, {
      limit: PROFILE_PAGE_SIZE,
      offset: pageParam,
    }),
    getNextPageParam: getNextCreatorProfileOffset,
    staleTime: 1000 * 60,
  });
  const data = profileQuery.data?.pages[0];
  const items = useMemo(() => flattenCreatorProfilePages(profileQuery.data?.pages), [profileQuery.data?.pages]);
  const profilePageCount = profileQuery.data?.pages.length ?? 0;
  const currentTabItems = useMemo(() => creatorProfileTabItems(items, activeTab), [activeTab, items]);
  const socialLinks = useMemo(() => data ? creatorProfileSocialLinks(data.profile) : [], [data]);
  const listItems = useMemo<CreatorListItem[]>(() => {
    const content: CreatorListItem[] = activeTab === 'tools'
      ? (data?.stats.toolsUsed ?? []).map((tool) => ({ kind: 'tool', key: `tool:${tool.slug}`, tool }))
      : currentTabItems.map((item) => ({ kind: 'post', key: `post:${item.id}`, item }));

    return [
      { kind: 'header', key: 'header' },
      { kind: 'tabs', key: 'tabs' },
      ...(content.length ? content : [{ kind: 'empty', key: 'empty', tab: activeTab } as const]),
    ];
  }, [activeTab, currentTabItems, data?.stats.toolsUsed]);

  useEffect(() => {
    if (isFocused && !previousFocusRef.current) {
      void queryClient.invalidateQueries({ queryKey });
    }
    previousFocusRef.current = isFocused;
  }, [isFocused, queryClient, queryKey]);

  useEffect(() => {
    setActiveVideoItemId(null);
    loadingMoreRef.current = false;
    lastLoadMoreAtRef.current = 0;
    lastLoadMorePageCountRef.current = null;
  }, [activeTab, username]);

  const followMutation = useMutation({
    mutationFn: (following: boolean) => api.setCreatorFollowing(data?.profile.id ?? '', following),
    onMutate: async (following) => {
      setFollowError(null);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<InfiniteData<CreatorProfileResponse>>(queryKey);
      queryClient.setQueryData<InfiniteData<CreatorProfileResponse>>(queryKey, (current) => current ? {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          viewer: { ...page.viewer, isFollowing: following },
        })),
      } : current);
      return { previous };
    },
    onError: (_error, _following, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      setFollowError('Could not update follow. Your previous state was restored.');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const handleFollowPress = () => {
    if (!data) return;
    if (!user) {
      router.push({
        pathname: '/auth',
        params: { returnTo: `/creators/${encodeURIComponent(data.profile.username)}` },
      } as never);
      return;
    }
    if (!data.viewer.isOwner) followMutation.mutate(!data.viewer.isFollowing);
  };

  const handleShareProfile = async () => {
    if (!data) return;
    const url = buildShareUrl(
      env.siteUrl,
      `/creators/${encodeURIComponent(data.profile.username)}`,
      'creator-profile'
    );
    const result = await Share.share({
      message: `${data.profile.displayName} on Magicbooklet\n${url}`,
      url,
      title: data.profile.displayName,
    });
    if (result.action !== Share.sharedAction) return;
    await api
      .shareCreatorProfile(data.profile.username, { sourceSurface: 'creator-profile' })
      .catch(() => null);
  };

  const requireSafetySignIn = () => {
    if (!data) return false;
    if (user) return true;
    router.push({
      pathname: '/auth',
      params: { returnTo: `/creators/${encodeURIComponent(data.profile.username)}` },
    } as never);
    return false;
  };

  const handleReportUser = () => {
    if (!data || data.viewer.isOwner || !requireSafetySignIn()) return;
    void showConfirmDialog({
      title: 'Report user?',
      message: `Magicbooklet will review @${data.profile.username} for unsafe or abusive behavior.`,
      confirmLabel: 'Report user',
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await api.reportUser(data.profile.id, {
          reason: 'unsafe_content',
          sourceSurface: 'creator-profile',
          details: `Reported from @${data.profile.username}'s mobile creator profile.`,
        });
        haptic.success();
        showMessageDialog({
          title: 'Report received',
          message: 'Thank you. Our moderation team will review this user.',
        });
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not report user', error);
      }
    });
  };

  const handleBlockUser = () => {
    if (!data || data.viewer.isOwner || !requireSafetySignIn()) return;
    void showConfirmDialog({
      title: `Block @${data.profile.username}?`,
      message: 'Their posts will be hidden, and neither of you will be able to follow the other.',
      confirmLabel: 'Block user',
      destructive: true,
    }).then(async (confirmed) => {
      if (!confirmed) return;
      try {
        await api.blockUser(data.profile.id);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
          queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] }),
          queryClient.invalidateQueries({ queryKey: ['profile-saved-media', user?.id] }),
        ]);
        router.replace('/(tabs)/showcase' as never);
      } catch (error) {
        haptic.error();
        showErrorDialog('Could not block user', error);
      }
    });
  };

  /**
   * Report and Block used to sit in the header as two permanently mounted,
   * danger-tinted, full-width buttons -- the loudest pair of controls on a
   * stranger's profile, louder than the work the profile exists to show, and
   * louder than Share, which is the one people actually reach for. Layout:
   * "make essential information easy to find by giving it sufficient space ...
   * don't obscure it by crowding it with nonessential details. You can make
   * secondary information available in other parts of the window."
   *
   * They keep a control of their own (they must stay reachable), one tap deeper,
   * through the sheet N2 built for exactly this: `showActionSheet` sorts
   * destructive entries to the top and puts Cancel at the bottom, so neither
   * ordering is this screen's to get wrong.
   */
  const handleSafetyOptions = () => {
    if (!data || data.viewer.isOwner) return;
    showActionSheet({
      title: `@${data.profile.username}`,
      actions: [
        { label: 'Report user', destructive: true, onPress: handleReportUser },
        { label: 'Block user', destructive: true, onPress: handleBlockUser },
      ],
    });
  };

  const openProfileItem = (item: ShowcaseFeedItem) => {
    queryClient.setQueryData(createShowcasePostQueryKey(item.id, user?.id), { success: true, item });
    router.push(showcaseFeedItemOpenHref({
      item,
      source: 'creator-profile',
      creatorUsername: data?.profile.username ?? username,
    }) as never);
  };

  const requestNextPage = useCallback(() => {
    const now = Date.now();
    if (activeTab === 'tools' || !canRequestNextFeedPage({
      cooldownMs: LOAD_MORE_COOLDOWN_MS,
      hasNextPage: profileQuery.hasNextPage,
      isBusy: profileQuery.isFetching,
      isRequestInFlight: loadingMoreRef.current,
      lastRequestedAt: lastLoadMoreAtRef.current,
      lastRequestedPageCount: lastLoadMorePageCountRef.current,
      now,
      pageCount: profilePageCount,
    })) return;

    loadingMoreRef.current = true;
    lastLoadMoreAtRef.current = now;
    lastLoadMorePageCountRef.current = profilePageCount;
    void profileQuery.fetchNextPage().finally(() => {
      loadingMoreRef.current = false;
    });
  }, [activeTab, profilePageCount, profileQuery]);

  const retryNextPage = useCallback(() => {
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    requestNextPage();
  }, [requestNextPage]);

  // Decoupled from query fetch state: on iOS a programmatic `refreshing` drags
  // the list down and can strand it there, so only a refresh the user asked
  // for may engage the control (see the note in app/(tabs)/showcase.tsx).
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const handleRefresh = () => {
    haptic.light();
    setPullRefreshing(true);
    lastLoadMorePageCountRef.current = null;
    lastLoadMoreAtRef.current = 0;
    queryClient.setQueryData<InfiniteData<CreatorProfileResponse>>(queryKey, (current) => {
      if (!current?.pages.length) return current;
      return { pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1) };
    });
    void profileQuery.refetch().finally(() => setPullRefreshing(false));
  };

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<ViewToken<CreatorListItem>> }) => {
    const nextActiveVideo = viewableItems.find((token) =>
      token.isViewable && token.item?.kind === 'post' && hasShowcaseVideoWithoutPreview(token.item.item)
    );
    setActiveVideoItemId(nextActiveVideo?.item?.kind === 'post' ? nextActiveVideo.item.item.id : null);
  }, []);
  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 55, minimumViewTime: 160 }), []);

  const notFound = isNotFoundError(profileQuery.error);
  if (profileQuery.isLoading && !data) {
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
        <Stack.Screen options={{ title: 'Creator' }} />
        <CreatorProfileSkeleton />
      </View>
    );
  }

  if (!data) {
    // The body used to print `error.message` -- whatever the API happened to
    // say, in the API's words, to someone who cannot act on it. Feedback:
    // "show people when a command can't be carried out and help them
    // understand why", which means copy that names the situation and a control
    // that moves them on: a missing creator is not retryable, so it offers
    // Showcase instead of a Retry that would fail the same way.
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background, paddingTop: 16, paddingHorizontal: 16, gap: appTheme.spacing.gap }}>
        <Stack.Screen options={{ title: 'Creator' }} />
        <StatusBlock
          tone={notFound ? 'neutral' : 'danger'}
          title={notFound ? 'Creator not found' : 'Could not load creator'}
          body={notFound
            ? 'This profile may have been removed, or the handle may have changed.'
            : 'Check your connection, then try again.'}
        />
        <SecondaryButton
          label={notFound ? 'Browse Showcase' : 'Try again'}
          onPress={notFound
            ? () => router.replace('/(tabs)/showcase' as never)
            : () => void profileQuery.refetch()}
        />
      </View>
    );
  }

  const renderItem = ({ item }: { item: CreatorListItem }) => {
    if (item.kind === 'header') {
      return (
        <View style={{ paddingBottom: 14 }}>
          <CreatorHeader
            data={data}
            followError={followError}
            isFollowLoading={followMutation.isPending}
            onEditProfile={() => router.push('/edit-profile' as never)}
            onFollowPress={handleFollowPress}
            onSafetyOptions={handleSafetyOptions}
            onShareProfile={handleShareProfile}
            socialLinks={socialLinks}
          />
        </View>
      );
    }
    if (item.kind === 'tabs') {
      return (
        <View style={{ backgroundColor: appTheme.colors.background, paddingBottom: 12 }}>
          <CreatorTabs activeTab={activeTab} data={data} onChange={setActiveTab} />
        </View>
      );
    }
    if (item.kind === 'tool') {
      return <CreatorToolRow tool={item.tool} />;
    }
    if (item.kind === 'empty') {
      return (
        <EmptyState
          icon={item.tab === 'unlocks' ? <Lock size={appTheme.icon.hero} color={appTheme.colors.faint} /> : item.tab === 'tools' ? <Layers3 size={appTheme.icon.hero} color={appTheme.colors.faint} /> : <ImageIcon size={appTheme.icon.hero} color={appTheme.colors.faint} />}
          title={item.tab === 'unlocks' ? 'No recipes yet' : item.tab === 'tools' ? 'No tagged tools yet' : 'No posts yet'}
          body={item.tab === 'unlocks'
            ? 'Reusable prompts, files, notes, and remix access will appear here.'
            : item.tab === 'tools'
              ? 'Tools will appear when this creator tags where a post was made.'
              : 'Published creator work will appear here.'}
        />
      );
    }

    return (
      <View style={{ paddingHorizontal: GRID_GAP / 2, paddingBottom: GRID_GAP }}>
        <CreatorPostTile
          activeVideoPreview={isFocused && activeVideoItemId === item.item.id}
          item={item.item}
          onPress={() => openProfileItem(item.item)}
          width={tileWidth}
        />
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      {/* The bar says what the view is, not who it contains: a username has no
          length bound, the profile header already prints the display name, and a
          title that changes as the query lands flickers on every open. */}
      <Stack.Screen options={{ title: 'Creator' }} />
      <FlashList
        data={listItems}
        drawDistance={900}
        extraData={`${activeTab}:${activeVideoItemId ?? ''}:${isFocused}`}
        getItemType={(item) => item.kind}
        keyExtractor={(item) => item.key}
        numColumns={2}
        onEndReached={requestNextPage}
        onEndReachedThreshold={0.35}
        onRefresh={handleRefresh}
        onViewableItemsChanged={onViewableItemsChanged}
        overrideItemLayout={(layout, item) => {
          if (item.kind !== 'post') layout.span = 2;
        }}
        refreshing={pullRefreshing}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[1]}
        viewabilityConfig={viewabilityConfig}
        style={{ flex: 1, width: '100%', maxWidth: 430, alignSelf: 'center', backgroundColor: appTheme.colors.background }}
        contentContainerStyle={{
          paddingTop: 12,
          paddingHorizontal: horizontalPadding,
          paddingBottom: bottomInset + 36,
        }}
        ListFooterComponent={
          profileQuery.isFetchingNextPage ? (
            <View style={{ minHeight: 72, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={appTheme.colors.image} />
            </View>
          ) : profileQuery.isFetchNextPageError ? (
            <FeedLoadMoreErrorFooter onRetry={retryNextPage} />
          ) : null
        }
      />
    </View>
  );
}

function CreatorHeader({
  data,
  followError,
  isFollowLoading,
  onEditProfile,
  onFollowPress,
  onSafetyOptions,
  onShareProfile,
  socialLinks,
}: {
  data: CreatorProfileResponse;
  followError: string | null;
  isFollowLoading: boolean;
  onEditProfile: () => void;
  onFollowPress: () => void;
  onSafetyOptions: () => void;
  onShareProfile: () => void;
  socialLinks: Array<{ label: string; url: string }>;
}) {
  const profile = data.profile;
  const initial = creatorInitial(profile);

  return (
    <View style={{ overflow: 'hidden', borderRadius: 28, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.borderSubtle, backgroundColor: appTheme.colors.panel }}>
      <View style={{ height: 136, backgroundColor: appTheme.colors.panelSoft }}>
        {profile.coverUrl ? (
          <Image source={{ uri: profile.coverUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <View style={{ position: 'absolute', inset: 0, backgroundColor: appTheme.colors.panelSoft }} />
        )}
        {profile.coverUrl ? <LinearGradient colors={['rgba(8,8,10,0.04)', 'rgba(8,8,10,0.90)']} style={{ position: 'absolute', inset: 0 }} /> : null}
      </View>

      <View style={{ padding: 16, paddingTop: 0, gap: 14 }}>
        <View style={{ marginTop: -42, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
          <CreatorAvatar avatarUrl={profile.avatarUrl} initial={initial} size={86} />
          <View style={{ flexDirection: 'row', gap: 8, flexShrink: 0 }}>
            {data.viewer.isOwner ? (
              <EditProfileButton onPress={onEditProfile} />
            ) : (
              <FollowButton following={data.viewer.isFollowing} loading={isFollowLoading} onPress={onFollowPress} />
            )}
            <CircleAction label="Share profile" onPress={onShareProfile}>
              <ShareGlyph size={appTheme.icon.compact} color={appTheme.colors.text} />
            </CircleAction>
            {!data.viewer.isOwner ? (
              <CircleAction label="More options" onPress={onSafetyOptions}>
                <MoreVertical size={appTheme.icon.default} color={appTheme.colors.text} />
              </CircleAction>
            ) : null}
          </View>
        </View>

        <View style={{ gap: 6 }}>
          <Text selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.74} style={{ color: appTheme.colors.text, fontSize: 29, lineHeight: 34, fontWeight: '800' }}>
            {profile.displayName}
          </Text>
          <Text selectable numberOfLines={1} style={{ color: appTheme.colors.primary, ...appTheme.type.bodySm, fontWeight: '700' }}>@{profile.username}</Text>
          {profile.location ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <MapPin size={14} color={appTheme.colors.muted} />
              <Text selectable numberOfLines={1} style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>{profile.location}</Text>
            </View>
          ) : null}
          {profile.bio ? <Text selectable style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>{profile.bio}</Text> : null}
          {followError ? <Text accessibilityLiveRegion="polite" style={{ color: appTheme.colors.danger, ...appTheme.type.caption }}>{followError}</Text> : null}
        </View>

        {socialLinks.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {socialLinks.map((link) => <SocialChip key={link.label} label={link.label} url={link.url} />)}
          </View>
        ) : null}

        <CreatorStats data={data} />
      </View>
    </View>
  );
}

function CreatorStats({ data }: { data: CreatorProfileResponse }) {
  const stats = [
    { label: 'Posts', value: data.stats.publicCreations },
    { label: 'Saves', value: data.stats.totalSaves },
    { label: 'Remixes', value: data.stats.totalRemixes },
    { label: 'Recipes', value: data.stats.unlocks },
  ];

  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: appTheme.colors.borderSubtle, paddingTop: 14 }}>
      {stats.map((stat, index) => (
        <View key={stat.label} style={{ flex: 1, minWidth: 0, alignItems: 'center', gap: 3, borderLeftWidth: index ? 1 : 0, borderLeftColor: appTheme.colors.borderSubtle, paddingHorizontal: 2 }}>
          <Text style={{ color: appTheme.colors.text, fontSize: 18, lineHeight: 22, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{formatCompactCount(stat.value)}</Text>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>{stat.label}</Text>
        </View>
      ))}
    </View>
  );
}

function CreatorTabs({ activeTab, data, onChange }: { activeTab: CreatorProfileTab; data: CreatorProfileResponse; onChange: (tab: CreatorProfileTab) => void }) {
  const counts: Record<CreatorProfileTab, number> = {
    creations: data.stats.publicCreations,
    unlocks: data.stats.unlocks,
    tools: data.stats.toolsUsed.length,
  };

  return (
    <View style={{ flexDirection: 'row', gap: 4, borderRadius: 18, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.borderSubtle, backgroundColor: appTheme.colors.overlayStrong, padding: 4 }}>
      {CREATOR_PROFILE_TABS.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tab.id)}
            style={({ pressed }) => ({ flex: 1, minHeight: appTheme.touch.default, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? appTheme.colors.primary : 'transparent', opacity: pressed ? appTheme.opacity.pressed : 1, paddingHorizontal: 5 })}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={{ color: active ? appTheme.colors.onPrimary : appTheme.colors.muted, ...appTheme.type.label, fontWeight: '700' }}>
              {tab.label} {formatCompactCount(counts[tab.id])}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CreatorPostTile({ activeVideoPreview, item, onPress, width }: { activeVideoPreview: boolean; item: ShowcaseFeedItem; onPress: () => void; width: number }) {
  const isTextPost = isTextOnlyShowcasePost(item);
  const displayText = getShowcasePostDisplayText(item);
  const height = Math.round(width * 1.25);
  const accent = accentColor(item.category === 'video' ? 'video' : item.category === 'text' ? 'motion' : 'image');
  const hasVideo = item.mediaKind === 'video' || item.category === 'video' || item.mediaItems?.some((mediaItem) => mediaItem.mediaKind === 'video');

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.title || 'creator post'}`} onPress={onPress} style={({ pressed }) => ({ width, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
      <View style={{ minHeight: height + 92, overflow: 'hidden', borderRadius: 20, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.borderSubtle, backgroundColor: appTheme.colors.panel }}>
        <View style={{ height, backgroundColor: appTheme.colors.surfaceInset }}>
          {isTextPost ? (
            <View style={{ flex: 1, padding: 13, justifyContent: 'space-between', backgroundColor: appTheme.colors.panelSoft }}>
              <FileText size={appTheme.icon.feature} color={accent} />
              <Text numberOfLines={7} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>{displayText}</Text>
            </View>
          ) : hasShowcasePreviewMedia(item) ? (
            <ShowcaseMediaPreview accent={accent} height={height} mediaItems={getShowcasePreviewMediaItems(item)} onPress={onPress} radius={0} recyclingKey={`creator-profile:${item.id}`} videoActivation={activeVideoPreview ? 'when-poster-missing' : 'never'} width={width} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ImageIcon size={appTheme.icon.hero} color={appTheme.colors.faint} /></View>
          )}
          {hasVideo ? (
            <View style={{ position: 'absolute', top: 8, right: 8, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.overlay }}>
              <Play size={appTheme.icon.sm} color="#fff" fill="#fff" />
            </View>
          ) : null}
          {item.asset ? (
            <View style={{ position: 'absolute', top: 8, left: 8, maxWidth: '72%', flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: appTheme.radii.pill, backgroundColor: appTheme.colors.overlayStrong, paddingHorizontal: 8, paddingVertical: 5 }}>
              <Lock size={appTheme.icon.xs} color={appTheme.colors.commerce} />
              <Text numberOfLines={1} style={{ color: appTheme.colors.commerce, ...appTheme.type.caption, fontWeight: '700' }}>
                {item.asset.accessMode === 'free' ? 'Free' : item.asset.priceQuote?.formatted ?? 'Unlock'}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={{ minHeight: 92, padding: 10, gap: 6 }}>
          <Text numberOfLines={2} style={{ minHeight: 38, color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '700' }}>{item.title || displayText}</Text>
          <Text numberOfLines={1} style={{ minHeight: 15, color: appTheme.colors.faint, ...appTheme.type.caption }}>
            {item.sourceTool ? `Made with ${item.sourceTool}` : ' '}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <TileStat icon={<Heart size={appTheme.icon.xs} color={appTheme.colors.muted} />} label={formatCompactCount(item.saveCount)} />
            <TileStat icon={<Repeat2 size={appTheme.icon.xs} color={appTheme.colors.muted} />} label={formatCompactCount(item.remixCount)} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

function CreatorToolRow({ tool }: { tool: CreatorTool }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`View posts made with ${tool.label}`}
      onPress={() => router.push({ pathname: '/(tabs)/showcase', params: { tool: tool.slug } } as never)}
      style={({ pressed }) => ({ minHeight: 76, marginBottom: 10, borderRadius: 20, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.borderSubtle, backgroundColor: appTheme.colors.panel, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${appTheme.colors.image}22` }}>
        <Layers3 size={20} color={appTheme.colors.image} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>{tool.label}</Text>
        <Text numberOfLines={1} style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>{formatCompactCount(tool.count)} post{tool.count === 1 ? '' : 's'}</Text>
      </View>
      <ChevronRight size={appTheme.icon.default} color={appTheme.colors.faint} />
    </Pressable>
  );
}

function EditProfileButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Edit profile" onPress={onPress} style={({ pressed }) => ({ minHeight: 48, borderRadius: appTheme.radii.pill, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7, backgroundColor: appTheme.colors.primary, opacity: pressed ? appTheme.opacity.pressed : 1, paddingHorizontal: 15 })}>
      <Pencil size={appTheme.icon.sm} color={appTheme.colors.onPrimary} />
      <Text style={{ color: appTheme.colors.onPrimary, ...appTheme.type.label, fontWeight: '700' }}>Edit</Text>
    </Pressable>
  );
}

function FollowButton({ following, loading, onPress }: { following: boolean; loading: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ busy: loading, selected: following }} disabled={loading} onPress={onPress} style={({ pressed }) => ({ minHeight: 48, borderRadius: appTheme.radii.pill, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7, borderWidth: following ? 1 : 0, borderColor: appTheme.colors.borderStrong, backgroundColor: following ? appTheme.colors.surface : appTheme.colors.primary, opacity: loading ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1, paddingHorizontal: 16 })}>
      {loading ? <ActivityIndicator size="small" color={following ? appTheme.colors.text : appTheme.colors.onPrimary} /> : following ? <UserCheck size={16} color={appTheme.colors.text} /> : <UserPlus size={16} color={appTheme.colors.onPrimary} />}
      <Text style={{ color: following ? appTheme.colors.text : appTheme.colors.onPrimary, ...appTheme.type.label, fontWeight: '700' }}>{following ? 'Following' : 'Follow'}</Text>
    </Pressable>
  );
}

function SocialChip({ label, url }: { label: string; url: string }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`Open ${label}`} onPress={() => void Linking.openURL(url)} style={({ pressed }) => ({ minHeight: appTheme.touch.default, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: appTheme.colors.border, backgroundColor: appTheme.colors.surface, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
      {label === 'Website' ? <Globe size={14} color={appTheme.colors.text} /> : <ExternalLink size={14} color={appTheme.colors.text} />}
      <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.label }}>{label}</Text>
    </Pressable>
  );
}

function CircleAction({ children, label, onPress }: { children: ReactNode; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: appTheme.colors.border, backgroundColor: appTheme.colors.panelSoft, opacity: pressed ? appTheme.opacity.pressed : 1 })}>{children}</Pressable>
  );
}

/**
 * Round, because the same person's avatar is round on the profile tab, on every
 * feed row and in the comments sheet. A rounded square here made one account
 * two shapes depending on which screen you reached it from.
 */
function CreatorAvatar({ avatarUrl, initial, size }: { avatarUrl: string | null; initial: string; size: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, padding: 3, backgroundColor: appTheme.colors.panel, borderWidth: 2, borderColor: appTheme.colors.primary }}>
      <View style={{ flex: 1, overflow: 'hidden', borderRadius: size / 2 - 5, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.panelSoft }}>
        {avatarUrl ? <Image source={{ uri: avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} /> : <Text selectable style={{ color: appTheme.colors.text, fontSize: 26, fontWeight: '800' }}>{initial}</Text>}
      </View>
    </View>
  );
}

function TileStat({ icon, label }: { icon: ReactNode; label: string }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>{icon}<Text style={{ color: appTheme.colors.muted, ...appTheme.type.caption, fontVariant: ['tabular-nums'] }}>{label}</Text></View>;
}

function EmptyState({ body, icon, title }: { body: string; icon: ReactNode; title: string }) {
  return (
    <View style={{ minHeight: 190, alignItems: 'center', justifyContent: 'center', padding: 18, gap: 8 }}>
      {icon}
      <AppText variant="cardTitle" style={{ textAlign: 'center' }}>{title}</AppText>
      <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>{body}</AppText>
    </View>
  );
}

function isNotFoundError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 404);
}
