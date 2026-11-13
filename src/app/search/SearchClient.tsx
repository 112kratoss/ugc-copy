'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Box, Clock3, LoaderCircle, RefreshCcw, Wrench, X } from 'lucide-react';

import { SegmentedControl } from '@/components/DesignSystem';
import { CreatorSearchResult } from '@/components/search/CreatorSearchResult';
import { SearchField } from '@/components/search/SearchField';
import { SearchPostWall } from '@/components/search/SearchPostWall';
import { SearchResultsPlaceholder } from '@/components/search/SearchResultsPlaceholder';
import { SearchStarter, useSearchStarter } from '@/components/search/SearchStarter';
import { SearchStateBlock } from '@/components/search/SearchStateBlock';
import { SearchTypeaheadList } from '@/components/search/SearchTypeaheadList';
import { clearSearchFieldHandoff, searchFieldHandoffPending } from '@/components/search/search-field-handoff';
import { useSearchTypeahead } from '@/components/search/use-search-typeahead';
import {
  NO_PUBLIC_SEARCH_FILTERS,
  PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH,
  PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH,
  PUBLIC_SEARCH_PROBE_PARAM,
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
  SEARCH_PAGE_HEADING,
  SEARCH_FAILED_BODY,
  SEARCH_FAILED_TITLE,
  SEARCH_FILTERED_EMPTY_BODY,
  SEARCH_FILTERS_CLEAR_LABEL,
  SEARCH_FILTERS_GROUP_LABEL,
  SEARCH_FILTER_SWITCHES,
  SEARCH_IDLE_BODY,
  SEARCH_IDLE_TITLE,
  SEARCH_LOADING_MORE_LABEL,
  SEARCH_NO_RESULTS_BODY,
  SEARCH_OFFLINE_BODY,
  SEARCH_RECENTS_CLEAR_ACTION_LABEL,
  SEARCH_RECENTS_CLEAR_LABEL,
  SEARCH_RECENTS_HEADING,
  SEARCH_RELATED_HEADING,
  SEARCH_RELATED_PARAM,
  SEARCH_RETRY_LABEL,
  SEARCH_SEARCHING_LABEL,
  SEARCH_SEE_ALL_LABEL,
  SEARCH_SHOW_MORE_LABEL,
  SEARCH_SORT_OPTIONS,
  SEARCH_TABS,
  isSearchAnswerThin,
  isSearchFilterSwitchOn,
  parseSearchEntityId,
  searchCorrectionNotice,
  searchEntityActionLabel,
  searchEntityCountLabel,
  searchEntityKindLabel,
  searchBusyBody,
  searchCreatorCardLabel,
  searchDocumentTitle,
  searchExactNotice,
  searchFailedLine,
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
  type SearchKindTab,
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
  type SearchTopSection,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import { searchTypeaheadOfferForTab, type SearchTypeaheadAction } from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';
import {
  SEARCH_STARTER_NO_RESULTS_HEADING,
  searchStarterEntityAction,
  searchStarterSearchAction,
  type SearchStarterEntity,
  type SearchStarterSearch,
} from '../../../ugc-mobile/lib/public-search-policy/search-starter';
import {
  SEARCH_PAGE_PATH,
  forgetSearchPageTraversal,
  readSearchPageAddress,
  writeSearchPageAddress,
  type SearchPageOpening,
} from './search-address';
import { clearSearchHistory, forgetSearchQuery, readSearchHistory, rememberSearchQuery } from '@/components/search/search-history';
import { forgetKeptSearchPages, keepSearchPage, readKeptSearchPage, type KeptSearchPage } from '@/lib/search-kept-pages';
import type { Session } from '@supabase/supabase-js';

const SEARCH_DEBOUNCE_MS = 300;

// What a request asked for. Its answer or error is drawn only while the page
// still asks the same thing, so a change never reads as the old outcome.
// `narrowing` is the filters and the exact reading as one string
// (publicSearchFilterKey), '' for none.
type SearchRequest = { query: string; type: PublicSearchType; sort: PublicSearchSort; narrowing: string };
// `relatedAsked`: the answer was asked for with related posts, or has been
// asked about them since. They are asked about once per answer.
// `viewerId`: the account the answer was asked for (a guest's, or null for a
// visitor): what Back may draw it for (search-kept-pages.ts), and whose own
// recipes its cards say "Your recipe" on.
type SearchAnswer = SearchRequest & { result: PublicSearchResponse; relatedAsked: boolean; viewerId: string | null };

/** A kept answer in the shape this page draws: a tab that spans a deploy may hold an older one. */
function isKeptSearchAnswer(value: unknown): value is SearchAnswer {
  if (typeof value !== 'object' || value === null) return false;
  const answer = value as Partial<SearchAnswer>;
  const result = answer.result as Partial<PublicSearchResponse> | undefined;
  return typeof answer.query === 'string'
    && typeof answer.type === 'string'
    && typeof answer.sort === 'string'
    && typeof answer.narrowing === 'string'
    && typeof answer.relatedAsked === 'boolean'
    && (answer.viewerId === null || typeof answer.viewerId === 'string')
    && typeof result === 'object' && result !== null
    && Array.isArray(result.creators?.items)
    && Array.isArray(result.posts?.items)
    && Array.isArray(result.recipes?.items);
}
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
  if (response.status !== 429) return new SearchRequestError(SEARCH_FAILED_BODY);
  const body = await response.json().catch(() => null) as { retryAfterSeconds?: unknown } | null;
  const seconds = typeof body?.retryAfterSeconds === 'number'
    && Number.isFinite(body.retryAfterSeconds)
    && body.retryAfterSeconds > 0
    ? Math.ceil(body.retryAfterSeconds)
    : null;
  return new SearchRequestError(searchBusyBody(seconds), seconds);
}

/** Top's answer for a query, as an empty tab of one kind reads it: by the query and whether it was read as typed. */
function topAnswerKey(query: string, exact: boolean): string {
  return `${exact ? 'exact' : 'read'}:${query}`;
}

