import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { FlashList } from '@shopify/flash-list';
import { useIsFocused } from '@react-navigation/native';
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
  Menu,
  MoreHorizontal,
  Play,
  Plus,
  Rocket,
  Share2,
  Sparkles,
  WandSparkles,
} from 'lucide-react-native';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { HomeSideMenu } from '@/components/home-side-menu';
import { OnboardingResumeCard } from '@/components/onboarding-resume-card';
import { TextPreviewCard } from '@/components/text-preview-card';
import { AppText, SecondaryButton, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  HOME_UNLOCKS_FEED_HREF,
  HOME_TOOL_SHORTCUTS,
  formatUsdCents,
  generationsToHomeCards,
  getOwnerPostSalesSummary,
  showcaseToCommunityCard,
  type HomeCommunityCard,
  type HomeGenerationCard,
  type HomeToolShortcut,
} from '@/lib/home-view-model';
import { isShowcaseGridReady } from '@/lib/showcase-feed-view-model';
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
import { useReducedMotion } from '@/lib/motion';
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
}

const DASHBOARD_COLORS = {
  background: appTheme.colors.background,
  surface: appTheme.colors.panel,
  surfaceRaised: appTheme.colors.panelSoft,
  border: appTheme.colors.borderSubtle,
  borderStrong: appTheme.colors.border,
  text: appTheme.colors.text,
  muted: appTheme.colors.muted,
  faint: appTheme.colors.faint,
  coral: appTheme.colors.primary,
  coralSoft: appTheme.colors.pressed,
} as const;

const TOOL_PREVIEW_IMAGES = {
  kingdom: require('../assets/images/home-previews/image.png'),
  city: require('../assets/images/home-previews/video.png'),
  runner: require('../assets/images/home-previews/motion.png'),
} as const;

