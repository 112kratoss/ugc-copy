import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import {
  Bell,
  ChevronRight,
  Crown,
  FileText,
  Heart,
  ImageIcon,
  Lock,
  Menu,
  MoreHorizontal,
  Play,
  Plus,
  Rocket,
  Share2,
  Sparkles,
  UserPlus,
  WandSparkles,
} from 'lucide-react-native';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { FantasyPortalArt } from '@/components/fantasy-portal-art';
import { HomeSideMenu } from '@/components/home-side-menu';
import { TextPreviewCard } from '@/components/text-preview-card';
import { useAuth } from '@/lib/auth';
import {
  FALLBACK_COMMUNITY,
  HOME_TOOL_SHORTCUTS,
  formatCompactCount,
  formatUsdCents,
  generationsToHomeCards,
  getOwnerPostSalesSummary,
  showcaseToCommunityCard,
  type HomeCommunityCard,
  type HomeGenerationCard,
  type HomeToolShortcut,
} from '@/lib/home-view-model';
import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';
import { HOME_RAIL_DRAW_DISTANCE } from '@/lib/media-performance';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import {
  SHOWCASE_FEED_STALE_TIME_MS,
  createShowcaseFeedQueryKey,
  flattenShowcaseFeedPages,
  getNextShowcaseFeedOffset,
  getShowcaseFeedPageParams,
} from '@/lib/showcase-feed-query';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { accentColor, appTheme } from '@/lib/theme';
import type { MarketplaceResource } from '@/lib/types';

interface UnlockCard {
  id: string;
  postId?: string;
  title: string;
  body: string;
  priceLabel: string;
  accessLabel: string;
  mediaUrl: string | null;
  isPreview: boolean;
}

const FALLBACK_UNLOCKS: UnlockCard[] = [
  {
    id: 'preview-beauty-hook',
    title: 'Beauty Product Hook',
    body: 'Prompt framework for a launch-ready product post.',
    priceLabel: 'Free',
    accessLabel: 'Prompt',
    mediaUrl: null,
    isPreview: true,
  },
  {
    id: 'preview-founder-caption',
    title: 'Founder Caption Kit',
    body: 'Reusable notes for founder updates and proof-led posts.',
    priceLabel: 'Free',
    accessLabel: 'Notes',
    mediaUrl: null,
    isPreview: true,
  },
  {
    id: 'preview-portrait-pack',
    title: 'Portrait Prompt Pack',
    body: 'Soft-lit portrait art direction and styling cues.',
    priceLabel: '$9',
    accessLabel: 'Prompt',
    mediaUrl: null,
    isPreview: true,
  },
];

const TOOL_PREVIEW_IMAGES = {
  kingdom: require('../assets/images/home-previews/image.png'),
  city: require('../assets/images/home-previews/video.png'),
  runner: require('../assets/images/home-previews/motion.png'),
} as const;

