import { Image } from 'expo-image';
import { router } from 'expo-router';
import { BookOpen, Clock3, Search, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
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
import type { MagicbookletApiClient } from '@/lib/api-client';
import {
  clearSearchHistory,
  forgetSearchQuery,
  normalizeSearchHistoryQuery,
  readSearchHistory,
  rememberSearchQuery,
} from '@/lib/search-history';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';
import type {
  CreatorSearchResult,
  PublicSearchResponse,
  PublicSearchType,
  RecipeSearchResult,
  ShowcaseFeedItem,
} from '@/lib/types';

const SEARCH_TYPES: Array<{ id: PublicSearchType; label: string }> = [
  { id: 'top', label: 'Top' },
  { id: 'creators', label: 'Creators' },
  { id: 'posts', label: 'Posts' },
  { id: 'recipes', label: 'Recipes' },
];

function emptySearchResponse(query = '', type: PublicSearchType = 'top'): PublicSearchResponse {
  return {
    query,
    normalizedQuery: normalizeSearchHistoryQuery(query),
    type,
    creators: { items: [], nextCursor: null },
    posts: { items: [], nextCursor: null },
    recipes: { items: [], nextCursor: null },
  };
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
        backgroundColor: active ? appTheme.colors.text : 'transparent',
        opacity: disabled ? 0.35 : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 17,
      })}
    >
      <Text style={{ color: active ? appTheme.colors.textInverse : appTheme.colors.muted, fontSize: 13, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function CreatorRow({ creator }: { creator: CreatorSearchResult }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${creator.displayName}'s profile`}
      onPress={() => router.push(`/creators/${encodeURIComponent(creator.username)}` as never)}
      style={({ pressed }) => ({
        minHeight: 76,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 13,
        borderRadius: appTheme.radii.lg,
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        padding: 13,
      })}
    >
      <CreatorAvatar uri={creator.avatarUrl} name={creator.displayName} size={48} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: appTheme.colors.text, fontSize: 15, fontWeight: '800' }}>{creator.displayName}</Text>
        <Text numberOfLines={1} style={{ marginTop: 2, color: appTheme.colors.muted, fontSize: 13 }}>@{creator.username}</Text>
      </View>
      <Text style={{ color: appTheme.colors.faint, fontSize: 12 }}>{creator.publicPostCount} posts</Text>
    </Pressable>
  );
}

