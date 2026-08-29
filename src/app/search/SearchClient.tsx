'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, LoaderCircle, MessageCircle, RefreshCcw, Sparkles } from 'lucide-react';

import { CreatorSearchResult } from '@/app/components/search/CreatorSearchResult';
import { SearchField } from '@/app/components/search/SearchField';
import { SearchStateBlock } from '@/app/components/search/SearchStateBlock';
import {
  PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH,
  PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH,
  emptyPublicSearchPage,
  normalizePublicSearchQuery,
  type PublicSearchResponse,
  type PublicSearchType,
  type RecipeSearchResult,
} from '@/lib/public-search';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { supabase } from '@/lib/supabase';

const SEARCH_TABS: Array<{ id: PublicSearchType; label: string }> = [
  { id: 'top', label: 'Top' },
  { id: 'creators', label: 'Creators' },
  { id: 'posts', label: 'Posts' },
  { id: 'recipes', label: 'Recipes' },
];

function emptyResponse(query: string, type: PublicSearchType): PublicSearchResponse {
  return {
    query,
    normalizedQuery: normalizePublicSearchQuery(query),
    type,
    creators: emptyPublicSearchPage(),
    posts: emptyPublicSearchPage(),
    recipes: emptyPublicSearchPage(),
  };
}

function searchPath(query: string, type: PublicSearchType) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (type !== 'top') params.set('type', type);
  return `/search${params.size ? `?${params.toString()}` : ''}`;
}

function PostSearchCard({ item, returnTo }: { item: ShowcaseFeedItem; returnTo: string }) {
  const cover = item.mediaItems?.slice().sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const preview = cover?.previewUrl ?? (cover?.mediaKind === 'image' ? cover.url : null) ?? (item.mediaKind === 'image' ? item.mediaUrl : null);
  return (
    <Link
      href={buildShowcaseDetailPath(item.id, { from: 'search', returnTo })}
      className="ui-focus-ring group overflow-hidden rounded-[26px] border border-white/8 bg-white/[0.035] transition hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.055]"
    >
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-[1.015]" />
      ) : (
        <div className="flex aspect-[4/3] items-center justify-center bg-[radial-gradient(circle_at_30%_20%,rgba(255,122,89,0.2),transparent_50%),#111116]">
          <Sparkles className="h-7 w-7 text-[var(--ui-primary)]" aria-hidden="true" />
        </div>
      )}
      <div className="p-4">
        <div className="truncate text-sm font-semibold text-white">{item.title}</div>
        <div className="mt-1 truncate text-xs text-zinc-400">{item.creator.name}</div>
        <div className="mt-3 flex items-center gap-4 text-xs text-zinc-500">
          <span>{item.saveCount} saves</span>
          <span className="inline-flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" />{item.commentCount}</span>
        </div>
      </div>
    </Link>
  );
}

function RecipeSearchCard({ recipe, returnTo }: { recipe: RecipeSearchResult; returnTo: string }) {
  const preview = recipe.post?.mediaPreviewUrl ?? recipe.post?.mediaUrl ?? null;
  return (
    <Link
      href={buildShowcaseDetailPath(recipe.postId, { from: 'search', returnTo, section: 'resources' })}
      className="ui-focus-ring group flex min-h-32 overflow-hidden rounded-[24px] border border-white/8 bg-white/[0.035] transition hover:border-white/15 hover:bg-white/[0.06]"
    >
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="w-28 shrink-0 object-cover sm:w-36" />
      ) : (
        <span className="flex w-28 shrink-0 items-center justify-center bg-emerald-400/8 text-emerald-300 sm:w-36">
          <BookOpen className="h-6 w-6" />
        </span>
      )}
      <span className="min-w-0 flex-1 p-4">
        <span className="block truncate text-sm font-semibold text-white">{recipe.title}</span>
        <span className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-400">{recipe.summary || recipe.previewText}</span>
        <span className="mt-3 flex items-center justify-between gap-3 text-xs">
          <span className="truncate text-zinc-500">{recipe.seller.name}</span>
          <span className="shrink-0 font-semibold text-emerald-300">{recipe.accessMode === 'free' ? 'Free' : recipe.priceQuote.formatted}</span>
        </span>
      </span>
    </Link>
  );
}