export function HomeDashboard() {
  const { user, api, credits, signOut } = useAuth();
  const isFocused = useIsFocused();
  const [menuVisible, setMenuVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const pageWidth = Math.min(width, 430);
  const isCompact = pageWidth < 390;
  const reduceMotion = useReducedMotion();
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
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.getProfile(),
    staleTime: 1000 * 60 * 5,
  });

  const sellerPostsQuery = useQuery({
    queryKey: ['owner-posts-sales-summary', user?.id],
    enabled: Boolean(user && menuVisible),
    queryFn: () => api.listOwnerPosts({ includeArchived: true, includeSummary: true, limit: 1, visibility: 'all' }),
    staleTime: 1000 * 60 * 2,
  });

  useEffect(() => {
    if (!isFocused || !user) return;
    void generationsQuery.refetch?.();
    if (menuVisible) void sellerPostsQuery.refetch?.();
  }, [isFocused, menuVisible, user?.id]);

  const showcaseQuery = useInfiniteQuery({
    queryKey: createShowcaseFeedQueryKey({ sort: 'recent' }, user?.id),
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
    return flattenShowcaseFeedPages(showcaseQuery.data?.pages)
      .filter(isShowcaseGridReady)
      .slice(0, 4)
      .map(showcaseToCommunityCard);
  }, [showcaseQuery.data]);

  const unlockCards = useMemo(
    () => (marketplaceQuery.data?.items ?? []).slice(0, 4).map(resourceToUnlockCard),
    [marketplaceQuery.data]
  );

  const salesSummary = useMemo(
    () => sellerPostsQuery.data?.summary ?? getOwnerPostSalesSummary(sellerPostsQuery.data?.posts),
    [sellerPostsQuery.data]
  );

  const displayName =
    profileQuery.data?.displayName?.trim() ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'Creator';

  return (
    <View style={{ flex: 1, backgroundColor: DASHBOARD_COLORS.background, paddingTop: topInset }}>
      <ScrollView
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        contentContainerStyle={{
          paddingTop: 10,
          paddingHorizontal: horizontalPadding,
          paddingBottom: tabBarMetrics.contentBottomOverlapPadding + 24,
          gap: 24,
        }}
      >
        <HomeTopBar credits={credits ?? 0} onMenuPress={() => setMenuVisible(true)} />

        <WelcomePanel
          displayName={displayName}
          signedIn={Boolean(user)}
          activeGenerationCount={activeGenerationCount}
          reduceMotion={reduceMotion}
        />

        <OnboardingResumeCard />

        <View style={{ gap: 12 }}>
          <SectionHeader title="Start with a format" actionLabel="All tools" onPress={() => router.push('/(tabs)/creator' as never)} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: toolGap }}>
            {HOME_TOOL_SHORTCUTS.map((tool) => (
              <ToolShortcutCard key={tool.id} tool={tool} width={toolCardWidth} reduceMotion={reduceMotion} />
            ))}
          </View>
        </View>

        {hasRecentStudio ? (
          <View style={{ gap: 12 }}>
            <SectionHeader title="Recent work" actionLabel="View all" onPress={() => router.push('/(tabs)/profile' as never)} compact />
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
          </View>
        ) : user && generationsQuery.isError ? (
          <RailFeedback
            title="Recent work is unavailable"
            body="Your creations are safe. Check your connection and try again."
            onRetry={() => void generationsQuery.refetch()}
          />
        ) : null}

        <View style={{ gap: 24 }}>
          {showcaseQuery.isLoading && communityCards.length === 0 ? (
            <RailLoading title="Loading showcase" />
          ) : showcaseQuery.isError && communityCards.length === 0 ? (
            <RailFeedback
              title="Showcase is unavailable"
              body="We could not load community work right now."
              onRetry={() => void showcaseQuery.refetch()}
            />
          ) : communityCards.length === 0 ? (
            <RailEmpty
              title="No showcase posts yet"
              body="New community work will appear here when it is published."
              actionLabel="Open showcase"
              onPress={() => router.push('/(tabs)/showcase' as never)}
            />
          ) : (
            <PreviewRail
              title="Showcase"
              actionLabel="Browse"
              onPress={() => router.push('/(tabs)/showcase' as never)}
              items={communityCards}
              width={previewCardWidth}
            />
          )}
          {marketplaceQuery.isLoading && unlockCards.length === 0 ? (
            <RailLoading title="Loading unlocks" />
          ) : marketplaceQuery.isError && unlockCards.length === 0 ? (
            <RailFeedback
              title="Unlocks are unavailable"
              body="We could not load creator resources right now."
              onRetry={() => void marketplaceQuery.refetch()}
            />
          ) : unlockCards.length === 0 ? (
            <RailEmpty
              title="No unlocks yet"
              body="Reusable creator resources will appear here as they are published."
              actionLabel="Browse resources"
              onPress={() => router.push(HOME_UNLOCKS_FEED_HREF as never)}
            />
          ) : (
            <UnlockRail
              title="Unlocks"
              actionLabel="Open"
              onPress={() => router.push(HOME_UNLOCKS_FEED_HREF as never)}
              items={unlockCards}
              width={previewCardWidth}
            />
          )}
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
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        onPress={onMenuPress}
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 24,
          borderWidth: 1,
          borderColor: DASHBOARD_COLORS.border,
          backgroundColor: DASHBOARD_COLORS.surface,
          opacity: pressed ? 0.72 : 1,
        })}
      >
        <Menu size={22} color={DASHBOARD_COLORS.text} strokeWidth={2.2} />
      </Pressable>

      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minWidth: 0 }}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: DASHBOARD_COLORS.coral }} />
        <Text numberOfLines={1} style={{ color: DASHBOARD_COLORS.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2, flexShrink: 1 }}>
          Magicbooklet
        </Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open credits"
          onPress={() => router.push('/pricing' as never)}
          style={({ pressed }) => ({
            minWidth: 68,
            height: 48,
            borderRadius: 24,
            borderWidth: 1,
            borderColor: DASHBOARD_COLORS.border,
            backgroundColor: DASHBOARD_COLORS.surface,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 10,
            opacity: pressed ? 0.78 : 1,
          })}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Crown size={15} color="#fbbf24" fill="rgba(251,191,36,0.2)" />
            <Text style={{ color: DASHBOARD_COLORS.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{credits}</Text>
            <Plus size={14} color={DASHBOARD_COLORS.coral} strokeWidth={2.5} />
          </View>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open notifications"
          onPress={() => router.push('/studio' as never)}
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            borderRadius: 24,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: DASHBOARD_COLORS.border,
            backgroundColor: DASHBOARD_COLORS.surface,
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <Bell size={21} color={DASHBOARD_COLORS.text} strokeWidth={2.1} />
        </Pressable>
      </View>
    </View>
  );
}

