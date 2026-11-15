import { Image } from 'expo-image';
import { router } from 'expo-router';
import { BookOpen, Box, Clock3, Search, Wrench, X } from 'lucide-react-native';
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
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { Reveal } from '@/components/reveal';
import { useSearchEntrance } from '@/components/search-entrance';
import { SearchCreatorHandleLine } from '@/components/search-creator-handle-line';
import { SearchFollowButton, SearchFollowFailedLine } from '@/components/search-follow-button';
import { SearchPostMasonry } from '@/components/search-post-masonry';
import { SearchRowPicture } from '@/components/search-row-picture';
import { SearchStarterSections } from '@/components/search-starter-sections';
import { SearchTypeaheadList } from '@/components/search-typeahead-list';
import { ChoiceChip, CreatorAvatar, SecondaryButton, SegmentedControl, StatusBlock } from '@/components/ui';
import { BackGlyph } from '@/lib/platform-glyphs';
import { creatorProfilePress } from '@/lib/creator-profile-opening';
import { ApiError, type MagicbookletApiClient } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { useReducedMotion } from '@/lib/motion';
import { searchFieldRestingFrame, type SearchEntranceOrigin } from '@/lib/search-entrance';
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
  shownRecentSearches,
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
  type SearchOpenedResult,
  searchInsteadLabel,
  searchMadeWithChipLabel,
  searchMadeWithRemoveLabel,
  searchEmptyTabPointer,
  searchEmptyTabPointerLine,
  searchEmptyTabTitle,
  searchNoResultsTitle,
  searchSeeTabLabel,
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
  searchEntityPicturesWith,
  type SearchEntity,
  type SearchFilters,
  type SearchThumbnail,
  type SearchRelatedSearch,
  type SearchTopSection,
} from '@/lib/public-search-policy/public-search-policy';
import {
  SEARCH_STARTER_NO_RESULTS_HEADING,
  isSearchStarterEmpty,
  searchStarterEntityAction,
  type SearchStarterCreator,
  type SearchStarterEntity,
  type SearchStarterSearch,
} from '@/lib/public-search-policy/search-starter';
import { useSearchStarterState } from '@/lib/use-search-starter';
import { appendSearchPosts, isSearchAnswerBlended, isSearchPageAllRepeats, searchEntrySettles } from '@/lib/public-search-policy/search-blend';
import { searchTypeaheadQuery, type SearchTypeaheadRow } from '@/lib/public-search-policy/search-typeahead';
import { searchEntryForChosenText, type SearchEntry, type SearchOpenKind } from '@/lib/public-search-policy/search-open-log';
import { SEARCH_RELATED_SEARCHES_HEADING } from '@/lib/public-search-policy/search-ui-words';
import { reportSearchOpen } from '@/lib/search-open-report';
import { searchScreenHref } from '@/lib/search-screen-route';
import { searchRelatedSearchChips, searchRequestExtras, searchTypeaheadEntityRoute } from '@/lib/search-screen-view-model';
import { useSearchCreatorFollow } from '@/lib/use-search-creator-follow';
import {
  clearSearchHistory,
  forgetSearchQuery,
  normalizeCreatorSearchQuery,
  normalizeSearchHistoryQuery,
  readSearchHistory,
  rememberSearchQuery,
  searchQueryLength,
} from '@/lib/search-history';
import { searchCreatorFollowStacks } from '@/lib/search-creator-row';
import { searchPostGridColumns } from '@/lib/search-post-grid';
import {
  searchAsksForResults,
  searchModeAfter,
  searchScreenBody,
  searchTabPressCommits,
  type SearchModeEvent,
  type SearchScreenMode,
} from '@/lib/search-typing-mode';
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
import { useSearchTypeahead } from '@/lib/use-search-typeahead';
import { formatUnlockCreditPrice } from '@/lib/pricing';

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

