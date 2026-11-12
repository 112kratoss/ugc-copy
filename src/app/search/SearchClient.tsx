'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Box, Clock3, LoaderCircle, MessageCircle, RefreshCcw, Sparkles, Wrench, X } from 'lucide-react';

import { SegmentedControl } from '@/components/DesignSystem';
import { CreatorSearchResult } from '@/components/search/CreatorSearchResult';
import { SearchField } from '@/components/search/SearchField';
import { SearchStateBlock } from '@/components/search/SearchStateBlock';
import {
  NO_PUBLIC_SEARCH_FILTERS,
  PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH,
  PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH,
  hasPublicSearchFilters,
  normalizeCreatorSearchQuery,
  normalizePublicSearchQuery,
  publicSearchFilterKey,
  publicSearchFilterParams,
  publicSearchQueryLength,
  publicSearchTypeHasFilters,
  publicSearchTypeHasSorts,
  searchEntityId,
  type PublicSearchFilters,
  type PublicSearchResponse,
  type PublicSearchSort,
  type PublicSearchType,
  type RecipeSearchResult,
  type SearchEntityResult,
} from '@/lib/public-search';
import { formatRecipeCreditPrice } from '@/lib/showcase-asset-labels';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { supabase } from '@/lib/supabase';

import {
  SEARCH_CORRECTED_AGAIN_LABEL,
  SEARCH_ENTITIES_HEADING,
  SEARCH_FILTERED_EMPTY_BODY,
  SEARCH_FILTERS_CLEAR_LABEL,
  SEARCH_FILTERS_GROUP_LABEL,
  SEARCH_FILTER_SWITCHES,
  SEARCH_RECENTS_CLEAR_LABEL,
  SEARCH_RECENTS_HEADING,
  isSearchFilterSwitchOn,
  parseSearchEntityId,
  searchCorrectionNotice,
  searchEntityActionLabel,
  searchEntityCountLabel,
  searchEntityKindLabel,
  searchExactNotice,
  searchInsteadLabel,
  searchMadeWithChipLabel,
  searchMadeWithRemoveLabel,
  toggleSearchFilterSwitch,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import { clearSearchHistory, forgetSearchQuery, readSearchHistory, rememberSearchQuery } from './search-history';

const SEARCH_TABS: Array<{ id: PublicSearchType; label: string }> = [
  { id: 'top', label: 'Top' },
  { id: 'creators', label: 'Creators' },
  { id: 'posts', label: 'Posts' },
  { id: 'recipes', label: 'Recipes' },
];

// The order of a Posts or Recipes search. The Top tab and Creators have one.
const SEARCH_SORTS: Array<{ value: PublicSearchSort; label: string }> = [
  { value: 'top', label: 'Top' },
  { value: 'latest', label: 'Latest' },
];

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_FAILED_MESSAGE = 'Search could not be loaded.';
const SEARCH_OFFLINE_MESSAGE = 'Search could not be loaded. Check your connection and try again.';

// What a request asked for. Its answer or error is drawn only while the page
// still asks the same thing, so a change never reads as the old outcome.
// `narrowing` is the filters and the exact reading as one string
// (publicSearchFilterKey), '' for none.
type SearchRequest = { query: string; type: PublicSearchType; sort: PublicSearchSort; narrowing: string };
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

function isSameRequest(
  entry: SearchRequest | null,
  query: string,
  type: PublicSearchType,
  sort: PublicSearchSort,
  narrowing: string,
) {
  return entry !== null && entry.query === query && entry.type === type && entry.sort === sort
    && entry.narrowing === narrowing;
}

// Only the active tab's kinds are drawn, so only they count as results: on
// Top, the models and tools the query names among them.
function shownResultCount(result: PublicSearchResponse, type: PublicSearchType) {
  return (type === 'top' ? result.entities?.length ?? 0 : 0)
    + (type === 'top' || type === 'creators' ? result.creators.items.length : 0)
    + (type === 'top' || type === 'posts' ? result.posts.items.length : 0)
    + (type === 'top' || type === 'recipes' ? result.recipes.items.length : 0);
}

// The page's address: the query, the tab, where it is not the ranked one the
// order, and what narrows the search, so a search can be shared and a post
// opened from it comes back to the same results.
function searchPath(
  query: string,
  type: PublicSearchType,
  sort: PublicSearchSort,
  filters: PublicSearchFilters,
  exact: boolean,
) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (type !== 'top') params.set('type', type);
  if (sort !== 'top') params.set('sort', sort);
  for (const [name, value] of Object.entries(publicSearchFilterParams(filters, exact))) params.set(name, value);
  return `/search${params.size ? `?${params.toString()}` : ''}`;
}