export function HomeDashboard() {
  const { user, api, credits, signOut } = useAuth();
  const [menuVisible, setMenuVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const pageWidth = Math.min(width, 430);
  const isCompact = pageWidth < 390;
  const horizontalPadding = isCompact ? 15 : 18;
  const contentWidth = pageWidth - horizontalPadding * 2;
  const toolGap = 10;
  const toolCardWidth = Math.floor((contentWidth - toolGap) / 2);
  const studioCardWidth = Math.max(162, Math.min(186, pageWidth * 0.43));
  const previewCardWidth = Math.max(188, Math.min(220, pageWidth * 0.52));

  const generationsQuery = useQuery({
    queryKey: ['home-generations', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.listGenerations(true),
  });

  const profileQuery = useQuery({
    queryKey: ['home-profile', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.getProfile(),
  });

  const sellerPostsQuery = useQuery({
    queryKey: ['home-seller-posts', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.listOwnerPosts({ includeArchived: true, visibility: 'all' }),
  });

  const showcaseQuery = useInfiniteQuery({
    queryKey: createShowcaseFeedQueryKey({ sort: 'recent' }),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.getShowcaseFeed(getShowcaseFeedPageParams({ offset: pageParam, sort: 'recent' })),
    getNextPageParam: getNextShowcaseFeedOffset,
    staleTime: SHOWCASE_FEED_STALE_TIME_MS,
  });

  const marketplaceQuery = useQuery({
    queryKey: ['home-marketplace-resources'],
    queryFn: () => api.listMarketplaceResources({ limit: 6, sort: 'recent' }),
    staleTime: SHOWCASE_FEED_STALE_TIME_MS,
  });

  const rawGenerations = generationsQuery.data?.generations ?? [];
  const generationCards = useMemo(() => generationsToHomeCards(rawGenerations), [rawGenerations]);
  const hasRecentStudio = generationCards.length > 0;
  const activeGenerationCount = rawGenerations.filter((item) => ['waiting', 'processing', 'starting'].includes(item.status)).length;

  const communityCards = useMemo(() => {
    const items = flattenShowcaseFeedPages(showcaseQuery.data?.pages).slice(0, 4).map(showcaseToCommunityCard);
    return items.length > 0 ? items : FALLBACK_COMMUNITY;
  }, [showcaseQuery.data]);

  const unlockCards = useMemo(() => {
    const items = (marketplaceQuery.data?.items ?? []).slice(0, 4).map(resourceToUnlockCard);
    return items.length > 0 ? items : FALLBACK_UNLOCKS;
  }, [marketplaceQuery.data]);

  const salesSummary = useMemo(
    () => getOwnerPostSalesSummary(sellerPostsQuery.data?.posts),
    [sellerPostsQuery.data]
  );

  const displayName =
    profileQuery.data?.displayName?.trim() ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'Creator';

  return (
    <View style={{ flex: 1, backgroundColor: '#03040d', paddingTop: topInset }}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(37,99,235,0.16)', 'rgba(217,70,239,0.08)', 'rgba(3,4,13,0)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 340 }}
      />
      <ScrollView
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        contentContainerStyle={{
          paddingTop: 12,
          paddingHorizontal: horizontalPadding,
          paddingBottom: tabBarMetrics.contentBottomPadding,
          gap: 16,
        }}
      >
        <HomeTopBar credits={credits ?? 0} onMenuPress={() => setMenuVisible(true)} />

        <WelcomePanel
          displayName={displayName}
          signedIn={Boolean(user)}
          credits={credits ?? 0}
          activeGenerationCount={activeGenerationCount}
          studioCount={rawGenerations.length}
          earningsUsdCents={salesSummary.earningsUsdCents}
        />

        <View style={{ gap: 11 }}>
          <SectionHeader title="Creator paths" actionLabel="Create" onPress={() => router.push('/(tabs)/creator' as never)} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: toolGap }}>
            {HOME_TOOL_SHORTCUTS.map((tool) => (
              <ToolShortcutCard key={tool.id} tool={tool} width={toolCardWidth} />
            ))}
          </View>
        </View>

        {hasRecentStudio ? (
          <Panel>
            <SectionHeader title="Recent Studio" actionLabel="View all" onPress={() => router.push('/(tabs)/profile' as never)} compact />
            <FlashList
              data={generationCards}
              drawDistance={HOME_RAIL_DRAW_DISTANCE}
              horizontal
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <View style={{ marginRight: 10 }}>
                  <RecentCreationCard item={item} width={studioCardWidth} />
                </View>
              )}
              showsHorizontalScrollIndicator={false}
              style={{ height: 160 }}
            />
          </Panel>
        ) : null}

        <View style={{ gap: 16 }}>
          <PreviewRail
            title="Showcase"
            actionLabel="Browse"
            onPress={() => router.push('/(tabs)/showcase' as never)}
            items={communityCards}
            width={previewCardWidth}
          />
          <UnlockRail
            title="Unlocks"
            actionLabel="Open"
            onPress={() => router.push('/(tabs)/marketplace' as never)}
            items={unlockCards}
            width={previewCardWidth}
          />
        </View>
      </ScrollView>

      <HomeSideMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        user={user}
        profile={profileQuery.data}
        credits={credits ?? 0}
        totalSalesUsdCents={salesSummary.earningsUsdCents}
        totalSalesLoading={Boolean(user) && sellerPostsQuery.isLoading}
        onSignOut={signOut}
      />
    </View>
  );
}

