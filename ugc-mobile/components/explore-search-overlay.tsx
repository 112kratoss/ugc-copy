import { useIsFocused } from '@react-navigation/native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { BookOpen, Clock3, Search, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { CreatorAvatar, SecondaryButton, StatusBlock } from '@/components/ui';
import { MotionView, useOverlayPresence } from '@/lib/motion';
import { BackGlyph } from '@/lib/platform-glyphs';
import { ApiError, type MagicbookletApiClient } from '@/lib/api-client';
import {
  clearSearchHistory,
  forgetSearchQuery,
  normalizeCreatorSearchQuery,
  normalizeSearchHistoryQuery,
  readSearchHistory,
  rememberSearchQuery,
} from '@/lib/search-history';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type {
  CreatorSearchResult,
  PublicSearchResponse,
  PublicSearchType,
  RecipeSearchResult,
  ShowcaseFeedItem,
} from '@/lib/types';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { formatUnlockCreditPrice } from '@/lib/pricing';

const SEARCH_TYPES: Array<{ id: PublicSearchType; label: string }> = [
  { id: 'top', label: 'Top' },
  { id: 'creators', label: 'Creators' },
  { id: 'posts', label: 'Posts' },
  { id: 'recipes', label: 'Recipes' },
];

// The server's minimums, counted on the query without its leading @
// (normalizeCreatorSearchQuery): creators from two characters, posts and
// recipes from three.
const MIN_CREATOR_QUERY_LENGTH = 2;
const MIN_CONTENT_QUERY_LENGTH = 3;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LENGTH_HINT = 'Search creators from two characters, or use three characters to discover posts and recipes.';

type SearchAnswer = { key: string; response: PublicSearchResponse };
type SearchFailure = { key: string; message: string; retryAfterSeconds: number | null };

function isContentType(type: PublicSearchType) {
  return type === 'posts' || type === 'recipes';
}

// An answer or a failure is drawn only under the query and tab it was asked
// for, so a new query or tab shows the spinner until its own answer lands.
function searchKey(query: string, type: PublicSearchType) {
  return `${type}:${query}`;
}

// Top draws all three kinds; a kind's tab draws only its own.
function shownResultCount(response: PublicSearchResponse, type: PublicSearchType) {
  return (type === 'top' || type === 'creators' ? response.creators.items.length : 0)
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
      return {
        message: retryAfterSeconds ? `Search is busy. Try again in ${retryAfterSeconds} s.` : 'Search is busy. Try again shortly.',
        retryAfterSeconds,
      };
    }
    if (error.status === 400) return { message: SEARCH_LENGTH_HINT, retryAfterSeconds: null };
    // Status 0 is the client's own: no answer at all, its timeout included.
    if (error.status === 0 || error.status >= 500) {
      return { message: 'Search could not be loaded. Check your connection and try again.', retryAfterSeconds: null };
    }
  }
  return { message: 'Search could not be loaded.', retryAfterSeconds: null };
}

function postPreview(item: ShowcaseFeedItem) {
  const cover = item.mediaItems?.slice().sort((left, right) => left.sortOrder - right.sortOrder)[0];
  return cover?.previewUrl
    ?? (cover?.mediaKind === 'image' ? cover.url : null)
    ?? (item.mediaKind === 'image' ? item.mediaUrl : null);
}