// Top's results by kind, and the query and reading they are for.
// What an empty tab reads from Top's answer: each kind's results (searchEmptyTabPointer).
type TopSections = Pick<PublicSearchResponse, 'creators' | 'posts' | 'recipes'>;
function topSectionsOf(response: PublicSearchResponse): TopSections {
  return { creators: response.creators, posts: response.posts, recipes: response.recipes };
}
function topCountsKey(query: string, exact: boolean) {
  return `${exact ? 'exact' : 'read'}:${query}`;
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
  busy = false,
}: {
  title: 'Creators' | 'Posts' | 'Recipes' | typeof SEARCH_ENTITIES_HEADING | typeof SEARCH_RELATED_HEADING;
  /**
   * The cards under this heading are the other order's, or the ones a filter
   * just switched narrows, until the answer lands: a small spinner beside the
   * title says so. The cards themselves stay at full strength (owner,
   * 2026-11-16: nothing in search dims).
   */
  busy?: boolean;
  /** Null where the results have one order, or the server has not said it reads another. */
  sort: PublicSearchSort | null;
  onSortChange: (sort: PublicSearchSort) => void;
  seeAll?: { section: SearchTopSection; onPress: () => void } | null;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text accessibilityRole="header" style={{ flexShrink: 1, color: theme.colors.text, fontSize: 18, fontWeight: '800' }}>{title}</Text>
        {busy ? <ActivityIndicator testID="search-results-busy" size="small" color={theme.colors.muted} /> : null}
      </View>
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

// Searches near this one (`relatedSearches`, 2026-11-15) over a Top or Posts
// answer: one row of chips that scrolls sideways, as the filters do, each
// searching its text. Nothing for an answer without them.
function RelatedSearches({ searches, onSearch }: { searches: readonly SearchRelatedSearch[]; onSearch: (text: string) => void }) {
  const theme = useAppTheme();
  if (searches.length === 0) return null;
  return (
    <View testID="search-related-searches" style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '800' }}>
        {SEARCH_RELATED_SEARCHES_HEADING}
      </Text>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginHorizontal: -appTheme.spacing.screen }}
        contentContainerStyle={{ alignItems: 'center', gap: 8, paddingHorizontal: appTheme.spacing.screen }}
      >
        {searches.map((search) => (
          <Pressable
            key={search.text}
            accessibilityRole="button"
            accessibilityLabel={`Search for ${search.text}`}
            testID="search-related-search"
            onPress={() => onSearch(search.text)}
            style={({ pressed }) => ({
              minHeight: appTheme.touch.default,
              maxWidth: 260,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              borderRadius: appTheme.radii.pill,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface,
              opacity: pressed ? appTheme.opacity.pressed : 1,
              paddingHorizontal: 14,
              paddingVertical: 6,
            })}
          >
            <Search size={appTheme.icon.xs} color={theme.colors.muted} />
            {/* Two lines at the largest sizes; its name holds the whole search. */}
            <Text numberOfLines={2} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 14, fontWeight: '700' }}>{search.text}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

// A model or tool as a result: pressing it shows the posts made with it.
function EntityRow({ entity, thumbnail, onPick }: {
  entity: SearchEntity;
  /** The picture the screen holds for it (searchEntityPicturesWith): a search's own answer carries none. */
  thumbnail: SearchThumbnail | null;
  onPick: () => void;
}) {
  const theme = useAppTheme();
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
      {/* The frame the start screen and the typing list draw a model in: its picture where the
          screen holds one, its kind's glyph in the same frame otherwise. */}
      <SearchRowPicture thumbnail={entity.thumbnail ?? thumbnail} size={40} Icon={entity.kind === 'model' ? Box : Wrench} testID="search-entity-picture" />
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

// Where a creator row's text starts: the row's padding, the avatar and the gap
// after it. Follow stood under the name starts there too.
const CREATOR_ROW_PADDING = 13;
const CREATOR_ROW_AVATAR = 48;
const CREATOR_ROW_TEXT_INSET = CREATOR_ROW_PADDING + CREATOR_ROW_AVATAR + 13;

// Follow is a control on the row (2026-11-15: follow from the list, as
// Pinterest, X and Instagram let a person do), no longer a state the row only
// shows while Follow lives on the profile. It follows in place, beside the
// row's press: the row still opens the profile, and the button's press neither
// opens it nor reports an open (components/search-follow-button.tsx). Its
// state still tells apart two creators with one name, as the web's card does.
// At the accessibility text sizes it stands under the name, where its words
// have the row's width (searchCreatorFollowStacks; review of #828, S9).
function CreatorRow({ creator, onOpen, followReturnTo }: { creator: CreatorSearchResult; onOpen: () => void; followReturnTo: string }) {
  const theme = useAppTheme();
  const followStacks = searchCreatorFollowStacks(useWindowDimensions().fontScale);
  const follow = useSearchCreatorFollow(creator, { returnTo: followReturnTo });
  // One line, as on the web card, where the browser folds a bio's line breaks
  // into spaces.
  const bio = creator.bio?.replace(/\s+/g, ' ').trim();
  const opener = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={searchCreatorCardLabel({ ...creator, isFollowing: follow.following })}
      testID="search-creator-row"
      // Their page is read once the finger has rested here, never for a scroll
      // of the results that starts on the row (`creatorProfilePress`).
      {...creatorProfilePress(creator.username, () => {
        onOpen();
        router.push(`/creators/${encodeURIComponent(creator.username)}` as never);
      })}
      style={({ pressed }) => ({
        minHeight: 76,
        minWidth: 0,
        flex: followStacks ? undefined : 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 13,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        padding: CREATOR_ROW_PADDING,
      })}
    >
      <CreatorAvatar uri={creator.avatarUrl} name={creator.displayName} size={CREATOR_ROW_AVATAR} />
      <View style={{ minWidth: 0, flex: 1 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>{creator.displayName}</Text>
        <SearchCreatorHandleLine username={creator.username} postCount={creator.publicPostCount} />
        {bio ? <Text numberOfLines={1} style={{ marginTop: 2, color: theme.colors.faint, fontSize: 12 }}>{bio}</Text> : null}
      </View>
    </Pressable>
  );
  const followButton = follow.offered
    ? <SearchFollowButton creator={creator} following={follow.following} pending={follow.pending} onPress={follow.press} />
    : null;
  return (
    <View
      testID="search-creator-card"
      style={{
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
      }}
    >
      {followStacks ? (
        <>
          {opener}
          {followButton ? (
            // A row holding the button at its start, never a column drawn
            // `alignItems: 'flex-start'`: there the button, whose press grows to
            // fill it, came out 1,230 pt tall at AX3 on iOS (simulator, 2026-11-16).
            <View
              testID="search-creator-follow"
              style={{ flexDirection: 'row', paddingLeft: CREATOR_ROW_TEXT_INSET, paddingRight: CREATOR_ROW_PADDING, paddingBottom: CREATOR_ROW_PADDING }}
            >
              {followButton}
            </View>
          ) : null}
        </>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {opener}
          {followButton ? <View testID="search-creator-follow" style={{ paddingRight: CREATOR_ROW_PADDING }}>{followButton}</View> : null}
        </View>
      )}
      {follow.failed ? (
        <View style={{ paddingHorizontal: CREATOR_ROW_PADDING, paddingBottom: CREATOR_ROW_PADDING }}>
          <SearchFollowFailedLine />
        </View>
      ) : null}
    </View>
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
      accessibilityLabel={searchRecipeCardLabel({ title: recipe.title, sellerName: recipe.seller.name, price, summary: recipe.summary || recipe.previewText })}
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
const NO_RELATED_SEARCHES: readonly SearchRelatedSearch[] = [];

// Posts that mean what the query says without holding its words: the cards
// the search's own posts are, under everything the search itself found.
function RelatedPosts({ posts, columns, onOpen }: { posts: readonly ShowcaseFeedItem[]; columns: number; onOpen: (item: ShowcaseFeedItem) => void }) {
  if (posts.length === 0) return null;
  return (
    <View testID="search-related-posts" style={{ gap: 10 }}>
      <ResultsHeading title={SEARCH_RELATED_HEADING} sort={null} onSortChange={noSortChange} />
      <SearchPostMasonry items={posts} columns={columns} onOpen={onOpen} />
    </View>
  );
}
const noSortChange = () => {};

/**
 * The search screen's body: the field, its tabs, and what it draws under them
 * (typing, results, the start and the dead ends). Drawn by the pushed
 * `/search` route (`app/search.tsx`), which Home and Explore open: the
 * navigator gives it its entrance and exit, the back swipe and Android's back
 * key, and covers the tab bar (search UX audit 2026-11-13, finding 7).
 * `initialQuery` and `initialType` open it on a search, as a shared search
 * link would, with the order, filters and exact reading the link names
 * (`initialSort`, `initialFilters`, `initialExact`); without them it opens on
 * an empty field.
 */
/** The header's numbers, which also place the field before it is measured (lib/search-entrance.ts). */
const SEARCH_HEADER_TOP_GAP = 8;
const SEARCH_HEADER_LEADING_WIDTH = 44;
const SEARCH_HEADER_GAP = 10;
const SEARCH_FIELD_HEIGHT = 50;
/** The magnifier's place from the capsule's start, as Explore's bar draws it (its border and padding). */
const SEARCH_FIELD_ICON_INSET = 16;
/** How long the start waits for the ideas to start from before it draws the idle card instead. */
const SEARCH_START_HOLD_MS = 900;

export function ExploreSearchOverlay({
  api,
  onClose,
  visible,
  initialQuery = null,
  initialType = null,
  initialSort = null,
  initialFilters = null,
  initialExact = false,
  entranceFrom = null,
}: {
  api: MagicbookletApiClient;
  onClose: () => void;
  visible: boolean;
  initialQuery?: string | null;
  initialType?: PublicSearchType | null;
  initialSort?: PublicSearchSort | null;
  initialFilters?: SearchFilters | null;
  initialExact?: boolean;
  /**
   * The control search was opened from, for the field to grow out of
   * (lib/search-entrance.ts); null grows out of nothing (a search link).
   */
  entranceFrom?: SearchEntranceOrigin | null;
}) {
  const theme = useAppTheme();
  // The registered account, null for a visitor and for a guest session: the
  // only viewer "from creators I follow" means anything for.
  const { user } = useAuth();
  const canFollow = Boolean(user);
  const insets = useSafeAreaInsets();
  const { fontScale, width: windowWidth } = useWindowDimensions();
  // The field grows out of the pressed control while the keyboard rises, as
  // iOS's own Search does (lib/search-entrance.ts). The header's numbers below
  // place it before it is measured.
  const entrance = useSearchEntrance({
    origin: entranceFrom,
    reducedMotion: useReducedMotion(),
    restingFrame: searchFieldRestingFrame({
      windowWidth,
      topInset: insets.top,
      topGap: SEARCH_HEADER_TOP_GAP,
      screenPadding: appTheme.spacing.screen,
      leadingWidth: SEARCH_HEADER_LEADING_WIDTH,
      gap: SEARCH_HEADER_GAP,
      height: SEARCH_FIELD_HEIGHT,
    }),
    iconSize: appTheme.icon.default,
    iconInset: SEARCH_FIELD_ICON_INSET,
  });
  // The field has (nearly) arrived: taps are taken and the focus given from then.
  const entranceLanded = entrance.touchable;
  const exitEntrance = entrance.exit;
  // Two posts across, one at the accessibility text sizes (search-post-grid.ts).
  const postColumns = searchPostGridColumns(fontScale);
  // Opened on a search (a link's `q`): its results from the first render, when
  // the tab it names searches a text that long; a shorter one opens as any
  // opening does, its text in the field and the keyboard up (review of #795).
  const openedText = initialQuery ? normalizeSearchHistoryQuery(initialQuery) : '';
  const openedOn = openedText && searchTabRuns(initialType ?? 'top', searchQueryLength(normalizeCreatorSearchQuery(openedText))) ? openedText : '';
  // A link is not the person's commit (owner's track lead, review of #795): a
  // search it opens is kept among the recent ones only once the person opens a
  // result from it or presses Search themselves (searchHistoryQueryFor's rule).
  const committedByPerson = useRef(!openedOn);
  const inputRef = useRef<TextInput>(null);
  const resultsScrollRef = useRef<ScrollView>(null);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  // The key of a search committed before its answer landed: kept among the
  // recent searches when that answer finds something.
  const rememberOnAnswer = useRef<string | null>(null);
  // The query just committed: its key is known once it is drawn.
  const pendingCommit = useRef<string | null>(null);
  // How the query was entered, for the search log (search-open-log.ts): sent
  // with every search of it and with every result opened from it. It belongs
  // to the query, so a tab, an order or a filter leaves it alone; each commit
  // says how. A search the screen opened on came from a link.
  const openedEntry: SearchEntry | null = openedOn ? 'link' : null;
  const searchEntry = useRef<SearchEntry | null>(openedEntry);
  // The query the person settled on, by how it was entered (the shared
  // searchEntrySettles): asked with related posts at once and in the blended
  // order (public-search-policy.ts, "Related posts"; search-blend.ts). A
  // link's search and a model's or tool's row are not, until the person
  // commits them: the web's rule (review of #828, S6).
  // The ref is read as a request is sent, the state by the wait after an
  // answer: a request that read the state would be made again when it changed.
  const openedSettled = openedOn && searchEntrySettles(openedEntry) ? openedOn : null;
  const settledQueryAtSend = useRef<string | null>(openedSettled);
  const [settledQuery, setSettledQuery] = useState<string | null>(openedSettled);
  const settleOn = (settled: string | null) => {
    settledQueryAtSend.current = settled;
    setSettledQuery(settled);
  };
  const [query, setQuery] = useState(openedText);
  // Typing (suggestions in place of results) or results (lib/search-typing-mode.ts).
  const [mode, setMode] = useState<SearchScreenMode>(openedOn ? 'results' : 'typing');
  const moveMode = (event: SearchModeEvent) => setMode((current) => searchModeAfter(current, event));
  // Each opening starts in typing, as the field takes the focus: a search
  // closed on its results would otherwise send its search again and draw the
  // old results until then. Adjusted while rendering, so the opening's first
  // frame is already the typing list (and the closing keeps what it showed).
  const [openFor, setOpenFor] = useState(visible);
  if (openFor !== visible) {
    setOpenFor(visible);
    if (visible) moveMode('focus');
  }
  // The tab the person picked. It stays picked whatever the length of the
  // query: a tab not searched yet shows the idle state (searchTabRuns).
  const [pickedType, setPickedType] = useState<PublicSearchType>(initialType ?? 'top');
  // The order picked for Posts and Recipes, kept across the two tabs.
  const [pickedSort, setPickedSort] = useState<PublicSearchSort>(initialSort ?? 'top');
  // What narrows Posts, kept across tabs as the order is and read only on Posts.
  const [pickedFilters, setPickedFilters] = useState<SearchFilters>(initialFilters ?? NO_SEARCH_FILTERS);
  // Filters are offered once an answer has said which it applied. A server
  // from before filters says nothing and narrows nothing, so there the
  // switches would change nothing and are not drawn. A link that names them
  // was written where they were offered (searchScreenHref), as an entity's
  // row comes from a server that narrows by it.
  const [filtersOffered, setFiltersOffered] = useState(initialFilters !== null && hasSearchFilters(initialFilters));
  // The query the person asked to have read as typed ("search instead for").
  // It belongs to that query: another one is corrected again where it needs to be.
  const [exactQuery, setExactQuery] = useState<string | null>(initialExact && openedText ? openedText : null);
  // The name of each entity an answer or a pressed result has given, by its id.
  const [entityLabels, setEntityLabels] = useState<Record<string, string>>({});
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [failure, setFailure] = useState<SearchFailure | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  // The kept searches a removal brought into the shown five: each eases in as
  // it mounts. Read against the list last drawn (`drawnHistory`), so two quick
  // removals each name their own arrival (review of #812, 4).
  const [pulledInRecents, setPulledInRecents] = useState<readonly string[]>([]);
  const drawnHistory = useRef<readonly string[]>([]);
  useEffect(() => {
    drawnHistory.current = history;
  }, [history]);
  const removeRecent = (item: string) => {
    void forgetSearchQuery(item).then((next) => {
      const before = shownRecentSearches(drawnHistory.current);
      const arrived = shownRecentSearches(next).filter((entry) => !before.includes(entry));
      if (arrived.length) setPulledInRecents((current) => [...current, ...arrived]);
      setHistory(next);
    });
  };
  // Whether the recent searches have been read for this opening: until then
  // the start is not drawn, so the idle card never stands in for them.
  const [historyRead, setHistoryRead] = useState(false);
  // What Top found for a query, by kind: what an empty tab points to
  // (searchEmptyTabPointer, the web's rule). Kept from the Top answer on hand,
  // or from the one request an empty tab may make for it (`askedTopFor`).
  const [topCounts, setTopCounts] = useState<{ key: string; top: TopSections } | null>(null);
  const askedTopFor = useRef<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const normalizedQuery = useMemo(() => normalizeSearchHistoryQuery(query), [query]);
  // What the screen draws: the start (nothing typed), the typing list, or the committed search's results.
  const body = searchScreenBody({ mode, text: query });
  const showingResults = body === 'results';
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
  // Where a visitor's or a guest's Follow comes back to once they have signed
  // up: this search as it stands, words, tab, order and filters, as the web's
  // comes back to its search page (review of #828, S5). The start's is `/search`.
  const followReturnTo = searchScreenHref({ query: normalizedQuery, type, sort, filters, exact });
  // Top and Creators from two characters, Posts and Recipes from three.
  const requestKey = searchTabRuns(type, countedLength) ? searchKey(normalizedQuery, type, sort, narrowing) : null;
  const response = answer && answer.key === requestKey ? answer.response : null;
  // The posts on show, for a later page to be held against. Kept by an
  // effect, never written while rendering.
  const shownPosts = useRef<readonly ShowcaseFeedItem[]>([]);
  useEffect(() => {
    shownPosts.current = response?.posts.items ?? [];
  }, [response]);
  const shownFailure = failure && failure.key === requestKey ? failure : null;
  // The answer on hand for this query and tab in the other order, or under
  // other filters or the other reading, if any.
  const otherOrder = !response && requestKey !== null && answer !== null
    && answer.scope === searchScope(normalizedQuery, type) ? answer.response : null;
  // While the other order of the same search loads, its cards stay up, at full
  // strength, with the control on them and a small spinner by their heading: the two orders hold the same results, and a
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
  // How this search read the query, said only of its own answer, and only
  // while it is on screen: not while the person types over it.
  const correctionNotice = response && showingResults ? searchCorrectionNotice(response.correctedQuery, type) : null;
  const exactNotice = response && exact && showingResults ? searchExactNotice(normalizedQuery) : null;
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

  // Typeahead: what the field offers while the person types, drawn in place
  // of results until a search is committed. The keyboard put away by a drag
  // does not end it.
  // Whether the picked tab searches a text this long (searchTabRuns): a
  // commit of a shorter one is not offered and the Search key does nothing,
  // so typing goes on (review of #786: it led to the idle invitation).
  const tabRunsText = useCallback(
    (text: string, onType: PublicSearchType = type) => searchTabRuns(onType, searchQueryLength(normalizeCreatorSearchQuery(normalizeSearchHistoryQuery(text)))),
    [type],
  );
  const typeahead = useSearchTypeahead({
    api,
    text: query,
    active: visible && mode === 'typing',
    viewerKey: user?.id ?? null,
    history,
    runs: tabRunsText,
  });

  // Recent searches keep what the person acted on, never each pause in typing.
  const rememberQuery = useCallback((value: string) => {
    void rememberSearchQuery(value).then(setHistory);
  }, []);
  // Kept under the typed query, unless what the person committed to or
  // opened was shown under the corrected spelling (searchHistoryQueryFor).
  const historyQueryFor = (opened: SearchOpenedResult | null) => searchHistoryQueryFor({
    query: normalizedQuery,
    type,
    answer: response,
    exact,
    opened,
  });
  const historyQuery = historyQueryFor(null);

  const requestClose = useCallback(() => {
    // Leaving with results on screen keeps the query; one that found nothing,
    // or is still unanswered, is not kept.
    if (committedByPerson.current && showingResults && shownResponse && resultCount > 0) rememberQuery(historyQuery);
    keptOnLeave.current = null;
    // Dismissing the keyboard alongside the field going back into its
    // control keeps close reading as one gesture instead of two staggered ones.
    Keyboard.dismiss();
    exitEntrance(onClose);
  }, [exitEntrance, historyQuery, onClose, rememberQuery, resultCount, showingResults, shownResponse]);

  // Leaving by the navigator (the back swipe, Android's back key) keeps the
  // search on screen as the close button does: read as it leaves.
  const keptOnLeave = useRef<string | null>(null);
  useEffect(() => {
    keptOnLeave.current = committedByPerson.current && showingResults && shownResponse && resultCount > 0 ? historyQuery : null;
  });
  useEffect(() => () => {
    if (keptOnLeave.current) void rememberSearchQuery(keptOnLeave.current);
  }, []);

  useEffect(() => {
    if (!visible) {
      requestSequence.current += 1;
      requestController.current?.abort();
      return;
    }
    void readSearchHistory().then((read) => {
      setHistory(read);
      setHistoryRead(true);
    });
  }, [visible]);
  useEffect(() => {
    // Opened on a search, it shows the results; else the field takes the focus
    // as it lands from its control, and the keyboard follows straight on
    // (lib/search-entrance.ts, touchesAfterMs; it waited for the push to end
    // before).
    if (!visible || openedOn || !entranceLanded) return;
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(focusTimer);
  }, [entranceLanded, openedOn, visible]);

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
    const settled = settledQueryAtSend.current === normalizedQuery;
    const askRelated = relatedApplies && !cursor && (relatedFollowUp || settled);
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (cursor) setLoadingMore(true);
    if (!relatedFollowUp) setFailure(null);
    try {
      // Related searches with the first page, the blended order with every
      // page of a search it applies to (searchRequestExtras): the same search
      // asks for the same order however far down it is read.
      let next = await api.searchPublicContent({
        query: normalizedQuery, type, sort, filters, exact, cursor, related: askRelated,
        ...searchRequestExtras({ query: normalizedQuery, type, sort, exact, cursor, settled }),
        entry: searchEntry.current,
      }, controller.signal);
      if (sequence !== requestSequence.current) return;
      // A later page made of nothing but posts already on show, with more to
      // come (a later page may hold a post already shown:
      // searchPublicContent.laterPages): the page after it is asked for in
      // the same press, once, so the press shows something. If that one is
      // repeats as well the list keeps its cursor and the next press asks:
      // never a loop.
      if (cursor && type === 'posts' && isSearchPageAllRepeats(shownPosts.current, next.posts)) {
        const after = next.posts.nextCursor;
        next = await api.searchPublicContent({
          query: normalizedQuery, type, sort, filters, exact, cursor: after, related: false,
          ...searchRequestExtras({ query: normalizedQuery, type, sort, exact, cursor: after, settled }),
          entry: searchEntry.current,
        }, controller.signal);
        if (sequence !== requestSequence.current) return;
      }
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
            // Asked with the first page only: kept over the pages after it.
            relatedSearches: current.response.relatedSearches,
            creators: type === 'creators' ? { ...next.creators, items: [...current.response.creators.items, ...next.creators.items] } : next.creators,
            // Left out by id: the posts this page holds that are already on show.
            posts: type === 'posts' ? { ...next.posts, items: appendSearchPosts(current.response.posts.items, next.posts.items) } : next.posts,
            recipes: type === 'recipes' ? { ...next.recipes, items: [...current.response.recipes.items, ...next.recipes.items] } : next.recipes,
          },
        } : current);
        return;
      }
      setAnswer({ key, scope, response: next, relatedAsked: askRelated });
      if (type === 'top') setTopCounts({ key: topCountsKey(normalizedQuery, exact), top: topSectionsOf(next) });
      if (rememberOnAnswer.current === key) {
        rememberOnAnswer.current = null;
        if (shownResultCount(next, type, normalizedQuery) > 0) {
          rememberQuery(searchHistoryQueryFor({ query: normalizedQuery, type, answer: next, exact }));
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

  // A search is asked only once it is committed, and at once: there is no
  // pause for typing to wait out, since typing asks for suggestions alone.
  // Then again whenever the tab, the order or a filter changes it.
  const asksForResults = visible && searchAsksForResults(mode);
  useEffect(() => {
    // A commit is kept among the recent searches when its answer finds something.
    if (pendingCommit.current !== null) {
      if (pendingCommit.current === normalizedQuery && requestKey) rememberOnAnswer.current = requestKey;
      pendingCommit.current = null;
    }
    // A commit belongs to the query it was made on.
    if (rememberOnAnswer.current !== requestKey) rememberOnAnswer.current = null;
    if (!asksForResults || !requestKey) {
      // A search still on its way is dropped, not only left unread.
      requestSequence.current += 1;
      requestController.current?.abort();
      // A page still loading is dropped with its query; the answer kept for
      // that query must not come back with a stuck Show more.
      setLoadingMore(false);
      return;
    }
    void runSearch();
  }, [asksForResults, normalizedQuery, requestKey, runSearch]);

  // A 429 names how long its window lasts; Retry comes back when it has passed.
  useEffect(() => {
    const seconds = failure?.retryAfterSeconds;
    if (!failure || !seconds) return;
    const timer = setTimeout(() => {
      setFailure((current) => (current === failure ? { ...failure, retryAfterSeconds: null } : current));
    }, seconds * 1000);
    return () => clearTimeout(timer);
  }, [failure]);

  // A search committed: the Search key, the "Search for" row, a completion,
  // a recent search, a model or tool, a tab pressed while typing. The field
  // holds `text`, the keyboard goes, and the results are asked for at once;
  // they are kept among the recent searches when the answer finds something.
  // `onType` is the tab it is searched on, when a press picks it with the commit.
  // `entry` is how the text was entered: typed unless the press says otherwise.
  const commitSearch = (text: string, onType: PublicSearchType = type, entry: SearchEntry = 'typed') => {
    const next = normalizeSearchHistoryQuery(text);
    if (searchTypeaheadQuery(next) === null || !tabRunsText(next, onType)) return;
    searchEntry.current = entry;
    committedByPerson.current = true;
    pendingCommit.current = next;
    settleOn(searchEntrySettles(entry) ? next : null);
    if (text !== query) setQuery(text);
    moveMode('commit');
    Keyboard.dismiss();
  };
  const submitSearch = () => commitSearch(query);
  // A recent search pressed under the empty field: searched on the picked tab
  // when it searches a text this long, else on Top, picked with it (a search
  // of two characters kept from Top would otherwise do nothing on Posts).
  const searchAgain = (text: string, entry: SearchEntry = 'recent') => {
    const onType: PublicSearchType = tabRunsText(text) ? type : 'top';
    if (onType !== type) setPickedType(onType);
    commitSearch(text, onType, entry);
  };

  // What the search log is told of a result opened from the search in front:
  // never awaited, never in the way of the press (lib/search-open-report.ts).
  // `position` is the result's 1-based place in the list it was pressed in.
  const reportOpened = (kind: SearchOpenKind, id: string, position: number) => {
    if (!showingResults || position < 1) return;
    reportSearchOpen(api, { query: normalizedQuery, type, sort, entry: searchEntry.current, kind, id, position });
  };
  const openResult = (opened: SearchOpenedResult) => rememberQuery(historyQueryFor(opened));
  const openCreator = (creator: CreatorSearchResult, position: number) => {
    reportOpened('creator', creator.id, position);
    openResult('creator');
  };
  // A post opens on its own page, over the search, which stays as it is under it.
  const openPost = (item: ShowcaseFeedItem) => {
    // Its place among the search's posts; a related post's follows them.
    const own = shownResponse?.posts.items ?? [];
    const place = own.findIndex((post) => post.id === item.id);
    const relatedPlace = place < 0 ? relatedPosts.findIndex((post) => post.id === item.id) : -1;
    reportOpened('post', item.id, place >= 0 ? place + 1 : relatedPlace >= 0 ? own.length + relatedPlace + 1 : 0);
    openResult('post');
    router.push(`/post/${encodeURIComponent(item.id)}` as never);
  };
  const openRecipe = (recipe: RecipeSearchResult, position: number) => {
    reportOpened('recipe', recipe.id, position);
    openResult('recipe');
  };

  // An entity pressed among the results: Posts, narrowed to it and to nothing
  // else, named at once. Its count is of the posts this query finds with it,
  // so a switch left on from an earlier look at Posts would open fewer than
  // the row said.
  const pickEntity = (entity: SearchEntity) => {
    setEntityLabels((current) => ({ ...current, [searchEntityId(entity)]: entity.label }));
    setPickedFilters({ ...NO_SEARCH_FILTERS, madeWith: searchEntityId(entity) });
    setPickedType('posts');
  };
  // A model's or tool's row of the typing list or the start: the search it
  // counted, `text`, on Posts narrowed to it. A text Posts does not search
  // (under three characters) runs on Top with nothing narrowed: the length is
  // read before anything changes, so no tab or filter is left picked by a row
  // that could not run as drawn (review of #794). An answer that offers
  // entities comes from a server that narrows by them.
  const searchEntityPosts = (entity: SearchEntity, text: string) => {
    if (!tabRunsText(text, 'posts')) {
      setPickedFilters(NO_SEARCH_FILTERS);
      setPickedType('top');
      commitSearch(text, 'top', 'entity');
      return;
    }
    setFiltersOffered(true);
    pickEntity(entity);
    commitSearch(text, 'posts', 'entity');
  };

  // A row of the typing list. The keyboard stays up for the press (the list
  // is in the scroll view below, which hands a tap to what it lands on), and
  // is put away by a choice that leads to results, so they are not under it.
  const pickSuggestion = (row: SearchTypeaheadRow) => {
    const action = typeahead.press(row);
    // A press that does not count: the row had only just come under the finger.
    if (!action) return;
    // A creator's profile, over the list: coming back finds the typing as it was.
    if (action.type === 'creator') {
      router.push(`/creators/${encodeURIComponent(action.username)}` as never);
      return;
    }
    if (action.type === 'entity') {
      const route = searchTypeaheadEntityRoute(action.entity, query);
      // A catalog model nobody has posted with: its creator, the model
      // chosen, never an empty Posts page. Pushed over the list, as a
      // creator's profile is: coming back finds the typing as it was.
      if (route.type === 'creator') {
        router.push(route.href as never);
        return;
      }
      // As pressing the entity among the results does: Posts narrowed to it,
      // for the search the row carries (an alias, a misspelling, two letters:
      // what is typed would find nothing) or else for what is typed.
      searchEntityPosts(action.entity, route.query);
      return;
    }
    // "Search for", a recent search or a completion: the field holds its
    // text and that search is committed.
    commitSearch(action.query, type, searchEntryForChosenText(action.query, query, history));
  };

  // The list is drawn in the scroll view the results use, which may have been
  // scrolled down them: it starts at its top whenever it comes on show. The
  // scroll view is also what keeps the keyboard up for a press on a row.
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
  // answer is thin, and once. In the app every search sent is a commit, so
  // asked with them already: this follow-up is kept for the shared rule (the
  // web's live results reach it) and for an answer that came without them.
  const relatedPosts = shownResponse ? searchRelatedPosts(type, shownResponse) : NO_RELATED_POSTS;
  // Searches near this one, over a Top or Posts answer (searchRelatedSearchChips).
  // One pressed is searched as a recent search is, on the picked tab where it
  // runs there, its filters kept, and says it came from here (`related`).
  const relatedSearches = shownResponse ? searchRelatedSearchChips(type, shownResponse) : NO_RELATED_SEARCHES;
  const searchRelated = (text: string) => searchAgain(text, 'related');
  const relatedFollowUpDelay = answer !== null && answer.key === requestKey && visible && showingResults
    ? searchRelatedFollowUpDelay({
      applies: relatedApplies,
      // A blended answer already holds, in its own order, every post the
      // related group could: the server does not look for them beside it.
      relatedAsked: answer.relatedAsked || isSearchAnswerBlended(answer.response),
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
  const relatedStatus = response && showingResults ? searchRelatedStatus(searchRelatedPosts(type, response).length) : '';
  useEffect(() => {
    if (relatedStatus) AccessibilityInfo.announceForAccessibility(relatedStatus);
  }, [relatedStatus]);

  // Android reads the notice from its live region; iOS has none, so the line is announced.
  const announcedNotice = correctionNotice ?? exactNotice;
  useEffect(() => {
    if (announcedNotice && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(announcedNotice);
  }, [announcedNotice]);

  // Ideas to start from: before anything is typed, and when a search finds
  // nothing. Asked once each time the search opens.
  const { answer: starterAnswer, settled: starterSettled } = useSearchStarterState(api, visible, user?.id ?? null);
  // The pictures the screen holds for models and tools, from the starter and from every
  // suggestion answer: a result's row draws the one it holds (searchEntityPicturesWith).
  const [entityPictures, setEntityPictures] = useState<Readonly<Record<string, SearchThumbnail>>>({});
  const suggestedEntities = typeahead.answerEntities;
  useEffect(() => {
    setEntityPictures((current) => searchEntityPicturesWith(current, suggestedEntities));
  }, [suggestedEntities]);
  useEffect(() => {
    if (starterAnswer) setEntityPictures((current) => searchEntityPicturesWith(current, starterAnswer.entities));
  }, [starterAnswer]);
  // The start waits for the ideas a moment, so they arrive in place of nothing
  // instead of replacing the idle card (filmed on the iPhone, 2026-11-14); a
  // slow answer gives way to the card after SEARCH_START_HOLD_MS.
  const [startHoldOver, setStartHoldOver] = useState(false);
  // Each opening holds afresh and reads its recent searches afresh (review of
  // #812, 5), adjusted while rendering as the opening's mode is.
  const [holdFor, setHoldFor] = useState(visible);
  if (holdFor !== visible) {
    setHoldFor(visible);
    if (visible) {
      setStartHoldOver(false);
      setHistoryRead(false);
    }
  }
  useEffect(() => {
    if (!visible) return undefined;
    const timer = setTimeout(() => setStartHoldOver(true), SEARCH_START_HOLD_MS);
    return () => clearTimeout(timer);
  }, [visible]);
  // A row eased in once does not ease in again when the start comes back.
  if (body !== 'start' && pulledInRecents.length) setPulledInRecents([]);
  // The recent searches are this phone's own and show as soon as they are
  // read; only an empty start waits a moment for the ideas.
  const startHolding = !historyRead || (!history.length && !starterAnswer && !starterSettled && !startHoldOver);
  // A model or tool row whose query no tab can search (one character: Top
  // starts at two) is not drawn: pressed, it could run nothing (review of #794).
  const starter = useMemo(() => {
    if (!starterAnswer) return null;
    const entities = starterAnswer.entities.filter((entity) => searchTabRuns('top', searchQueryLength(normalizeCreatorSearchQuery(entity.query))));
    const shown = entities.length === starterAnswer.entities.length ? starterAnswer : { ...starterAnswer, entities };
    return isSearchStarterEmpty(shown) ? null : shown;
  }, [starterAnswer]);
  const startFromEntity = (entity: SearchStarterEntity) => {
    // The search the starter counted: the entity's own query, on Posts, narrowed to it.
    const action = searchStarterEntityAction(entity);
    if (action.type !== 'entity') return;
    searchEntityPosts(entity, action.query);
  };
  const startFromCreator = (creator: SearchStarterCreator) => {
    router.push(`/creators/${encodeURIComponent(creator.username)}` as never);
  };
  // A search to try starts afresh: a filter left on from an earlier search would narrow it.
  const startFromSearch = (search: SearchStarterSearch) => {
    setPickedFilters(NO_SEARCH_FILTERS);
    searchAgain(search.text, 'starter');
  };

  // A search that found nothing on its tab says what another tab holds
  // (finding 8), from Top's answer for the same query: the one on hand, or
  // one request made for it, once. A filtered search keeps its own words.
  const shownTab = type === 'top' ? null : type;
  const emptyTab = showingResults
    && response !== null
    && shownResultCount(response, type, normalizedQuery) === 0
    && searchSaysNoResults(countedLength)
    && !hasSearchFilters(filters);
  const countsKey = topCountsKey(normalizedQuery, exact);
  const pointerCounts = topCounts?.key === countsKey ? topCounts.top : null;
  const asksTopCounts = emptyTab && shownTab !== null && pointerCounts === null;
  useEffect(() => {
    if (!asksTopCounts || askedTopFor.current === countsKey) return;
    // A probe: the person never ran this search, so the server leaves it out
    // of the search log (SEARCH_PROBE_PARAM). Cut off when the screen stops
    // asking for it (back to typing, another query, a tab that is not empty),
    // as the search itself is. A query counts as asked only once its request
    // has settled: one cut off is asked again when an empty tab next needs it,
    // one that failed is not (the tab's own "No …" stands).
    const controller = new AbortController();
    api.searchPublicContent(
      { query: normalizedQuery, type: 'top', sort: 'top', filters: NO_SEARCH_FILTERS, exact, cursor: null, related: false, probe: true },
      controller.signal,
    )
      .then((next) => {
        // One cut off may still answer: it is for a query no longer on screen.
        if (controller.signal.aborted) return;
        askedTopFor.current = countsKey;
        setTopCounts({ key: countsKey, top: topSectionsOf(next) });
      })
      .catch(() => {
        if (!controller.signal.aborted) askedTopFor.current = countsKey;
      });
    return () => controller.abort();
  }, [api, asksTopCounts, countsKey, exact, normalizedQuery]);
  const otherTab = emptyTab && shownTab !== null && pointerCounts ? searchEmptyTabPointer(shownTab, pointerCounts) : null;
  // Nothing anywhere: Top found nothing, or this tab and every other did.
  const nothingFound = emptyTab && (shownTab === null || (pointerCounts !== null && otherTab === null));

  if (!visible) return null;

  return (
    // iOS gives the keyboard's room through the results' own insets
    // (automaticallyAdjustKeyboardInsets) instead of this area's padding: the
    // padding re-laid the whole screen out on the UI thread at every frame of
    // the keyboard's rise, and its first frame, landing on the keyboard's
    // setup, was late (Animation Hitches on the iPhone 16e, 2026-11-14).
    <KeyboardAvoidingArea
      iosScrollViewAdjustsInsets
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      <View style={{ paddingTop: insets.top + SEARCH_HEADER_TOP_GAP, paddingHorizontal: appTheme.spacing.screen, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SEARCH_HEADER_GAP }}>
          <Animated.View style={entrance.styles.leadingStyle}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close search" onPress={requestClose} hitSlop={10} style={{ minWidth: SEARCH_HEADER_LEADING_WIDTH, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
              <BackGlyph size={appTheme.icon.feature} color={theme.colors.text} />
            </Pressable>
          </Animated.View>
          <View
            ref={entrance.fieldRef}
            onLayout={entrance.onFieldLayout}
            style={{ minHeight: SEARCH_FIELD_HEIGHT, minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: SEARCH_FIELD_ICON_INSET }}
          >
            {/* The field's capsule, drawn behind it so it can grow out of the
                control search was opened from; a round button's own skin
                covers it as it starts. */}
            <Animated.View
              pointerEvents="none"
              style={[
                { position: 'absolute', borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceInset },
                entrance.styles.capsuleStyle,
              ]}
            >
              <Animated.View
                style={[
                  { position: 'absolute', left: -1, top: -1, right: -1, bottom: -1, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: theme.colors.borderSubtle, backgroundColor: theme.colors.panel },
                  entrance.styles.buttonSkinStyle,
                ]}
              />
            </Animated.View>
            <Animated.View style={entrance.styles.iconStyle}>
              <Search size={appTheme.icon.default} color={theme.colors.muted} />
            </Animated.View>
            <Animated.View style={[{ minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center' }, entrance.styles.textStyle]}>
            <TextInput
              ref={inputRef}
              accessibilityLabel={SEARCH_FIELD_LABEL}
              autoCapitalize="none"
              autoCorrect={false}
              enterKeyHint="search"
              maxLength={100}
              onChangeText={(text) => {
                // Only a change of the text is typing. iOS sends the text it
                // holds again as its on-screen keyboard goes, which a commit
                // makes it do: read as an edit, that took the results away
                // again (seen on the simulator, 2026-11-13).
                if (text === query) return;
                setQuery(text);
                moveMode('edit');
              }}
              // Tapping the field goes back to typing for the text it holds.
              onFocus={() => moveMode('focus')}
              onSubmitEditing={submitSearch}
              // Below the picked tab's minimum the Search key commits
              // nothing, and the keyboard stays for the typing to go on.
              submitBehavior={tabRunsText(query) ? 'blurAndSubmit' : 'submit'}
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
                onPress={() => {
                  setQuery('');
                  moveMode('edit');
                  inputRef.current?.focus();
                }}
                style={{ minWidth: 44, minHeight: 44, marginRight: -14, alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={appTheme.icon.compact} color={theme.colors.muted} />
              </Pressable>
            ) : null}
            </Animated.View>
          </View>
        </View>
        <Animated.View style={entrance.styles.contentStyle}>
        <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 3, paddingTop: 10 }} accessibilityRole="tablist">
          {SEARCH_TABS.map((item) => (
            <SearchTab
              key={item.id}
              active={type === item.id}
              label={item.label}
              onPress={() => {
                setPickedType(item.id);
                // While typing, a tab opens on the results for what is typed.
                if (searchTabPressCommits({ mode, text: query })) commitSearch(query, item.id);
              }}
            />
          ))}
        </ScrollView>
        </Animated.View>
      </View>

      <Animated.View style={[{ flex: 1 }, entrance.styles.contentStyle]}>
      <ScrollView
        ref={resultsScrollRef}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          flexGrow: 1,
          gap: 22,
          padding: appTheme.spacing.screen,
          // A pushed screen: the tab bar is under it, not over it.
          paddingBottom: insets.bottom + appTheme.spacing.section,
        }}
      >
        {showingResults && filtersShown ? (
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
        {body === 'suggestions' && typeahead.shown ? (
          // While typing: suggestions only, in place of results. The list
          // stays when a drag puts the keyboard away; a commit ends it. A
          // text too short to search, with nothing suggested for it, has no
          // list: the invitation stands in for it.
          <SearchTypeaheadList
            sections={typeahead.sections}
            query={query}
            busy={typeahead.busy}
            settlingRows={typeahead.settlingRows}
            onPick={pickSuggestion}
          />
        ) : body !== 'results' || !requestKey ? (
          // Recent searches under an empty field only, as on the web: under a
          // typed query that is not searched they would read as its results.
          // Under them, the ideas to start from; with neither, the invitation.
          body === 'start' && startHolding ? (
            // Held a moment for the recent searches and the ideas, so they
            // arrive in place of nothing (startHolding).
            <View testID="search-start-holding" />
          ) : body === 'start' && (history.length || starter) ? (
            <View style={{ gap: 28 }}>
              {history.length ? (
                <View style={{ gap: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    {/* Gives way to the clear button at the largest text sizes, which it pushed off the screen. */}
                    <Text accessibilityRole="header" style={{ flexShrink: 1, color: theme.colors.text, fontSize: 17, fontWeight: '800' }}>{SEARCH_RECENTS_HEADING}</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={SEARCH_RECENTS_CLEAR_ACTION_LABEL}
                      onPress={() => void clearSearchHistory().then(() => setHistory([]))}
                      style={{ minHeight: 44, justifyContent: 'center' }}
                    >
                      <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '700' }}>{SEARCH_RECENTS_CLEAR_LABEL}</Text>
                    </Pressable>
                  </View>
                  {shownRecentSearches(history).map((item) => (
                    // The newest five of the ten kept: one removed brings the
                    // next into the last place, easing in (SEARCH_RECENTS_SHOWN).
                    <Reveal key={item} enabled={pulledInRecents.includes(item)} style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={searchRecentAgainLabel(item)}
                        onPress={() => searchAgain(item)}
                        style={{ minHeight: 46, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                      >
                        <Clock3 size={appTheme.icon.sm} color={theme.colors.faint} />
                        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 15 }}>{item}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={searchRecentRemoveLabel(item)}
                        onPress={() => removeRecent(item)}
                        style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                      >
                        <X size={appTheme.icon.sm} color={theme.colors.faint} />
                      </Pressable>
                    </Reveal>
                  ))}
                </View>
              ) : null}
              {starter ? (
                // Fades and rises in as it arrives, as iOS's suggestions do,
                // once it has mounted (Reveal afterMount).
                <Reveal afterMount>
                  <SearchStarterSections
                    answer={starter}
                    onEntity={startFromEntity}
                    onCreator={startFromCreator}
                    onSearch={startFromSearch}
                    followReturnTo={followReturnTo}
                  />
                </Reveal>
              ) : null}
            </View>
          ) : body === 'start' ? (
            <Reveal afterMount>
              <StatusBlock title={SEARCH_IDLE_TITLE} body={SEARCH_IDLE_BODY} />
            </Reveal>
          ) : (
            <StatusBlock title={SEARCH_IDLE_TITLE} body={SEARCH_IDLE_BODY} />
          )
        ) : shownResponse && resultCount > 0 ? (
          <View style={{ gap: 25 }}>
            <RelatedSearches searches={relatedSearches} onSearch={searchRelated} />
            {entities.length ? (
              <View style={{ gap: 10 }}>
                <ResultsHeading title={SEARCH_ENTITIES_HEADING} sort={null} onSortChange={setPickedSort} />
                {entities.map((entity, index) => (
                  <EntityRow key={searchEntityId(entity)} entity={entity} thumbnail={entityPictures[searchEntityId(entity)] ?? null} onPick={() => { reportOpened('entity', searchEntityId(entity), index + 1); pickEntity(entity); }} />
                ))}
              </View>
            ) : null}
            {(type === 'top' || type === 'creators') && shownResponse.creators.items.length ? (
              <View style={{ gap: 10 }}>
                <ResultsHeading title="Creators" sort={null} onSortChange={setPickedSort} seeAll={type === 'top' ? { section: 'creators', onPress: () => setPickedType('creators') } : null} />
                {shownResponse.creators.items.map((creator, index) => (
                  <CreatorRow key={creator.id} creator={creator} onOpen={() => openCreator(creator, index + 1)} followReturnTo={followReturnTo} />
                ))}
                {type === 'top' && searchTopSectionHasMore('creators', shownResponse.creators.items.length)
                  ? <SeeAllButton section="creators" onPress={() => setPickedType('creators')} />
                  : null}
              </View>
            ) : null}
            {(type === 'top' || type === 'posts') && shownResponse.posts.items.length ? (
              <View style={{ gap: 10 }}>
                <ResultsHeading title="Posts" busy={reordering} sort={type === 'posts' ? shownSort : null} onSortChange={setPickedSort} seeAll={type === 'top' ? { section: 'posts', onPress: () => setPickedType('posts') } : null} />
                <View accessibilityState={{ busy: reordering }}>
                  <SearchPostMasonry
                    testID="search-posts"
                    items={shownResponse.posts.items}
                    columns={postColumns}
                    narrowedTo={filters.madeWith && madeWithLabel ? { id: filters.madeWith, label: madeWithLabel } : null}
                    onOpen={openPost}
                  />
                </View>
                {type === 'top' && searchTopSectionHasMore('posts', shownResponse.posts.items.length)
                  ? <SeeAllButton section="posts" onPress={() => setPickedType('posts')} />
                  : null}
              </View>
            ) : null}
            {(type === 'top' || type === 'recipes') && shownResponse.recipes.items.length ? (
              <View style={{ gap: 10 }}>
                <ResultsHeading title="Recipes" busy={reordering} sort={type === 'recipes' ? shownSort : null} onSortChange={setPickedSort} seeAll={type === 'top' ? { section: 'recipes', onPress: () => setPickedType('recipes') } : null} />
                <View accessibilityState={{ busy: reordering }} style={{ gap: 10 }}>
                  {shownResponse.recipes.items.map((recipe, index) => <RecipeRow key={recipe.id} recipe={recipe} onOpen={() => openRecipe(recipe, index + 1)} />)}
                </View>
                {type === 'top' && searchTopSectionHasMore('recipes', shownResponse.recipes.items.length)
                  ? <SeeAllButton section="recipes" onPress={() => setPickedType('recipes')} />
                  : null}
              </View>
            ) : null}
            {nextCursor ? <SecondaryButton disabled={loadingMore || retryBlocked} label={loadingMore ? SEARCH_LOADING_MORE_LABEL : SEARCH_SHOW_MORE_LABEL} onPress={() => void runSearch(nextCursor)} /> : null}
            <RelatedPosts posts={relatedPosts} columns={postColumns} onOpen={openPost} />
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
            {otherTab && shownTab ? (
              // This tab is empty, another is not: said, with the way there.
              <View style={{ gap: 12 }}>
                <StatusBlock title={searchEmptyTabTitle(shownTab, normalizedQuery)} body={searchEmptyTabPointerLine(otherTab)} />
                <SecondaryButton
                  label={searchSeeTabLabel(otherTab.tab)}
                  onPress={() => {
                    // The count said is Top's, unfiltered: Posts opens without
                    // a filter left on from before, so it holds what was said.
                    if (otherTab.tab === 'posts') setPickedFilters(NO_SEARCH_FILTERS);
                    setPickedType(otherTab.tab);
                  }}
                />
              </View>
            ) : (
              <StatusBlock
                title={shownTab && !nothingFound && !hasSearchFilters(filters) ? searchEmptyTabTitle(shownTab, normalizedQuery) : searchNoResultsTitle(normalizedQuery)}
                body={hasSearchFilters(filters) ? SEARCH_FILTERED_EMPTY_BODY : SEARCH_NO_RESULTS_BODY}
              />
            )}
            <RelatedPosts posts={relatedPosts} columns={postColumns} onOpen={openPost} />
            {nothingFound && starter ? (
              <SearchStarterSections
                answer={starter}
                heading={SEARCH_STARTER_NO_RESULTS_HEADING}
                onEntity={startFromEntity}
                onCreator={startFromCreator}
                onSearch={startFromSearch}
                followReturnTo={followReturnTo}
              />
            ) : null}
          </View>
        ) : (
          <View style={{ minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={{ color: theme.colors.muted, fontSize: 13 }}>{SEARCH_SEARCHING_LABEL}</Text>
          </View>
        )}
      </ScrollView>
      </Animated.View>
      {entrance.touchable ? null : (
        // Takes the taps while the field grows or goes back, so the second tap
        // of a double tap does nothing. A shield, not pointerEvents on the
        // field's parents: on iOS those turn off their interaction, and the
        // field then refused the focus the entrance gives it (simulator,
        // 2026-11-14).
        <View
          testID="search-entrance-shield"
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          onStartShouldSetResponder={() => true}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />
      )}
    </KeyboardAvoidingArea>
  );
}
