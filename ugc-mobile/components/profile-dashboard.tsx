import { useQuery } from '@tanstack/react-query';
import { FlashList } from '@shopify/flash-list';
import { useIsFocused } from '@react-navigation/native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import {
  ChevronRight,
  Crown,
  Heart,
  ImageIcon,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Store,
  UserRound,
  Wallet,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, Text, useWindowDimensions, View, type PanResponderGestureState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FantasyPortalArt } from '@/components/fantasy-portal-art';
import { StableMediaImage } from '@/components/media-preview';
import { AppText, ChoiceChip, IconButton, MetricCard, PrimaryButton, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { formatUsdCents, getOwnerPostSalesSummary } from '@/lib/home-view-model';
import { immersiveViewerHref, profileMediaFeedHref } from '@/lib/immersive-preview-view-model';
import {
  FALLBACK_PROFILE_MEDIA,
  PROFILE_MEDIA_TABS,
  generationToProfileMediaCard,
  getProfileMediaEmptyTitle,
  getProfileMediaSectionTitle,
  getProfileMediaSwipeTarget,
  getProfileHandle,
  getProfileInitials,
  getProfileName,
  getProfileStats,
  ownerPostToProfileMediaCard,
  savedShowcaseToProfileMediaCards,
  type ProfileMediaCard,
  type ProfileMediaSwipeDirection,
  type ProfileMediaTab,
} from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';
import type { ProfileResponse } from '@/lib/types';

const PROFILE_GALLERY_COLUMNS = 3;
const PROFILE_GALLERY_GAP = 8;
const PROFILE_GALLERY_ASPECT_RATIO = 0.74;
const PROFILE_MEDIA_SWIPE_START_DISTANCE = 28;
const PROFILE_MEDIA_SWIPE_COMMIT_DISTANCE = 56;
const PROFILE_MEDIA_SWIPE_AXIS_RATIO = 1.25;

export function ProfileDashboard({
  initialTab = 'Saved',
  highlightedPostId = null,
}: {
  initialTab?: ProfileMediaTab;
  highlightedPostId?: string | null;
} = {}) {
  const { user, api, credits } = useAuth();
  const isFocused = useIsFocused();
  const [activeTab, setActiveTab] = useState<ProfileMediaTab>(initialTab);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const pageWidth = Math.min(width, 430);
  const isCompact = pageWidth < 390;
  const horizontalPadding = isCompact ? 16 : 18;

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user),
    queryFn: api.getProfile,
  });

  const generationsQuery = useQuery({
    queryKey: ['profile-generations', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.listGenerations(false),
  });

  const postsQuery = useQuery({
    queryKey: ['profile-owner-posts', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.listOwnerPosts({ includeArchived: false, visibility: 'all' }),
  });

  const savedQuery = useQuery({
    queryKey: ['profile-saved-media', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.getSavedMedia({ limit: 24 }),
  });

  useEffect(() => {
    if (!isFocused || !user) return;
    void Promise.all([
      generationsQuery.refetch?.(),
      postsQuery.refetch?.(),
      savedQuery.refetch?.(),
    ]);
  }, [isFocused, user?.id]);

  const savedCards = useMemo(
    () => savedShowcaseToProfileMediaCards(savedQuery.data?.items),
    [savedQuery.data]
  );
  const allCreationCards = useMemo(
    () => (generationsQuery.data?.generations ?? []).map(generationToProfileMediaCard),
    [generationsQuery.data]
  );
  const readyCreationCount = useMemo(
    () => allCreationCards.filter((card) => card.isGridReady).length,
    [allCreationCards]
  );
  const creationCards = useMemo(
    () => allCreationCards.filter((card) => card.isGridReady).slice(0, 12),
    [allCreationCards]
  );
  const allPostCards = useMemo(
    () => (postsQuery.data?.posts ?? []).map(ownerPostToProfileMediaCard),
    [postsQuery.data]
  );
  const readyPostCount = useMemo(
    () => allPostCards.filter((card) => card.isGridReady).length,
    [allPostCards]
  );
  const postCards = useMemo(
    () => allPostCards.filter((card) => card.isGridReady).slice(0, 12),
    [allPostCards]
  );
  const salesSummary = useMemo(
    () => getOwnerPostSalesSummary(postsQuery.data?.posts),
    [postsQuery.data]
  );
  const profile = profileQuery.data;
  const displayName = getProfileName(profile, user?.email);
  const handle = getProfileHandle(profile, user?.email);
  const initials = getProfileInitials(profile, user?.email);
  const stats = getProfileStats({
    generationsCount: readyCreationCount,
    postsCount: readyPostCount,
    savedCount: savedCards.length,
  });
  const tabCards = activeTab === 'Saved' ? savedCards : activeTab === 'Creations' ? creationCards : postCards;
  const showPreviewCards = !user && tabCards.length === 0;
  const visibleCards = showPreviewCards ? FALLBACK_PROFILE_MEDIA : tabCards;
  const isMediaLoading =
    (activeTab === 'Saved' && savedQuery.isLoading)
    || (activeTab === 'Creations' && generationsQuery.isLoading)
    || (activeTab === 'Posts' && postsQuery.isLoading);
  const handleMediaTabChange = useCallback((tab: ProfileMediaTab) => {
    setActiveTab(tab);
  }, []);
  const handleMediaSwipe = useCallback((direction: ProfileMediaSwipeDirection) => {
    setActiveTab((currentTab) => getProfileMediaSwipeTarget(currentTab, direction));
  }, []);
  const refreshActiveMedia = () => {
    if (activeTab === 'Saved') {
      void savedQuery.refetch();
      return;
    }
    if (activeTab === 'Creations') {
      void generationsQuery.refetch();
      return;
    }
    void postsQuery.refetch();
  };

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  if (!user) {
    return (
      <ProfileMediaList
        activeTab={activeTab}
        cards={FALLBACK_PROFILE_MEDIA}
        contentBottomPadding={tabBarMetrics.contentBottomOverlapPadding}
        emptyTitle="Sign in to load your media"
        fallbackAvatarInitials="C"
        header={(
          <>
            <ProfileTitle />
            <SignedOutCard />
          </>
        )}
        horizontalPadding={horizontalPadding}
        isLoading={false}
        onSwipeTab={handleMediaSwipe}
        onTabChange={handleMediaTabChange}
        topInset={topInset}
      />
    );
  }

  return (
    <ProfileMediaList
      activeTab={activeTab}
      cards={visibleCards}
      contentBottomPadding={tabBarMetrics.contentBottomOverlapPadding}
      emptyTitle={getProfileMediaEmptyTitle(activeTab)}
      fallbackAvatarInitials={initials}
      fallbackAvatarUrl={profile?.avatarUrl}
      header={(
        <>
          <ProfileTitle />
          {profileQuery.error && !profile ? (
            <StatusBlock tone="danger" title="Could not load profile" body={profileQuery.error instanceof Error ? profileQuery.error.message : 'Try again.'} />
          ) : null}
          <ProfileHeroCard
            profile={profile}
            displayName={displayName}
            handle={handle}
            initials={initials}
            email={user.email}
            stats={stats}
            onEdit={() => router.push('/edit-profile' as never)}
          />
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <BalanceCard
              icon={<Crown size={22} color="#fbbf24" />}
              label="Credits"
              value={String(credits ?? profile?.credits ?? 0)}
              onPress={() => router.push('/pricing' as never)}
            />
            <BalanceCard
              icon={<Wallet size={22} color="#22d3ee" />}
              label="Wallet"
              value={formatUsdCents(salesSummary.earningsUsdCents)}
              onPress={() => router.push('/seller-dashboard' as never)}
            />
          </View>
          <SellerDashboardButton />
        </>
      )}
      horizontalPadding={horizontalPadding}
      highlightedPostId={highlightedPostId}
      isLoading={isMediaLoading}
      onRefresh={refreshActiveMedia}
      onSwipeTab={handleMediaSwipe}
      onTabChange={handleMediaTabChange}
      title={getProfileMediaSectionTitle(activeTab)}
      topInset={topInset}
    />
  );
}

function ProfileMediaList({
  activeTab,
  cards,
  contentBottomPadding,
  emptyTitle,
  fallbackAvatarInitials,
  fallbackAvatarUrl,
  header,
  horizontalPadding,
  highlightedPostId,
  isLoading,
  onRefresh,
  onSwipeTab,
  onTabChange,
  title,
  topInset,
}: {
  activeTab: ProfileMediaTab;
  cards: ProfileMediaCard[];
  contentBottomPadding: number;
  emptyTitle: string;
  fallbackAvatarInitials: string;
  fallbackAvatarUrl?: string | null;
  header: React.ReactNode;
  horizontalPadding: number;
  highlightedPostId?: string | null;
  isLoading: boolean;
  onRefresh?: () => void;
  onSwipeTab: (direction: ProfileMediaSwipeDirection) => void;
  onTabChange: (tab: ProfileMediaTab) => void;
  title?: string;
  topInset: number;
}) {
  const { width } = useWindowDimensions();
  const pageWidth = Math.min(width, 430);
  const contentWidth = pageWidth - horizontalPadding * 2;
  const cardWidth = Math.floor((contentWidth - PROFILE_GALLERY_GAP * (PROFILE_GALLERY_COLUMNS - 1)) / PROFILE_GALLERY_COLUMNS);
  const cardHeight = Math.round(cardWidth / PROFILE_GALLERY_ASPECT_RATIO);
  const swipeResponder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => isProfileMediaSwipeGesture(gestureState),
      onPanResponderRelease: (_, gestureState) => {
        const direction = getProfileMediaSwipeDirection(gestureState);
        if (direction) onSwipeTab(direction);
      },
    }),
    [onSwipeTab]
  );

  return (
    <View {...swipeResponder.panHandlers} style={{ flex: 1, backgroundColor: appTheme.colors.background, paddingTop: topInset }}>
      <FlashList
        data={isLoading ? [] : cards}
        drawDistance={400}
        extraData={activeTab}
        getItemType={(item) => item.mediaKind ?? item.previewKind}
        keyExtractor={(item) => `${item.label}-${item.id}`}
        ListHeaderComponent={(
          <View style={{ gap: 20, paddingBottom: 14 }}>
            {header}
            <ProfileMediaHeader
              activeTab={activeTab}
              onRefresh={onRefresh}
              onTabChange={onTabChange}
              title={title}
            />
          </View>
        )}
        ListEmptyComponent={isLoading ? (
          <View style={{ minHeight: 160, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color="#d946ef" />
          </View>
        ) : (
          <ProfileMediaEmpty title={emptyTitle} />
        )}
        numColumns={PROFILE_GALLERY_COLUMNS}
        removeClippedSubviews={false}
        renderItem={({ item, index }) => (
          <View
            style={{
              width: cardWidth,
              marginRight: index % PROFILE_GALLERY_COLUMNS === PROFILE_GALLERY_COLUMNS - 1 ? 0 : PROFILE_GALLERY_GAP,
              marginBottom: PROFILE_GALLERY_GAP,
            }}
          >
            <ProfileMediaTile
              item={item}
              width={cardWidth}
              height={cardHeight}
              fallbackAvatarUrl={fallbackAvatarUrl}
              fallbackAvatarInitials={fallbackAvatarInitials}
              highlighted={activeTab === 'Posts' && highlightedPostId === item.sourceId}
            />
          </View>
        )}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, backgroundColor: appTheme.colors.background }}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: 18,
          paddingHorizontal: horizontalPadding,
          paddingBottom: contentBottomPadding,
        }}
      />
    </View>
  );
}