function HomeTopBar({ credits, onMenuPress }: { credits: number; onMenuPress: () => void }) {
  return (
    <View style={{ minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        onPress={onMenuPress}
        style={({ pressed }) => ({
          width: 38,
          height: 38,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 19,
          backgroundColor: 'rgba(255,255,255,0.06)',
          opacity: pressed ? 0.72 : 1,
        })}
      >
        <Menu size={23} color="#ffffff" strokeWidth={2.2} />
      </Pressable>

      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minWidth: 0 }}>
        <Sparkles size={22} color="#c084fc" fill="rgba(192,132,252,0.2)" />
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 19, fontWeight: '900', letterSpacing: 0, flexShrink: 1 }}>
          Magicbooklet
        </Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open credits"
          onPress={() => router.push('/pricing' as never)}
          style={({ pressed }) => ({
            minWidth: 72,
            height: 38,
            borderRadius: 19,
            overflow: 'hidden',
            opacity: pressed ? 0.78 : 1,
          })}
        >
          <LinearGradient
            colors={['rgba(124,58,237,0.4)', 'rgba(22,24,36,0.92)']}
            style={{ flex: 1, borderWidth: 1, borderColor: 'rgba(168,85,247,0.36)', borderRadius: 19, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Crown size={15} color="#fbbf24" fill="rgba(251,191,36,0.24)" />
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'] }}>{credits}</Text>
              <Plus size={14} color="#c084fc" strokeWidth={2.5} />
            </View>
          </LinearGradient>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open notifications"
          onPress={() => router.push('/studio' as never)}
          style={({ pressed }) => ({
            width: 38,
            height: 38,
            borderRadius: 19,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(255,255,255,0.06)',
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <Bell size={21} color="#ffffff" strokeWidth={2.1} />
        </Pressable>
      </View>
    </View>
  );
}

function WelcomePanel({
  displayName,
  signedIn,
  credits,
  activeGenerationCount,
  studioCount,
  earningsUsdCents,
}: {
  displayName: string;
  signedIn: boolean;
  credits: number;
  activeGenerationCount: number;
  studioCount: number;
  earningsUsdCents: number;
}) {
  const title = signedIn ? `Welcome back, ${displayName}` : 'Welcome to Magicbooklet';
  const body = signedIn
    ? 'Pick up a render, launch a new path, or open your workspace.'
    : 'Explore creator paths, then sign in when you are ready to save and publish.';
  const studioValue = signedIn
    ? studioCount > 0
      ? formatCompactCount(studioCount)
      : earningsUsdCents > 0
        ? formatUsdCents(earningsUsdCents)
        : 'Empty'
    : 'Preview';

  return (
    <Panel padded={false}>
      <LinearGradient
        colors={['rgba(37,99,235,0.22)', 'rgba(217,70,239,0.16)', 'rgba(15,23,42,0.2)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ padding: 16, gap: 14 }}
      >
        <View style={{ gap: 5 }}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={{ color: '#fff', fontSize: 22, fontWeight: '900' }}>
            {title}
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.68)', fontSize: 14, lineHeight: 20, fontWeight: '600' }}>
            {body}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <MetricTile label="Credits" value={formatCompactCount(credits)} accent="rgba(168,85,247,0.22)" />
          <MetricTile label="Renders" value={activeGenerationCount > 0 ? `${activeGenerationCount} live` : 'Ready'} accent="rgba(56,189,248,0.16)" />
          <MetricTile label="Studio" value={studioValue} accent="rgba(52,211,153,0.14)" />
        </View>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create now"
            onPress={() => router.push('/(tabs)/creator' as never)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 48,
              borderRadius: 17,
              overflow: 'hidden',
              opacity: pressed ? 0.82 : 1,
              transform: [{ scale: pressed ? 0.985 : 1 }],
            })}
          >
            <LinearGradient
              colors={['#2563eb', '#d946ef']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 }}
            >
              <WandSparkles size={19} color="#ffffff" />
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '900' }}>Create new</Text>
            </LinearGradient>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Studio"
            onPress={() => router.push('/(tabs)/profile' as never)}
            style={({ pressed }) => ({
              minWidth: 104,
              minHeight: 48,
              borderRadius: 17,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.13)',
              backgroundColor: 'rgba(255,255,255,0.06)',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.78 : 1,
            })}
          >
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>Studio</Text>
          </Pressable>
        </View>
      </LinearGradient>
    </Panel>
  );
}