function WelcomePanel({
  displayName,
  signedIn,
  activeGenerationCount,
  reduceMotion,
}: {
  displayName: string;
  signedIn: boolean;
  activeGenerationCount: number;
  reduceMotion: boolean;
}) {
  const title = signedIn ? `Ready when you are, ${displayName}` : 'Create something worth sharing';
  const body = signedIn
    ? 'Choose a format and turn the next idea into a polished post.'
    : 'Choose a format, make a first draft, then sign in to save it.';

  return (
    <View
      style={{
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: DASHBOARD_COLORS.borderStrong,
        backgroundColor: DASHBOARD_COLORS.surfaceRaised,
        padding: 18,
        gap: 16,
      }}
    >
        <View style={{ gap: 7 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: activeGenerationCount > 0 ? '#34d399' : DASHBOARD_COLORS.coral }} />
            <Text style={{ color: DASHBOARD_COLORS.muted, fontSize: 12, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' }}>
              {activeGenerationCount > 0 ? `${activeGenerationCount} render${activeGenerationCount === 1 ? '' : 's'} in progress` : 'Creator workspace'}
            </Text>
          </View>
          <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.82} style={{ color: DASHBOARD_COLORS.text, fontSize: 25, lineHeight: 30, fontWeight: '800', letterSpacing: -0.5 }}>
            {title}
          </Text>
          <Text style={{ color: DASHBOARD_COLORS.muted, fontSize: 14, lineHeight: 20, fontWeight: '600' }}>
            {body}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create new project"
          accessibilityHint="Opens the creator tools"
          onPress={() => router.push('/(tabs)/creator' as never)}
          style={({ pressed }) => ({
            minHeight: 52,
            borderRadius: 18,
            backgroundColor: DASHBOARD_COLORS.coral,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 9,
            opacity: pressed ? 0.84 : 1,
            transform: reduceMotion ? undefined : [{ scale: pressed ? 0.985 : 1 }],
          })}
        >
          <WandSparkles size={19} color={appTheme.colors.onPrimary} strokeWidth={2.5} />
          <Text style={{ color: appTheme.colors.onPrimary, fontSize: 15, fontWeight: '800' }}>Create new</Text>
        </Pressable>
    </View>
  );
}

function ToolShortcutCard({ tool, width, reduceMotion }: { tool: HomeToolShortcut; width: number; reduceMotion: boolean }) {
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
        opacity: disabled ? 0.58 : pressed ? 0.82 : 1,
        transform: reduceMotion ? undefined : [{ scale: pressed && !disabled ? 0.99 : 1 }],
      })}
    >
      <View
        style={{
          minHeight: 158,
          borderRadius: 20,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: DASHBOARD_COLORS.border,
          backgroundColor: DASHBOARD_COLORS.surface,
          padding: tool.previewVariant ? 0 : 14,
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colors.accent }} />
        {tool.previewVariant ? (
          <ToolPreview variant={tool.previewVariant} icon={<Icon size={18} color="#ffffff" fill={tool.id === 'video' ? 'transparent' : 'rgba(255,255,255,0.14)'} />} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ width: 38, height: 38, borderRadius: 13, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon size={20} color={colors.accent} fill={tool.id === 'video' ? 'transparent' : colors.fill} />
            </View>
            {tool.badge ? (
              <View style={{ borderRadius: 999, borderWidth: 1, borderColor: DASHBOARD_COLORS.border, backgroundColor: DASHBOARD_COLORS.surfaceRaised, paddingHorizontal: 8, paddingVertical: 5 }}>
                <Text style={{ color: DASHBOARD_COLORS.muted, fontSize: 10, fontWeight: '800', textTransform: 'uppercase' }}>{tool.badge}</Text>
              </View>
            ) : (
              <ChevronRight size={20} color={DASHBOARD_COLORS.muted} />
            )}
          </View>
        )}
        <View style={{ gap: 5, paddingHorizontal: tool.previewVariant ? 12 : 0, paddingBottom: tool.previewVariant ? 11 : 0, paddingTop: tool.previewVariant ? 10 : 0 }}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: appTheme.colors.text, fontSize: tool.previewVariant ? 16 : 17, fontWeight: '800' }}>
            {tool.title}
          </Text>
          <Text numberOfLines={2} style={{ color: DASHBOARD_COLORS.muted, fontSize: 12, lineHeight: 17, fontWeight: '600' }}>
            {tool.body}
          </Text>
        </View>
      </View>
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
    <View style={{ height: 82, overflow: 'hidden', backgroundColor: DASHBOARD_COLORS.surfaceRaised }}>
      <Image source={TOOL_PREVIEW_IMAGES[variant]} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
      <LinearGradient
        colors={['rgba(0,0,0,0.04)', 'rgba(0,0,0,0.48)']}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View style={{ position: 'absolute', left: 9, top: 9, width: 30, height: 30, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.38)', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
    </View>
  );
}