function ProfileTitle() {
  return (
    <View style={{ minHeight: 42, alignItems: 'center', justifyContent: 'center' }}>
      <AppText variant="sectionTitle" style={{ fontWeight: '900' }}>
        Profile
      </AppText>
    </View>
  );
}

function SignedOutCard() {
  return (
    <View
      style={{
        overflow: 'hidden',
        borderRadius: 28,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(168,85,247,0.28)',
        backgroundColor: '#090914',
      }}
    >
      <FantasyPortalArt variant="portal" muted />
      <LinearGradient colors={['rgba(3,4,13,0.94)', 'rgba(3,4,13,0.72)']} style={{ position: 'absolute', inset: 0 }} />
      <View style={{ padding: 22, gap: 16 }}>
        <View style={{ width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(217,70,239,0.18)', borderWidth: 1, borderColor: 'rgba(217,70,239,0.34)' }}>
          <UserRound size={34} color="#ffffff" />
        </View>
        <View style={{ gap: 8 }}>
          <AppText variant="pageTitle" style={{ fontSize: 27, lineHeight: 32 }}>Sign in to view your creator profile.</AppText>
          <AppText variant="bodySm" color="muted">
            Saved media, creations, posts, credits, and wallet balance will appear here.
          </AppText>
        </View>
        <PrimaryButton label="Sign in" onPress={() => router.push('/auth')} accent="motion" />
      </View>
    </View>
  );
}

function ProfileHeroCard({
  profile,
  displayName,
  handle,
  initials,
  email,
  stats,
  onEdit,
}: {
  profile?: ProfileResponse | null;
  displayName: string;
  handle: string;
  initials: string;
  email?: string;
  stats: ReturnType<typeof getProfileStats>;
  onEdit: () => void;
}) {
  return (
    <View
      style={{
        overflow: 'hidden',
        borderRadius: 30,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(168,85,247,0.28)',
        backgroundColor: '#090914',
      }}
    >
      <View style={{ height: 118, overflow: 'hidden' }}>
        {profile?.coverUrl ? (
          <Image source={{ uri: profile.coverUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <FantasyPortalArt variant="tree" muted />
        )}
        <LinearGradient colors={['rgba(3,4,13,0.18)', 'rgba(3,4,13,0.78)']} style={{ position: 'absolute', inset: 0 }} />
      </View>

      <View style={{ paddingHorizontal: 18, paddingBottom: 18 }}>
        <View style={{ marginTop: -42, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <ProfileAvatar profile={profile} initials={initials} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit profile"
            onPress={onEdit}
            style={({ pressed }) => ({
              minHeight: 42,
              borderRadius: 21,
              overflow: 'hidden',
              opacity: pressed ? 0.78 : 1,
            })}
          >
            <LinearGradient
              colors={['#f032d0', '#7c3cff']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 15 }}
            >
              <Pencil size={15} color="#ffffff" />
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900' }}>Edit Profile</Text>
            </LinearGradient>
          </Pressable>
        </View>

        <View style={{ gap: 8, paddingTop: 14 }}>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: '#fff', fontSize: 28, fontWeight: '900' }}>{displayName}</Text>
          <Text numberOfLines={1} style={{ color: '#d946ef', fontSize: 15, fontWeight: '800' }}>{handle}</Text>
          {profile?.bio ? (
            <Text numberOfLines={3} style={{ color: 'rgba(255,255,255,0.72)', fontSize: 14, lineHeight: 21 }}>{profile.bio}</Text>
          ) : (
            <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.62)', fontSize: 14, lineHeight: 21 }}>
              {email ? `Signed in as ${email}` : 'Creator profile ready for saved media and posts.'}
            </Text>
          )}
        </View>

        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.09)', marginVertical: 16 }} />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {stats.map((stat) => (
            <View key={stat.label} style={{ flex: 1, minWidth: 0, alignItems: 'center', gap: 5 }}>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={{ color: '#fff', fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] }}>{stat.value}</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '700' }}>{stat.label}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function ProfileAvatar({ profile, initials }: { profile?: ProfileResponse | null; initials: string }) {
  return (
    <View
      style={{
        width: 86,
        height: 86,
        borderRadius: 43,
        padding: 3,
        backgroundColor: '#03040d',
      }}
    >
      <LinearGradient
        colors={['#f032d0', '#7c3cff', '#22d3ee']}
        style={{ flex: 1, borderRadius: 40, padding: 2 }}
      >
        <View style={{ flex: 1, overflow: 'hidden', borderRadius: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: '#141225' }}>
          {profile?.avatarUrl ? (
            <Image source={{ uri: profile.avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          ) : (
            <>
              <Sparkles size={21} color="#d946ef" />
              <Text style={{ color: '#fff', fontSize: 25, fontWeight: '900' }}>{initials}</Text>
            </>
          )}
        </View>
      </LinearGradient>
    </View>
  );
}

function BalanceCard({
  icon,
  label,
  value,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <MetricCard
      icon={icon}
      label={label}
      value={value}
      accent={label === 'Wallet' ? 'workflow' : 'amber'}
      onPress={onPress}
      trailing={<ChevronRight size={17} color={appTheme.colors.muted} strokeWidth={2.3} />}
      compact
    />
  );
}

function SellerDashboardButton() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open seller dashboard"
      onPress={() => router.push('/seller-dashboard' as never)}
      style={({ pressed }) => ({
        minHeight: 62,
        borderRadius: 22,
        borderCurve: 'continuous',
        overflow: 'hidden',
        opacity: pressed ? 0.82 : 1,
        transform: [{ scale: pressed ? 0.99 : 1 }],
      })}
    >
      <LinearGradient
        colors={['rgba(217,70,239,0.18)', 'rgba(34,211,238,0.10)']}
        style={{
          flex: 1,
          borderWidth: 1,
          borderColor: 'rgba(217,70,239,0.26)',
          borderRadius: 22,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 13,
        }}
      >
        <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(217,70,239,0.18)', alignItems: 'center', justifyContent: 'center' }}>
          <Store size={21} color="#ffffff" />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <AppText variant="cardTitle" numberOfLines={1}>Seller Dashboard</AppText>
          <AppText variant="caption" color="muted" numberOfLines={1}>Sales, paid unlocks, and seller listings</AppText>
        </View>
        <ChevronRight size={23} color="#ffffff" />
      </LinearGradient>
    </Pressable>
  );
}

