import { useIsFocused } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, router } from 'expo-router';
import {
  ExternalLink,
  FileText,
  Globe,
  Heart,
  ImageIcon,
  Layers3,
  Lock,
  MapPin,
  Play,
  RefreshCw,
  Repeat2,
  Share2,
  UserCheck,
  UserPlus,
} from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Share,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { AppText, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  CREATOR_PROFILE_TABS,
  creatorInitial,
  creatorProfileSocialLinks,
  creatorProfileTabItems,
  creatorProfileUnlockSummary,
  selectActiveCreatorProfileVideoId,
  type CreatorProfileVideoPreviewLayout,
  type CreatorProfileTab,
} from '@/lib/creator-profile-view-model';
import { env } from '@/lib/env';
import { formatCompactCount } from '@/lib/home-view-model';
import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { hasShowcasePreviewMedia, hasShowcaseVideoWithoutPreview } from '@/lib/showcase-media';
import { createShowcasePostQueryKey } from '@/lib/showcase-feed-query';
import { getShowcasePostDisplayText, isTextOnlyShowcasePost } from '@/lib/showcase-display';
import { accentColor, appTheme } from '@/lib/theme';
import type { CreatorProfileResponse, ShowcaseFeedItem } from '@/lib/types';

const PROFILE_QUERY_LIMIT = 48;
const GRID_GAP = 10;