function MetricTile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View
      style={{
        flex: 1,
        minHeight: 58,
        borderRadius: 15,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: accent,
        paddingHorizontal: 10,
        paddingVertical: 9,
        justifyContent: 'space-between',
      }}
    >
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: 'rgba(255,255,255,0.62)', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>
        {label}
      </Text>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: '#fff', fontSize: 15, fontWeight: '900', fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
    </View>
  );
}

function ToolShortcutCard({ tool, width }: { tool: HomeToolShortcut; width: number }) {
  const Icon = tool.id === 'image' ? ImageIcon : tool.id === 'video' ? Play : tool.id === 'motion' ? Rocket : Sparkles;
  const colors = toolColors(tool.accent);
  const disabled = !tool.href;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tool.badge ? `${tool.title} ${tool.badge}` : tool.title}
      disabled={disabled}
      onPress={() => {
        if (tool.href) {
          router.push(tool.href as never);
        }
      }}
      style={({ pressed }) => ({
        width,
        opacity: disabled ? 0.86 : pressed ? 0.82 : 1,
        transform: [{ scale: pressed && !disabled ? 0.985 : 1 }],
      })}
    >
      <LinearGradient
        colors={colors.background}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          minHeight: tool.previewVariant ? 150 : 132,
          borderRadius: 20,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: colors.border,
          padding: tool.previewVariant ? 0 : 13,
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        <View style={{ position: 'absolute', right: -18, bottom: -18, width: 92, height: 92, borderRadius: 46, backgroundColor: colors.glow }} />
        {tool.previewVariant ? (
          <ToolPreview variant={tool.previewVariant} icon={<Icon size={18} color="#ffffff" fill={tool.id === 'video' ? 'transparent' : 'rgba(255,255,255,0.14)'} />} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ width: 36, height: 36, borderRadius: 13, backgroundColor: colors.icon, alignItems: 'center', justifyContent: 'center' }}>
              <Icon size={20} color="#ffffff" fill={tool.id === 'video' ? 'transparent' : 'rgba(255,255,255,0.14)'} />
            </View>
            {tool.badge ? (
              <View style={{ borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.32)', paddingHorizontal: 8, paddingVertical: 4 }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '900', textTransform: 'uppercase' }}>{tool.badge}</Text>
              </View>
            ) : (
              <ChevronRight size={20} color="rgba(255,255,255,0.86)" />
            )}
          </View>
        )}
        <View style={{ gap: 5, paddingHorizontal: tool.previewVariant ? 12 : 0, paddingBottom: tool.previewVariant ? 11 : 0, paddingTop: tool.previewVariant ? 10 : 0 }}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: appTheme.colors.text, fontSize: tool.previewVariant ? 16 : 17, fontWeight: '900' }}>
            {tool.title}
          </Text>
          <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 17, fontWeight: '600' }}>
            {tool.body}
          </Text>
        </View>
      </LinearGradient>
    </Pressable>
  );
}