function SearchTab({
  active,
  disabled,
  label,
  onPress,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        backgroundColor: active ? theme.colors.text : 'transparent',
        opacity: disabled ? 0.35 : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 17,
      })}
    >
      <Text style={{ color: active ? theme.colors.textInverse : theme.colors.muted, fontSize: 13, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function CreatorRow({ creator, onOpen }: { creator: CreatorSearchResult; onOpen: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${creator.displayName}'s profile`}
      onPress={() => {
        onOpen();
        router.push(`/creators/${encodeURIComponent(creator.username)}` as never);
      }}
      style={({ pressed }) => ({
        minHeight: 76,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 13,
        borderRadius: appTheme.radii.lg,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        padding: 13,
      })}
    >
      <CreatorAvatar uri={creator.avatarUrl} name={creator.displayName} size={48} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>{creator.displayName}</Text>
        <Text numberOfLines={1} style={{ marginTop: 2, color: theme.colors.muted, fontSize: 13 }}>@{creator.username}</Text>
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
      accessibilityLabel={`Open post ${item.title}`}
      onPress={() => {
        onOpen();
        router.push(`/post/${encodeURIComponent(item.id)}` as never);
      }}
      style={({ pressed }) => ({
        flex: 1,
        overflow: 'hidden',
        borderRadius: appTheme.radii.lg,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {preview ? (
        <Image source={{ uri: preview }} contentFit="cover" style={{ width: '100%', aspectRatio: 1.15 }} />
      ) : (
        <View style={{ width: '100%', aspectRatio: 1.15, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.panel }}>
          <Search size={appTheme.icon.feature} color={theme.colors.primary} />
        </View>
      )}
      <View style={{ gap: 3, padding: 12 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 14, fontWeight: '800' }}>{item.title}</Text>
        <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 12 }}>{item.creator.name}</Text>
      </View>
    </Pressable>
  );
}

function RecipeRow({ recipe, onOpen }: { recipe: RecipeSearchResult; onOpen: () => void }) {
  const theme = useAppTheme();
  // Only an image post may fall back to its media URL: a video's is not an image.
  const preview = recipe.post?.mediaPreviewUrl
    ?? (recipe.post?.mediaKind === 'image' ? recipe.post.mediaUrl : null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open recipe ${recipe.title}`}
      onPress={() => {
        onOpen();
        router.push({ pathname: '/marketplace/[assetId]', params: { assetId: recipe.id, postId: recipe.postId } });
      }}
      style={({ pressed }) => ({
        minHeight: 104,
        flexDirection: 'row',
        overflow: 'hidden',
        borderRadius: appTheme.radii.lg,
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
        <Text style={{ color: theme.colors.success, fontSize: 12, fontWeight: '800' }}>
          {recipe.accessMode === 'free' ? 'Free' : formatUnlockCreditPrice(recipe.priceUsdCents)}
        </Text>
      </View>
    </Pressable>
  );
}

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
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isFocused = useIsFocused();
  // The floating tab bar stays mounted above this overlay, so the results list
  // needs the same clearance the feed itself uses or the last row never
  // scrolls out from underneath it.
  const tabBarMetrics = getMagicTabBarMetrics(width, insets.bottom);
  const { mounted, animatedStyle } = useOverlayPresence(visible);
  const inputRef = useRef<TextInput>(null);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  // The query of the request last scheduled. A change of tab alone means the
  // person has stopped typing, so its request skips the debounce.
  const scheduledQuery = useRef<string | null>(null);
  // The key of a query committed with the Search key before its answer landed.
  const rememberOnAnswer = useRef<string | null>(null);
  const [query, setQuery] = useState('');
  // The tab the person picked. A query long enough for creators but not for
  // posts and recipes runs, and shows, as Creators; the pick comes back after.
  const [pickedType, setPickedType] = useState<PublicSearchType>('top');
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [failure, setFailure] = useState<SearchFailure | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const normalizedQuery = useMemo(() => normalizeSearchHistoryQuery(query), [query]);
  const countedLength = normalizeCreatorSearchQuery(normalizedQuery).length;
  const creatorsOnly = countedLength >= MIN_CREATOR_QUERY_LENGTH && countedLength < MIN_CONTENT_QUERY_LENGTH;
  const type: PublicSearchType = creatorsOnly && isContentType(pickedType) ? 'creators' : pickedType;
  // From the creator minimum on, the tab in effect always meets its own.
  const requestKey = countedLength >= MIN_CREATOR_QUERY_LENGTH ? searchKey(normalizedQuery, type) : null;
  const response = answer && answer.key === requestKey ? answer.response : null;
  const shownFailure = failure && failure.key === requestKey ? failure : null;
  const resultCount = response ? shownResultCount(response, type) : 0;
  const retryBlocked = Boolean(shownFailure?.retryAfterSeconds);
  const nextCursor = !response
    ? null
    : type === 'creators'
      ? response.creators.nextCursor
      : type === 'posts'
        ? response.posts.nextCursor
        : type === 'recipes'
          ? response.recipes.nextCursor
          : null;

  // Recent searches keep what the person acted on, never each pause in typing.
  const rememberQuery = useCallback((value: string) => {
    void rememberSearchQuery(value).then(setHistory);
  }, []);

  const requestClose = useCallback(() => {
    // Leaving with results on screen keeps the query; one that found nothing,
    // or is still unanswered, is not kept.
    if (response && resultCount > 0) rememberQuery(normalizedQuery);
    // Dismissing the keyboard alongside the fade keeps close reading as one
    // gesture instead of two staggered ones.
    Keyboard.dismiss();
    onClose();
  }, [normalizedQuery, onClose, rememberQuery, response, resultCount]);

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

  const runSearch = useCallback(async (cursor: string | null = null) => {
    if (!requestKey) return;
    const key = requestKey;
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (cursor) setLoadingMore(true);
    setFailure(null);
    try {
      const next = await api.searchPublicContent({ query: normalizedQuery, type, cursor }, controller.signal);
      if (sequence !== requestSequence.current) return;
      if (cursor) {
        setAnswer((current) => current?.key === key ? {
          key,
          response: {
            ...next,
            creators: type === 'creators' ? { ...next.creators, items: [...current.response.creators.items, ...next.creators.items] } : next.creators,
            posts: type === 'posts' ? { ...next.posts, items: [...current.response.posts.items, ...next.posts.items] } : next.posts,
            recipes: type === 'recipes' ? { ...next.recipes, items: [...current.response.recipes.items, ...next.recipes.items] } : next.recipes,
          },
        } : current);
        return;
      }
      setAnswer({ key, response: next });
      if (rememberOnAnswer.current === key) {
        rememberOnAnswer.current = null;
        if (shownResultCount(next, type) > 0) rememberQuery(normalizedQuery);
      }
    } catch (requestError) {
      if (controller.signal.aborted || (requestError instanceof Error && requestError.name === 'AbortError')) return;
      if (sequence === requestSequence.current) setFailure({ key, ...describeSearchFailure(requestError) });
    } finally {
      if (sequence === requestSequence.current) setLoadingMore(false);
    }
  }, [api, normalizedQuery, rememberQuery, requestKey, type]);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
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
    if (!requestKey) return;
    if (!response) {
      rememberOnAnswer.current = requestKey;
      return;
    }
    if (resultCount > 0) rememberQuery(normalizedQuery);
  };

  const openResult = () => rememberQuery(normalizedQuery);

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
              accessibilityLabel="Search creators, posts, and recipes"
              autoCapitalize="none"
              autoCorrect={false}
              enterKeyHint="search"
              maxLength={100}
              onChangeText={setQuery}
              onSubmitEditing={submitSearch}
              placeholder="Search Magicbooklet"
              placeholderTextColor={theme.colors.faint}
              returnKeyType="search"
              value={query}
              style={{ minWidth: 0, flex: 1, color: theme.colors.text, fontSize: 15, paddingVertical: 12 }}
            />
            {query ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                onPress={() => setQuery('')}
                style={{ minWidth: 44, minHeight: 44, marginRight: -13, alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={appTheme.icon.compact} color={theme.colors.muted} />
              </Pressable>
            ) : null}
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 3, paddingTop: 10 }} accessibilityRole="tablist">
          {SEARCH_TYPES.map((item) => (
            <SearchTab
              key={item.id}
              active={type === item.id}
              disabled={creatorsOnly && isContentType(item.id)}
              label={item.label}
              onPress={() => setPickedType(item.id)}
            />
          ))}
        </ScrollView>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          flexGrow: 1,
          gap: 22,
          padding: appTheme.spacing.screen,
          paddingBottom: tabBarMetrics.contentBottomOverlapPadding + appTheme.spacing.section,
        }}
      >
        {!requestKey ? (
          history.length ? (
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: theme.colors.text, fontSize: 17, fontWeight: '800' }}>Recent searches</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear all recent searches"
                  onPress={() => void clearSearchHistory().then(() => setHistory([]))}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '700' }}>Clear</Text>
                </Pressable>
              </View>
              {history.map((item) => (
                <View key={item} style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Search again for ${item}`}
                    onPress={() => setQuery(item)}
                    style={{ minHeight: 46, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                  >
                    <Clock3 size={appTheme.icon.sm} color={theme.colors.faint} />
                    <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 15 }}>{item}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item} from recent searches`}
                    onPress={() => void forgetSearchQuery(item).then(setHistory)}
                    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <X size={appTheme.icon.sm} color={theme.colors.faint} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : (
            <StatusBlock title="Find your next idea" body={SEARCH_LENGTH_HINT} />
          )
        ) : response && resultCount > 0 ? (
          <View style={{ gap: 25 }}>
            {(type === 'top' || type === 'creators') && response.creators.items.length ? (
              <View style={{ gap: 10 }}>
                <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 18, fontWeight: '800' }}>Creators</Text>
                {response.creators.items.map((creator) => <CreatorRow key={creator.id} creator={creator} onOpen={openResult} />)}
              </View>
            ) : null}
            {(type === 'top' || type === 'posts') && response.posts.items.length ? (
              <View style={{ gap: 10 }}>
                <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 18, fontWeight: '800' }}>Posts</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  {response.posts.items.map((post) => <View key={post.id} style={{ width: '48%' }}><PostRow item={post} onOpen={openResult} /></View>)}
                </View>
              </View>
            ) : null}
            {(type === 'top' || type === 'recipes') && response.recipes.items.length ? (
              <View style={{ gap: 10 }}>
                <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 18, fontWeight: '800' }}>Recipes</Text>
                {response.recipes.items.map((recipe) => <RecipeRow key={recipe.id} recipe={recipe} onOpen={openResult} />)}
              </View>
            ) : null}
            {nextCursor ? <SecondaryButton disabled={loadingMore || retryBlocked} label={loadingMore ? 'Loading…' : 'Show more'} onPress={() => void runSearch(nextCursor)} /> : null}
            {shownFailure ? <Text accessibilityRole="alert" style={{ color: theme.colors.danger, textAlign: 'center', fontSize: 13 }}>{shownFailure.message}</Text> : null}
          </View>
        ) : shownFailure ? (
          <View style={{ gap: 12 }}>
            <StatusBlock tone="danger" title="Search did not load" body={shownFailure.message} />
            <SecondaryButton disabled={retryBlocked} label="Retry search" onPress={() => void runSearch()} />
          </View>
        ) : response ? (
          <StatusBlock title={`No results for “${normalizedQuery}”`} body="Try a shorter phrase, check the spelling, or search for a creator handle." />
        ) : (
          <View style={{ minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={{ color: theme.colors.muted, fontSize: 13 }}>Searching…</Text>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingArea>
    </MotionView>
  );
}