function RecentCreationCard({ item, width }: { item: HomeGenerationCard; width: number }) {
  const Icon = item.kind === 'image' ? ImageIcon : item.kind === 'video' ? Play : item.kind === 'text' ? FileText : Rocket;
  const isText = item.kind === 'text';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => {
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
        backgroundColor: DASHBOARD_COLORS.surface,
        opacity: pressed ? 0.86 : 1,
      })}
    >
      {isText ? (
        <TextPreviewCard text={item.previewText} accent={accentColor('amber')} height={160} radius={18} lines={4} />
      ) : item.mediaUrl && item.kind === 'image' ? (
        <FeedMediaFrame
          kind="image"
          url={item.previewUrl ?? item.mediaUrl}
          cacheKey={item.previewCacheKey}
          thumbhash={item.previewThumbhash}
          recyclingKey={`home-generation:${item.id}`}
          radius={18}
          style={{ position: 'absolute', inset: 0 }}
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: DASHBOARD_COLORS.surfaceRaised }}>
          <Icon size={28} color={toolColors(item.kind === 'text' ? 'workflow' : item.kind).accent} strokeWidth={1.8} />
        </View>
      )}
      <LinearGradient colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.82)']} style={{ position: 'absolute', inset: 0 }} />
      <View style={{ position: 'absolute', left: 10, top: 10, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.38)', padding: 7 }}>
        <Icon size={18} color="#ffffff" />
      </View>
      <View style={{ position: 'absolute', left: 12, right: 12, bottom: 11, gap: 5 }}>
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>{item.title}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.68)', fontSize: 12, fontWeight: '700' }}>{item.label} • {item.timeLabel}</Text>
          <MoreHorizontal size={19} color="#ffffff" />
        </View>
      </View>
    </Pressable>
  );
}

function RailLoading({ title }: { title: string }) {
  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <AppText heading variant="cardTitle">{title}</AppText>
      <View
        accessible
        accessibilityLabel={title}
        accessibilityLiveRegion="polite"
        style={{
          minHeight: 96,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: appTheme.spacing.gap,
          borderRadius: appTheme.radii.lg,
          borderWidth: 1,
          borderColor: appTheme.colors.borderSubtle,
          backgroundColor: appTheme.colors.panel,
        }}
      >
        <ActivityIndicator color={appTheme.colors.primary} />
        <AppText variant="bodySm" color="muted">Fetching the latest items…</AppText>
      </View>
    </View>
  );
}

function RailFeedback({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry: () => void;
}) {
  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <StatusBlock tone="danger" title={title} body={body} />
      <SecondaryButton label="Try again" onPress={onRetry} />
    </View>
  );
}

function RailEmpty({
  title,
  body,
  actionLabel,
  onPress,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onPress: () => void;
}) {
  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <StatusBlock title={title} body={body} />
      <SecondaryButton label={actionLabel} onPress={onPress} />
    </View>
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
    <View style={{ gap: 12 }}>
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
    </View>
  );
}