function ToolPreview({
  variant,
  icon,
}: {
  variant: NonNullable<HomeToolShortcut['previewVariant']>;
  icon: ReactNode;
}) {
  return (
    <View style={{ height: 58, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.2)' }}>
      <Image source={TOOL_PREVIEW_IMAGES[variant]} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
      <LinearGradient
        colors={['rgba(0,0,0,0.04)', 'rgba(0,0,0,0.48)']}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View style={{ position: 'absolute', left: 9, top: 9, width: 30, height: 30, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.38)', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
      <View style={{ position: 'absolute', right: 9, bottom: 8, width: 29, height: 29, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.42)', alignItems: 'center', justifyContent: 'center' }}>
        <ChevronRight size={17} color="#ffffff" />
      </View>
    </View>
  );
}

function RecentCreationCard({ item, width }: { item: HomeGenerationCard; width: number }) {
  const Icon = item.kind === 'image' ? ImageIcon : item.kind === 'video' ? Play : item.kind === 'text' ? FileText : Rocket;
  const isText = item.kind === 'text';
  const isFallbackPreview = item.sourceId.startsWith('preview-');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => {
        if (isFallbackPreview) {
          router.push('/(tabs)/creator' as never);
          return;
        }
        router.push(immersiveViewerHref({ source: item.viewerSource, initialId: item.sourceId }) as never);
      }}
      style={({ pressed }) => ({
        width,
        height: 160,
        overflow: 'hidden',
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.11)',
        backgroundColor: '#090914',
        opacity: pressed ? 0.86 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      {isText ? (
        <TextPreviewCard text={item.previewText} accent={accentColor('amber')} height={160} radius={18} lines={4} />
      ) : item.mediaUrl && item.kind === 'image' ? (
        <FeedMediaFrame kind="image" url={item.mediaUrl} recyclingKey={`home-generation:${item.id}`} radius={18} style={{ position: 'absolute', inset: 0 }} />
      ) : (
        <FantasyPortalArt variant={item.artVariant} muted />
      )}
      <LinearGradient colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.82)']} style={{ position: 'absolute', inset: 0 }} />
      <View style={{ position: 'absolute', left: 10, top: 10, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.38)', padding: 7 }}>
        <Icon size={18} color="#ffffff" />
      </View>
      <View style={{ position: 'absolute', left: 12, right: 12, bottom: 11, gap: 5 }}>
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 15, fontWeight: '900' }}>{item.title}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.68)', fontSize: 12, fontWeight: '700' }}>{item.label} • {item.timeLabel}</Text>
          <MoreHorizontal size={19} color="#ffffff" />
        </View>
      </View>
    </Pressable>
  );
}

function PreviewRail({
  title,
  actionLabel,
  onPress,
  items,
  width,
}: {
  title: string;
  actionLabel: string;
  onPress: () => void;
  items: HomeCommunityCard[];
  width: number;
}) {
  return (
    <Panel>
      <SectionHeader title={title} actionLabel={actionLabel} onPress={onPress} compact />
      <FlashList
        data={items}
        drawDistance={HOME_RAIL_DRAW_DISTANCE}
        horizontal
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={{ marginRight: 10 }}>
            <CommunityPreviewCard item={item} width={width} />
          </View>
        )}
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        disableIntervalMomentum
        snapToAlignment="start"
        snapToInterval={width + 10}
        style={{ height: 204 }}
      />
    </Panel>
  );
}