export function CreatorProfileScreen({
  initialTab = 'posts',
  username,
}: {
  initialTab?: CreatorProfileTab;
  username: string;
}) {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<CreatorProfileTab>(initialTab);
  const [gridTop, setGridTop] = useState<number | null>(null);
  const [scrollOffsetY, setScrollOffsetY] = useState(0);
  const [scrollViewportHeight, setScrollViewportHeight] = useState(0);
  const [videoTileLayouts, setVideoTileLayouts] = useState<Record<string, CreatorProfileVideoPreviewLayout>>({});
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const contentWidth = Math.min(width, 430);
  const horizontalPadding = contentWidth < 390 ? 14 : 16;
  const gridWidth = contentWidth - horizontalPadding * 2;
  const tileWidth = Math.floor((gridWidth - GRID_GAP) / 2);
  const profileQuery = useQuery({
    queryKey: ['creator-profile', username],
    enabled: Boolean(username),
    queryFn: () => api.getCreatorProfile(username, { limit: PROFILE_QUERY_LIMIT }),
    staleTime: 1000 * 60,
  });
  const data = profileQuery.data;
  const currentTabItems = useMemo(
    () => creatorProfileTabItems(data?.items ?? [], activeTab),
    [activeTab, data?.items]
  );
  const selectedVideoItemId = useMemo(
    () => selectActiveCreatorProfileVideoId(
      currentTabItems,
      videoTileLayouts,
      gridTop,
      scrollOffsetY,
      scrollViewportHeight
    ),
    [currentTabItems, gridTop, scrollOffsetY, scrollViewportHeight, videoTileLayouts]
  );
  const activeVideoItemId = isFocused ? selectedVideoItemId : null;
  const socialLinks = useMemo(
    () => data ? creatorProfileSocialLinks(data.profile) : [],
    [data]
  );

  useEffect(() => {
    setGridTop(null);
    setVideoTileLayouts({});
  }, [activeTab, username]);

  const recordVideoTileLayout = (id: string, layout: CreatorProfileVideoPreviewLayout) => {
    setVideoTileLayouts((current) => {
      const previous = current[id];
      if (previous?.y === layout.y && previous.height === layout.height) return current;
      return { ...current, [id]: layout };
    });
  };
  const followMutation = useMutation({
    mutationFn: (following: boolean) => api.setCreatorFollowing(data?.profile.id ?? '', following),
    onMutate: async (following) => {
      await queryClient.cancelQueries({ queryKey: ['creator-profile', username] });
      const previous = queryClient.getQueryData<CreatorProfileResponse>(['creator-profile', username]);
      queryClient.setQueryData<CreatorProfileResponse>(['creator-profile', username], (current) => current ? {
        ...current,
        viewer: {
          ...current.viewer,
          isFollowing: following,
        },
      } : current);
      return { previous };
    },
    onError: (_error, _following, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['creator-profile', username], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['creator-profile', username] });
    },
  });

  const handleFollowPress = () => {
    if (!data) return;
    if (!user) {
      router.push('/auth' as never);
      return;
    }
    if (data.viewer.isOwner) return;
    followMutation.mutate(!data.viewer.isFollowing);
  };

  const handleShareProfile = async () => {
    if (!data) return;
    const url = `${env.siteUrl.replace(/\/$/, '')}/creators/${encodeURIComponent(data.profile.username)}`;
    await Share.share({
      message: `${data.profile.displayName} on Magicbooklet\n${url}`,
      url,
      title: data.profile.displayName,
    });
  };

  const openProfileItem = (item: ShowcaseFeedItem) => {
    queryClient.setQueryData(createShowcasePostQueryKey(item.id, user?.id), { success: true, item });
    router.push(immersiveViewerHref({
      source: 'creator-profile',
      initialId: item.id,
      creatorUsername: data?.profile.username ?? username,
    }) as never);
  };

  const notFound = isNotFoundError(profileQuery.error);

  if (profileQuery.isLoading && !data) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.background }}>
        <Stack.Screen options={{ title: 'Creator' }} />
        <ActivityIndicator color={appTheme.colors.motion} />
      </View>
    );
  }

  if (!data) {
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background, paddingTop: topInset + 16, paddingHorizontal: 16 }}>
        <Stack.Screen options={{ title: notFound ? 'Not found' : 'Creator' }} />
        <StatusBlock
          tone={notFound ? 'neutral' : 'danger'}
          title={notFound ? 'Creator not found' : 'Could not load creator'}
          body={profileQuery.error instanceof Error ? profileQuery.error.message : 'Try again from the feed.'}
        />
      </View>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: appTheme.colors.background }}
      contentContainerStyle={{
        width: '100%',
        maxWidth: 430,
        alignSelf: 'center',
        paddingTop: topInset + 12,
        paddingHorizontal: horizontalPadding,
        paddingBottom: bottomInset + 36,
        gap: 18,
      }}
      onLayout={(event) => setScrollViewportHeight(event.nativeEvent.layout.height)}
      onScroll={(event) => setScrollOffsetY(event.nativeEvent.contentOffset.y)}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
    >
      <Stack.Screen options={{ title: `@${data.profile.username}` }} />
      <CreatorHeader
        data={data}
        isFollowLoading={followMutation.isPending}
        onFollowPress={handleFollowPress}
        onShareProfile={handleShareProfile}
        socialLinks={socialLinks}
      />
      <CreatorStats data={data} />
      <CreatorTabs
        activeTab={activeTab}
        data={data}
        onChange={setActiveTab}
      />
      {activeTab === 'tools' ? (
        <ToolsList tools={data.stats.toolsUsed} />
      ) : (
        <View onLayout={(event) => setGridTop(event.nativeEvent.layout.y)}>
          <CreatorGrid
            activeVideoItemId={activeVideoItemId}
            items={currentTabItems}
            onOpenItem={openProfileItem}
            onVideoTileLayout={recordVideoTileLayout}
            tab={activeTab}
            tileWidth={tileWidth}
          />
        </View>
      )}
      {profileQuery.isRefetching ? (
        <View style={{ alignItems: 'center', paddingVertical: 10 }}>
          <RefreshCw size={18} color={appTheme.colors.muted} />
        </View>
      ) : null}
    </ScrollView>
  );
}

