import { useIsFocused } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { BookOpen, Box, Clock3, MessageCircle, Search, Wrench, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { SearchTypeaheadList } from '@/components/search-typeahead-list';
import { TextPostPlate } from '@/components/text-post-plate';
import { ChoiceChip, CreatorAvatar, SecondaryButton, SegmentedControl, StatusBlock } from '@/components/ui';
import { MotionView, useOverlayPresence } from '@/lib/motion';
import { BackGlyph } from '@/lib/platform-glyphs';
import { creatorProfilePress } from '@/lib/creator-profile-opening';
import { ApiError, type MagicbookletApiClient } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import {
  NO_SEARCH_FILTERS,
  SEARCH_CLEAR_FIELD_LABEL,
  SEARCH_CORRECTED_AGAIN_LABEL,
  SEARCH_ENTITIES_HEADING,
  SEARCH_FAILED_BODY,
  SEARCH_FAILED_TITLE,
  SEARCH_FIELD_LABEL,
  SEARCH_FILTERED_EMPTY_BODY,
  SEARCH_FILTERS_CLEAR_LABEL,
  SEARCH_FILTERS_GROUP_LABEL,
  SEARCH_FILTER_SWITCHES,
  SEARCH_IDLE_BODY,
  SEARCH_IDLE_TITLE,
  SEARCH_LOADING_MORE_LABEL,
  SEARCH_NO_RESULTS_BODY,
  SEARCH_OFFLINE_BODY,
  SEARCH_PLACEHOLDER,
  SEARCH_RECENTS_CLEAR_ACTION_LABEL,
  SEARCH_RECENTS_CLEAR_LABEL,
  SEARCH_RECENTS_HEADING,
  SEARCH_RETRY_LABEL,
  SEARCH_SEARCHING_LABEL,
  SEARCH_SEE_ALL_LABEL,
  SEARCH_SHOW_MORE_LABEL,
  SEARCH_SORT_OPTIONS,
  SEARCH_TABS,
  hasSearchFilters,
  isSearchFilterSwitchOn,
  parseSearchEntityId,
  SEARCH_RELATED_HEADING,
  isSearchAnswerThin,
  searchCorrectionNotice,
  searchEntityActionLabel,
  searchEntityCountLabel,
  searchEntityId,
  searchEntityKindLabel,
  searchBusyBody,
  searchCreatorCardLabel,
  searchExactNotice,
  searchFailedLine,
  searchFilterKey,
  searchHistoryQueryFor,
  searchInsteadLabel,
  searchMadeWithChipLabel,
  searchMadeWithRemoveLabel,
  searchNoResultsTitle,
  searchPostCardLabel,
  searchRecentAgainLabel,
  searchRecentRemoveLabel,
  searchRecipeCardLabel,
  searchRelatedApplies,
  searchRelatedFollowUpDelay,
  searchRelatedPosts,
  searchRelatedStatus,
  searchSaysNoResults,
  searchSeeAllLabel,
  searchTabRuns,
  searchTopSectionHasMore,
  toggleSearchFilterSwitch,
  type SearchEntity,
  type SearchFilters,
  type SearchTopSection,
} from '@/lib/public-search-policy/public-search-policy';
import type { SearchTypeaheadRow } from '@/lib/public-search-policy/search-typeahead';
import {
  clearSearchHistory,
  forgetSearchQuery,
  normalizeCreatorSearchQuery,
  normalizeSearchHistoryQuery,
  readSearchHistory,
  rememberSearchQuery,
  searchQueryLength,
} from '@/lib/search-history';
import { searchPostGridCellWidth, searchPostGridColumns } from '@/lib/search-post-grid';
import { isTextOnlyShowcasePost } from '@/lib/showcase-display';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { buildTextPostPlate, textPostPlateUnderCaption } from '@/lib/text-post-plate-view-model';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type {
  CreatorSearchResult,
  PublicSearchResponse,
  PublicSearchSort,
  PublicSearchType,
  RecipeSearchResult,
  ShowcaseFeedItem,
} from '@/lib/types';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { useSearchTypeahead } from '@/lib/use-search-typeahead';
import { formatUnlockCreditPrice } from '@/lib/pricing';

const SEARCH_DEBOUNCE_MS = 300;

// `scope` is the query and tab an answer was asked for, whatever the order.
// `relatedAsked`: the answer was asked for with related posts, or has been
// asked about them since. They are asked about once per answer.
type SearchAnswer = { key: string; scope: string; response: PublicSearchResponse; relatedAsked: boolean };
type SearchFailure = { key: string; message: string; retryAfterSeconds: number | null };

function isContentType(type: PublicSearchType) {
  return type === 'posts' || type === 'recipes';
}

// An answer or a failure is drawn only under the query and tab it was asked
// for, so a new query or tab shows the spinner until its own answer lands.
// `narrowing` is the filters and the exact reading as one string
// (searchFilterKey), '' for none.
function searchKey(query: string, type: PublicSearchType, sort: PublicSearchSort, narrowing: string) {
  return `${type}:${sort}:${narrowing}:${query}`;
}

function searchScope(query: string, type: PublicSearchType) {
  return `${type}:${query}`;
}

// The models and tools an answer offers: on Top, and only for a query Posts
// is searched for (three characters), since pressing one opens Posts.
function offeredEntities(response: PublicSearchResponse, type: PublicSearchType, query: string) {
  if (type !== 'top') return [];
  if (!searchTabRuns('posts', searchQueryLength(normalizeCreatorSearchQuery(query)))) return [];
  return response.entities ?? [];
}

// Top draws every kind, the models and tools the query names among them; a
// kind's tab draws only its own.
function shownResultCount(response: PublicSearchResponse, type: PublicSearchType, query: string) {
  return offeredEntities(response, type, query).length
    + (type === 'top' || type === 'creators' ? response.creators.items.length : 0)
    + (type === 'top' || type === 'posts' ? response.posts.items.length : 0)
    + (type === 'top' || type === 'recipes' ? response.recipes.items.length : 0);
}

function retryAfterSecondsOf(details: unknown) {
  const value = typeof details === 'object' && details !== null
    ? (details as { retryAfterSeconds?: unknown }).retryAfterSeconds
    : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

// Only a request that got no answer, or a server fault, is a reason to send
// someone to check their connection.
function describeSearchFailure(error: unknown): Omit<SearchFailure, 'key'> {
  if (error instanceof ApiError) {
    // Every request inside the server's window is refused the same way, so
    // Retry waits it out.
    if (error.status === 429) {
      const retryAfterSeconds = retryAfterSecondsOf(error.details);
      return { message: searchBusyBody(retryAfterSeconds), retryAfterSeconds };
    }
    // Status 0 is the client's own: no answer at all, its timeout included.
    if (error.status === 0 || error.status >= 500) {
      return { message: SEARCH_OFFLINE_BODY, retryAfterSeconds: null };
    }
  }
  return { message: SEARCH_FAILED_BODY, retryAfterSeconds: null };
}

function postPreview(item: ShowcaseFeedItem) {
  const cover = item.mediaItems?.slice().sort((left, right) => left.sortOrder - right.sortOrder)[0];
  return cover?.previewUrl
    ?? (cover?.mediaKind === 'image' ? cover.url : null)
    ?? (item.mediaKind === 'image' ? item.mediaUrl : null);
}

function SearchTab({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        backgroundColor: active ? theme.colors.text : 'transparent',
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 17,
      })}
    >
      <Text style={{ color: active ? theme.colors.textInverse : theme.colors.muted, fontSize: 13, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
}

// A kind's heading and, on its own tab, the order its results are in. The
// control is the app's segmented control as tabs, each order sized to its
// word, as the comment order is beside its sheet's title. On Top, "See all"
// opens the kind's own tab, as on the web.
function ResultsHeading({
  title,
  sort,
  onSortChange,
  seeAll,
}: {
  title: 'Creators' | 'Posts' | 'Recipes' | typeof SEARCH_ENTITIES_HEADING | typeof SEARCH_RELATED_HEADING;
  /** Null where the results have one order, or the server has not said it reads another. */
  sort: PublicSearchSort | null;
  onSortChange: (sort: PublicSearchSort) => void;
  seeAll?: { section: SearchTopSection; onPress: () => void } | null;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text accessibilityRole="header" style={{ flexShrink: 1, color: theme.colors.text, fontSize: 18, fontWeight: '800' }}>{title}</Text>
      {sort ? (
        <SegmentedControl
          role="tab"
          fill={false}
          accessibilityLabel={`Sort ${title.toLowerCase()}`}
          options={SEARCH_SORT_OPTIONS}
          value={sort}
          onChange={onSortChange}
        />
      ) : seeAll ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={searchSeeAllLabel(seeAll.section)}
          onPress={seeAll.onPress}
          hitSlop={4}
          style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4, opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Text style={{ color: theme.colors.primary, fontSize: 14, fontWeight: '700' }}>{SEARCH_SEE_ALL_LABEL}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// Under a full Top section, which is when its tab has more (Top carries no
// cursor: searchTopSectionHasMore): the way to the rest, the width of the results.
function SeeAllButton({ section, onPress }: { section: SearchTopSection; onPress: () => void }) {
  return <SecondaryButton label={searchSeeAllLabel(section)} onPress={onPress} />;
}

// A state, not a control: the row opens the profile, where Follow lives. It
// tells apart two creators with one name, as the web's search card does.
function FollowingChip() {
  const theme = useAppTheme();
  const tone = theme.semantic.neutral;
  return (
    <View
      style={{
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: tone.border,
        backgroundColor: tone.background,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color: tone.foreground, fontSize: 11, fontWeight: '800' }}>Following</Text>
    </View>
  );
}

// A model or tool as a result: pressing it shows the posts made with it.
function EntityRow({ entity, onPick }: { entity: SearchEntity; onPick: () => void }) {
  const theme = useAppTheme();
  const Icon = entity.kind === 'model' ? Box : Wrench;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={searchEntityActionLabel(entity)}
      onPress={onPick}
      style={({ pressed }) => ({
        minHeight: 60,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 13,
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 13,
        paddingVertical: 10,
      })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          backgroundColor: theme.colors.surfaceStrong,
        }}
      >
        <Icon size={appTheme.icon.default} color={theme.colors.primary} />
      </View>
      <View style={{ minWidth: 0, flex: 1 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>{entity.label}</Text>
        <Text numberOfLines={1} style={{ marginTop: 2, color: theme.colors.muted, fontSize: 13 }}>
          {`${searchEntityKindLabel(entity.kind)} · ${searchEntityCountLabel(entity)}`}
        </Text>
      </View>
    </Pressable>
  );
}

// What narrows a Posts search: switches that say whether they are on, and the
// made-with filter as a chip of its own that removes it. One row that scrolls
// sideways, under the tabs it belongs to.
function SearchFilterBar({
  filters,
  madeWithLabel,
  followingOffered,
  onChange,
}: {
  filters: SearchFilters;
  /** The name of the made-with entity, once known. */
  madeWithLabel: string | null;
  /** A visitor or a guest follows nobody: the switch is drawn only for an account. */
  followingOffered: boolean;
  onChange: (filters: SearchFilters) => void;
}) {
  const theme = useAppTheme();
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={SEARCH_FILTERS_GROUP_LABEL}
      style={{ flexGrow: 0, marginHorizontal: -appTheme.spacing.screen }}
      contentContainerStyle={{ alignItems: 'center', gap: 8, paddingHorizontal: appTheme.spacing.screen }}
    >
      {filters.madeWith && madeWithLabel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={searchMadeWithRemoveLabel(madeWithLabel)}
          accessibilityState={{ selected: true }}
          onPress={() => onChange({ ...filters, madeWith: null })}
          style={({ pressed }) => ({
            minHeight: appTheme.touch.default,
            maxWidth: 260,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: theme.state.selected.border,
            backgroundColor: theme.state.selected.background,
            opacity: pressed ? appTheme.opacity.pressed : 1,
            paddingHorizontal: appTheme.spacing.gap,
          })}
        >
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13, fontWeight: '800' }}>
            {searchMadeWithChipLabel(madeWithLabel)}
          </Text>
          <X size={appTheme.icon.sm} color={theme.colors.text} />
        </Pressable>
      ) : null}
      {SEARCH_FILTER_SWITCHES.filter((item) => item.id !== 'following' || followingOffered).map((item) => (
        <ChoiceChip
          key={item.id}
          compact
          accent="primary"
          label={item.label}
          active={isSearchFilterSwitchOn(filters, item.id)}
          onPress={() => onChange(toggleSearchFilterSwitch(filters, item.id))}
        />
      ))}
      {hasSearchFilters(filters) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={SEARCH_FILTERS_CLEAR_LABEL}
          onPress={() => onChange(NO_SEARCH_FILTERS)}
          style={{ minHeight: appTheme.touch.default, justifyContent: 'center', paddingHorizontal: 6 }}
        >
          <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '700' }}>{SEARCH_FILTERS_CLEAR_LABEL}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

// How the search read the query, and the way to the other reading.
function ReadingNotice({ line, actionLabel, onAction }: { line: string; actionLabel: string; onAction: () => void }) {
  const theme = useAppTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10 }}
    >
      <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>{line}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        onPress={onAction}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ color: theme.colors.primary, fontSize: 14, fontWeight: '700' }}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