function CommunityPreviewCard({ item, width }: { item: HomeCommunityCard; width: number }) {
  const isFallbackPreview = item.sourceId.startsWith('preview-');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => {
        if (isFallbackPreview) {
          router.push('/(tabs)/showcase' as never);
          return;
        }
        router.push(immersiveViewerHref({ source: item.viewerSource, initialId: item.sourceId }) as never);
      }}
      style={({ pressed }) => ({
        width,
        height: 202,
        overflow: 'hidden',
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.11)',
        backgroundColor: '#080916',
        opacity: pressed ? 0.86 : 1,
      })}
    >
      <View style={{ height: 108, overflow: 'hidden' }}>
        {item.previewKind === 'text' ? (
          <TextPreviewCard text={item.body} accent={accentColor('workflow')} height={108} radius={0} lines={3} compact />
        ) : item.previewUrl || (item.mediaUrl && item.mediaKind === 'image') ? (
          <FeedMediaFrame
            kind="image"
            url={item.previewUrl || item.mediaUrl as string}
            backdropUrl={item.previewUrl}
            recyclingKey={`home-community:${item.id}`}
            style={{ position: 'absolute', inset: 0 }}
          />
        ) : (
          <FantasyPortalArt variant={item.artVariant} muted />
        )}
        <LinearGradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.5)']} style={{ position: 'absolute', inset: 0 }} />
        <View
          style={{
            position: 'absolute',
            left: item.previewKind === 'text' ? undefined : 9,
            right: item.previewKind === 'text' ? 9 : undefined,
            top: 9,
            borderRadius: 999,
            backgroundColor: 'rgba(0,0,0,0.5)',
            paddingHorizontal: 8,
            paddingVertical: 5,
          }}
        >
          <Text numberOfLines={1} style={{ color: '#fff', fontSize: 11, fontWeight: '900' }}>{item.accessLabel}</Text>
        </View>
      </View>
      <View style={{ flex: 1, paddingHorizontal: 10, paddingTop: 9, paddingBottom: 9, justifyContent: 'space-between', gap: 5 }}>
        <View style={{ gap: 4 }}>
          <Text numberOfLines={1} style={{ color: '#fff', fontSize: 14, lineHeight: 17, fontWeight: '900' }}>{item.title}</Text>
          <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 12, lineHeight: 14, fontWeight: '700' }}>{item.creatorHandle}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <MiniStat icon={<Heart size={13} color="#ffffff" />} label={item.saveLabel} />
          <MiniStat icon={<Share2 size={13} color="#ffffff" />} label="Share" />
        </View>
      </View>
    </Pressable>
  );
}

function UnlockRail({
  title,
  actionLabel,
  onPress,
  items,
  width,
}: {
  title: string;
  actionLabel: string;
  onPress: () => void;
  items: UnlockCard[];
  width: number;
}) {
  return (
    <Panel>
      <SectionHeader title={title} actionLabel={actionLabel} onPress={onPress} compact />
      <FlashList
        data={items}
        drawDistance={HOME_RAIL_DRAW_DISTANCE}
        horizontal
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={{ marginRight: 10 }}>
            <UnlockPreviewCard item={item} width={width} />
          </View>
        )}
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        disableIntervalMomentum
        snapToAlignment="start"
        snapToInterval={width + 10}
        style={{ height: 146 }}
      />
    </Panel>
  );
}

function UnlockPreviewCard({ item, width }: { item: UnlockCard; width: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => {
        if (item.isPreview) {
          router.push('/(tabs)/marketplace' as never);
          return;
        }
        const postQuery = item.postId ? `?postId=${encodeURIComponent(item.postId)}` : '';
        router.push(`/marketplace/${encodeURIComponent(item.id)}${postQuery}` as never);
      }}
      style={({ pressed }) => ({
        width,
        minHeight: 144,
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.11)',
        backgroundColor: '#0d0e16',
        overflow: 'hidden',
        opacity: pressed ? 0.86 : 1,
      })}
    >
      {item.mediaUrl ? (
        <FeedMediaFrame kind="image" url={item.mediaUrl} recyclingKey={`home-unlock:${item.id}`} radius={18} style={{ position: 'absolute', inset: 0 }} />
      ) : (
        <LinearGradient colors={['rgba(16,185,129,0.22)', 'rgba(124,58,237,0.12)', 'rgba(8,9,18,1)']} style={{ position: 'absolute', inset: 0 }} />
      )}
      <LinearGradient colors={['rgba(0,0,0,0.08)', 'rgba(0,0,0,0.86)']} style={{ position: 'absolute', inset: 0 }} />
      <View style={{ minHeight: 144, padding: 12, justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <View style={{ borderRadius: 999, backgroundColor: 'rgba(16,185,129,0.2)', borderWidth: 1, borderColor: 'rgba(52,211,153,0.32)', paddingHorizontal: 8, paddingVertical: 5 }}>
            <Text numberOfLines={1} style={{ color: '#bbf7d0', fontSize: 11, fontWeight: '900' }}>{item.accessLabel}</Text>
          </View>
          <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>{item.priceLabel}</Text>
        </View>
        <View style={{ gap: 6 }}>
          <Text numberOfLines={2} style={{ color: '#fff', fontSize: 15, lineHeight: 18, fontWeight: '900' }}>{item.title}</Text>
          <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.66)', fontSize: 12, lineHeight: 17, fontWeight: '600' }}>{item.body}</Text>
        </View>
      </View>
    </Pressable>
  );
}