function CreatorHeader({
  data,
  isFollowLoading,
  onFollowPress,
  onShareProfile,
  socialLinks,
}: {
  data: CreatorProfileResponse;
  isFollowLoading: boolean;
  onFollowPress: () => void;
  onShareProfile: () => void;
  socialLinks: Array<{ label: string; url: string }>;
}) {
  const profile = data.profile;
  const initial = creatorInitial(profile);
  const hasCover = Boolean(profile.coverUrl);

  return (
    <View
      style={{
        overflow: 'hidden',
        borderRadius: 28,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.panel,
      }}
    >
      {hasCover ? (
        <View style={{ height: 136, backgroundColor: '#0b1020' }}>
          <Image source={{ uri: profile.coverUrl as string }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          <LinearGradient colors={['rgba(0,0,0,0.05)', 'rgba(9,9,11,0.92)']} style={{ position: 'absolute', inset: 0 }} />
        </View>
      ) : null}

      <View style={{ padding: 16, paddingTop: hasCover ? 0 : 16, gap: 14 }}>
        <View style={{ marginTop: hasCover ? -42 : 0, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <CreatorAvatar avatarUrl={profile.avatarUrl} initial={initial} size={hasCover ? 86 : 72} />
          <View style={{ flexDirection: 'row', gap: 8, flexShrink: 0 }}>
            <CircleAction label="Share profile" onPress={onShareProfile}>
              <Share2 size={18} color={appTheme.colors.text} strokeWidth={2.4} />
            </CircleAction>
            {data.viewer.isOwner ? (
              <View style={{
                minHeight: 48,
                borderRadius: appTheme.radii.pill,
                borderWidth: 1,
                borderColor: appTheme.colors.border,
                paddingHorizontal: 16,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: appTheme.colors.surface,
              }}>
                <Text style={{ color: appTheme.colors.muted, ...appTheme.type.label }}>Your profile</Text>
              </View>
            ) : (
              <FollowButton
                following={data.viewer.isFollowing}
                loading={isFollowLoading}
                onPress={onFollowPress}
              />
            )}
          </View>
        </View>

        <View style={{ gap: 6 }}>
          <Text
            selectable
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.74}
            style={{ color: appTheme.colors.text, fontSize: 29, lineHeight: 34, fontWeight: '900' }}
          >
            {profile.displayName}
          </Text>
          <Text selectable numberOfLines={1} style={{ color: appTheme.colors.image, ...appTheme.type.bodySm, fontWeight: '900' }}>
            @{profile.username}
          </Text>
          {profile.location ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <MapPin size={14} color={appTheme.colors.muted} strokeWidth={2.3} />
              <Text selectable numberOfLines={1} style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>
                {profile.location}
              </Text>
            </View>
          ) : null}
          {profile.bio ? (
            <Text selectable style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>
              {profile.bio}
            </Text>
          ) : null}
        </View>

        {socialLinks.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {socialLinks.map((link) => (
              <SocialChip key={link.label} label={link.label} url={link.url} />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function CreatorStats({ data }: { data: CreatorProfileResponse }) {
  const stats = [
    { label: 'Creations', value: data.stats.publicCreations },
    { label: 'Saves', value: data.stats.totalSaves },
    { label: 'Remixes', value: data.stats.totalRemixes },
    { label: 'Unlocks', value: data.stats.unlocks },
  ];

  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {stats.map((stat) => (
        <View
          key={stat.label}
          style={{
            flex: 1,
            minHeight: 76,
            borderRadius: 18,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: appTheme.colors.borderSubtle,
            backgroundColor: appTheme.colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            paddingHorizontal: 4,
          }}
        >
          <Text style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontVariant: ['tabular-nums'] }}>
            {formatCompactCount(stat.value)}
          </Text>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>
            {stat.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function CreatorTabs({
  activeTab,
  data,
  onChange,
}: {
  activeTab: CreatorProfileTab;
  data: CreatorProfileResponse;
  onChange: (tab: CreatorProfileTab) => void;
}) {
  const counts: Record<CreatorProfileTab, number> = {
    posts: data.items.length,
    unlocks: data.items.filter((item) => item.asset).length,
    tools: data.stats.toolsUsed.length,
  };

  return (
    <View style={{ flexDirection: 'row', gap: 8, borderRadius: appTheme.radii.pill, backgroundColor: appTheme.colors.surfaceInset, padding: 4 }}>
      {CREATOR_PROFILE_TABS.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tab.id)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 48,
              borderRadius: appTheme.radii.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? appTheme.colors.text : 'transparent',
              opacity: pressed ? appTheme.opacity.pressed : 1,
              paddingHorizontal: 8,
            })}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              style={{
                color: active ? appTheme.colors.textInverse : appTheme.colors.muted,
                ...appTheme.type.label,
                fontWeight: '900',
              }}
            >
              {tab.label} {counts[tab.id] > 0 ? formatCompactCount(counts[tab.id]) : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CreatorGrid({
  activeVideoItemId,
  items,
  onOpenItem,
  onVideoTileLayout,
  tab,
  tileWidth,
}: {
  activeVideoItemId: string | null;
  items: ShowcaseFeedItem[];
  onOpenItem: (item: ShowcaseFeedItem) => void;
  onVideoTileLayout: (id: string, layout: CreatorProfileVideoPreviewLayout) => void;
  tab: CreatorProfileTab;
  tileWidth: number;
}) {
  if (!items.length) {
    return (
      <EmptyState
        icon={tab === 'unlocks' ? <Lock size={28} color={appTheme.colors.faint} /> : <ImageIcon size={28} color={appTheme.colors.faint} />}
        title={tab === 'unlocks' ? 'No unlocks yet' : 'No public posts yet'}
        body={tab === 'unlocks'
          ? 'Unlockable prompts, files, notes, and remix access will appear here.'
          : 'Published creator posts will appear here.'}
      />
    );
  }

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP }}>
      {items.map((item) => (
        <CreatorPostTile
          activeVideoPreview={activeVideoItemId === item.id}
          key={item.id}
          item={item}
          onVideoLayout={onVideoTileLayout}
          width={tileWidth}
          onPress={() => onOpenItem(item)}
        />
      ))}
    </View>
  );
}

function CreatorPostTile({
  activeVideoPreview,
  item,
  onPress,
  onVideoLayout,
  width,
}: {
  activeVideoPreview: boolean;
  item: ShowcaseFeedItem;
  onPress: () => void;
  onVideoLayout: (id: string, layout: CreatorProfileVideoPreviewLayout) => void;
  width: number;
}) {
  const isTextPost = isTextOnlyShowcasePost(item);
  const displayText = getShowcasePostDisplayText(item);
  const height = Math.round(width * 1.28);
  const accent = accentColor(item.category === 'video' ? 'video' : item.category === 'text' ? 'motion' : 'image');
  const hasVideo = item.mediaKind === 'video'
    || item.category === 'video'
    || item.mediaItems?.some((mediaItem) => mediaItem.mediaKind === 'video');
  const unlockSummary = creatorProfileUnlockSummary(item.asset);
  const needsVideoFrame = hasShowcaseVideoWithoutPreview(item);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.title || 'creator post'}`}
      onLayout={needsVideoFrame ? (event) => onVideoLayout(item.id, event.nativeEvent.layout) : undefined}
      onPress={onPress}
      style={({ pressed }) => ({
        width,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      <View
        style={{
          minHeight: height + 82,
          overflow: 'hidden',
          borderRadius: 20,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: item.asset ? `${appTheme.colors.commerce}66` : appTheme.colors.borderSubtle,
          backgroundColor: appTheme.colors.panel,
        }}
      >
        <View style={{ height, backgroundColor: '#050506' }}>
          {isTextPost ? (
            <LinearGradient colors={['#1d1431', '#111215']} style={{ flex: 1, padding: 13, justifyContent: 'space-between' }}>
              <FileText size={22} color={accent} />
              <Text numberOfLines={6} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
                {displayText}
              </Text>
            </LinearGradient>
          ) : hasShowcasePreviewMedia(item) ? (
            <ShowcaseMediaPreview
              accent={accent}
              height={height}
              item={item}
              onPress={onPress}
              radius={0}
              recyclingKey={`creator-profile:${item.id}`}
              videoActivation={activeVideoPreview ? 'when-poster-missing' : 'never'}
              width={width}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ImageIcon size={30} color={appTheme.colors.faint} />
            </View>
          )}
          {hasVideo ? (
            <View style={{ position: 'absolute', top: 8, right: 8, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.overlay }}>
              <Play size={15} color="#fff" fill="#fff" />
            </View>
          ) : null}
          {item.asset ? (
            <View style={{ position: 'absolute', top: 8, left: 8, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: appTheme.radii.pill, backgroundColor: appTheme.colors.overlayStrong, paddingHorizontal: 8, paddingVertical: 5 }}>
              <Lock size={12} color={appTheme.colors.commerce} />
              <Text style={{ color: appTheme.colors.commerce, ...appTheme.type.caption, fontWeight: '900' }}>
                {item.asset.accessMode === 'free' ? 'Free' : item.asset.priceQuote?.formatted ?? 'Unlock'}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={{ padding: 10, gap: 7 }}>
          <Text numberOfLines={2} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '900' }}>
            {item.title || displayText}
          </Text>
          {unlockSummary ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Lock size={12} color={appTheme.colors.commerce} strokeWidth={2.5} />
              <Text numberOfLines={1} style={{ color: appTheme.colors.muted, flex: 1, ...appTheme.type.caption, fontWeight: '800' }}>
                {unlockSummary}
              </Text>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <TileStat icon={<Heart size={13} color={appTheme.colors.muted} />} label={formatCompactCount(item.saveCount)} />
            <TileStat icon={<Repeat2 size={13} color={appTheme.colors.muted} />} label={formatCompactCount(item.remixCount)} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

function ToolsList({ tools }: { tools: CreatorProfileResponse['stats']['toolsUsed'] }) {
  if (!tools.length) {
    return (
      <EmptyState
        icon={<Layers3 size={28} color={appTheme.colors.faint} />}
        title="No tagged tools yet"
        body="Tools will appear when this creator tags where portfolio pieces were made."
      />
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {tools.map((tool) => (
        <View
          key={tool.slug}
          style={{
            minHeight: 72,
            borderRadius: 20,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: appTheme.colors.borderSubtle,
            backgroundColor: appTheme.colors.panel,
            padding: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: `${appTheme.colors.image}22` }}>
            <Layers3 size={20} color={appTheme.colors.image} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text selectable numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>
              {tool.label}
            </Text>
            <Text selectable numberOfLines={1} style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>
              Used in {formatCompactCount(tool.count)} portfolio piece{tool.count === 1 ? '' : 's'}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function FollowButton({
  following,
  loading,
  onPress,
}: {
  following: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: loading, selected: following }}
      disabled={loading}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        borderRadius: appTheme.radii.pill,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 7,
        borderWidth: 1,
        borderColor: following ? appTheme.colors.borderStrong : appTheme.colors.text,
        backgroundColor: following ? appTheme.colors.surface : appTheme.colors.text,
        opacity: loading ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 16,
      })}
    >
      {loading ? (
        <ActivityIndicator size="small" color={following ? appTheme.colors.text : appTheme.colors.textInverse} />
      ) : following ? (
        <UserCheck size={16} color={appTheme.colors.text} />
      ) : (
        <UserPlus size={16} color={appTheme.colors.textInverse} />
      )}
      <Text style={{ color: following ? appTheme.colors.text : appTheme.colors.textInverse, ...appTheme.type.label, fontWeight: '900' }}>
        {following ? 'Following' : 'Follow'}
      </Text>
    </Pressable>
  );
}

function SocialChip({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${label}`}
      onPress={() => {
        void Linking.openURL(url);
      }}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 11,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {label === 'Website' ? <Globe size={14} color={appTheme.colors.text} /> : <ExternalLink size={14} color={appTheme.colors.text} />}
      <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.label }}>
        {label}
      </Text>
    </Pressable>
  );
}

function CircleAction({ children, label, onPress }: { children: React.ReactNode; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panelSoft,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

function CreatorAvatar({
  avatarUrl,
  initial,
  size,
}: {
  avatarUrl: string | null;
  initial: string;
  size: number;
}) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, padding: 3, backgroundColor: appTheme.colors.background }}>
      <LinearGradient colors={[appTheme.colors.image, appTheme.colors.motion, appTheme.colors.commerce]} style={{ flex: 1, borderRadius: size / 2, padding: 2 }}>
        <View style={{ flex: 1, overflow: 'hidden', borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.panel }}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          ) : (
            <Text selectable style={{ color: appTheme.colors.text, fontSize: 26, fontWeight: '900' }}>
              {initial}
            </Text>
          )}
        </View>
      </LinearGradient>
    </View>
  );
}

function TileStat({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {icon}
      <Text style={{ color: appTheme.colors.muted, ...appTheme.type.caption, fontVariant: ['tabular-nums'] }}>
        {label}
      </Text>
    </View>
  );
}

function EmptyState({
  body,
  icon,
  title,
}: {
  body: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <View
      style={{
        minHeight: 156,
        borderRadius: 22,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 18,
        gap: 8,
      }}
    >
      {icon}
      <AppText variant="cardTitle" style={{ textAlign: 'center' }}>{title}</AppText>
      <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>{body}</AppText>
    </View>
  );
}

function isNotFoundError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 404);
}