function requestKey(request: SearchRequest): string {
  return `${request.type}:${request.sort}:${request.narrowing}:${request.query}`;
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

// The models and tools an answer offers: on Top, and only for a query Posts
// is searched for (three characters), since pressing one opens Posts.
function offeredEntities(result: PublicSearchResponse, type: PublicSearchType, query: string) {
  if (type !== 'top') return [];
  if (publicSearchQueryLength(normalizeCreatorSearchQuery(query)) < PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH) return [];
  return result.entities ?? [];
}

// Only the active tab's kinds are drawn, so only they count as results: on
// Top, the models and tools the query names among them.
function shownResultCount(result: PublicSearchResponse, type: PublicSearchType, query: string) {
  return offeredEntities(result, type, query).length
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
  return `${SEARCH_PAGE_PATH}${params.size ? `?${params.toString()}` : ''}`;
}

// 44 px tall at every width: the chips are pressed by finger on a phone.
const CHIP_CLASS = 'ui-focus-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition';
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
          className="ui-focus-ring inline-flex min-h-11 items-center rounded-full px-3 text-sm text-zinc-400 hover:text-white"
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
      options={SEARCH_SORT_OPTIONS}
      value={sort}
      onChange={onChange}
      fill={false}
      // The full size: 46 px tall, pressed by finger on a phone.
      size="default"
    />
  );
}

function RecipeSearchCard({ recipe, returnTo }: { recipe: RecipeSearchResult; returnTo: string }) {
  // The server leaves the preview empty until a video has a poster; its
  // media URL is not an image, so only an image post falls back to it.
  const preview = recipe.post?.mediaPreviewUrl
    ?? (recipe.post?.mediaKind === 'image' ? recipe.post.mediaUrl : null);
  // In credits, as the app's search row and every recipe chip price it (decision 2).
  const price = recipe.accessMode === 'free' ? 'Free' : formatRecipeCreditPrice(recipe.priceUsdCents);
  return (
    <Link
      href={buildShowcaseDetailPath(recipe.postId, { from: 'search', returnTo, section: 'resources' })}
      data-search-result="recipe"
      aria-label={searchRecipeCardLabel({ title: recipe.title, sellerName: recipe.seller.name, price, summary: recipe.summary || recipe.previewText })}
      className="ui-focus-ring group flex min-h-32 overflow-hidden rounded-2xl border border-white/8 bg-white/[0.035] transition hover:border-white/15 hover:bg-white/[0.06]"
    >
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="w-28 shrink-0 object-cover sm:w-36" />
      ) : (
        <span className="flex w-28 shrink-0 items-center justify-center bg-emerald-400/8 text-emerald-300 sm:w-36">
          <BookOpen className="h-6 w-6" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1 p-4">
        <span className="block truncate text-sm font-semibold text-white">{recipe.title}</span>
        <span className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-400">{recipe.summary || recipe.previewText}</span>
        <span className="mt-3 flex items-center justify-between gap-3 text-xs">
          <span className="truncate text-zinc-400">{recipe.seller.name}</span>
          <span className="shrink-0 font-semibold text-emerald-300">{price}</span>
        </span>
      </span>
    </Link>
  );
}

// A Top section's way to its own tab: "See all" by its heading, always, and a
// full-width button under its last row when the section is full, which is
// when its tab has more (Top carries no cursor: searchTopSectionHasMore).
function SeeAllLink({ section, onPress }: { section: SearchTopSection; onPress: () => void }) {
  return (
    <button
      type="button"
      aria-label={searchSeeAllLabel(section)}
      onClick={onPress}
      className="ui-focus-ring inline-flex min-h-11 items-center rounded-full px-3 text-sm text-zinc-400 hover:text-white"
    >
      {SEARCH_SEE_ALL_LABEL}
    </button>
  );
}

function SeeAllButton({ section, onPress }: { section: SearchTopSection; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="ui-focus-ring mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.05] px-6 text-sm font-semibold text-white transition hover:bg-white/[0.09]"
    >
      {searchSeeAllLabel(section)}
    </button>
  );
}