function SectionHeader({
  title,
  actionLabel,
  onPress,
  compact = false,
}: {
  title: string;
  actionLabel: string;
  onPress: () => void;
  compact?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.84} style={{ color: appTheme.colors.text, flex: 1, fontSize: compact ? 16 : 18, fontWeight: '900' }}>
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${actionLabel} ${title}`}
        hitSlop={10}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: 30,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ color: '#c084fc', fontSize: compact ? 12 : 13, fontWeight: '900' }}>{actionLabel}</Text>
        <ChevronRight size={compact ? 15 : 16} color="#c084fc" />
      </Pressable>
    </View>
  );
}

function Panel({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  return (
    <View
      style={{
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(15,16,24,0.72)',
        overflow: 'hidden',
        padding: padded ? 12 : 0,
        gap: padded ? 11 : 0,
      }}
    >
      {children}
    </View>
  );
}

function MiniStat({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <View style={{ minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.07)', paddingHorizontal: 8 }}>
      {icon}
      <Text numberOfLines={1} style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{label}</Text>
    </View>
  );
}

function toolColors(accent: HomeToolShortcut['accent']) {
  if (accent === 'image') {
    return {
      background: ['#123a8f', '#07152e'] as const,
      icon: 'rgba(96,165,250,0.32)',
      border: 'rgba(96,165,250,0.42)',
      glow: 'rgba(37,99,235,0.28)',
    };
  }
  if (accent === 'video') {
    return {
      background: ['#9f234c', '#2b0b19'] as const,
      icon: 'rgba(251,113,133,0.34)',
      border: 'rgba(251,113,133,0.42)',
      glow: 'rgba(244,63,94,0.26)',
    };
  }
  if (accent === 'motion') {
    return {
      background: ['#5b21b6', '#17072f'] as const,
      icon: 'rgba(192,132,252,0.34)',
      border: 'rgba(192,132,252,0.42)',
      glow: 'rgba(124,58,237,0.3)',
    };
  }
  return {
    background: ['#08725f', '#06231f'] as const,
    icon: 'rgba(52,211,153,0.3)',
    border: 'rgba(52,211,153,0.42)',
    glow: 'rgba(16,185,129,0.26)',
  };
}

function resourceToUnlockCard(item: MarketplaceResource): UnlockCard {
  const accessLabel = item.resourceKinds?.[0] ? item.resourceKinds[0] : item.accessMode === 'free' ? 'Free unlock' : 'Unlock';
  return {
    id: item.id,
    postId: item.postId,
    title: item.title,
    body: item.summary ?? item.description ?? item.previewText ?? 'Reusable creator resource.',
    priceLabel: item.accessMode === 'free' ? 'Free' : item.priceQuote?.formatted ?? formatUsdCents(item.priceUsdCents ?? 0),
    accessLabel,
    mediaUrl: item.mediaUrl ?? item.post?.mediaUrl ?? null,
    isPreview: false,
  };
}
