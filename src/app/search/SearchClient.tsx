'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, LoaderCircle, MessageCircle, RefreshCcw, Sparkles } from 'lucide-react';

import { CreatorSearchResult } from '@/components/search/CreatorSearchResult';
import { SearchField } from '@/components/search/SearchField';
import { SearchStateBlock } from '@/components/search/SearchStateBlock';
import {
  PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH,
  PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH,
  normalizeCreatorSearchQuery,
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

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_FAILED_MESSAGE = 'Search could not be loaded.';
const SEARCH_OFFLINE_MESSAGE = 'Search could not be loaded. Check your connection and try again.';

// What a request asked for. Its answer or error is drawn only while the page
// still asks the same thing, so a change never reads as the old outcome.
type SearchRequest = { query: string; type: PublicSearchType };
type SearchAnswer = SearchRequest & { result: PublicSearchResponse };
type SearchFailure = SearchRequest & { message: string };

class SearchRequestError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number | null = null) {
    super(message);
  }
}

// The app's search overlay reads failures the same way; keep the two in step.
// A 429 names how long the limit lasts and an earlier retry is refused again,
// so Retry waits that long.
async function failedResponseError(response: Response): Promise<SearchRequestError> {
  if (response.status !== 429) return new SearchRequestError(SEARCH_FAILED_MESSAGE);
  const body = await response.json().catch(() => null) as { retryAfterSeconds?: unknown } | null;
  const seconds = typeof body?.retryAfterSeconds === 'number'
    && Number.isFinite(body.retryAfterSeconds)
    && body.retryAfterSeconds > 0
    ? Math.ceil(body.retryAfterSeconds)
    : null;
  return seconds === null
    ? new SearchRequestError('Search is busy. Try again shortly.')
    : new SearchRequestError(`Search is busy. Try again in ${seconds} s.`, seconds);
}

function isContentType(type: PublicSearchType) {
  return type === 'posts' || type === 'recipes';
}

function isSameRequest(entry: SearchRequest | null, query: string, type: PublicSearchType) {
  return entry !== null && entry.query === query && entry.type === type;
}

// Only the active tab's kinds are drawn, so only they count as results.
function shownResultCount(result: PublicSearchResponse, type: PublicSearchType) {
  return (type === 'top' || type === 'creators' ? result.creators.items.length : 0)
    + (type === 'top' || type === 'posts' ? result.posts.items.length : 0)
    + (type === 'top' || type === 'recipes' ? result.recipes.items.length : 0);
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
          <span>{item.saveCount} {item.saveCount === 1 ? 'save' : 'saves'}</span>
          <span className="inline-flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" />{item.commentCount}</span>
        </div>
      </div>
    </Link>
  );
}