const CHIP_CLASS = 'ui-focus-ring inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition';
const CHIP_OFF_CLASS = 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/20 hover:bg-white/[0.08] hover:text-white';
const CHIP_ON_CLASS = 'border-white bg-white text-black';

// A model or tool as a result: pressing it shows the posts made with it.
function EntityResult({ entity, onPick }: { entity: SearchEntityResult; onPick: (entity: SearchEntityResult) => void }) {
  const Icon = entity.kind === 'model' ? Box : Wrench;
  return (
    <li>
      <button
        type="button"
        aria-label={searchEntityActionLabel(entity)}
        onClick={() => onPick(entity)}
        className="ui-focus-ring flex min-h-16 w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.035] px-4 py-3 text-left transition hover:border-white/15 hover:bg-white/[0.065]"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-[var(--ui-primary)]">
          <Icon className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{entity.label}</span>
          <span className="mt-0.5 block truncate text-xs text-zinc-400">
            {searchEntityKindLabel(entity.kind)} · {searchEntityCountLabel(entity)}
          </span>
        </span>
      </button>
    </li>
  );
}

// What narrows a Posts search: toggle buttons, pressed while on, and the
// made-with filter as a chip of its own that removes it.
function SearchFilterBar({
  filters,
  madeWithLabel,
  followingOffered,
  onChange,
}: {
  filters: PublicSearchFilters;
  /** The name of the made-with entity, once known. */
  madeWithLabel: string | null;
  /** A visitor follows nobody: the switch is drawn only for an account. */
  followingOffered: boolean;
  onChange: (filters: PublicSearchFilters) => void;
}) {
  return (
    <div role="group" aria-label={SEARCH_FILTERS_GROUP_LABEL} className="mb-6 flex flex-wrap items-center gap-2">
      {filters.madeWith && madeWithLabel ? (
        <button
          type="button"
          aria-pressed="true"
          aria-label={searchMadeWithRemoveLabel(madeWithLabel)}
          onClick={() => onChange({ ...filters, madeWith: null })}
          className={`${CHIP_CLASS} ${CHIP_ON_CLASS} max-w-full`}
        >
          <span className="truncate">{searchMadeWithChipLabel(madeWithLabel)}</span>
          <X className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
      ) : null}
      {SEARCH_FILTER_SWITCHES.filter((item) => item.id !== 'following' || followingOffered).map((item) => {
        const on = isSearchFilterSwitchOn(filters, item.id);
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(toggleSearchFilterSwitch(filters, item.id))}
            className={`${CHIP_CLASS} ${on ? CHIP_ON_CLASS : CHIP_OFF_CLASS}`}
          >
            {item.label}
          </button>
        );
      })}
      {hasPublicSearchFilters(filters) ? (
        <button
          type="button"
          onClick={() => onChange(NO_PUBLIC_SEARCH_FILTERS)}
          className="ui-focus-ring inline-flex min-h-10 items-center rounded-full px-3 text-sm text-zinc-400 hover:text-white"
        >
          {SEARCH_FILTERS_CLEAR_LABEL}
        </button>
      ) : null}
    </div>
  );
}