function CreatorRow({ creator, onOpen }: { creator: CreatorSearchResult; onOpen: () => void }) {
  const theme = useAppTheme();
  // One line, as on the web card, where the browser folds a bio's line breaks
  // into spaces.
  const bio = creator.bio?.replace(/\s+/g, ' ').trim();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={searchCreatorCardLabel(creator)}
      // Their page is read once the finger has rested here, never for a scroll
      // of the results that starts on the row (`creatorProfilePress`).
      {...creatorProfilePress(creator.username, () => {
        onOpen();
        router.push(`/creators/${encodeURIComponent(creator.username)}` as never);
      })}
      style={({ pressed }) => ({
        minHeight: 76,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 13,
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        padding: 13,
      })}
    >
      <CreatorAvatar uri={creator.avatarUrl} name={creator.displayName} size={48} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>{creator.displayName}</Text>
          {creator.isFollowing ? <FollowingChip /> : null}
        </View>
        <Text numberOfLines={1} style={{ marginTop: 2, color: theme.colors.muted, fontSize: 13 }}>@{creator.username}</Text>
        {bio ? <Text numberOfLines={1} style={{ marginTop: 2, color: theme.colors.faint, fontSize: 12 }}>{bio}</Text> : null}
      </View>
      <Text style={{ color: theme.colors.faint, fontSize: 12 }}>
        {`${creator.publicPostCount} ${creator.publicPostCount === 1 ? 'post' : 'posts'}`}
      </Text>
    </Pressable>
  );
}