function RecipeSearchCard({ recipe, returnTo }: { recipe: RecipeSearchResult; returnTo: string }) {
  // The server leaves the preview empty until a video has a poster; its
  // media URL is not an image, so only an image post falls back to it.
  const preview = recipe.post?.mediaPreviewUrl
    ?? (recipe.post?.mediaKind === 'image' ? recipe.post.mediaUrl : null);
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
  const [query, setQuery] = useState(initialQuery);
  // The tab the user chose. Below three characters only creators can be
  // searched, so a content tab shows as Creators and comes back at three.
  const [pickedType, setPickedType] = useState(initialType);
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [failure, setFailure] = useState<SearchFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const retryUnblockTimer = useRef<number | null>(null);
  // The query of the last scheduled search. A URL query arrives already typed
  // and a tab change keeps the query, so only a new query waits for a pause.
  const scheduledQuery = useRef(initialQuery);
  const tabRefs = useRef<Partial<Record<PublicSearchType, HTMLButtonElement | null>>>({});
  const normalizedQuery = useMemo(() => normalizePublicSearchQuery(query), [query]);
  // The server strips leading "@" (a handle search) before its length checks,
  // so the gates count the same characters; "@j" would be refused with a 400.
  const gatedQueryLength = normalizeCreatorSearchQuery(normalizedQuery).length;
  const canSearch = gatedQueryLength >= PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH;
  const contentTabsDisabled = canSearch && gatedQueryLength < PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH;
  const activeType: PublicSearchType = contentTabsDisabled && isContentType(pickedType) ? 'creators' : pickedType;
  const returnTo = searchPath(normalizedQuery, activeType);

  const onTabListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const enabledTabs = SEARCH_TABS.filter((tab) => !(contentTabsDisabled && isContentType(tab.id)));
    const currentIndex = Math.max(0, enabledTabs.findIndex((tab) => tab.id === activeType));
    const step = event.key === 'ArrowRight' ? 1 : enabledTabs.length - 1;
    const nextTab = enabledTabs[(currentIndex + step) % enabledTabs.length];
    setPickedType(nextTab.id);
    tabRefs.current[nextTab.id]?.focus();
  };

  const requestSearch = useCallback(async ({ append = false, cursor = null }: { append?: boolean; cursor?: string | null } = {}) => {
    const request: SearchRequest = { query: normalizedQuery, type: activeType };
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (append) setLoadingMore(true);
    setFailure(null);
    try {
      const params = new URLSearchParams({ q: request.query, type: request.type });
      if (cursor) params.set('cursor', cursor);
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`/api/search?${params.toString()}`, {
        cache: 'no-store',
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        signal: controller.signal,
      }).catch((fetchError: unknown) => {
        // A rejected fetch never reached the server. An abort keeps its own
        // error so the guards below drop it without a message.
        throw controller.signal.aborted ? fetchError : new SearchRequestError(SEARCH_OFFLINE_MESSAGE);
      });
      if (!response.ok) throw await failedResponseError(response);
      const next = await response.json() as PublicSearchResponse;
      if (sequence !== requestSequence.current) return;
      if (retryUnblockTimer.current !== null) window.clearTimeout(retryUnblockTimer.current);
      retryUnblockTimer.current = null;
      setRetryBlocked(false);
      setAnswer((current) => {
        if (!append) return { ...request, result: next };
        if (!current || !isSameRequest(current, request.query, request.type)) return current;
        return {
          ...current,
          result: {
            ...next,
            creators: request.type === 'creators' ? { ...next.creators, items: [...current.result.creators.items, ...next.creators.items] } : next.creators,
            posts: request.type === 'posts' ? { ...next.posts, items: [...current.result.posts.items, ...next.posts.items] } : next.posts,
            recipes: request.type === 'recipes' ? { ...next.recipes, items: [...current.result.recipes.items, ...next.recipes.items] } : next.recipes,
          },
        };
      });
    } catch (requestError) {
      if (sequence !== requestSequence.current) return;
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      const error = requestError instanceof SearchRequestError ? requestError : new SearchRequestError(SEARCH_FAILED_MESSAGE);
      setFailure({ ...request, message: error.message });
      if (error.retryAfterSeconds !== null) {
        if (retryUnblockTimer.current !== null) window.clearTimeout(retryUnblockTimer.current);
        setRetryBlocked(true);
        retryUnblockTimer.current = window.setTimeout(() => {
          retryUnblockTimer.current = null;
          setRetryBlocked(false);
        }, error.retryAfterSeconds * 1000);
      }
    } finally {
      if (sequence === requestSequence.current) setLoadingMore(false);
    }
  }, [activeType, normalizedQuery]);

  useEffect(() => () => {
    requestController.current?.abort();
    if (retryUnblockTimer.current !== null) window.clearTimeout(retryUnblockTimer.current);
  }, []);

  useEffect(() => {
    if (!canSearch) {
      // Drop an answer still on its way: the page is back to its idle state.
      requestSequence.current += 1;
      setAnswer(null);
      setFailure(null);
      // history.replaceState keeps Next's router in step without a server
      // render; this page is dynamic, so router.replace re-rendered it per keystroke.
      window.history.replaceState(null, '', '/search');
      return;
    }
    // Cleared now rather than when the request starts, so an old error never
    // stands for the new query during the pause.
    setFailure(null);
    const search = () => {
      window.history.replaceState(null, '', searchPath(normalizedQuery, activeType));
      void requestSearch();
    };
    const waitForPause = scheduledQuery.current !== normalizedQuery;
    scheduledQuery.current = normalizedQuery;
    if (!waitForPause) {
      search();
      return;
    }
    const timer = window.setTimeout(search, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeType, canSearch, normalizedQuery, requestSearch]);

  const currentAnswer = isSameRequest(answer, normalizedQuery, activeType) ? answer : null;
  const currentFailure = isSameRequest(failure, normalizedQuery, activeType) ? failure : null;
  const pending = canSearch && !currentAnswer && !currentFailure;
  // While the next query on the same tab loads, the previous cards stay up,
  // dimmed. Another tab's answer holds other kinds, so it is not drawn.
  const shownAnswer = currentAnswer ?? (pending && answer?.type === activeType ? answer : null);
  const resultCount = shownAnswer ? shownResultCount(shownAnswer.result, activeType) : 0;
  const staleResultsShown = pending && resultCount > 0;
  const statusMessage = !canSearch
    ? ''
    : pending
      ? 'Searching…'
      : currentFailure
        ? ''
        : `${resultCount} ${resultCount === 1 ? 'result' : 'results'} for ${normalizedQuery}`;
  const nextCursor = !currentAnswer
    ? null
    : activeType === 'creators'
      ? currentAnswer.result.creators.nextCursor
      : activeType === 'posts'
        ? currentAnswer.result.posts.nextCursor
        : activeType === 'recipes'
          ? currentAnswer.result.recipes.nextCursor
          : null;

  return (
    <div className="min-h-screen px-4 pb-24 pt-10 sm:px-6 sm:pt-14">
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
              const disabled = contentTabsDisabled && isContentType(tab.id);
              return (
                <button
                  key={tab.id}
                  ref={(element) => { tabRefs.current[tab.id] = element; }}
                  type="button"
                  role="tab"
                  aria-selected={activeType === tab.id}
                  tabIndex={activeType === tab.id ? 0 : -1}
                  disabled={disabled}
                  onClick={() => setPickedType(tab.id)}
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

        <div className="mt-8" aria-busy={pending}>
          {staleResultsShown ? (
            <div className="mb-6 flex items-center gap-2 text-sm text-zinc-400">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Searching…
            </div>
          ) : null}
          {!canSearch ? (
            <SearchStateBlock tone="initial" title="Start with a creator or idea" body="Type at least two characters. Posts and recipes become available after three." />
          ) : currentFailure && !currentAnswer ? (
            <SearchStateBlock
              tone="error"
              title="Search did not load"
              body={currentFailure.message}
              action={<button type="button" disabled={retryBlocked} onClick={() => void requestSearch()} className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"><RefreshCcw className="h-4 w-4" /> Retry</button>}
            />
          ) : !shownAnswer || resultCount === 0 ? (
            pending ? (
              <div className="flex min-h-72 items-center justify-center rounded-[32px] border border-white/8 bg-white/[0.025] text-sm text-zinc-400">
                <LoaderCircle className="mr-2 h-5 w-5 animate-spin" /> Searching…
              </div>
            ) : (
              <SearchStateBlock title={`No results for “${normalizedQuery}”`} body="Try a shorter phrase, check the spelling, or search for a creator handle." />
            )
          ) : (
            <div className={`space-y-10 transition-opacity${staleResultsShown ? ' opacity-60' : ''}`}>
              {(activeType === 'top' || activeType === 'creators') && shownAnswer.result.creators.items.length ? (
                <section aria-labelledby="search-creators-heading">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 id="search-creators-heading" className="text-xl font-semibold text-white">Creators</h2>
                    {activeType === 'top' ? <button type="button" onClick={() => setPickedType('creators')} className="ui-focus-ring rounded-full px-3 py-2 text-sm text-zinc-400 hover:text-white">See all</button> : null}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">{shownAnswer.result.creators.items.map((creator) => <CreatorSearchResult key={creator.id} creator={creator} />)}</div>
                </section>
              ) : null}

              {(activeType === 'top' || activeType === 'posts') && shownAnswer.result.posts.items.length ? (
                <section aria-labelledby="search-posts-heading">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 id="search-posts-heading" className="text-xl font-semibold text-white">Posts</h2>
                    {activeType === 'top' ? <button type="button" onClick={() => setPickedType('posts')} className="ui-focus-ring rounded-full px-3 py-2 text-sm text-zinc-400 hover:text-white">See all</button> : null}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{shownAnswer.result.posts.items.map((item) => <PostSearchCard key={item.id} item={item} returnTo={returnTo} />)}</div>
                </section>
              ) : null}

              {(activeType === 'top' || activeType === 'recipes') && shownAnswer.result.recipes.items.length ? (
                <section aria-labelledby="search-recipes-heading">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 id="search-recipes-heading" className="text-xl font-semibold text-white">Recipes</h2>
                    {activeType === 'top' ? <button type="button" onClick={() => setPickedType('recipes')} className="ui-focus-ring rounded-full px-3 py-2 text-sm text-zinc-400 hover:text-white">See all</button> : null}
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2">{shownAnswer.result.recipes.items.map((recipe) => <RecipeSearchCard key={recipe.id} recipe={recipe} returnTo={returnTo} />)}</div>
                </section>
              ) : null}

              {nextCursor ? (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    disabled={loadingMore || retryBlocked}
                    onClick={() => void requestSearch({ append: true, cursor: nextCursor })}
                    className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-6 text-sm font-semibold text-white transition hover:bg-white/[0.09] disabled:opacity-50"
                  >
                    {loadingMore ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                    {loadingMore ? 'Loading…' : 'Show more'}
                  </button>
                </div>
              ) : null}

              {currentFailure ? <p role="alert" className="text-center text-sm text-rose-300">{currentFailure.message}</p> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