function SearchSortControl({
  kind,
  sort,
  onChange,
}: {
  kind: 'posts' | 'recipes';
  sort: PublicSearchSort;
  onChange: (sort: PublicSearchSort) => void;
}) {
  return (
    <SegmentedControl
      ariaLabel={`Sort ${kind}`}
      options={SEARCH_SORTS}
      value={sort}
      onChange={onChange}
      fill={false}
      size="compact"
    />
  );
}

function PostSearchCard({ item, returnTo }: { item: ShowcaseFeedItem; returnTo: string }) {
  const cover = item.mediaItems?.slice().sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const preview = cover?.previewUrl ?? (cover?.mediaKind === 'image' ? cover.url : null) ?? (item.mediaKind === 'image' ? item.mediaUrl : null);
  return (
    <Link
      href={buildShowcaseDetailPath(item.id, { from: 'search', returnTo })}
      className="ui-focus-ring group overflow-hidden rounded-3xl border border-white/8 bg-white/[0.035] transition hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.055]"
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
      className="ui-focus-ring group flex min-h-32 overflow-hidden rounded-2xl border border-white/8 bg-white/[0.035] transition hover:border-white/15 hover:bg-white/[0.06]"
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
          <span className="shrink-0 font-semibold text-emerald-300">
            {/* In credits, as the app's search row and every recipe chip price it (decision 2). */}
            {recipe.accessMode === 'free' ? 'Free' : formatRecipeCreditPrice(recipe.priceUsdCents)}
          </span>
        </span>
      </span>
    </Link>
  );
}

