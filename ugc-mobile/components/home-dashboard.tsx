import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Link, router } from 'expo-router';
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
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FantasyPortalArt } from '@/components/fantasy-portal-art';
import { HomeSideMenu } from '@/components/home-side-menu';
import { TextPreviewCard } from '@/components/text-preview-card';
import { useAuth } from '@/lib/auth';
import {
  FALLBACK_COMMUNITY,
  FALLBACK_GENERATIONS,
  HOME_TOOL_SHORTCUTS,
  generationToHomeCard,
  getOwnerPostSalesSummary,
  showcaseToCommunityCard,
  type HomeCommunityCard,
  type HomeGenerationCard,
  type HomeToolShortcut,
} from '@/lib/home-view-model';
import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';
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

const FEED_TABS = [
  { label: 'For You', sort: 'recent' },
  { label: 'Following', sort: 'top-remixes' },
  { label: 'Trending', sort: 'top-saves' },
] as const;

export function HomeDashboard() {
  const { user, api, credits, signOut } = useAuth();
  const [feedTab, setFeedTab] = useState<(typeof FEED_TABS)[number]>(FEED_TABS[0]);
  const [menuVisible, setMenuVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const pageWidth = Math.min(width, 430);
  const isCompact = pageWidth < 410;
  const horizontalPadding = isCompact ? 16 : 18;
  const heroHeight = Math.max(260, Math.min(304, pageWidth * 0.7));
  const recentCardWidth = Math.max(214, Math.min(250, pageWidth * 0.64));
  const toolCardWidth = Math.max(154, Math.min(182, pageWidth * 0.43));

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
    queryKey: createShowcaseFeedQueryKey({ sort: feedTab.sort }),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.getShowcaseFeed(getShowcaseFeedPageParams({ offset: pageParam, sort: feedTab.sort })),
    getNextPageParam: getNextShowcaseFeedOffset,
    staleTime: SHOWCASE_FEED_STALE_TIME_MS,
  });

  const generationCards = useMemo(() => {
    const items = (generationsQuery.data?.generations ?? []).slice(0, 6).map(generationToHomeCard);
    return items.length > 0 ? items : FALLBACK_GENERATIONS;
  }, [generationsQuery.data]);

  const communityCards = useMemo(() => {
    const items = flattenShowcaseFeedPages(showcaseQuery.data?.pages).slice(0, 4).map(showcaseToCommunityCard);
    return items.length > 0 ? items : FALLBACK_COMMUNITY;
  }, [showcaseQuery.data]);

  const salesSummary = useMemo(
    () => getOwnerPostSalesSummary(sellerPostsQuery.data?.posts),
    [sellerPostsQuery.data]
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#03040d', paddingTop: topInset }}>
      <ScrollView
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: '#03040d' }}
        contentContainerStyle={{
          paddingTop: 18,
          paddingHorizontal: horizontalPadding,
          paddingBottom: tabBarMetrics.contentBottomPadding,
          gap: 28,
        }}
      >
        <HomeTopBar credits={credits ?? 0} onMenuPress={() => setMenuVisible(true)} />

        <HeroCard height={heroHeight} />

        <SectionHeader title="Create Something" actionLabel="See All" onPress={() => router.push('/(tabs)/creator' as never)} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingRight: horizontalPadding }}>
          {HOME_TOOL_SHORTCUTS.map((tool) => (
            <ToolShortcutCard key={tool.id} tool={tool} width={toolCardWidth} />
          ))}
        </ScrollView>

        <SectionHeader title="Recent Creations" actionLabel="View Profile" onPress={() => router.push('/(tabs)/profile' as never)} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingRight: horizontalPadding }}>
          {generationCards.map((item) => (
            <RecentCreationCard key={item.id} item={item} width={recentCardWidth} />
          ))}
        </ScrollView>

        <View style={{ gap: 14 }}>
          <View style={{ gap: 16 }}>
            <View style={{ flexDirection: isCompact ? 'column' : 'row', alignItems: isCompact ? 'stretch' : 'center', justifyContent: 'space-between', gap: 12 }}>
              <Text style={{ color: appTheme.colors.text, fontSize: isCompact ? 23 : 24, fontWeight: '900' }}>Community Feed</Text>
              <FeedSegment value={feedTab.label} onChange={(label) => {
                const next = FEED_TABS.find((tab) => tab.label === label) ?? FEED_TABS[0];
                setFeedTab(next);
              }} />
            </View>
          </View>
          <View style={{ gap: 16 }}>
            {communityCards.map((item) => (
              <CommunityPostCard key={item.id} item={item} />
            ))}
          </View>
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
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open menu"
        onPress={onMenuPress}
        style={({ pressed }) => ({
          width: 34,
          height: 42,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.72 : 1,
        })}
      >
        <Menu size={28} color="#ffffff" strokeWidth={2.2} />
      </Pressable>

      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 0 }}>
        <Sparkles size={24} color="#d946ef" fill="rgba(217,70,239,0.22)" />
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 20, fontWeight: '900', letterSpacing: 0, flexShrink: 1 }}>Magic Booklet</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open credits"
          onPress={() => router.push('/pricing' as never)}
          style={({ pressed }) => ({
            minWidth: 82,
            height: 42,
            borderRadius: 22,
            overflow: 'hidden',
            opacity: pressed ? 0.78 : 1,
          })}
        >
          <LinearGradient
            colors={['rgba(255,255,255,0.12)', 'rgba(124,58,237,0.22)']}
            style={{ flex: 1, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', borderRadius: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Crown size={16} color="#fbbf24" fill="rgba(251,191,36,0.32)" />
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{credits}</Text>
              <Plus size={16} color="#d946ef" strokeWidth={2.4} />
            </View>
          </LinearGradient>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open notifications"
          onPress={() => router.push('/studio' as never)}
          style={({ pressed }) => ({
            width: 34,
            height: 42,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <Bell size={25} color="#ffffff" strokeWidth={2.1} />
          <View style={{ position: 'absolute', right: 2, top: 1, width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#7c3cff' }}>
            <Plus size={12} color="#ffffff" strokeWidth={2.6} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function HeroCard({ height }: { height: number }) {
  return (
    <View
      style={{
        height,
        overflow: 'hidden',
        borderRadius: 28,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(168,85,247,0.28)',
        backgroundColor: '#080817',
        boxShadow: '0 26px 70px rgba(0,0,0,0.5)',
      }}
    >
      <FantasyPortalArt variant="portal" />
      <LinearGradient
        colors={['rgba(5,5,16,0.95)', 'rgba(5,5,16,0.62)', 'rgba(5,5,16,0.08)']}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View style={{ position: 'absolute', left: 20, top: 20, bottom: 28, width: '54%', justifyContent: 'center', gap: 10 }}>
        <Text style={{ color: 'rgba(255,255,255,0.78)', fontSize: 17, lineHeight: 22, fontWeight: '500' }}>Turn your ideas into</Text>
        <Text style={{ color: '#ffffff', fontSize: 31, lineHeight: 34, fontWeight: '900' }}>
          <Text style={{ color: '#f03bd0' }}>stunning{'\n'}</Text>
          creations
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.78)', fontSize: 14, lineHeight: 20 }}>Image, video or motion transfer - the magic is in your hands.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create now"
          onPress={() => router.push('/(tabs)/creator' as never)}
          style={({ pressed }) => ({
            width: 164,
            minHeight: 50,
            borderRadius: 16,
            overflow: 'hidden',
            opacity: pressed ? 0.82 : 1,
            transform: [{ scale: pressed ? 0.98 : 1 }],
          })}
        >
          <LinearGradient
            colors={['#ed34ca', '#7838ff']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }}
          >
            <WandSparkles size={22} color="#ffffff" fill="rgba(255,255,255,0.16)" />
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '900' }}>Create Now</Text>
          </LinearGradient>
        </Pressable>
      </View>
      <View style={{ position: 'absolute', bottom: 16, alignSelf: 'center', flexDirection: 'row', gap: 7 }}>
        {[0, 1, 2, 3].map((dot) => (
          <View key={dot} style={{ width: dot === 0 ? 24 : 20, height: 6, borderRadius: 999, backgroundColor: dot === 0 ? '#d946ef' : 'rgba(255,255,255,0.28)' }} />
        ))}
      </View>
    </View>
  );
}

function SectionHeader({
  title,
  actionLabel,
  onPress,
}: {
  title: string;
  actionLabel: string;
  onPress: () => void;
}) {
  const { width } = useWindowDimensions();
  const isCompact = Math.min(width, 430) < 390;

  return (
    <View style={{ marginBottom: -12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.84} style={{ color: appTheme.colors.text, flex: 1, fontSize: isCompact ? 22 : 24, fontWeight: '900' }}>{title}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${actionLabel} ${title}`}
        hitSlop={10}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: 36,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ color: '#a855f7', fontSize: isCompact ? 15 : 16, fontWeight: '800' }}>{actionLabel}</Text>
        <ChevronRight size={isCompact ? 19 : 20} color="#a855f7" />
      </Pressable>
    </View>
  );
}

function ToolShortcutCard({ tool, width }: { tool: HomeToolShortcut; width: number }) {
  const Icon = tool.id === 'image' ? ImageIcon : tool.id === 'video' ? Play : Rocket;
  const accent = tool.id === 'image' ? '#8b35ff' : tool.id === 'video' ? '#2563eb' : '#0f9f8e';

  return (
    <Link href={`/create/${tool.id}` as never} asChild>
      <Pressable style={({ pressed }) => ({ width, opacity: pressed ? 0.82 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}>
        <LinearGradient
          colors={tool.id === 'image' ? ['#1b0838', '#10051e'] : tool.id === 'video' ? ['#061d4d', '#041022'] : ['#073b36', '#06191b']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{
            minHeight: 156,
            borderRadius: 19,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: `${accentColor(tool.accent)}66`,
            padding: 18,
            justifyContent: 'space-between',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: accent, alignItems: 'center', justifyContent: 'center' }}>
              <Icon size={31} color="#ffffff" fill={tool.id === 'video' ? 'transparent' : 'rgba(255,255,255,0.18)'} />
            </View>
            <ChevronRight size={26} color="#ffffff" />
          </View>
          <View style={{ gap: 8 }}>
            <Text style={{ color: appTheme.colors.text, fontSize: 20, fontWeight: '900' }}>{tool.title}</Text>
            <Text style={{ color: 'rgba(255,255,255,0.76)', fontSize: 15, lineHeight: 21 }}>{tool.body}</Text>
          </View>
        </LinearGradient>
      </Pressable>
    </Link>
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
          router.push('/(tabs)/profile' as never);
          return;
        }
        router.push(immersiveViewerHref({ source: item.viewerSource, initialId: item.sourceId }) as never);
      }}
      style={({ pressed }) => ({
        width,
        height: 194,
        overflow: 'hidden',
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: '#090914',
        opacity: pressed ? 0.86 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      {isText ? (
        <TextPreviewCard text={item.previewText} accent={accentColor('amber')} height={194} radius={18} lines={4} />
      ) : item.mediaUrl && item.kind === 'image' ? (
        <Image source={{ uri: item.mediaUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
      ) : (
        <FantasyPortalArt variant={item.artVariant} muted />
      )}
      <LinearGradient colors={['rgba(0,0,0,0.04)', 'rgba(0,0,0,0.78)']} style={{ position: 'absolute', inset: 0 }} />
      <View style={{ position: 'absolute', left: 13, top: 13, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.38)', padding: 7 }}>
        <Icon size={21} color="#ffffff" />
      </View>
      <View style={{ position: 'absolute', left: 14, right: 14, bottom: 12, gap: 7 }}>
        <View style={{ alignSelf: 'flex-start', borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.42)', paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>{item.label}</Text>
        </View>
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 17, fontWeight: '900' }}>{item.title}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>{item.timeLabel}</Text>
          <MoreHorizontal size={24} color="#ffffff" />
        </View>
      </View>
    </Pressable>
  );
}

function FeedSegment({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.06)', padding: 3 }}>
      {FEED_TABS.map((tab) => {
        const active = tab.label === value;
        return (
          <Pressable
            key={tab.label}
            onPress={() => onChange(tab.label)}
            style={({ pressed }) => ({
              minHeight: 38,
              flex: 1,
              minWidth: 0,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 20,
              backgroundColor: active ? 'rgba(124,58,237,0.72)' : 'transparent',
              opacity: pressed ? 0.76 : 1,
              paddingHorizontal: 12,
            })}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: active ? '#fff' : appTheme.colors.muted, fontWeight: active ? '800' : '600', fontSize: 14 }}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CommunityPostCard({ item }: { item: HomeCommunityCard }) {
  const { width } = useWindowDimensions();
  const isCompact = Math.min(width, 430) < 390;
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
      style={({ pressed }) => ({ opacity: pressed ? 0.86 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] })}
    >
        <View
          style={{
            overflow: 'hidden',
            borderRadius: 24,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.12)',
            backgroundColor: '#080916',
          }}
        >
          <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <LinearGradient colors={['#f03bd0', '#6738ff']} style={{ width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' }}>
                <Sparkles size={24} color="#fff" />
              </LinearGradient>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text numberOfLines={1} style={{ color: '#fff', fontSize: 17, fontWeight: '900', flexShrink: 1 }}>{item.creatorName}</Text>
                  <View style={{ width: 17, height: 17, borderRadius: 8.5, backgroundColor: '#7c3cff', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: '900' }}>✓</Text>
                  </View>
                </View>
                <Text style={{ color: appTheme.colors.muted, fontSize: 13 }}>{item.timeLabel}</Text>
              </View>
            </View>
            <Pressable style={{ borderRadius: 16, overflow: 'hidden' }}>
              <LinearGradient colors={['#8b35ff', '#5b21b6']} style={{ minWidth: isCompact ? 78 : 88, minHeight: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: isCompact ? 10 : 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: isCompact ? 5 : 7 }}>
                  <UserPlus size={isCompact ? 15 : 16} color="#ffffff" />
                  <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={{ color: '#fff', fontSize: isCompact ? 13 : 14, fontWeight: '900' }}>Follow</Text>
                </View>
              </LinearGradient>
            </Pressable>
            <MoreHorizontal size={24} color="#ffffff" />
          </View>

          <View style={{ height: isCompact ? 220 : 238, overflow: 'hidden' }}>
            {item.mediaUrl && item.mediaKind === 'image' ? (
              <Image source={{ uri: item.mediaUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
            ) : (
              <FantasyPortalArt variant={item.artVariant} />
            )}
            <LinearGradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.72)']} style={{ position: 'absolute', inset: 0 }} />
            <View style={{ position: 'absolute', left: 14, right: 14, bottom: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: isCompact ? 8 : 10 }}>
              <View style={{ flexDirection: 'row', gap: isCompact ? 8 : 10, flex: 1, minWidth: 0 }}>
                <StatPill compact={isCompact} icon={<Heart size={18} color="#ffffff" fill="#ffffff" />} label={item.saveLabel} />
                <StatPill compact={isCompact} collapseLabel={isCompact} icon={<Share2 size={18} color="#ffffff" />} label="Share" />
              </View>
              <View style={{ borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.5)' }}>
                <View style={{ minHeight: isCompact ? 40 : 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: isCompact ? 10 : 13 }}>
                  <Lock size={isCompact ? 16 : 17} color="#f03bd0" fill="rgba(240,59,208,0.24)" />
                  <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={{ color: '#fff', fontWeight: '800', fontSize: isCompact ? 13 : 14 }}>{item.accessLabel}</Text>
                </View>
              </View>
            </View>
          </View>
        </View>
    </Pressable>
  );
}

function StatPill({
  icon,
  label,
  compact = false,
  collapseLabel = false,
}: {
  icon: React.ReactNode;
  label: string;
  compact?: boolean;
  collapseLabel?: boolean;
}) {
  return (
    <View style={{ minHeight: compact ? 38 : 42, flexDirection: 'row', alignItems: 'center', gap: compact ? 6 : 8, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.46)', paddingHorizontal: collapseLabel ? 10 : compact ? 9 : 12 }}>
      {icon}
      {!collapseLabel ? <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={{ color: '#fff', fontWeight: '800', fontSize: compact ? 13 : 14 }}>{label}</Text> : null}
    </View>
  );
}