function ProfileMediaHeader({
  activeTab,
  onTabChange,
  onRefresh,
  title,
}: {
  activeTab: ProfileMediaTab;
  onTabChange: (tab: ProfileMediaTab) => void;
  onRefresh?: () => void;
  title?: string;
}) {
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText variant="sectionTitle" numberOfLines={1} style={{ flex: 1 }}>
          {title ?? getProfileMediaSectionTitle(activeTab)}
        </AppText>
        <IconButton
          icon={RefreshCw}
          label="Refresh media"
          disabled={!onRefresh}
          onPress={onRefresh}
          accent="motion"
          style={{ minHeight: 38, minWidth: 38 }}
        />
      </View>
      <ProfileSegment value={activeTab} onChange={onTabChange} />
    </View>
  );
}

function ProfileMediaEmpty({ title }: { title: string }) {
  return (
    <View
      style={{
        minHeight: 154,
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        gap: 8,
      }}
    >
      <ImageIcon size={30} color={appTheme.colors.faint} />
      <AppText variant="cardTitle">{title}</AppText>
      <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
        This section will fill as you save media, create generations, or publish posts.
      </AppText>
    </View>
  );
}

function isProfileMediaSwipeGesture(gestureState: PanResponderGestureState) {
  const horizontalDistance = Math.abs(gestureState.dx);
  const verticalDistance = Math.abs(gestureState.dy);
  return horizontalDistance >= PROFILE_MEDIA_SWIPE_START_DISTANCE
    && horizontalDistance > verticalDistance * PROFILE_MEDIA_SWIPE_AXIS_RATIO;
}