export default function SearchClient({
  initialQuery,
  initialType,
  initialSort = 'top',
  initialFilters = NO_PUBLIC_SEARCH_FILTERS,
  initialExact = false,
}: {
  initialQuery: string;
  initialType: PublicSearchType;
  initialSort?: PublicSearchSort;
  /** A shared link's filters. */
  initialFilters?: PublicSearchFilters;
  /** A shared link asked for the query as typed. */
  initialExact?: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  // The tab the user chose. Below three characters only creators can be
  // searched, so a content tab shows as Creators and comes back at three.
  const [pickedType, setPickedType] = useState(initialType);
  // The order the user chose for Posts and Recipes. It is kept across tabs,
  // and read only on the two that have another order than the ranked one.
  const [pickedSort, setPickedSort] = useState(initialSort);
  // What narrows Posts. Kept across tabs, as the order is, and read only on
  // Posts: the Top tab is the best of each kind.
  const [pickedFilters, setPickedFilters] = useState(initialFilters);
  // The query the person asked to have read as typed ("search instead for").
  // It belongs to that query: typing another one is a new search, corrected
  // again where it needs to be.
  const [exactQuery, setExactQuery] = useState(initialExact ? initialQuery : null);
  // The name of each entity this page has been told, by its id, so a filter
  // picked from a result is named before its own answer arrives.
  const [entityLabels, setEntityLabels] = useState<Record<string, string>>({});
  // A registered account: the only viewer "from creators I follow" means anything for.
  const [canFollow, setCanFollow] = useState(false);
  // Recent searches live in this browser alone, and are read after the first
  // paint: the server's HTML has none to agree with.
  const [history, setHistory] = useState<string[]>([]);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const recentsRef = useRef<HTMLDivElement | null>(null);
  const searchFormRef = useRef<HTMLFormElement | null>(null);
  // A search committed with Enter before its answer landed: kept once it finds something.
  const rememberOnAnswer = useRef<string | null>(null);
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
  // The server strips leading "@" (a handle search) before its length checks
  // and counts characters, an emoji as one, so the gates count the same;
  // "@j" would be refused with a 400.
  const gatedQueryLength = publicSearchQueryLength(normalizeCreatorSearchQuery(normalizedQuery));
  const canSearch = gatedQueryLength >= PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH;
  const contentTabsDisabled = canSearch && gatedQueryLength < PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH;
  const activeType: PublicSearchType = contentTabsDisabled && isContentType(pickedType) ? 'creators' : pickedType;
  const activeSort: PublicSearchSort = publicSearchTypeHasSorts(activeType) ? pickedSort : 'top';
  const activeFilters = publicSearchTypeHasFilters(activeType) ? pickedFilters : NO_PUBLIC_SEARCH_FILTERS;
  // Creators are never corrected: there the exact reading changes nothing and is not named.
  const activeExact = activeType !== 'creators' && exactQuery !== null && exactQuery === normalizedQuery;
  const narrowing = publicSearchFilterKey(activeFilters, activeExact);
  const returnTo = searchPath(normalizedQuery, activeType, activeSort, activeFilters, activeExact);

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
    const request: SearchRequest = { query: normalizedQuery, type: activeType, sort: activeSort, narrowing };
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (append) setLoadingMore(true);
    setFailure(null);
    try {
      const params = new URLSearchParams({ q: request.query, type: request.type });
      // A cursor pages the order it was issued for, so a later page names it too.
      if (request.sort !== 'top') params.set('sort', request.sort);
      // A cursor pages the filters and the reading it was issued under, so a later page names them too.
      for (const [name, value] of Object.entries(publicSearchFilterParams(activeFilters, activeExact))) params.set(name, value);
      if (cursor) params.set('cursor', cursor);
      const { data: { session } } = await supabase.auth.getSession();
      setCanFollow(Boolean(session?.user) && session?.user?.is_anonymous !== true);
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
      // The names this answer gives: its entities, and the one its filter is read with.
      const named = [...(next.entities ?? []), ...(next.filters?.madeWith ? [next.filters.madeWith] : [])];
      if (named.length) {
        setEntityLabels((current) => ({
          ...current,
          ...Object.fromEntries(named.map((entity) => [searchEntityId(entity), entity.label])),
        }));
      }
      const requestKey = `${request.type}:${request.sort}:${request.narrowing}:${request.query}`;
      if (!append && rememberOnAnswer.current === requestKey) {
        rememberOnAnswer.current = null;
        if (shownResultCount(next, request.type) > 0) setHistory(rememberSearchQuery(request.query));
      }
      setAnswer((current) => {
        if (!append) return { ...request, result: next };
        if (!current || !isSameRequest(current, request.query, request.type, request.sort, request.narrowing)) return current;
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
  }, [activeExact, activeFilters, activeSort, activeType, narrowing, normalizedQuery]);

  useEffect(() => {
    setHistory(readSearchHistory());
    // The box can hold the focus before this script runs (autofocus on an
    // empty search, or a press on the server's HTML), and a focus that
    // happened then fires no event here.
    if (searchFormRef.current?.contains(document.activeElement)) setRecentsOpen(true);
  }, []);

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
      window.history.replaceState(null, '', searchPath(normalizedQuery, activeType, activeSort, activeFilters, activeExact));
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
  }, [activeExact, activeFilters, activeSort, activeType, canSearch, normalizedQuery, requestSearch]);

  const currentAnswer = isSameRequest(answer, normalizedQuery, activeType, activeSort, narrowing) ? answer : null;
  const currentFailure = isSameRequest(failure, normalizedQuery, activeType, activeSort, narrowing) ? failure : null;
  const pending = canSearch && !currentAnswer && !currentFailure;
  // While the next query on the same tab loads, the previous cards stay up,
  // dimmed, and so do the cards of the other order while Top or Latest loads:
  // the two hold the same results. Another tab's answer holds other kinds, so
  // it is not drawn.
  const shownAnswer = currentAnswer ?? (pending && answer?.type === activeType ? answer : null);
  const resultCount = shownAnswer ? shownResultCount(shownAnswer.result, activeType) : 0;
  const staleResultsShown = pending && resultCount > 0;
  // How the search in front read the query, said only of an answer for it.
  const correctionNotice = currentAnswer
    ? searchCorrectionNotice(currentAnswer.result.correctedQuery, activeType)
    : null;
  const exactNotice = currentAnswer && activeExact ? searchExactNotice(normalizedQuery) : null;
  // One live region says the settled outcome, the reading first: "Showing
  // results for “portrait”. 12 results for portriat".
  const statusMessage = !canSearch
    ? ''
    : pending
      ? 'Searching…'
      : currentFailure
        ? ''
        : `${correctionNotice ?? exactNotice ? `${correctionNotice ?? exactNotice}. ` : ''}${resultCount} ${resultCount === 1 ? 'result' : 'results'} for ${normalizedQuery}`;
  // The filters as the page shows them: the made-with entity by the name an
  // answer or a pressed result gave it, by its key until then.
  const madeWithLabel = !activeFilters.madeWith
    ? null
    : (currentAnswer?.result.filters?.madeWith?.label
      ?? entityLabels[activeFilters.madeWith]
      ?? parseSearchEntityId(activeFilters.madeWith)?.key
      ?? null);
  const filtersShown = canSearch && publicSearchTypeHasFilters(activeType);
  const entities = activeType === 'top' && shownAnswer ? shownAnswer.result.entities ?? [] : [];

  const pickEntity = (entity: SearchEntityResult) => {
    setEntityLabels((current) => ({ ...current, [searchEntityId(entity)]: entity.label }));
    setPickedFilters((current) => ({ ...current, madeWith: searchEntityId(entity) }));
    setPickedType('posts');
  };

  // Recent searches keep what the person acted on, never each pause in
  // typing: a search committed with Enter, and one a result was opened from.
  const commitSearch = () => {
    if (!canSearch) return;
    if (currentAnswer) {
      if (resultCount > 0) setHistory(rememberSearchQuery(normalizedQuery));
      return;
    }
    rememberOnAnswer.current = `${activeType}:${activeSort}:${narrowing}:${normalizedQuery}`;
  };
  const rememberOpenedResult = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || !event.target.closest('a[href]')) return;
    if (currentAnswer && resultCount > 0) setHistory(rememberSearchQuery(normalizedQuery));
  };
  const recentsShown = recentsOpen && query === '' && history.length > 0;
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
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--ui-primary)]">Discover Magic Booklet</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-5xl">Search the creator community</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-400 sm:text-base">Find people, public work, and production-ready recipes without leaving your creative flow.</p>
        </div>

        <div className="sticky top-20 z-20 mt-8 rounded-4xl bg-black/70 p-2 backdrop-blur-xl sm:top-24">
          {/* Enter commits the search (it is kept among the recent ones); the
              results follow the typing either way. */}
          <form
            ref={searchFormRef}
            role="search"
            onSubmit={(event) => { event.preventDefault(); commitSearch(); }}
            onFocus={() => setRecentsOpen(true)}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Node) || !recentsRef.current?.contains(next)) setRecentsOpen(false);
            }}
          >
            <SearchField value={query} onChange={setQuery} onClear={() => setQuery('')} autoFocus={!initialQuery} />
          </form>
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

        {recentsShown ? (
          <div
            ref={recentsRef}
            className="mt-6 rounded-3xl border border-white/8 bg-white/[0.025] p-4 sm:p-5"
            // A press on a row must not take the focus from the field first:
            // the list would close under the pointer before the press lands.
            onMouseDown={(event) => event.preventDefault()}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Node) || !event.currentTarget.parentElement?.contains(next)) setRecentsOpen(false);
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id="search-recents-heading" className="text-base font-semibold text-white">{SEARCH_RECENTS_HEADING}</h2>
              <button
                type="button"
                onClick={() => setHistory(clearSearchHistory())}
                className="ui-focus-ring inline-flex min-h-11 items-center rounded-full px-3 text-sm text-zinc-400 hover:text-white"
              >
                {SEARCH_RECENTS_CLEAR_LABEL}
              </button>
            </div>
            <ul aria-labelledby="search-recents-heading" className="mt-1">
              {history.map((item) => (
                <li key={item} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Search again for ${item}`}
                    onClick={() => { setQuery(item); setRecentsOpen(false); }}
                    className="ui-focus-ring flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left text-sm text-zinc-200 hover:bg-white/[0.06]"
                  >
                    <Clock3 className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                    <span className="truncate">{item}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${item} from recent searches`}
                    onClick={() => setHistory(forgetSearchQuery(item))}
                    className="ui-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-8" aria-busy={pending} onClickCapture={rememberOpenedResult}>
          {filtersShown ? (
            <SearchFilterBar
              filters={activeFilters}
              madeWithLabel={madeWithLabel}
              followingOffered={canFollow}
              onChange={setPickedFilters}
            />
          ) : null}
          {correctionNotice ? (
            <p className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-300">
              <span>{correctionNotice}</span>
              <button
                type="button"
                onClick={() => setExactQuery(normalizedQuery)}
                className="ui-focus-ring inline-flex min-h-10 items-center rounded-full px-2 text-sm font-semibold text-[var(--ui-primary)] hover:underline"
              >
                {searchInsteadLabel(normalizedQuery)}
              </button>
            </p>
          ) : exactNotice ? (
            <p className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-300">
              <span>{exactNotice}</span>
              <button
                type="button"
                onClick={() => setExactQuery(null)}
                className="ui-focus-ring inline-flex min-h-10 items-center rounded-full px-2 text-sm font-semibold text-[var(--ui-primary)] hover:underline"
              >
                {SEARCH_CORRECTED_AGAIN_LABEL}
              </button>
            </p>
          ) : null}
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
              <div className="flex min-h-72 items-center justify-center rounded-3xl border border-white/8 bg-white/[0.025] text-sm text-zinc-400">
                <LoaderCircle className="mr-2 h-5 w-5 animate-spin" /> Searching…
              </div>
            ) : (
              <SearchStateBlock
                title={`No results for “${normalizedQuery}”`}
                body={hasPublicSearchFilters(activeFilters)
                  ? SEARCH_FILTERED_EMPTY_BODY
                  : 'Try a shorter phrase, check the spelling, or search for a creator handle.'}
              />
            )
          ) : (
            <div className={`space-y-10 transition-opacity${staleResultsShown ? ' opacity-60' : ''}`}>
              {entities.length ? (
                <section aria-labelledby="search-entities-heading">
                  <h2 id="search-entities-heading" className="mb-4 text-xl font-semibold text-white">{SEARCH_ENTITIES_HEADING}</h2>
                  <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {entities.map((entity) => <EntityResult key={searchEntityId(entity)} entity={entity} onPick={pickEntity} />)}
                  </ul>
                </section>
              ) : null}

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
                    {activeType === 'top'
                      ? <button type="button" onClick={() => setPickedType('posts')} className="ui-focus-ring rounded-full px-3 py-2 text-sm text-zinc-400 hover:text-white">See all</button>
                      : <SearchSortControl kind="posts" sort={activeSort} onChange={setPickedSort} />}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{shownAnswer.result.posts.items.map((item) => <PostSearchCard key={item.id} item={item} returnTo={returnTo} />)}</div>
                </section>
              ) : null}

              {(activeType === 'top' || activeType === 'recipes') && shownAnswer.result.recipes.items.length ? (
                <section aria-labelledby="search-recipes-heading">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 id="search-recipes-heading" className="text-xl font-semibold text-white">Recipes</h2>
                    {activeType === 'top'
                      ? <button type="button" onClick={() => setPickedType('recipes')} className="ui-focus-ring rounded-full px-3 py-2 text-sm text-zinc-400 hover:text-white">See all</button>
                      : <SearchSortControl kind="recipes" sort={activeSort} onChange={setPickedSort} />}
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