// Posts that mean what the query says without holding its words: the same
// cards as the search's own posts, under everything the search itself found.
function RelatedPosts({ posts, returnTo, viewerId }: { posts: readonly ShowcaseFeedItem[]; returnTo: string; viewerId: string | null }) {
  if (posts.length === 0) return null;
  return (
    <section aria-labelledby="search-related-heading">
      <h2 id="search-related-heading" className="mb-4 text-xl font-semibold text-white">{SEARCH_RELATED_HEADING}</h2>
      <SearchPostWall items={posts} returnTo={returnTo} viewerId={viewerId} />
    </section>
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
  // The search the page opens on: the address's own when Back or Forward has
  // brought the page back (readSearchPageAddress says why), the server's
  // reading of it otherwise. Read once, as the page mounts.
  const [opening] = useState<SearchPageOpening>(() => readSearchPageAddress() ?? {
    query: initialQuery,
    type: initialType,
    sort: initialSort,
    filters: initialFilters,
    exact: initialExact,
  });
  // What this address showed when the person left it, when Back or Forward
  // has brought the page back to it (search-kept-pages.ts): drawn at once,
  // with the pages "Show more" added, at the place they had scrolled to, and
  // not asked for again. A fresh visit to the same address asks as before.
  const [restored] = useState<KeptSearchPage<SearchAnswer> | null>(() => (
    readSearchPageAddress()
      ? readKeptSearchPage(`${window.location.pathname}${window.location.search}`, isKeptSearchAnswer)
      : null
  ));
  const [query, setQuery] = useState(opening.query);
  // The tab the user chose. It stays chosen whatever the length of the query:
  // a tab that is not searched yet shows the idle state (searchTabRuns).
  const [pickedType, setPickedType] = useState(opening.type);
  // The order the user chose for Posts and Recipes. It is kept across tabs,
  // and read only on the two that have another order than the ranked one.
  const [pickedSort, setPickedSort] = useState(opening.sort);
  // What narrows Posts. Kept across tabs, as the order is, and read only on
  // Posts: the Top tab is the best of each kind.
  const [pickedFilters, setPickedFilters] = useState(opening.filters);
  // The query the person asked to have read as typed ("search instead for").
  // It belongs to that query: typing another one is a new search, corrected
  // again where it needs to be.
  const [exactQuery, setExactQuery] = useState(opening.exact ? opening.query : null);
  // The name of each entity this page has been told, by its id, so a filter
  // picked from a result is named before its own answer arrives.
  const [entityLabels, setEntityLabels] = useState<Record<string, string>>({});
  // A registered account: the only viewer "from creators I follow" means anything for.
  const [canFollow, setCanFollow] = useState(false);
  // The account the session names now, once read (undefined until then):
  // an answer asked for another is never kept for Back.
  const viewer = useRef<string | null | undefined>(undefined);
  // Recent searches live in this browser alone, and are read after the first
  // paint: the server's HTML has none to agree with.
  const [history, setHistory] = useState<string[]>([]);
  const [recentsOpen, setRecentsOpen] = useState(false);
  // The focus is in the search form: the typeahead asks and draws only then.
  const [fieldFocused, setFieldFocused] = useState(false);
  // Opened by a search from the top bar's field: the focus comes on into this
  // page's field, with the typeahead closed for the text it brought
  // (search-field-handoff.ts). Read without taking it, as a render may run twice.
  const [handedOff] = useState(() => typeof window !== 'undefined' && searchFieldHandoffPending());
  const router = useRouter();
  const recentsRef = useRef<HTMLDivElement | null>(null);
  const searchFormRef = useRef<HTMLFormElement | null>(null);
  // A search committed with Enter before its answer landed: kept once it finds something.
  const rememberOnAnswer = useRef<string | null>(null);
  const [answer, setAnswer] = useState<SearchAnswer | null>(() => restored?.answer ?? null);
  // Top's answers this page has had, by query and reading (topAnswerKey): what
  // an empty tab of one kind reads to say what the other tabs hold. A few, the
  // latest kept; one more request at most when none is on hand (below).
  const [topAnswers, setTopAnswers] = useState<ReadonlyMap<string, PublicSearchResponse>>(() => new Map());
  const keepTopAnswer = useCallback((key: string, result: PublicSearchResponse) => {
    setTopAnswers((current) => {
      const next = new Map(current);
      next.delete(key);
      next.set(key, result);
      while (next.size > 8) next.delete(next.keys().next().value as string);
      return next;
    });
  }, []);
  // What to start a search from, asked once as the page opens (SearchStarter.tsx).
  const starter = useSearchStarter();
  // The request the restored answer is, while the page still asks it: the
  // search it would make on mount is not made. Forgotten once the search
  // changes, so coming back to the same text later asks as any search does.
  const restoredRequest = useRef(restored ? requestKey(restored.answer) : null);
  const [failure, setFailure] = useState<SearchFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const retryUnblockTimer = useRef<number | null>(null);
  // The query of the last scheduled search. A URL query arrives already typed
  // and a tab change keeps the query, so only a new query waits for a pause.
  const scheduledQuery = useRef(opening.query);
  // The query the person settled on: Enter, a suggestion pressed, a recent
  // search opened. A search for it is asked with related posts
  // (public-search-policy.ts, "Related posts"); one still being typed is not.
  // The ref is read as a request is sent, the state by the wait after an
  // answer: a request that read the state would be made again when it changed.
  const settledQueryAtSend = useRef<string | null>(null);
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
  const settleOn = (settled: string) => {
    settledQueryAtSend.current = settled;
    setSettledQuery(settled);
  };
  const tabRefs = useRef<Partial<Record<PublicSearchType, HTMLButtonElement | null>>>({});
  const normalizedQuery = useMemo(() => normalizePublicSearchQuery(query), [query]);
  // The server strips leading "@" (a handle search) before its length checks
  // and counts characters, an emoji as one, so the gates count the same;
  // "@j" would be refused with a 400.
  const gatedQueryLength = publicSearchQueryLength(normalizeCreatorSearchQuery(normalizedQuery));
  const activeType: PublicSearchType = pickedType;
  // The tab in front is searched for this query: Top and Creators from two
  // characters, Posts and Recipes from three. No tab is dimmed meanwhile.
  const canSearch = searchTabRuns(activeType, gatedQueryLength);
  const activeSort: PublicSearchSort = publicSearchTypeHasSorts(activeType) ? pickedSort : 'top';
  const activeFilters = publicSearchTypeHasFilters(activeType) ? pickedFilters : NO_PUBLIC_SEARCH_FILTERS;
  // Creators are never corrected: there the exact reading changes nothing and is not named.
  const activeExact = activeType !== 'creators' && exactQuery !== null && exactQuery === normalizedQuery;
  const narrowing = publicSearchFilterKey(activeFilters, activeExact);
  const returnTo = searchPath(normalizedQuery, activeType, activeSort, activeFilters, activeExact);
  // The page's address: the search's, once the query is one any tab searches
  // for, so a Posts tab waiting for its third character keeps its place.
  const address = gatedQueryLength >= PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH ? returnTo : SEARCH_PAGE_PATH;

  const onTabListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const currentIndex = Math.max(0, SEARCH_TABS.findIndex((tab) => tab.id === activeType));
    const step = event.key === 'ArrowRight' ? 1 : SEARCH_TABS.length - 1;
    const nextTab = SEARCH_TABS[(currentIndex + step) % SEARCH_TABS.length];
    setPickedType(nextTab.id);
    tabRefs.current[nextTab.id]?.focus();
  };

  // Related posts can come with the search in front (the first page of it).
  const relatedApplies = canSearch && searchRelatedApplies({
    query: normalizedQuery,
    type: activeType,
    sort: activeSort,
    narrowing,
    queryLength: gatedQueryLength,
    laterPage: false,
  });

  // `relatedFollowUp`: the search in front asked again for its related posts,
  // over the answer on hand. That answer stays whatever becomes of the
  // request: its failure is not the search's, and is drawn as nothing.
  const requestSearch = useCallback(async ({
    append = false,
    cursor = null,
    relatedFollowUp = false,
  }: { append?: boolean; cursor?: string | null; relatedFollowUp?: boolean } = {}) => {
    const request: SearchRequest = { query: normalizedQuery, type: activeType, sort: activeSort, narrowing };
    // Asked for with the search a person has settled on, and by the follow-up; never for a later page.
    const askRelated = relatedApplies && !cursor && (relatedFollowUp || settledQueryAtSend.current === request.query);
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (append) setLoadingMore(true);
    if (!relatedFollowUp) setFailure(null);
    try {
      const params = new URLSearchParams({ q: request.query, type: request.type });
      if (askRelated) params.set(SEARCH_RELATED_PARAM, '1');
      // A cursor pages the order it was issued for, so a later page names it too.
      if (request.sort !== 'top') params.set('sort', request.sort);
      // A cursor pages the filters and the reading it was issued under, so a later page names them too.
      for (const [name, value] of Object.entries(publicSearchFilterParams(activeFilters, activeExact))) params.set(name, value);
      if (cursor) params.set('cursor', cursor);
      const { data: { session } } = await supabase.auth.getSession();
      const registered = Boolean(session?.user) && session?.user?.is_anonymous !== true;
      setCanFollow(registered);
      const viewerId = session?.user?.id ?? null;
      // Whose session this is, if the page's own read has not said yet.
      if (viewer.current === undefined) viewer.current = viewerId;
      if (!registered && activeFilters.following) {
        // A visitor or a guest follows nobody, and the server would leave the
        // filter out: a shared link that names it is read without it, in the
        // page's state and its address, so no switch is on that is not drawn.
        // The search is asked again once the filter is gone.
        setPickedFilters((current) => (current.following ? { ...current, following: false } : current));
        return;
      }
      const response = await fetch(`/api/search?${params.toString()}`, {
        cache: 'no-store',
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        signal: controller.signal,
      }).catch((fetchError: unknown) => {
        // A rejected fetch never reached the server. An abort keeps its own
        // error so the guards below drop it without a message.
        throw controller.signal.aborted ? fetchError : new SearchRequestError(SEARCH_OFFLINE_BODY);
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
        if (shownResultCount(next, request.type, request.query) > 0) {
          setHistory(rememberSearchQuery(searchHistoryQueryFor({
            query: request.query,
            type: request.type,
            answer: next,
            exact: activeExact,
          })));
        }
      }
      if (!append && request.type === 'top' && request.narrowing === publicSearchFilterKey(NO_PUBLIC_SEARCH_FILTERS, activeExact)) {
        keepTopAnswer(topAnswerKey(request.query, activeExact), next);
      }
      setAnswer((current) => {
        if (!append) return { ...request, result: next, relatedAsked: askRelated, viewerId };
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
      if (relatedFollowUp) {
        // The answer on hand stands, and is not asked about again.
        setAnswer((current) => (
          current && isSameRequest(current, request.query, request.type, request.sort, request.narrowing)
            ? { ...current, relatedAsked: true }
            : current
        ));
        return;
      }
      const error = requestError instanceof SearchRequestError ? requestError : new SearchRequestError(SEARCH_FAILED_BODY);
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
  }, [activeExact, activeFilters, activeSort, activeType, keepTopAnswer, narrowing, normalizedQuery, relatedApplies]);

  // The traversal that brought the page back, if one did, has been read above.
  useEffect(() => forgetSearchPageTraversal(), []);

  useEffect(() => {
    clearSearchFieldHandoff();
    if (handedOff) searchFormRef.current?.querySelector('input')?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the page mounts
  }, []);

  useEffect(() => {
    setHistory(readSearchHistory());
    // The box can hold the focus before this script runs (autofocus on an
    // empty search, or a press on the server's HTML), and a focus that
    // happened then fires no event here.
    if (searchFormRef.current?.contains(document.activeElement)) {
      setRecentsOpen(true);
      setFieldFocused(true);
    }
    // Recent searches end at sign-out, as the app's do: a sign-out while this
    // page is open clears them here; one made anywhere else is caught by the
    // list's own check of whose it is (search-history.ts).
    // Whose session this is: read once as the page mounts (a page Back has
    // restored makes no request that would read it), then kept by the events.
    let disposed = false;
    const learnViewer = (session: Session | null) => {
      viewer.current = session?.user?.id ?? null;
      setCanFollow(Boolean(session?.user) && session?.user?.is_anonymous !== true);
    };
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (!disposed && viewer.current === undefined) learnViewer(session);
    }).catch(() => {});
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') setHistory(clearSearchHistory());
      // What another account's searches showed is not drawn for this one.
      // supabase-js says SIGNED_IN again each time the tab comes back into
      // view: only a change of account forgets them.
      const next = session?.user?.id ?? null;
      if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && viewer.current !== undefined && next !== viewer.current)) {
        forgetKeptSearchPages();
      }
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') {
        learnViewer(event === 'SIGNED_OUT' ? null : session ?? null);
      }
    });
    return () => {
      disposed = true;
      data.subscription.unsubscribe();
    };
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
      writeSearchPageAddress(address);
      return;
    }
    // The restored answer is this search's: nothing to ask, only the address to keep.
    const key = requestKey({ query: normalizedQuery, type: activeType, sort: activeSort, narrowing });
    if (restoredRequest.current !== null && restoredRequest.current !== key) restoredRequest.current = null;
    if (restoredRequest.current === key) {
      writeSearchPageAddress(address);
      return;
    }
    // Cleared now rather than when the request starts, so an old error never
    // stands for the new query during the pause.
    setFailure(null);
    const search = () => {
      // The address follows the search without a server render (this page is
      // dynamic: router.replace rendered it again at every keystroke) and
      // without a word to Next's router (writeSearchPageAddress says why).
      // The search is asked whether or not the person has pressed something
      // that leaves the page meanwhile: a navigation that fails, or is given
      // up, finds the page with the search it says it is running.
      writeSearchPageAddress(address);
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
  }, [activeSort, activeType, address, canSearch, narrowing, normalizedQuery, requestSearch]);

  // History and the browser's tabs tell searches apart: "nano · Search |
  // Magic Booklet". Written from here, after Next's metadata has set the
  // route's own title, and again at each search the page runs.
  const documentTitle = `${searchDocumentTitle(normalizedQuery)} | Magic Booklet`;
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  // The address waits for the pause the search waits for, and a press can
  // leave the page inside that pause: a result, a link of the header, a
  // suggestion. So any press anywhere writes it first, in the capture phase,
  // ahead of whatever the press goes on to do: the entry the person leaves
  // names the search they left, and Back returns to it.
  useEffect(() => {
    const writeAddress = () => writeSearchPageAddress(address);
    document.addEventListener('click', writeAddress, true);
    return () => document.removeEventListener('click', writeAddress, true);
  }, [address]);

  const currentAnswer = isSameRequest(answer, normalizedQuery, activeType, activeSort, narrowing) ? answer : null;

  // What is on screen, kept for Back and Forward (search-kept-pages.ts): the
  // answer for the search in front, the pages added to it included, under the
  // address that names it and the account it was asked for, and how far the
  // page is scrolled. Kept at a press on a link (before it opens), when a
  // creator is chosen from the list, when the page is hidden, and as the page
  // goes; the scroll for that last one is the one noted while the address was
  // still this page's, since the next page may scroll the window before this
  // one is gone. Never an answer asked for an account the session no longer
  // names: a sign-out unmounts the page with the account's answer on screen.
  const onScreen = useRef<{ address: string; answer: SearchAnswer | null }>({ address, answer: null });
  onScreen.current = { address, answer: currentAnswer };
  const lastScrollY = useRef(restored?.scrollY ?? 0);
  // A live region speaks when its words change, never for what it held when
  // drawn: a page Back restored says its count a moment after it is drawn.
  const [restoredUnsaid, setRestoredUnsaid] = useState(restored !== null);
  useEffect(() => {
    if (!restoredUnsaid) return;
    const timer = window.setTimeout(() => setRestoredUnsaid(false), 100);
    return () => window.clearTimeout(timer);
  }, [restoredUnsaid]);
  // Keeps what is on screen now: for a way out that is no link press (a creator chosen with Enter).
  const keepBeforeLeaving = useRef<(() => void) | null>(null);
  useEffect(() => {
    const keep = (scrollY: number) => {
      const { address: kept, answer: shown } = onScreen.current;
      if (!shown || kept === SEARCH_PAGE_PATH || shown.viewerId !== viewer.current) return;
      keepSearchPage(kept, shown, scrollY, shown.viewerId);
    };
    let frame = 0;
    const noteScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (window.location.pathname === SEARCH_PAGE_PATH) lastScrollY.current = window.scrollY;
      });
    };
    const keepNow = () => {
      if (window.location.pathname === SEARCH_PAGE_PATH) lastScrollY.current = window.scrollY;
      keep(lastScrollY.current);
    };
    // A press that can leave the page: on a link. Every other press (a tab, a
    // switch, the field) leaves the page where it is and writes nothing.
    const keepOnLink = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a[href]')) keepNow();
    };
    keepBeforeLeaving.current = keepNow;
    window.addEventListener('scroll', noteScroll, { passive: true });
    document.addEventListener('click', keepOnLink, true);
    window.addEventListener('pagehide', keepNow);
    return () => {
      keepBeforeLeaving.current = null;
      window.removeEventListener('scroll', noteScroll);
      document.removeEventListener('click', keepOnLink, true);
      window.removeEventListener('pagehide', keepNow);
      if (frame) window.cancelAnimationFrame(frame);
      keep(lastScrollY.current);
    };
  }, []);
  // Back at the place the person left, before the first paint. The posts
  // wall has measured its cards by now (a child's layout effect runs first)
  // but places them in a render that follows this effect, so the window is
  // scrolled against the wall's plain grid of the same columns, which is at
  // least as tall as the placed wall: the scroll is never cut short, and the
  // placing, in the same commit before the paint, keeps it (the E2E case holds
  // the card under the same pixel).
  useLayoutEffect(() => {
    if (restored) window.scrollTo(0, restored.scrollY);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the page mounts
  }, []);
  const currentFailure = isSameRequest(failure, normalizedQuery, activeType, activeSort, narrowing) ? failure : null;
  const pending = canSearch && !currentAnswer && !currentFailure;
  // While the next query on the same tab loads, the previous cards stay up,
  // dimmed, and so do the cards of the other order while Top or Latest loads:
  // the two hold the same results. Another tab's answer holds other kinds, so
  // it is not drawn.
  const shownAnswer = currentAnswer ?? (pending && answer?.type === activeType ? answer : null);
  const resultCount = shownAnswer ? shownResultCount(shownAnswer.result, activeType, normalizedQuery) : 0;
  const staleResultsShown = pending && resultCount > 0;
  // How the search in front read the query, said only of an answer for it.
  const correctionNotice = currentAnswer
    ? searchCorrectionNotice(currentAnswer.result.correctedQuery, activeType)
    : null;
  const exactNotice = currentAnswer && activeExact ? searchExactNotice(normalizedQuery) : null;
  // Related posts: the group the answer in front brings, and when to ask for
  // it over an answer that came without (the shared rule,
  // searchRelatedFollowUpDelay): at once for a search the person has settled
  // on, after a pause with the search left alone otherwise, only where the
  // answer is thin, and once.
  const relatedPosts = shownAnswer ? searchRelatedPosts(activeType, shownAnswer.result) : [];
  const relatedFollowUpDelay = currentAnswer
    ? searchRelatedFollowUpDelay({
      applies: relatedApplies,
      relatedAsked: currentAnswer.relatedAsked,
      thin: isSearchAnswerThin(activeType, currentAnswer.result.posts),
      settled: settledQuery === normalizedQuery,
    })
    : null;
  useEffect(() => {
    if (relatedFollowUpDelay === null) return;
    const timer = window.setTimeout(() => void requestSearch({ relatedFollowUp: true }), relatedFollowUpDelay);
    return () => window.clearTimeout(timer);
  }, [relatedFollowUpDelay, requestSearch]);
  const relatedStatus = currentAnswer ? searchRelatedStatus(searchRelatedPosts(activeType, currentAnswer.result).length) : '';
  // One live region says the settled outcome, the reading first: "Showing
  // results for “portrait”. 12 results for portriat", and the related posts
  // after it: "0 results for ocean at dusk. 3 related posts".
  const statusMessage = !canSearch || restoredUnsaid
    ? ''
    : pending
      ? SEARCH_SEARCHING_LABEL
      : currentFailure
        ? ''
        // Half a word that found no creator draws the idle invitation, and
        // the live region gives no verdict either (review of #784).
        : resultCount === 0 && !searchSaysNoResults(gatedQueryLength)
          ? ''
          : `${correctionNotice ?? exactNotice ? `${correctionNotice ?? exactNotice}. ` : ''}${resultCount} ${resultCount === 1 ? 'result' : 'results'} for ${normalizedQuery}${relatedStatus ? `. ${relatedStatus}` : ''}`;
  // The filters as the page shows them: the made-with entity by the name an
  // answer or a pressed result gave it, by its key until then.
  const madeWithLabel = !activeFilters.madeWith
    ? null
    : (currentAnswer?.result.filters?.madeWith?.label
      ?? entityLabels[activeFilters.madeWith]
      ?? parseSearchEntityId(activeFilters.madeWith)?.key
      ?? null);
  const filtersShown = canSearch && publicSearchTypeHasFilters(activeType);
  const entities = shownAnswer ? offeredEntities(shownAnswer.result, activeType, normalizedQuery) : [];

  // Pressing an entity opens Posts narrowed to it and to nothing else: its
  // count is of the posts this query finds with it, so a switch left on from
  // an earlier look at Posts would open fewer than the row said.
  const pickEntity = (entity: SearchEntityResult) => {
    setEntityLabels((current) => ({ ...current, [searchEntityId(entity)]: entity.label }));
    setPickedFilters({ ...NO_PUBLIC_SEARCH_FILTERS, madeWith: searchEntityId(entity) });
    setPickedType('posts');
  };

  // Recent searches keep what the person acted on, never each pause in
  // typing: a search committed with Enter, and one a result was opened from.
  // It is kept under the typed query, unless what the person committed to or
  // opened was shown under the corrected spelling (searchHistoryQueryFor).
  const rememberCurrentSearch = (current: SearchAnswer, opened: SearchOpenedResult | null = null) => setHistory(rememberSearchQuery(searchHistoryQueryFor({
    query: normalizedQuery,
    type: activeType,
    answer: current.result,
    exact: activeExact,
    opened,
  })));
  const commitSearch = () => {
    if (!canSearch) return;
    settleOn(normalizedQuery);
    if (currentAnswer) {
      if (resultCount > 0) rememberCurrentSearch(currentAnswer);
      return;
    }
    rememberOnAnswer.current = `${activeType}:${activeSort}:${narrowing}:${normalizedQuery}`;
  };
  const rememberOpenedResult = (event: React.MouseEvent<HTMLDivElement>) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    const kind = link.getAttribute('data-search-result');
    const opened = kind === 'creator' || kind === 'post' || kind === 'recipe' ? kind : null;
    if (currentAnswer && resultCount > 0) rememberCurrentSearch(currentAnswer, opened);
  };
  const recentsShown = recentsOpen && query === '' && history.length > 0;

  // Typeahead: what the box offers while the person types, ahead of the
  // results, which load as they did. Its list is drawn only for the text the
  // box holds, and is closed by Escape, by Enter and by choosing a row, so it
  // never stands over a search the person has committed. The recent searches
  // the text matches come first, and it leaves out what the tab in front draws
  // live under it (searchTypeaheadOfferForTab): on Top the creators and the
  // models and tools, on Creators the creators.
  const typeahead = useSearchTypeahead({
    text: query,
    focused: fieldFocused,
    closedFor: handedOff ? opening.query : null,
    recents: history,
    offer: searchTypeaheadOfferForTab(activeType),
  });
  const runTypeaheadAction = (action: SearchTypeaheadAction | null) => {
    if (!action) return;
    if (action.type === 'creator') {
      // Chosen with Enter there is no press to write the address first (above), nor to keep the page.
      writeSearchPageAddress(address);
      keepBeforeLeaving.current?.();
      router.push(`/creators/${encodeURIComponent(action.username)}`);
      return;
    }
    if (action.type === 'entity') {
      // As pressing the entity among the results does: Posts for what is typed, narrowed to it.
      pickEntity(action.entity);
      return;
    }
    // A completion or a recent search fills the box and is searched at once, with no pause for
    // typing, and committed as Enter commits a search: kept among the recent
    // ones once it finds something.
    const next = normalizePublicSearchQuery(action.query);
    const nextFilters = publicSearchTypeHasFilters(pickedType) ? pickedFilters : NO_PUBLIC_SEARCH_FILTERS;
    const nextSort: PublicSearchSort = publicSearchTypeHasSorts(pickedType) ? pickedSort : 'top';
    scheduledQuery.current = next;
    rememberOnAnswer.current = `${pickedType}:${nextSort}:${publicSearchFilterKey(nextFilters, false)}:${next}`;
    settleOn(next);
    setQuery(action.query);
  };
  // The starter's rows (SearchStarter.tsx). A model or tool: Posts for its
  // own query (`query`, which need not read like its name), narrowed to it and
  // to nothing else, asked at once (the shared searchStarterEntityAction): the
  // search the starter counted, so it opens the posts the row said. A
  // suggested search: a fresh start on Top with nothing narrowing it (no
  // filter the person cannot see on the idle page), filled in and committed as
  // Enter commits.
  const pickStarterEntity = (entity: SearchStarterEntity) => {
    const action = searchStarterEntityAction(entity);
    if (action.type !== 'entity') return;
    const next = normalizePublicSearchQuery(action.query);
    setEntityLabels((current) => ({ ...current, [action.madeWith]: entity.label }));
    setPickedFilters({ ...NO_PUBLIC_SEARCH_FILTERS, madeWith: action.madeWith });
    setPickedType('posts');
    scheduledQuery.current = next;
    setQuery(next);
  };
  const pickStarterSearch = (search: SearchStarterSearch) => {
    const action = searchStarterSearchAction(search);
    if (action.type !== 'search') return;
    const next = normalizePublicSearchQuery(action.query);
    setPickedFilters(NO_PUBLIC_SEARCH_FILTERS);
    setPickedType('top');
    scheduledQuery.current = next;
    rememberOnAnswer.current = `top:top:${publicSearchFilterKey(NO_PUBLIC_SEARCH_FILTERS, false)}:${next}`;
    settleOn(next);
    setQuery(action.query);
  };

  // An empty tab of one kind says what the other tabs hold, from Top's answer
  // for the same search: the one on hand, or one request for it (and no more)
  // where there is none. Only for an unfiltered search a tab could hold
  // posts or recipes for (three characters): a filter narrows Posts alone,
  // and its own words say to remove one.
  const readExact = exactQuery !== null && exactQuery === normalizedQuery;
  const emptyKindTab: SearchKindTab | null = activeType !== 'top'
    && currentAnswer !== null
    && resultCount === 0
    && !hasPublicSearchFilters(activeFilters)
    && gatedQueryLength >= PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH
    ? activeType
    : null;
  const topForEmptyTab = emptyKindTab ? topAnswers.get(topAnswerKey(normalizedQuery, readExact)) ?? null : null;
  // Asked once per page opening and search: marked asked while the request
  // is out and for good once it has settled, so an abort (the person leaves
  // the tab, StrictMode's re-run in development) leaves it to ask again.
  const askedTopFor = useRef(new Set<string>());
  useEffect(() => {
    if (!emptyKindTab || topForEmptyTab) return;
    const key = topAnswerKey(normalizedQuery, readExact);
    const asked = askedTopFor.current;
    if (asked.has(key)) return;
    asked.add(key);
    const controller = new AbortController();
    let settled = false;
    void (async () => {
      try {
        // Marked as asked by the page, not by the person: answered as any
        // search, left out of the search log (PUBLIC_SEARCH_PROBE_PARAM).
        const params = new URLSearchParams({ q: normalizedQuery, type: 'top', [PUBLIC_SEARCH_PROBE_PARAM]: '1' });
        for (const [name, value] of Object.entries(publicSearchFilterParams(NO_PUBLIC_SEARCH_FILTERS, readExact))) params.set(name, value);
        const { data: { session } } = await supabase.auth.getSession();
        const response = await fetch(`/api/search?${params.toString()}`, {
          cache: 'no-store',
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          settled = true;
          return;
        }
        const top = await response.json() as PublicSearchResponse;
        settled = true;
        keepTopAnswer(key, top);
      } catch {
        // The tab says it found nothing, as it did before: the pointer is an
        // extra. Settled unless it was the abort below.
        if (!controller.signal.aborted) settled = true;
      }
    })();
    return () => {
      controller.abort();
      if (!settled) asked.delete(key);
    };
  }, [emptyKindTab, keepTopAnswer, normalizedQuery, readExact, topForEmptyTab]);
  const emptyTabPointer = emptyKindTab ? searchEmptyTabPointer(emptyKindTab, topForEmptyTab) : null;

  const nextCursor = !currentAnswer
    ? null
    : activeType === 'creators'
      ? currentAnswer.result.creators.nextCursor
      : activeType === 'posts'
        ? currentAnswer.result.posts.nextCursor
        : activeType === 'recipes'
          ? currentAnswer.result.recipes.nextCursor
          : null;

  // Before a search, and for half a word that found no creator: ideas to
  // start from (the starter), under any recent searches, or the invitation it
  // stood in for where there are none (the route switched off, or failed).
  const idleBlock = starter ? (
    <SearchStarter
      answer={starter}
      onEntity={pickStarterEntity}
      onSearch={pickStarterSearch}
    />
  ) : (
    <SearchStateBlock tone="initial" title={SEARCH_IDLE_TITLE} body={SEARCH_IDLE_BODY} />
  );

  return (
    // The field's row, pinned under the top bar: its height is the token the
    // tabs, pinned under it from 640px, are offset by (rem, never pixels).
    <div className="min-h-screen px-4 pb-24 sm:px-6 [--search-field-row:4.75rem]">
      <div className="mx-auto max-w-6xl">
        {/* The page's one heading, for a screen reader and the outline: the
            field is the first thing a person sees (no marketing heading over
            it, search UX audit 2026-11-13, finding 4). */}
        <h1 className="sr-only">{SEARCH_PAGE_HEADING}</h1>

        {/* Solid and flush under the top bar, wider than the column by its
            gutter, so no card shows through at its sides or above it. */}
        <div className="sticky top-[var(--app-shell-topbar-height)] z-20 -mx-4 h-[var(--search-field-row)] bg-[var(--ui-bg-app)] px-4 pt-3 sm:-mx-6 sm:px-6">
          {/* Enter commits the search (it is kept among the recent ones); the
              results follow the typing either way. */}
          <form
            ref={searchFormRef}
            role="search"
            className="relative"
            onSubmit={(event) => { event.preventDefault(); commitSearch(); }}
            onFocus={() => { setRecentsOpen(true); setFieldFocused(true); }}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Node) || !recentsRef.current?.contains(next)) setRecentsOpen(false);
              // Still focused while the focus only moves inside the form (to Clear and back).
              if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFieldFocused(false);
            }}
          >
            <SearchField
              value={query}
              onChange={setQuery}
              onClear={() => setQuery('')}
              autoFocus={!opening.query}
              // The cards on show are the search before this one: the field says
              // so, without a line that would push them down (review of #787).
              busy={staleResultsShown}
              combobox={{
                expanded: typeahead.shown,
                listId: typeahead.listId,
                activeOptionId: typeahead.activeOptionId,
                onKeyDown: (event) => runTypeaheadAction(typeahead.onKeyDown(event)),
              }}
            />
            {/* Said politely when the list opens or changes; the results have a status of their own below. */}
            <div aria-live="polite" aria-atomic="true" className="sr-only" data-search-typeahead-status="">{typeahead.status}</div>
            {typeahead.shown ? (
              <SearchTypeaheadList
                listId={typeahead.listId}
                sections={typeahead.sections}
                query={typeahead.query}
                activeIndex={typeahead.activeIndex}
                stale={typeahead.stale}
                busy={typeahead.busy}
                settlingRows={typeahead.settlingRows}
                onPick={(row) => runTypeaheadAction(typeahead.press(row))}
                onHighlight={typeahead.highlightRow}
                // Under the box, over the tabs and the results while the person
                // is still typing; clear of the top bar, the field's row and
                // the phone's bottom navigation.
                className="absolute inset-x-0 top-full z-30 mt-2 max-h-[min(26rem,calc(100dvh-var(--app-shell-topbar-height)-var(--search-field-row)-var(--app-shell-bottom-nav-space,0px)-1rem))]"
              />
            ) : null}
          </form>
        </div>
        {/* Pinned under the field from 640px; on a phone it scrolls away with
            the page, so the results get the screen and the field stays in reach. */}
        <div className="z-10 -mx-4 bg-[var(--ui-bg-app)] px-4 pb-2 sm:sticky sm:top-[calc(var(--app-shell-topbar-height)+var(--search-field-row))] sm:-mx-6 sm:px-6">
          <div
            className="flex gap-1 overflow-x-auto pb-1"
            role="tablist"
            aria-label="Search result type"
            onKeyDown={onTabListKeyDown}
          >
            {SEARCH_TABS.map((tab) => (
              <button
                key={tab.id}
                ref={(element) => { tabRefs.current[tab.id] = element; }}
                type="button"
                role="tab"
                aria-selected={activeType === tab.id}
                tabIndex={activeType === tab.id ? 0 : -1}
                onClick={() => setPickedType(tab.id)}
                className={`ui-focus-ring min-h-11 shrink-0 rounded-full px-5 text-sm font-semibold transition ${activeType === tab.id ? 'bg-white text-black' : 'text-zinc-400 hover:bg-white/8 hover:text-white'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Announce a settled summary rather than making the whole result grid
            a live region, which would re-read every card on each change.
            Silent while the typeahead's list is open: the box is still being
            typed into, the list's own region says its count, and two polite
            regions changing at each pause would talk over each other. It
            speaks when the list closes (Enter, a row, Escape, the focus
            leaving) and whenever there is no list. */}
        <p role="status" className="sr-only">{typeahead.shown ? '' : statusMessage}</p>

        {recentsShown ? (
          <div
            ref={recentsRef}
            className="mt-4 rounded-3xl border border-white/8 bg-white/[0.025] p-4 sm:p-5"
            // A press on a row must not take the focus from the field first:
            // the list would close under the pointer before the press lands.
            onMouseDown={(event) => event.preventDefault()}
            onBlur={(event) => {
              // Open while the focus is in the list or back in the box, closed once it is anywhere else.
              const next = event.relatedTarget;
              if (
                !(next instanceof Node)
                || !(event.currentTarget.contains(next) || searchFormRef.current?.contains(next))
              ) {
                setRecentsOpen(false);
              }
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id="search-recents-heading" className="text-base font-semibold text-white">{SEARCH_RECENTS_HEADING}</h2>
              <button
                type="button"
                aria-label={SEARCH_RECENTS_CLEAR_ACTION_LABEL}
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
                    aria-label={searchRecentAgainLabel(item)}
                    onClick={() => { settleOn(normalizePublicSearchQuery(item)); setQuery(item); setRecentsOpen(false); }}
                    className="ui-focus-ring flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left text-sm text-zinc-200 hover:bg-white/[0.06]"
                  >
                    <Clock3 className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                    <span className="truncate">{item}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={searchRecentRemoveLabel(item)}
                    onClick={() => setHistory(forgetSearchQuery(item))}
                    className="ui-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-4" aria-busy={pending} onClickCapture={rememberOpenedResult}>
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
                className="ui-focus-ring inline-flex min-h-11 items-center rounded-full px-2 text-sm font-semibold text-[var(--ui-primary)] hover:underline"
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
                className="ui-focus-ring inline-flex min-h-11 items-center rounded-full px-2 text-sm font-semibold text-[var(--ui-primary)] hover:underline"
              >
                {SEARCH_CORRECTED_AGAIN_LABEL}
              </button>
            </p>
          ) : null}
          {!canSearch ? (
            idleBlock
          ) : currentFailure && !currentAnswer ? (
            <SearchStateBlock
              tone="error"
              title={SEARCH_FAILED_TITLE}
              body={currentFailure.message}
              action={<button type="button" disabled={retryBlocked} onClick={() => void requestSearch()} className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"><RefreshCcw className="h-4 w-4" aria-hidden="true" /> {SEARCH_RETRY_LABEL}</button>}
            />
          ) : !shownAnswer || resultCount === 0 ? (
            pending ? (
              // No earlier cards to keep on show: blocks in the shape of the
              // tab's results (the status line above says "Searching…").
              <SearchResultsPlaceholder
                type={activeType}
                creatorsOnly={gatedQueryLength < PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH}
              />
            ) : !searchSaysNoResults(gatedQueryLength) ? (
              // Half a word is no verdict: a two-character search that finds
              // no creator leaves the page as it was before typing.
              idleBlock
            ) : (
              <div className="space-y-10">
                {emptyTabPointer ? (
                  // Another tab found something: say what, and offer it.
                  <SearchStateBlock
                    title={searchEmptyTabTitle(emptyKindTab ?? emptyTabPointer.tab, normalizedQuery)}
                    body={searchEmptyTabPointerLine(emptyTabPointer)}
                    action={(
                      <button
                        type="button"
                        onClick={() => {
                          // The count is Top's, unfiltered: Posts opens unfiltered too, as it counted.
                          if (emptyTabPointer.tab === 'posts') setPickedFilters(NO_PUBLIC_SEARCH_FILTERS);
                          setPickedType(emptyTabPointer.tab);
                        }}
                        className="ui-focus-ring inline-flex min-h-11 items-center rounded-full bg-white px-5 text-sm font-semibold text-black"
                      >
                        {searchSeeTabLabel(emptyTabPointer.tab)}
                      </button>
                    )}
                  />
                ) : (
                  <SearchStateBlock
                    title={activeType === 'top' ? searchNoResultsTitle(normalizedQuery) : searchEmptyTabTitle(activeType, normalizedQuery)}
                    body={hasPublicSearchFilters(activeFilters) ? SEARCH_FILTERED_EMPTY_BODY : SEARCH_NO_RESULTS_BODY}
                  />
                )}
                <RelatedPosts posts={relatedPosts} returnTo={returnTo} viewerId={shownAnswer?.viewerId ?? null} />
                {/* Nothing anywhere (Top found nothing, or the tab's own search
                    did and Top's answer says no other tab has anything): ideas
                    to start again from, under it. */}
                {starter && !emptyTabPointer && !hasPublicSearchFilters(activeFilters)
                  && (activeType === 'top' || topForEmptyTab !== null) ? (
                    <SearchStarter
                      answer={starter}
                      heading={SEARCH_STARTER_NO_RESULTS_HEADING}
                      onEntity={pickStarterEntity}
                      onSearch={pickStarterSearch}
                    />
                  ) : null}
              </div>
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
                    {activeType === 'top' ? <SeeAllLink section="creators" onPress={() => setPickedType('creators')} /> : null}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">{shownAnswer.result.creators.items.map((creator) => <CreatorSearchResult key={creator.id} creator={creator} label={searchCreatorCardLabel(creator)} />)}</div>
                  {activeType === 'top' && searchTopSectionHasMore('creators', shownAnswer.result.creators.items.length)
                    ? <SeeAllButton section="creators" onPress={() => setPickedType('creators')} />
                    : null}
                </section>
              ) : null}

              {(activeType === 'top' || activeType === 'posts') && shownAnswer.result.posts.items.length ? (
                <section aria-labelledby="search-posts-heading">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 id="search-posts-heading" className="text-xl font-semibold text-white">Posts</h2>
                    {activeType === 'top'
                      ? <SeeAllLink section="posts" onPress={() => setPickedType('posts')} />
                      : <SearchSortControl kind="posts" sort={activeSort} onChange={setPickedSort} />}
                  </div>
                  <SearchPostWall items={shownAnswer.result.posts.items} returnTo={returnTo} viewerId={shownAnswer.viewerId} />
                  {activeType === 'top' && searchTopSectionHasMore('posts', shownAnswer.result.posts.items.length)
                    ? <SeeAllButton section="posts" onPress={() => setPickedType('posts')} />
                    : null}
                </section>
              ) : null}

              {(activeType === 'top' || activeType === 'recipes') && shownAnswer.result.recipes.items.length ? (
                <section aria-labelledby="search-recipes-heading">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 id="search-recipes-heading" className="text-xl font-semibold text-white">Recipes</h2>
                    {activeType === 'top'
                      ? <SeeAllLink section="recipes" onPress={() => setPickedType('recipes')} />
                      : <SearchSortControl kind="recipes" sort={activeSort} onChange={setPickedSort} />}
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2">{shownAnswer.result.recipes.items.map((recipe) => <RecipeSearchCard key={recipe.id} recipe={recipe} returnTo={returnTo} />)}</div>
                  {activeType === 'top' && searchTopSectionHasMore('recipes', shownAnswer.result.recipes.items.length)
                    ? <SeeAllButton section="recipes" onPress={() => setPickedType('recipes')} />
                    : null}
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
                    {loadingMore ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                    {loadingMore ? SEARCH_LOADING_MORE_LABEL : SEARCH_SHOW_MORE_LABEL}
                  </button>
                </div>
              ) : null}

              <RelatedPosts posts={relatedPosts} returnTo={returnTo} viewerId={shownAnswer?.viewerId ?? null} />

              {currentFailure ? <p role="alert" className="text-center text-sm text-rose-300">{searchFailedLine(currentFailure.message)}</p> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