function PostRow({ item, onOpen }: { item: ShowcaseFeedItem; onOpen: () => void }) {
  const theme = useAppTheme();
  const preview = postPreview(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={searchPostCardLabel({ title: item.title, creatorName: item.creator.name })}
      onPress={() => {
        onOpen();
        router.push(`/post/${encodeURIComponent(item.id)}` as never);
      }}
      style={({ pressed }) => ({
        flex: 1,
        overflow: 'hidden',
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {preview ? (
        <Image source={{ uri: preview }} contentFit="cover" style={{ width: '100%', aspectRatio: 1.15 }} />
      ) : isTextOnlyShowcasePost(item) ? (
        // A post with no picture has its writing to show. The frame used to
        // hold a magnifier, which read as a result that had failed to load.
        <View style={{ width: '100%', aspectRatio: 1.15 }}>
          <TextPostPlate
            testID="search-text-post-plate"
            // The title is the caption's first line, just under the frame.
            content={textPostPlateUnderCaption(buildTextPostPlate(item))}
            size="feature"
            // Until the plate has been laid out and counts its own lines.
            bodyLines={5}
          />
        </View>
      ) : (
        <View style={{ width: '100%', aspectRatio: 1.15, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.panel }}>
          <Search size={appTheme.icon.feature} color={theme.colors.primary} />
        </View>
      )}
      <View style={{ gap: 3, padding: 12 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 14, fontWeight: '800' }}>{item.title}</Text>
        <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 12 }}>{item.creator.name}</Text>
        {/* The web card's counts, in its order and words. */}
        <View style={{ marginTop: 5, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.faint, fontSize: 12 }}>
            {`${item.saveCount} ${item.saveCount === 1 ? 'save' : 'saves'}`}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <MessageCircle size={appTheme.icon.xs} color={theme.colors.faint} />
            <Text style={{ color: theme.colors.faint, fontSize: 12 }}>{String(item.commentCount)}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

function RecipeRow({ recipe, onOpen }: { recipe: RecipeSearchResult; onOpen: () => void }) {
  const theme = useAppTheme();
  // Only an image post may fall back to its media URL: a video's is not an image.
  const preview = recipe.post?.mediaPreviewUrl
    ?? (recipe.post?.mediaKind === 'image' ? recipe.post.mediaUrl : null);
  const price = recipe.accessMode === 'free' ? 'Free' : formatUnlockCreditPrice(recipe.priceUsdCents);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={searchRecipeCardLabel({ title: recipe.title, sellerName: recipe.seller.name, price })}
      onPress={() => {
        onOpen();
        // A recipe is read and bought on its post, as on the web, whose search
        // opens the post at `#recipe`: in the reel, with the params the post's
        // own link opens it with (`app/post/[id].tsx`), on its Details page
        // with the resources card first. The standalone unlock screen had no
        // way to the post, its creator or Remix.
        router.push({
          pathname: '/viewer',
          params: { source: 'showcase-feed', initialId: recipe.postId, initialPage: 'details', initialSection: 'resources' },
        });
      }}
      style={({ pressed }) => ({
        minHeight: 104,
        flexDirection: 'row',
        overflow: 'hidden',
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {preview ? (
        <Image source={{ uri: preview }} contentFit="cover" style={{ width: 106 }} />
      ) : (
        <View style={{ width: 106, alignItems: 'center', justifyContent: 'center', backgroundColor: `${theme.colors.success}12` }}>
          <BookOpen size={appTheme.icon.feature} color={theme.colors.success} />
        </View>
      )}
      <View style={{ minWidth: 0, flex: 1, gap: 5, justifyContent: 'center', padding: 13 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 14, fontWeight: '800' }}>{recipe.title}</Text>
        <Text numberOfLines={2} style={{ color: theme.colors.muted, fontSize: 12, lineHeight: 17 }}>{recipe.summary || recipe.previewText}</Text>
        {/* Who sells it, on the price's line, as the web card has it. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.faint, fontSize: 12 }}>{recipe.seller.name}</Text>
          <Text style={{ color: theme.colors.success, fontSize: 12, fontWeight: '800' }}>{price}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const NO_RELATED_POSTS: readonly ShowcaseFeedItem[] = [];

// Posts that mean what the query says without holding its words: the cards
// the search's own posts are, under everything the search itself found.
function RelatedPosts({ posts, cellWidth, onOpen }: { posts: readonly ShowcaseFeedItem[]; cellWidth: '100%' | '48%'; onOpen: () => void }) {
  if (posts.length === 0) return null;
  return (
    <View testID="search-related-posts" style={{ gap: 10 }}>
      <ResultsHeading title={SEARCH_RELATED_HEADING} sort={null} onSortChange={noSortChange} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {posts.map((post) => <View key={post.id} style={{ width: cellWidth }}><PostRow item={post} onOpen={onOpen} /></View>)}
      </View>
    </View>
  );
}
const noSortChange = () => {};

export function ExploreSearchOverlay({
  api,
  onClose,
  visible,
}: {
  api: MagicbookletApiClient;
  onClose: () => void;
  visible: boolean;
}) {
  const theme = useAppTheme();
  // The registered account, null for a visitor and for a guest session: the
  // only viewer "from creators I follow" means anything for.
  const { user } = useAuth();
  const canFollow = Boolean(user);
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  // Two posts across, one at the accessibility text sizes (search-post-grid.ts).
  const postCellWidth = searchPostGridCellWidth(searchPostGridColumns(fontScale));
  const isFocused = useIsFocused();
  // The floating tab bar stays mounted above this overlay, so the results list
  // needs the same clearance the feed itself uses or the last row never
  // scrolls out from underneath it.
  const tabBarMetrics = getMagicTabBarMetrics(width, insets.bottom);
  const { mounted, animatedStyle } = useOverlayPresence(visible);
  const inputRef = useRef<TextInput>(null);
  const resultsScrollRef = useRef<ScrollView>(null);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  // The query of the request last scheduled. A change of tab alone means the
  // person has stopped typing, so its request skips the debounce.
  const scheduledQuery = useRef<string | null>(null);
  // The key of a query committed with the Search key before its answer landed.
  const rememberOnAnswer = useRef<string | null>(null);
  // A completion just chosen: its search is committed as the Search key commits one.
  const committedCompletion = useRef<string | null>(null);
  // The query the person settled on: the Search key, a suggestion pressed, a
  // recent search opened. A search for it is asked with related posts
  // (public-search-policy.ts, "Related posts"); one still being typed is not.
  // The ref is read as a request is sent, the state by the wait after an
  // answer: a request that read the state would be made again when it changed.
  const settledQueryAtSend = useRef<string | null>(null);
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
  const settleOn = (settled: string) => {
    settledQueryAtSend.current = settled;
    setSettledQuery(settled);
  };
  const [query, setQuery] = useState('');
  // The field has the focus, which on a phone is the keyboard being up.
  const [inputFocused, setInputFocused] = useState(false);
  // The tab the person picked. It stays picked whatever the length of the
  // query: a tab not searched yet shows the idle state (searchTabRuns).
  const [pickedType, setPickedType] = useState<PublicSearchType>('top');
  // The order picked for Posts and Recipes, kept across the two tabs.
  const [pickedSort, setPickedSort] = useState<PublicSearchSort>('top');
  // What narrows Posts, kept across tabs as the order is and read only on Posts.
  const [pickedFilters, setPickedFilters] = useState<SearchFilters>(NO_SEARCH_FILTERS);
  // Filters are offered once an answer has said which it applied. A server
  // from before filters says nothing and narrows nothing, so there the
  // switches would change nothing and are not drawn.
  const [filtersOffered, setFiltersOffered] = useState(false);
  // The query the person asked to have read as typed ("search instead for").
  // It belongs to that query: another one is corrected again where it needs to be.
  const [exactQuery, setExactQuery] = useState<string | null>(null);
  // The name of each entity an answer or a pressed result has given, by its id.
  const [entityLabels, setEntityLabels] = useState<Record<string, string>>({});
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [failure, setFailure] = useState<SearchFailure | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const normalizedQuery = useMemo(() => normalizeSearchHistoryQuery(query), [query]);
  const countedLength = searchQueryLength(normalizeCreatorSearchQuery(normalizedQuery));
  const type: PublicSearchType = pickedType;
  // The Top tab and Creators have one order, whatever was picked on another tab.
  const sort: PublicSearchSort = isContentType(type) ? pickedSort : 'top';
  // A visitor or a guest follows nobody, and the server would leave the filter
  // out. One object for as long as nothing it is made of changes: the search
  // below is asked again whenever it is another.
  const narrowsPosts = type === 'posts' && filtersOffered;
  const filters: SearchFilters = useMemo(() => {
    if (!narrowsPosts) return NO_SEARCH_FILTERS;
    return canFollow || !pickedFilters.following ? pickedFilters : { ...pickedFilters, following: false };
  }, [canFollow, narrowsPosts, pickedFilters]);
  // Creators are never corrected: there the exact reading changes nothing and is not asked for.
  const exact = type !== 'creators' && exactQuery !== null && exactQuery === normalizedQuery;
  const narrowing = searchFilterKey(filters, exact);
  // Top and Creators from two characters, Posts and Recipes from three.
  const requestKey = searchTabRuns(type, countedLength) ? searchKey(normalizedQuery, type, sort, narrowing) : null;
  const response = answer && answer.key === requestKey ? answer.response : null;
  const shownFailure = failure && failure.key === requestKey ? failure : null;
  // The answer on hand for this query and tab in the other order, or under
  // other filters or the other reading, if any.
  const otherOrder = !response && requestKey !== null && answer !== null
    && answer.scope === searchScope(normalizedQuery, type) ? answer.response : null;
  // While the other order of the same search loads, its cards stay up, dimmed,
  // with the control on them: the two orders hold the same results, and a
  // spinner in their place would take the control from under the finger. The
  // same goes for a filter just switched: the cards it narrows stay under the
  // switches until its answer lands. A request that failed is no longer
  // loading: the cards go, and the failed search is drawn as any other is,
  // with Retry.
  const reordering = otherOrder !== null && !shownFailure;
  const shownResponse = response ?? (reordering ? otherOrder : null);
  const resultCount = shownResponse ? shownResultCount(shownResponse, type, normalizedQuery) : 0;
  // Latest is offered once an answer says which order it is in. A server from
  // before sorts says nothing and reads every search ranked, so there the
  // control would change nothing and is not drawn.
  const sortOffered = isContentType(type) && (shownResponse ?? otherOrder)?.sort !== undefined;
  const shownSort = sortOffered ? sort : null;
  const retryBlocked = Boolean(shownFailure?.retryAfterSeconds);
  // How this search read the query, said only of its own answer.
  const correctionNotice = response ? searchCorrectionNotice(response.correctedQuery, type) : null;
  const exactNotice = response && exact ? searchExactNotice(normalizedQuery) : null;
  const filtersShown = requestKey !== null && type === 'posts' && filtersOffered;
  // The made-with filter by the name an answer or a pressed result gave it, by its key until then.
  const madeWithLabel = !filters.madeWith
    ? null
    : (response?.filters?.madeWith?.label
      ?? entityLabels[filters.madeWith]
      ?? parseSearchEntityId(filters.madeWith)?.key
      ?? null);
  const entities = shownResponse ? offeredEntities(shownResponse, type, normalizedQuery) : [];
  const nextCursor = !response
    ? null
    : type === 'creators'
      ? response.creators.nextCursor
      : type === 'posts'
        ? response.posts.nextCursor
        : type === 'recipes'
          ? response.recipes.nextCursor
          : null;

  // Typeahead: what the field offers while the person types, drawn above the
  // results, which load as they did. Only while the field has the focus: once
  // the keyboard is put away to read the results, the list is gone with it.
  const typeahead = useSearchTypeahead({
    api,
    text: query,
    active: visible && inputFocused,
    viewerKey: user?.id ?? null,
  });

  // Recent searches keep what the person acted on, never each pause in typing.
  const rememberQuery = useCallback((value: string) => {
    void rememberSearchQuery(value).then(setHistory);
  }, []);
  // A search the answer read as something else is kept as it was read
  // ("portrait" for "portriat"), unless the person asked for it as typed.
  const historyQuery = searchHistoryQueryFor({
    query: normalizedQuery,
    type,
    correctedQuery: response?.correctedQuery,
    exact,
  });

  const requestClose = useCallback(() => {
    // Leaving with results on screen keeps the query; one that found nothing,
    // or is still unanswered, is not kept.
    if (shownResponse && resultCount > 0) rememberQuery(historyQuery);
    // Dismissing the keyboard alongside the fade keeps close reading as one
    // gesture instead of two staggered ones.
    Keyboard.dismiss();
    onClose();
  }, [historyQuery, onClose, rememberQuery, resultCount, shownResponse]);

  // Android's back key closes the search only while this screen is the one
  // showing. A result tap pushes the post over the tabs with the search still
  // open underneath, and an unfocused claim would run ahead of the navigator,
  // close the search out of sight, and swallow the press meant for the post.
  useHardwareBack(visible && isFocused, requestClose);

  useEffect(() => {
    if (!visible) {
      requestSequence.current += 1;
      requestController.current?.abort();
      return;
    }
    void readSearchHistory().then(setHistory);
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(focusTimer);
  }, [visible]);

  // Related posts can come with the search in front (the first page of it).
  const relatedApplies = requestKey !== null && searchRelatedApplies({
    query: normalizedQuery,
    type,
    sort,
    narrowing,
    queryLength: countedLength,
    laterPage: false,
  });

  // `relatedFollowUp`: the search in front asked again for its related posts,
  // over the answer on hand. That answer stays whatever becomes of the
  // request: its failure is not the search's, and is drawn as nothing.
  const runSearch = useCallback(async (cursor: string | null = null, relatedFollowUp = false) => {
    if (!requestKey) return;
    const key = requestKey;
    const scope = searchScope(normalizedQuery, type);
    // Asked for with the search a person has settled on, and by the follow-up; never for a later page.
    const askRelated = relatedApplies && !cursor && (relatedFollowUp || settledQueryAtSend.current === normalizedQuery);
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (cursor) setLoadingMore(true);
    if (!relatedFollowUp) setFailure(null);
    try {
      const next = await api.searchPublicContent({ query: normalizedQuery, type, sort, filters, exact, cursor, related: askRelated }, controller.signal);
      if (sequence !== requestSequence.current) return;
      if (next.filters !== undefined) setFiltersOffered(true);
      // The names this answer gives: its entities, and the one its filter is read with.
      const named = [...(next.entities ?? []), ...(next.filters?.madeWith ? [next.filters.madeWith] : [])];
      if (named.length) {
        setEntityLabels((current) => ({
          ...current,
          ...Object.fromEntries(named.map((entity) => [searchEntityId(entity), entity.label])),
        }));
      }
      if (cursor) {
        setAnswer((current) => current?.key === key ? {
          key,
          scope,
          relatedAsked: current.relatedAsked,
          response: {
            ...next,
            creators: type === 'creators' ? { ...next.creators, items: [...current.response.creators.items, ...next.creators.items] } : next.creators,
            posts: type === 'posts' ? { ...next.posts, items: [...current.response.posts.items, ...next.posts.items] } : next.posts,
            recipes: type === 'recipes' ? { ...next.recipes, items: [...current.response.recipes.items, ...next.recipes.items] } : next.recipes,
          },
        } : current);
        return;
      }
      setAnswer({ key, scope, response: next, relatedAsked: askRelated });
      if (rememberOnAnswer.current === key) {
        rememberOnAnswer.current = null;
        if (shownResultCount(next, type, normalizedQuery) > 0) {
          rememberQuery(searchHistoryQueryFor({ query: normalizedQuery, type, correctedQuery: next.correctedQuery, exact }));
        }
      }
    } catch (requestError) {
      if (controller.signal.aborted || (requestError instanceof Error && requestError.name === 'AbortError')) return;
      if (sequence !== requestSequence.current) return;
      if (relatedFollowUp) {
        // The answer on hand stands, and is not asked about again.
        setAnswer((current) => (current?.key === key ? { ...current, relatedAsked: true } : current));
        return;
      }
      setFailure({ key, ...describeSearchFailure(requestError) });
    } finally {
      if (sequence === requestSequence.current) setLoadingMore(false);
    }
  }, [api, exact, filters, normalizedQuery, relatedApplies, rememberQuery, requestKey, sort, type]);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    // A completion chosen from the typeahead is committed as its search is asked.
    if (committedCompletion.current !== null) {
      if (committedCompletion.current === normalizedQuery && requestKey) rememberOnAnswer.current = requestKey;
      committedCompletion.current = null;
    }
    // A commit belongs to the query it was made on.
    if (rememberOnAnswer.current !== requestKey) rememberOnAnswer.current = null;
    if (!visible) return;
    if (!requestKey) {
      requestSequence.current += 1;
      scheduledQuery.current = null;
      // A page still loading is dropped with its query; the answer kept for
      // that query must not come back with a stuck Show more.
      setLoadingMore(false);
      return;
    }
    const delay = scheduledQuery.current === normalizedQuery ? 0 : SEARCH_DEBOUNCE_MS;
    scheduledQuery.current = normalizedQuery;
    const timer = setTimeout(() => void runSearch(), delay);
    return () => clearTimeout(timer);
  }, [normalizedQuery, requestKey, runSearch, visible]);

  // A 429 names how long its window lasts; Retry comes back when it has passed.
  useEffect(() => {
    const seconds = failure?.retryAfterSeconds;
    if (!failure || !seconds) return;
    const timer = setTimeout(() => {
      setFailure((current) => (current === failure ? { ...failure, retryAfterSeconds: null } : current));
    }, seconds * 1000);
    return () => clearTimeout(timer);
  }, [failure]);

  // The Search key commits the query: it is kept now if its answer found
  // something, or when an answer still on its way does.
  const submitSearch = () => {
    // The search is what is typed: the typeahead gets out of its way.
    typeahead.close();
    if (!requestKey) return;
    settleOn(normalizedQuery);
    if (!response) {
      rememberOnAnswer.current = requestKey;
      return;
    }
    if (resultCount > 0) rememberQuery(historyQuery);
  };

  const openResult = () => rememberQuery(historyQuery);

  // An entity pressed among the results: Posts, narrowed to it and to nothing
  // else, named at once. Its count is of the posts this query finds with it,
  // so a switch left on from an earlier look at Posts would open fewer than
  // the row said.
  const pickEntity = (entity: SearchEntity) => {
    setEntityLabels((current) => ({ ...current, [searchEntityId(entity)]: entity.label }));
    setPickedFilters({ ...NO_SEARCH_FILTERS, madeWith: searchEntityId(entity) });
    setPickedType('posts');
  };

  // A row of the typeahead. The keyboard stays up for the press (the list is
  // in the scroll view below, which hands a tap to what it lands on), and is
  // put away after a choice that leads to results, so they are not under it.
  const pickSuggestion = (row: SearchTypeaheadRow) => {
    const action = typeahead.press(row);
    // A press that does not count: the row had only just come under the finger.
    if (!action) return;
    if (action.type === 'creator') {
      router.push(`/creators/${encodeURIComponent(action.username)}` as never);
      return;
    }
    Keyboard.dismiss();
    if (action.type === 'entity') {
      // As pressing the entity among the results does. An answer that offers
      // entities comes from a server that narrows by them.
      setFiltersOffered(true);
      pickEntity(action.entity);
      return;
    }
    // A completion fills the field and is searched at once, with no pause for
    // typing, and is committed as the Search key commits a search.
    const next = normalizeSearchHistoryQuery(action.query);
    scheduledQuery.current = next;
    committedCompletion.current = next;
    // The person settled on it: its request asks for related posts with the
    // search, and an answer already on hand for this very text is asked about at once.
    settleOn(next);
    setQuery(action.query);
  };

  // The list is the first thing in the results' scroll view, so it is in view
  // only at the top: the field focused again after the results were scrolled
  // would offer it off-screen. It is brought into view whenever it is shown.
  // Chosen over pinning it under the field, outside the scrolled content: a
  // pinned panel of up to fourteen rows would need a scroll of its own inside
  // the half of the screen the keyboard leaves and would cover the results it
  // now only pushes down, and the scroll view is what keeps the keyboard up
  // for a press on a row.
  const typeaheadShown = typeahead.shown;
  useEffect(() => {
    if (typeaheadShown) resultsScrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [typeaheadShown]);

  // Said to a screen reader when the list opens or its count changes.
  const typeaheadStatus = typeahead.status;
  useEffect(() => {
    if (typeaheadStatus) AccessibilityInfo.announceForAccessibility(typeaheadStatus);
  }, [typeaheadStatus]);

  // Related posts: the group the answer in front brings, and when to ask for
  // it over an answer that came without (the shared rule,
  // searchRelatedFollowUpDelay): at once for a search the person has settled
  // on, after a pause with the search left alone otherwise, only where the
  // answer is thin, and once.
  const relatedPosts = shownResponse ? searchRelatedPosts(type, shownResponse) : NO_RELATED_POSTS;
  const relatedFollowUpDelay = answer !== null && answer.key === requestKey && visible
    ? searchRelatedFollowUpDelay({
      applies: relatedApplies,
      relatedAsked: answer.relatedAsked,
      thin: isSearchAnswerThin(type, answer.response.posts),
      settled: settledQuery === normalizedQuery,
    })
    : null;
  useEffect(() => {
    if (relatedFollowUpDelay === null) return;
    const timer = setTimeout(() => void runSearch(null, true), relatedFollowUpDelay);
    return () => clearTimeout(timer);
  }, [relatedFollowUpDelay, runSearch]);
  // They can arrive after the results a screen reader has already been through: said when they do.
  const relatedStatus = response ? searchRelatedStatus(searchRelatedPosts(type, response).length) : '';
  useEffect(() => {
    if (relatedStatus) AccessibilityInfo.announceForAccessibility(relatedStatus);
  }, [relatedStatus]);

  // Android reads the notice from its live region; iOS has none, so the line is announced.
  const announcedNotice = correctionNotice ?? exactNotice;
  useEffect(() => {
    if (announcedNotice && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(announcedNotice);
  }, [announcedNotice]);

  if (!mounted) return null;

  return (
    <MotionView
      pointerEvents={visible ? 'auto' : 'none'}
      style={[{ position: 'absolute', inset: 0, zIndex: 20 }, animatedStyle]}
    >
    <KeyboardAvoidingArea
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: appTheme.spacing.screen, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close search" onPress={requestClose} hitSlop={10} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <BackGlyph size={appTheme.icon.feature} color={theme.colors.text} />
          </Pressable>
          <View style={{ minHeight: 50, minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceInset, paddingHorizontal: 15 }}>
            <Search size={appTheme.icon.default} color={theme.colors.muted} />
            <TextInput
              ref={inputRef}
              accessibilityLabel={SEARCH_FIELD_LABEL}
              autoCapitalize="none"
              autoCorrect={false}
              enterKeyHint="search"
              maxLength={100}
              onBlur={() => setInputFocused(false)}
              onChangeText={setQuery}
              onFocus={() => setInputFocused(true)}
              onSubmitEditing={submitSearch}
              placeholder={SEARCH_PLACEHOLDER}
              placeholderTextColor={theme.colors.faint}
              returnKeyType="search"
              value={query}
              style={{ minWidth: 0, flex: 1, color: theme.colors.text, fontSize: 15, paddingVertical: 12 }}
            />
            {query ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={SEARCH_CLEAR_FIELD_LABEL}
                onPress={() => setQuery('')}
                style={{ minWidth: 44, minHeight: 44, marginRight: -13, alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={appTheme.icon.compact} color={theme.colors.muted} />
              </Pressable>
            ) : null}
          </View>
        </View>
        <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 3, paddingTop: 10 }} accessibilityRole="tablist">
          {SEARCH_TABS.map((item) => (
            <SearchTab
              key={item.id}
              active={type === item.id}
              label={item.label}
              onPress={() => setPickedType(item.id)}
            />
          ))}
        </ScrollView>
      </View>

      <ScrollView
        ref={resultsScrollRef}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          flexGrow: 1,
          gap: 22,
          padding: appTheme.spacing.screen,
          paddingBottom: tabBarMetrics.contentBottomOverlapPadding + appTheme.spacing.section,
        }}
      >
        {/* Above everything the search itself draws, in every state of it: the
            person is still typing, and what completes the typing comes first.
            It takes no room once it has nothing to offer or the keyboard is down. */}
        {typeahead.shown ? <SearchTypeaheadList sections={typeahead.sections} busy={typeahead.busy} settlingRows={typeahead.settlingRows} onPick={pickSuggestion} /> : null}
        {filtersShown ? (
          <SearchFilterBar
            filters={filters}
            madeWithLabel={madeWithLabel}
            followingOffered={canFollow}
            onChange={setPickedFilters}
          />
        ) : null}
        {correctionNotice ? (
          <ReadingNotice
            line={correctionNotice}
            actionLabel={searchInsteadLabel(normalizedQuery)}
            onAction={() => setExactQuery(normalizedQuery)}
          />
        ) : exactNotice ? (
          <ReadingNotice line={exactNotice} actionLabel={SEARCH_CORRECTED_AGAIN_LABEL} onAction={() => setExactQuery(null)} />
        ) : null}
        {!requestKey ? (
          history.length ? (
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 17, fontWeight: '800' }}>{SEARCH_RECENTS_HEADING}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={SEARCH_RECENTS_CLEAR_ACTION_LABEL}
                  onPress={() => void clearSearchHistory().then(() => setHistory([]))}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '700' }}>{SEARCH_RECENTS_CLEAR_LABEL}</Text>
                </Pressable>
              </View>
              {history.map((item) => (
                <View key={item} style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={searchRecentAgainLabel(item)}
                    onPress={() => { settleOn(normalizeSearchHistoryQuery(item)); setQuery(item); }}
                    style={{ minHeight: 46, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                  >
                    <Clock3 size={appTheme.icon.sm} color={theme.colors.faint} />
                    <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 15 }}>{item}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={searchRecentRemoveLabel(item)}
                    onPress={() => void forgetSearchQuery(item).then(setHistory)}
                    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <X size={appTheme.icon.sm} color={theme.colors.faint} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : (
            <StatusBlock title={SEARCH_IDLE_TITLE} body={SEARCH_IDLE_BODY} />
          )
        ) : shownResponse && resultCount > 0 ? (
          <View style={{ gap: 25 }}>
            {entities.length ? (
              <View style={{ gap: 10 }}>
                <ResultsHeading title={SEARCH_ENTITIES_HEADING} sort={null} onSortChange={setPickedSort} />
                {entities.map((entity) => (
                  <EntityRow key={searchEntityId(entity)} entity={entity} onPick={() => pickEntity(entity)} />
                ))}
              </View>
            ) : null}
            {(type === 'top' || type === 'creators') && shownResponse.creators.items.length ? (
              <View style={{ gap: 10 }}>
                <ResultsHeading title="Creators" sort={null} onSortChange={setPickedSort} seeAll={type === 'top' ? { section: 'creators', onPress: () => setPickedType('creators') } : null} />
                {shownResponse.creators.items.map((creator) => <CreatorRow key={creator.id} creator={creator} onOpen={openResult} />)}
                {type === 'top' && searchTopSectionHasMore('creators', shownResponse.creators.items.length)
                  ? <SeeAllButton section="creators" onPress={() => setPickedType('creators')} />
                  : null}
              </View>
            ) : null}
            {(type === 'top' || type === 'posts') && shownResponse.posts.items.length ? (
              <View style={{ gap: 10 }}>
                <ResultsHeading title="Posts" sort={type === 'posts' ? shownSort : null} onSortChange={setPickedSort} seeAll={type === 'top' ? { section: 'posts', onPress: () => setPickedType('posts') } : null} />
                <View
                  accessibilityState={{ busy: reordering }}
                  style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, opacity: reordering ? appTheme.opacity.disabled : 1 }}
                >
                  {shownResponse.posts.items.map((post) => <View key={post.id} style={{ width: postCellWidth }}><PostRow item={post} onOpen={openResult} /></View>)}
                </View>
                {type === 'top' && searchTopSectionHasMore('posts', shownResponse.posts.items.length)
                  ? <SeeAllButton section="posts" onPress={() => setPickedType('posts')} />
                  : null}
              </View>
            ) : null}
            {(type === 'top' || type === 'recipes') && shownResponse.recipes.items.length ? (
              <View style={{ gap: 10 }}>
                <ResultsHeading title="Recipes" sort={type === 'recipes' ? shownSort : null} onSortChange={setPickedSort} seeAll={type === 'top' ? { section: 'recipes', onPress: () => setPickedType('recipes') } : null} />
                <View accessibilityState={{ busy: reordering }} style={{ gap: 10, opacity: reordering ? appTheme.opacity.disabled : 1 }}>
                  {shownResponse.recipes.items.map((recipe) => <RecipeRow key={recipe.id} recipe={recipe} onOpen={openResult} />)}
                </View>
                {type === 'top' && searchTopSectionHasMore('recipes', shownResponse.recipes.items.length)
                  ? <SeeAllButton section="recipes" onPress={() => setPickedType('recipes')} />
                  : null}
              </View>
            ) : null}
            {nextCursor ? <SecondaryButton disabled={loadingMore || retryBlocked} label={loadingMore ? SEARCH_LOADING_MORE_LABEL : SEARCH_SHOW_MORE_LABEL} onPress={() => void runSearch(nextCursor)} /> : null}
            <RelatedPosts posts={relatedPosts} cellWidth={postCellWidth} onOpen={openResult} />
            {shownFailure ? <Text accessibilityRole="alert" style={{ color: theme.colors.danger, textAlign: 'center', fontSize: 13 }}>{searchFailedLine(shownFailure.message)}</Text> : null}
          </View>
        ) : shownFailure ? (
          <View style={{ gap: 12 }}>
            {/* The order that failed keeps its control, so the other one, whose
                results were on screen a moment ago, is one press away. */}
            {shownSort && (type === 'posts' || type === 'recipes') ? (
              <ResultsHeading title={type === 'posts' ? 'Posts' : 'Recipes'} sort={shownSort} onSortChange={setPickedSort} />
            ) : null}
            <StatusBlock tone="danger" title={SEARCH_FAILED_TITLE} body={shownFailure.message} />
            <SecondaryButton disabled={retryBlocked} label={SEARCH_RETRY_LABEL} onPress={() => void runSearch()} />
          </View>
        ) : response && !searchSaysNoResults(countedLength) ? (
          // Half a word is no verdict: a two-character search that finds no
          // creator leaves the screen as it was before typing.
          <StatusBlock title={SEARCH_IDLE_TITLE} body={SEARCH_IDLE_BODY} />
        ) : response ? (
          <View style={{ gap: 25 }}>
            <StatusBlock
              title={searchNoResultsTitle(normalizedQuery)}
              body={hasSearchFilters(filters) ? SEARCH_FILTERED_EMPTY_BODY : SEARCH_NO_RESULTS_BODY}
            />
            <RelatedPosts posts={relatedPosts} cellWidth={postCellWidth} onOpen={openResult} />
          </View>
        ) : (
          <View style={{ minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={{ color: theme.colors.muted, fontSize: 13 }}>{SEARCH_SEARCHING_LABEL}</Text>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingArea>
    </MotionView>
  );
}