function PostRow({ item }: { item: ShowcaseFeedItem }) {
  const preview = postPreview(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open post ${item.title}`}
      onPress={() => router.push(`/post/${encodeURIComponent(item.id)}` as never)}
      style={({ pressed }) => ({
        flex: 1,
        overflow: 'hidden',
        borderRadius: appTheme.radii.lg,
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {preview ? (
        <Image source={{ uri: preview }} contentFit="cover" style={{ width: '100%', aspectRatio: 1.15 }} />
      ) : (
        <View style={{ width: '100%', aspectRatio: 1.15, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.panel }}>
          <Search size={appTheme.icon.feature} color={appTheme.colors.primary} />
        </View>
      )}
      <View style={{ gap: 3, padding: 12 }}>
        <Text numberOfLines={1} style={{ color: appTheme.colors.text, fontSize: 14, fontWeight: '800' }}>{item.title}</Text>
        <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 12 }}>{item.creator.name}</Text>
      </View>
    </Pressable>
  );
}

function RecipeRow({ recipe }: { recipe: RecipeSearchResult }) {
  const preview = recipe.post?.mediaPreviewUrl ?? recipe.post?.mediaUrl ?? null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open recipe ${recipe.title}`}
      onPress={() => router.push({ pathname: '/marketplace/[assetId]', params: { assetId: recipe.id, postId: recipe.postId } })}
      style={({ pressed }) => ({
        minHeight: 104,
        flexDirection: 'row',
        overflow: 'hidden',
        borderRadius: appTheme.radii.lg,
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {preview ? (
        <Image source={{ uri: preview }} contentFit="cover" style={{ width: 106 }} />
      ) : (
        <View style={{ width: 106, alignItems: 'center', justifyContent: 'center', backgroundColor: `${appTheme.colors.success}12` }}>
          <BookOpen size={appTheme.icon.feature} color={appTheme.colors.success} />
        </View>
      )}
      <View style={{ minWidth: 0, flex: 1, gap: 5, justifyContent: 'center', padding: 13 }}>
        <Text numberOfLines={1} style={{ color: appTheme.colors.text, fontSize: 14, fontWeight: '800' }}>{recipe.title}</Text>
        <Text numberOfLines={2} style={{ color: appTheme.colors.muted, fontSize: 12, lineHeight: 17 }}>{recipe.summary || recipe.previewText}</Text>
        <Text style={{ color: appTheme.colors.success, fontSize: 12, fontWeight: '800' }}>
          {recipe.accessMode === 'free' ? 'Free' : recipe.priceQuote.formatted}
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
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // The floating tab bar stays mounted above this overlay, so the results list
  // needs the same clearance the feed itself uses or the last row never
  // scrolls out from underneath it.
  const tabBarMetrics = getMagicTabBarMetrics(width, insets.bottom);
  const { mounted, animatedStyle } = useOverlayPresence(visible);
  const inputRef = useRef<TextInput>(null);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<PublicSearchType>('top');
  const [result, setResult] = useState<PublicSearchResponse>(() => emptySearchResponse());
  const [history, setHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedQuery = useMemo(() => normalizeSearchHistoryQuery(query), [query]);
  const hasResults = result.creators.items.length + result.posts.items.length + result.recipes.items.length > 0;
  const nextCursor = type === 'creators'
    ? result.creators.nextCursor
    : type === 'posts'
      ? result.posts.nextCursor
      : type === 'recipes'
        ? result.recipes.nextCursor
        : null;

  const requestClose = useCallback(() => {
    // Dismissing the keyboard alongside the fade keeps close reading as one
    // gesture instead of two staggered ones.
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!visible) {
      requestSequence.current += 1;
      requestController.current?.abort();
      return;
    }
    void readSearchHistory().then(setHistory);
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 120);
    const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
      requestClose();
      return true;
    });
    return () => {
      clearTimeout(focusTimer);
      backSubscription.remove();
    };
  }, [requestClose, visible]);

  const runSearch = useCallback(async (cursor: string | null = null) => {
    if (normalizedQuery.length < 2) return;
    if ((type === 'posts' || type === 'recipes') && normalizedQuery.length < 3) return;
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const next = await api.searchPublicContent({ query: normalizedQuery, type, cursor }, controller.signal);
      if (sequence !== requestSequence.current) return;
      setResult((current) => cursor ? {
        ...next,
        creators: type === 'creators' ? { ...next.creators, items: [...current.creators.items, ...next.creators.items] } : next.creators,
        posts: type === 'posts' ? { ...next.posts, items: [...current.posts.items, ...next.posts.items] } : next.posts,
        recipes: type === 'recipes' ? { ...next.recipes, items: [...current.recipes.items, ...next.recipes.items] } : next.recipes,
      } : next);
      if (!cursor) void rememberSearchQuery(normalizedQuery).then(setHistory);
    } catch (requestError) {
      if (controller.signal.aborted || (requestError instanceof Error && requestError.name === 'AbortError')) return;
      if (sequence === requestSequence.current) setError('Search could not be loaded. Check your connection and try again.');
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [api, normalizedQuery, type]);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    if (!visible) return;
    if (normalizedQuery.length < 2) {
      requestSequence.current += 1;
      setResult(emptySearchResponse(normalizedQuery, type));
      setLoading(false);
      setError(null);
      return;
    }
    if (normalizedQuery.length === 2 && (type === 'posts' || type === 'recipes')) {
      setType('creators');
      return;
    }
    const timer = setTimeout(() => void runSearch(), 300);
    return () => clearTimeout(timer);
  }, [normalizedQuery, runSearch, type, visible]);

  if (!mounted) return null;

  return (
    <MotionView
      pointerEvents={visible ? 'auto' : 'none'}
      style={[{ position: 'absolute', inset: 0, zIndex: 20 }, animatedStyle]}
    >
    <KeyboardAvoidingArea
      style={{ flex: 1, backgroundColor: appTheme.colors.background }}
    >
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: appTheme.spacing.screen, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: appTheme.colors.borderSubtle }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close search" onPress={requestClose} hitSlop={10} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <BackGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
          </Pressable>
          <View style={{ minHeight: 50, minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: appTheme.colors.border, backgroundColor: appTheme.colors.surfaceInset, paddingHorizontal: 15 }}>
            <Search size={appTheme.icon.default} color={appTheme.colors.muted} />
            <TextInput
              ref={inputRef}
              accessibilityLabel="Search creators, posts, and recipes"
              autoCapitalize="none"
              autoCorrect={false}
              enterKeyHint="search"
              maxLength={100}
              onChangeText={setQuery}
              placeholder="Search Magicbooklet"
              placeholderTextColor={appTheme.colors.faint}
              returnKeyType="search"
              value={query}
              style={{ minWidth: 0, flex: 1, color: appTheme.colors.text, fontSize: 15, paddingVertical: 12 }}
            />
            {query ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                onPress={() => setQuery('')}
                style={{ minWidth: 44, minHeight: 44, marginRight: -13, alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={appTheme.icon.compact} color={appTheme.colors.muted} />
              </Pressable>
            ) : null}
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 3, paddingTop: 10 }} accessibilityRole="tablist">
          {SEARCH_TYPES.map((item) => (
            <SearchTab
              key={item.id}
              active={type === item.id}
              disabled={normalizedQuery.length === 2 && (item.id === 'posts' || item.id === 'recipes')}
              label={item.label}
              onPress={() => setType(item.id)}
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
        {normalizedQuery.length < 2 ? (
          history.length ? (
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: appTheme.colors.text, fontSize: 17, fontWeight: '800' }}>Recent searches</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear all recent searches"
                  onPress={() => void clearSearchHistory().then(() => setHistory([]))}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text style={{ color: appTheme.colors.primary, fontSize: 13, fontWeight: '700' }}>Clear</Text>
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
                    <Clock3 size={appTheme.icon.sm} color={appTheme.colors.faint} />
                    <Text numberOfLines={1} style={{ flex: 1, color: appTheme.colors.textSecondary, fontSize: 15 }}>{item}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item} from recent searches`}
                    onPress={() => void forgetSearchQuery(item).then(setHistory)}
                    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <X size={appTheme.icon.sm} color={appTheme.colors.faint} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : (
            <StatusBlock title="Find your next idea" body="Search creators from two characters, or use three characters to discover posts and recipes." />
          )
        ) : loading && !hasResults ? (
          <View style={{ minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <ActivityIndicator color={appTheme.colors.primary} />
            <Text style={{ color: appTheme.colors.muted, fontSize: 13 }}>Searching…</Text>
          </View>
        ) : error && !hasResults ? (
          <View style={{ gap: 12 }}>
            <StatusBlock tone="danger" title="Search did not load" body={error} />
            <SecondaryButton label="Retry search" onPress={() => void runSearch()} />
          </View>
        ) : !hasResults ? (
          <StatusBlock title={`No results for “${normalizedQuery}”`} body="Try a shorter phrase, check the spelling, or search for a creator handle." />
        ) : (
          <View style={{ gap: 25 }}>
            {(type === 'top' || type === 'creators') && result.creators.items.length ? (
              <View style={{ gap: 10 }}>
                <Text accessibilityRole="header" style={{ color: appTheme.colors.text, fontSize: 18, fontWeight: '800' }}>Creators</Text>
                {result.creators.items.map((creator) => <CreatorRow key={creator.id} creator={creator} />)}
              </View>
            ) : null}
            {(type === 'top' || type === 'posts') && result.posts.items.length ? (
              <View style={{ gap: 10 }}>
                <Text accessibilityRole="header" style={{ color: appTheme.colors.text, fontSize: 18, fontWeight: '800' }}>Posts</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  {result.posts.items.map((post) => <View key={post.id} style={{ width: '48%' }}><PostRow item={post} /></View>)}
                </View>
              </View>
            ) : null}
            {(type === 'top' || type === 'recipes') && result.recipes.items.length ? (
              <View style={{ gap: 10 }}>
                <Text accessibilityRole="header" style={{ color: appTheme.colors.text, fontSize: 18, fontWeight: '800' }}>Recipes</Text>
                {result.recipes.items.map((recipe) => <RecipeRow key={recipe.id} recipe={recipe} />)}
              </View>
            ) : null}
            {nextCursor ? <SecondaryButton disabled={loadingMore} label={loadingMore ? 'Loading…' : 'Show more'} onPress={() => void runSearch(nextCursor)} /> : null}
            {error ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.danger, textAlign: 'center', fontSize: 13 }}>{error}</Text> : null}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingArea>
    </MotionView>
  );
}