function getProfileMediaSwipeDirection(gestureState: PanResponderGestureState): ProfileMediaSwipeDirection | null {
  const horizontalDistance = Math.abs(gestureState.dx);
  const verticalDistance = Math.abs(gestureState.dy);

  if (
    horizontalDistance < PROFILE_MEDIA_SWIPE_COMMIT_DISTANCE
    || horizontalDistance <= verticalDistance * PROFILE_MEDIA_SWIPE_AXIS_RATIO
  ) {
    return null;
  }

  return gestureState.dx < 0 ? 'left' : 'right';
}

function ProfileSegment({ value, onChange }: { value: ProfileMediaTab; onChange: (value: ProfileMediaTab) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: appTheme.spacing.compact, borderRadius: appTheme.radii.pill, backgroundColor: appTheme.colors.surfaceInset, padding: 4 }}>
      {PROFILE_MEDIA_TABS.map((tab) => {
        const active = tab === value;
        return (
          <ChoiceChip
            key={tab}
            label={tab}
            active={active}
            onPress={() => onChange(tab)}
            accent={tab === 'Saved' ? 'image' : tab === 'Creations' ? 'motion' : 'workflow'}
            grow
            compact
          />
        );
      })}
    </View>
  );
}

function ProfileMediaTile({
  item,
  width,
  height,
  fallbackAvatarUrl,
  fallbackAvatarInitials,
  highlighted,
}: {
  item: ProfileMediaCard;
  width: number;
  height: number;
  fallbackAvatarUrl?: string | null;
  fallbackAvatarInitials: string;
  highlighted?: boolean;
}) {
  const avatarUrl = item.avatarUrl ?? fallbackAvatarUrl ?? null;
  const avatarInitials = item.avatarUrl
    ? getGalleryInitials(item.avatarLabel ?? item.meta)
    : item.avatarLabel
      ? getGalleryInitials(item.avatarLabel)
      : fallbackAvatarInitials;
  const countLabel = item.countLabel ?? '0';
  const isFallbackPreview = item.id.startsWith('preview-');
  const isSavedTile = item.label === 'Saved';
  const accessibilityLabel = isSavedTile
    ? `${item.label}, ${item.title}, ${countLabel} likes`
    : `${item.label}, ${item.title}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        if (isFallbackPreview) {
          router.push(item.href as never);
          return;
        }
        router.push(
          (isSavedTile ? immersiveViewerHref : profileMediaFeedHref)({
            source: item.viewerSource,
            initialId: item.sourceId,
          }) as never
        );
      }}
      style={({ pressed }) => ({
        width,
        height,
        opacity: pressed ? 0.84 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      <View
        testID={highlighted ? 'profile-highlighted-post-tile' : undefined}
        style={{
          flex: 1,
          overflow: 'hidden',
          borderRadius: 12,
          borderCurve: 'continuous',
          borderWidth: highlighted ? 2 : 0,
          borderColor: highlighted ? 'rgba(103,255,69,0.72)' : 'transparent',
          backgroundColor: '#090914',
        }}
      >
        <ProfileGalleryPreview item={item} height={height} />
        <LinearGradient
          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.16)', 'rgba(0,0,0,0.70)']}
          locations={[0, 0.48, 1]}
          style={{ position: 'absolute', inset: 0 }}
        />
        {item.mediaKind === 'video' ? (
          <View style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.38)' }}>
            <Play size={15} color="#ffffff" fill="#ffffff" strokeWidth={2.4} />
          </View>
        ) : null}
        {isSavedTile ? (
          <ProfileSavedFeedOverlay
            item={item}
            avatarUrl={avatarUrl}
            avatarInitials={avatarInitials}
            countLabel={countLabel}
          />
        ) : (
          <ProfileMinimalMediaOverlay item={item} />
        )}
      </View>
    </Pressable>
  );
}

function ProfileSavedFeedOverlay({
  item,
  avatarUrl,
  avatarInitials,
  countLabel,
}: {
  item: ProfileMediaCard;
  avatarUrl: string | null;
  avatarInitials: string;
  countLabel: string;
}) {
  return (
    <View testID="profile-saved-overlay" pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
      <View
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          right: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          borderRadius: 14,
          backgroundColor: 'rgba(3,4,13,0.66)',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.16)',
          paddingHorizontal: 6,
          paddingVertical: 5,
        }}
      >
        <View
          style={{
            width: 21,
            height: 21,
            borderRadius: 10.5,
            overflow: 'hidden',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#27272a',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.24)',
          }}
        >
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          ) : (
            <Text style={{ color: '#fff', fontSize: 8, fontWeight: '900' }}>{avatarInitials}</Text>
          )}
        </View>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: '#ffffff', fontSize: 10, fontWeight: '900' }}>
          {item.avatarLabel || item.meta}
        </Text>
      </View>

      <View
        style={{
          position: 'absolute',
          left: 8,
          right: 8,
          bottom: 8,
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 8,
        }}
      >
        <Text
          numberOfLines={2}
          style={{
            flex: 1,
            minWidth: 0,
            color: '#ffffff',
            fontSize: 12,
            lineHeight: 15,
            fontWeight: '900',
          }}
        >
          {item.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 34, justifyContent: 'flex-end' }}>
          <Heart size={15} color="#ff4d2d" fill="#ff4d2d" strokeWidth={2.2} />
          <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] }}>
            {countLabel}
          </Text>
        </View>
      </View>
    </View>
  );
}

function ProfileMinimalMediaOverlay({ item }: { item: ProfileMediaCard }) {
  const accent = item.label === 'Creation' ? '#e879f9' : '#67e8f9';
  const icon = item.label === 'Creation'
    ? <Sparkles size={13} color={accent} strokeWidth={2.4} />
    : item.mediaKind === 'video'
      ? <Play size={13} color={accent} fill={accent} strokeWidth={2.4} />
      : <ImageIcon size={13} color={accent} strokeWidth={2.4} />;
  const stateColor = item.label === 'Creation'
    ? item.linkedPostLabel && item.linkedPostLabel !== 'Not posted'
      ? '#67ff45'
      : '#c084fc'
    : item.visibilityLabel === 'Public'
      ? '#67ff45'
      : item.visibilityLabel === 'Private'
        ? '#f59e0b'
        : '#67e8f9';

  return (
    <View testID="profile-minimal-overlay" pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
      <View
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(3,4,13,0.62)',
          borderWidth: 1,
          borderColor: item.label === 'Creation' ? 'rgba(216,180,254,0.38)' : 'rgba(103,232,249,0.28)',
        }}
      >
        {icon}
      </View>

      <View
        style={{
          position: 'absolute',
          bottom: 8,
          left: 8,
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: stateColor,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.72)',
        }}
      />
    </View>
  );
}

function ProfileGalleryPreview({ item, height }: { item: ProfileMediaCard; height: number }) {
  const previewMediaUrl = item.previewState === 'videoPoster'
    ? item.previewUrl
    : item.previewState === 'image'
      ? item.previewUrl ?? item.mediaUrl
      : item.mediaKind === 'image'
        ? item.previewUrl ?? item.mediaUrl
        : null;
  if (previewMediaUrl) {
    return (
      <View style={{ width: '100%', height, overflow: 'hidden', backgroundColor: '#090914' }}>
        <StableMediaImage
          url={previewMediaUrl}
          cacheKey={item.previewCacheKey ?? item.id}
          thumbhash={item.previewThumbhash}
          contentFit="cover"
          transition={120}
          style={{ position: 'absolute', inset: 0 }}
        />
      </View>
    );
  }

  if (item.mediaKind === 'video' && item.mediaUrl) {
    return <ProfileVideoFallback item={item} height={height} />;
  }

  if (item.previewKind === 'text') {
    return <ProfileTextPreview item={item} height={height} />;
  }

  return (
    <ProfileUnavailableFallback item={item} height={height} showTitle={item.label !== 'Post'} />
  );
}

function ProfileTextPreview({ item, height }: { item: ProfileMediaCard; height: number }) {
  const accent = item.label === 'Creation' ? '#e879f9' : '#67e8f9';
  const label = item.label === 'Creation' ? 'Text creation' : 'Text post';

  return (
    <View testID="profile-text-preview" style={{ height, overflow: 'hidden', backgroundColor: '#090914' }}>
      <LinearGradient
        colors={['#2a1740', '#171827', '#080810']}
        locations={[0, 0.48, 1]}
        style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 12, paddingTop: 46, paddingBottom: 14 }}
      >
        <View
          style={{
            alignSelf: 'flex-start',
            borderRadius: 999,
            backgroundColor: 'rgba(103,232,249,0.12)',
            borderWidth: 1,
            borderColor: 'rgba(103,232,249,0.42)',
            paddingHorizontal: 8,
            paddingVertical: 4,
            marginBottom: 8,
          }}
        >
          <Text numberOfLines={1} style={{ color: accent, fontSize: 9, fontWeight: '900' }}>{label}</Text>
        </View>
        <Text numberOfLines={5} style={{ color: '#ffffff', fontSize: 13, lineHeight: 16, fontWeight: '900' }}>
          {item.previewText || item.title}
        </Text>
      </LinearGradient>
    </View>
  );
}

function ProfileVideoFallback({ item, height }: { item: ProfileMediaCard; height: number }) {
  const label = item.badge ?? 'Video';
  const statusLabel = item.previewStatusLabel ?? (item.label === 'Creation' ? 'Tap to view media' : 'Preview unavailable');

  return (
    <View testID="profile-video-preview-fallback" style={{ height, overflow: 'hidden', backgroundColor: '#090914' }}>
      <LinearGradient
        colors={['#26143a', '#111827', '#05050a']}
        locations={[0, 0.52, 1]}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 }}
      >
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(232,121,249,0.18)',
            borderWidth: 1,
            borderColor: 'rgba(232,121,249,0.52)',
          }}
        >
          <Play size={18} color="#ffffff" fill="#ffffff" strokeWidth={2.3} />
        </View>
        <Text style={{ marginTop: 10, color: '#ffffff', fontSize: 12, fontWeight: '900' }}>{label}</Text>
        <Text
          numberOfLines={1}
          style={{ marginTop: 3, color: 'rgba(255,255,255,0.66)', fontSize: 9, fontWeight: '800' }}
        >
          {statusLabel}
        </Text>
      </LinearGradient>
    </View>
  );
}

function ProfileUnavailableFallback({
  item,
  height,
  showTitle = true,
  statusLabel,
}: {
  item: ProfileMediaCard;
  height: number;
  showTitle?: boolean;
  statusLabel?: string;
}) {
  const accent = item.label === 'Creation' ? '#e879f9' : '#67e8f9';

  return (
    <View testID="profile-art-preview-fallback" style={{ height, overflow: 'hidden', backgroundColor: '#090914' }}>
      <LinearGradient
        colors={['#182235', '#11131e', '#07070c']}
        locations={[0, 0.5, 1]}
        style={{ flex: 1, justifyContent: 'center', padding: 10 }}
      >
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(103,232,249,0.12)',
            borderWidth: 1,
            borderColor: 'rgba(103,232,249,0.48)',
          }}
        >
          {item.label === 'Creation'
            ? <Sparkles size={14} color={accent} strokeWidth={2.4} />
            : <ImageIcon size={14} color={accent} strokeWidth={2.4} />}
        </View>
        {showTitle ? (
          <Text numberOfLines={2} style={{ marginTop: 10, color: '#ffffff', fontSize: 11, lineHeight: 14, fontWeight: '900' }}>
            {item.title}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          style={{ marginTop: showTitle ? 4 : 10, color: 'rgba(255,255,255,0.66)', fontSize: 9, fontWeight: '800' }}
        >
          {statusLabel ?? item.previewStatusLabel ?? 'Preview unavailable'}
        </Text>
      </LinearGradient>
    </View>
  );
}

function getGalleryInitials(label: string) {
  const words = label
    .replace(/@/g, '')
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join('') || 'C';
}