export default function SearchClient({
  initialQuery,
  initialType,
}: {
  initialQuery: string;
  initialType: PublicSearchType;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [activeType, setActiveType] = useState(initialType);
  const [result, setResult] = useState<PublicSearchResponse>(() => emptyResponse(initialQuery, initialType));
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const tabRefs = useRef<Partial<Record<PublicSearchType, HTMLButtonElement | null>>>({});
  const normalizedQuery = useMemo(() => normalizePublicSearchQuery(query), [query]);
  const returnTo = searchPath(normalizedQuery, activeType);

  const onTabListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const enabledTabs = SEARCH_TABS.filter(
      (tab) => !(normalizedQuery.length === 2 && (tab.id === 'posts' || tab.id === 'recipes')),
    );
    const currentIndex = Math.max(0, enabledTabs.findIndex((tab) => tab.id === activeType));
    const step = event.key === 'ArrowRight' ? 1 : enabledTabs.length - 1;
    const nextTab = enabledTabs[(currentIndex + step) % enabledTabs.length];
    setActiveType(nextTab.id);
    tabRefs.current[nextTab.id]?.focus();
  };

  const requestSearch = useCallback(async ({ append = false, cursor = null }: { append?: boolean; cursor?: string | null } = {}) => {
    if (normalizedQuery.length < PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH) return;
    if ((activeType === 'posts' || activeType === 'recipes') && normalizedQuery.length < PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH) return;
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: normalizedQuery, type: activeType });
      if (cursor) params.set('cursor', cursor);
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`/api/search?${params.toString()}`, {
        cache: 'no-store',
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'Search is busy. Try again shortly.' : 'Search could not be loaded.');
      const next = await response.json() as PublicSearchResponse;
      if (sequence !== requestSequence.current) return;
      setResult((current) => append ? {
        ...next,
        creators: activeType === 'creators' ? { ...next.creators, items: [...current.creators.items, ...next.creators.items] } : next.creators,
        posts: activeType === 'posts' ? { ...next.posts, items: [...current.posts.items, ...next.posts.items] } : next.posts,
        recipes: activeType === 'recipes' ? { ...next.recipes, items: [...current.recipes.items, ...next.recipes.items] } : next.recipes,
      } : next);
    } catch (requestError) {
      if (sequence !== requestSequence.current) return;
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setError(requestError instanceof Error ? requestError.message : 'Search could not be loaded.');
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [activeType, normalizedQuery]);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    if (normalizedQuery.length < PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH) {
      requestSequence.current += 1;
      setResult(emptyResponse(normalizedQuery, activeType));
      setLoading(false);
      setError(null);
      router.replace('/search', { scroll: false });
      return;
    }
    if (normalizedQuery.length === 2 && (activeType === 'posts' || activeType === 'recipes')) {
      setActiveType('creators');
      return;
    }
    const timer = window.setTimeout(() => {
      router.replace(searchPath(normalizedQuery, activeType), { scroll: false });
      void requestSearch();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeType, normalizedQuery, requestSearch, router]);

  const resultCount = result.creators.items.length + result.posts.items.length + result.recipes.items.length;
  const hasResults = resultCount > 0;
  const statusMessage = normalizedQuery.length < PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH
    ? ''
    : loading
      ? 'Searching…'
      : error
        ? ''
        : `${resultCount} ${resultCount === 1 ? 'result' : 'results'} for ${normalizedQuery}`;
  const nextCursor = activeType === 'creators'
    ? result.creators.nextCursor
    : activeType === 'posts'
      ? result.posts.nextCursor
      : activeType === 'recipes'
        ? result.recipes.nextCursor
        : null;

  return (
    <main id="main-content" className="min-h-screen px-4 pb-24 pt-10 sm:px-6 sm:pt-14">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--ui-primary)]">Discover Magicbooklet</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-5xl">Search the creator community</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-400 sm:text-base">Find people, public work, and production-ready recipes without leaving your creative flow.</p>
        </div>

        <div className="sticky top-20 z-20 mt-8 rounded-[28px] bg-black/70 p-2 backdrop-blur-xl sm:top-24">
          <SearchField value={query} onChange={setQuery} onClear={() => setQuery('')} autoFocus={!initialQuery} />
          <div
            className="mt-2 flex gap-1 overflow-x-auto px-1 pb-1"
            role="tablist"
            aria-label="Search result type"
            onKeyDown={onTabListKeyDown}
          >
            {SEARCH_TABS.map((tab) => {
              const disabled = normalizedQuery.length === 2 && (tab.id === 'posts' || tab.id === 'recipes');
              return (
                <button
                  key={tab.id}
                  ref={(element) => { tabRefs.current[tab.id] = element; }}
                  type="button"
                  role="tab"
                  aria-selected={activeType === tab.id}
                  tabIndex={activeType === tab.id ? 0 : -1}
                  disabled={disabled}
                  onClick={() => setActiveType(tab.id)}
                  className={`ui-focus-ring min-h-11 shrink-0 rounded-full px-5 text-sm font-semibold transition ${activeType === tab.id ? 'bg-white text-black' : 'text-zinc-400 hover:bg-white/8 hover:text-white disabled:cursor-not-allowed disabled:opacity-35'}`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Announce a settled summary rather than making the whole result grid
            a live region, which would re-read every card on each change. */}
        <p role="status" className="sr-only">{statusMessage}</p>

        <div className="mt-8" aria-busy={loading}>
          {normalizedQuery.length < PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH ? (
            <SearchStateBlock tone="initial" title="Start with a creator or idea" body="Type at least two characters. Posts and recipes become available after three." />
          ) : loading && !hasResults ? (
            <div className="flex min-h-72 items-center justify-center rounded-[32px] border border-white/8 bg-white/[0.025] text-sm text-zinc-400">
              <LoaderCircle className="mr-2 h-5 w-5 animate-spin" /> Searching…
            </div>
          ) : error && !hasResults ? (
            <SearchStateBlock
              tone="error"
              title="Search did not load"
              body={error}
              action={<button type="button" onClick={() => void requestSearch()} className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-black"><RefreshCcw className="h-4 w-4" /> Retry</button>}
            />
          ) : !hasResults ? (
            <SearchStateBlock title={`No results for “${normalizedQuery}”`} body="Try a shorter phrase, check the spelling, or search for a creator handle." />
          ) : (
            <div className="space-y-10">
              {(activeType === 'top' || activeType === 'creators') && result.creators.items.length ? (
                <section aria-labelledby="search-creators-heading">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 id="search-creators-heading" className="text-xl font-semibold text-white">Creators</h2>
                    {activeType === 'top' ? <button type="button" onClick={() => setActiveType('creators')} className="ui-focus-ring rounded-full px-3 py-2 text-sm text-zinc-400 hover:text-white">See all</button> : null}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">{result.creators.items.map((creator) => <CreatorSearchResult key={creator.id} creator={creator} />)}</div>
                </section>
              ) : null}

              {(activeType === 'top' || activeType === 'posts') && result.posts.items.length ? (
                <section aria-labelledby="search-posts-heading">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 id="search-posts-heading" className="text-xl font-semibold text-white">Posts</h2>
                    {activeType === 'top' ? <button type="button" onClick={() => setActiveType('posts')} className="ui-focus-ring rounded-full px-3 py-2 text-sm text-zinc-400 hover:text-white">See all</button> : null}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{result.posts.items.map((item) => <PostSearchCard key={item.id} item={item} returnTo={returnTo} />)}</div>
                </section>
              ) : null}

              {(activeType === 'top' || activeType === 'recipes') && result.recipes.items.length ? (
                <section aria-labelledby="search-recipes-heading">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 id="search-recipes-heading" className="text-xl font-semibold text-white">Recipes</h2>
                    {activeType === 'top' ? <button type="button" onClick={() => setActiveType('recipes')} className="ui-focus-ring rounded-full px-3 py-2 text-sm text-zinc-400 hover:text-white">See all</button> : null}
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2">{result.recipes.items.map((recipe) => <RecipeSearchCard key={recipe.id} recipe={recipe} returnTo={returnTo} />)}</div>
                </section>
              ) : null}

              {nextCursor ? (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void requestSearch({ append: true, cursor: nextCursor })}
                    className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-6 text-sm font-semibold text-white transition hover:bg-white/[0.09] disabled:opacity-50"
                  >
                    {loadingMore ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                    {loadingMore ? 'Loading…' : 'Show more'}
                  </button>
                </div>
              ) : null}

              {error ? <p role="alert" className="text-center text-sm text-rose-300">{error}</p> : null}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