function CommunityPreviewCard({ item, width }: { item: HomeCommunityCard; width: number }) {
  const isFallbackPreview = item.sourceId.startsWith('preview-');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => {
        router.push(immersiveViewerHref({ source: item.viewerSource, initialId: item.sourceId }) as never);
      }}
      style={({ pressed }) => ({
        width,
        height: 202,
        overflow: 'hidden',
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: DASHBOARD_COLORS.border,
        backgroundColor: DASHBOARD_COLORS.surface,
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
            cacheKey={item.previewCacheKey}
            thumbhash={item.previewThumbhash}
            imageBackdrop="none"
            imageContentFit="cover"
            recyclingKey={`home-community:${item.id}`}
            style={{ position: 'absolute', inset: 0 }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: DASHBOARD_COLORS.surfaceRaised }}>
            <ImageIcon size={28} color={appTheme.colors.image} strokeWidth={1.8} />
          </View>
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
          <Text numberOfLines={1} style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{item.accessLabel}</Text>
        </View>
      </View>
      <View style={{ flex: 1, paddingHorizontal: 10, paddingTop: 9, paddingBottom: 9, justifyContent: 'space-between', gap: 5 }}>
        <View style={{ gap: 4 }}>
          <Text numberOfLines={1} style={{ color: DASHBOARD_COLORS.text, fontSize: 14, lineHeight: 17, fontWeight: '800' }}>{item.title}</Text>
          <Text numberOfLines={1} style={{ color: DASHBOARD_COLORS.muted, fontSize: 12, lineHeight: 14, fontWeight: '700' }}>{item.creatorHandle}</Text>
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
    <View style={{ gap: 12 }}>
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
    </View>
  );
}

function UnlockPreviewCard({ item, width }: { item: UnlockCard; width: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => {
        const postQuery = item.postId ? `?postId=${encodeURIComponent(item.postId)}` : '';
        router.push(`/marketplace/${encodeURIComponent(item.id)}${postQuery}` as never);
      }}
      style={({ pressed }) => ({
        width,
        minHeight: 144,
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: DASHBOARD_COLORS.border,
        backgroundColor: DASHBOARD_COLORS.surface,
        overflow: 'hidden',
        opacity: pressed ? 0.86 : 1,
      })}
    >
      {item.mediaUrl ? (
        <FeedMediaFrame kind="image" url={item.mediaUrl} recyclingKey={`home-unlock:${item.id}`} radius={18} style={{ position: 'absolute', inset: 0 }} />
      ) : (
        <View style={{ position: 'absolute', inset: 0, backgroundColor: DASHBOARD_COLORS.surfaceRaised }} />
      )}
      {item.mediaUrl ? <LinearGradient colors={['rgba(0,0,0,0.08)', 'rgba(0,0,0,0.86)']} style={{ position: 'absolute', inset: 0 }} /> : null}
      <View style={{ minHeight: 144, padding: 12, justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <View style={{ borderRadius: 999, backgroundColor: DASHBOARD_COLORS.coralSoft, borderWidth: 1, borderColor: appTheme.colors.primaryStrong, paddingHorizontal: 8, paddingVertical: 5 }}>
            <Text numberOfLines={1} style={{ color: appTheme.colors.primaryStrong, fontSize: 11, fontWeight: '800' }}>{item.accessLabel}</Text>
          </View>
          <Text numberOfLines={1} style={{ color: DASHBOARD_COLORS.text, fontSize: 12, fontWeight: '800' }}>{item.priceLabel}</Text>
        </View>
        <View style={{ gap: 6 }}>
          <Text numberOfLines={2} style={{ color: DASHBOARD_COLORS.text, fontSize: 15, lineHeight: 18, fontWeight: '800' }}>{item.title}</Text>
          <Text numberOfLines={2} style={{ color: DASHBOARD_COLORS.muted, fontSize: 12, lineHeight: 17, fontWeight: '600' }}>{item.body}</Text>
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
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.84} style={{ color: appTheme.colors.text, flex: 1, fontSize: compact ? 16 : 18, fontWeight: '800' }}>
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${actionLabel} ${title}`}
        hitSlop={10}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: 48,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ color: DASHBOARD_COLORS.coral, fontSize: compact ? 12 : 13, fontWeight: '800' }}>{actionLabel}</Text>
        <ChevronRight size={compact ? 15 : 16} color={DASHBOARD_COLORS.coral} />
      </Pressable>
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
      accent: appTheme.colors.image,
      soft: 'rgba(56,189,248,0.13)',
      fill: 'rgba(56,189,248,0.16)',
    };
  }
  if (accent === 'video') {
    return {
      accent: appTheme.colors.video,
      soft: 'rgba(251,113,133,0.13)',
      fill: 'rgba(251,113,133,0.16)',
    };
  }
  if (accent === 'motion') {
    return {
      accent: appTheme.colors.motion,
      soft: 'rgba(167,139,250,0.13)',
      fill: 'rgba(167,139,250,0.16)',
    };
  }
  return {
    accent: appTheme.colors.workflow,
    soft: 'rgba(52,211,153,0.13)',
    fill: 'rgba(52,211,153,0.16)',
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
  };
}
