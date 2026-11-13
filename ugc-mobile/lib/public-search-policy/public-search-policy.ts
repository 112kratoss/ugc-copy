/**
 * The rules both search clients follow, in one copy the web's search page and
 * the app's search overlay share by relative import (search phase 3,
 * 2026-11-12), and the server reads for what a request may name:
 *
 *   - recent searches: what is kept on the device, how a new search joins the
 *     list, how many are kept. Each client brings its own storage
 *     (`localStorage` on the web, AsyncStorage in the app);
 *   - entities: a model or tool posts are made with, as a search result
 *     ("Kling 2.6 · 14 posts"), and the id a filter names it by
 *     (`model:kling-2.6`);
 *   - filters on a Posts search: made with, pictures or videos, has a recipe,
 *     from creators the viewer follows, and the request parameters they
 *     travel in, which are also the web page's address;
 *   - the corrected reading: the words of "Showing results for …" and of
 *     "Search instead for …".
 *
 * Metro, Next.js and Vitest all compile this file, so it stays free of React
 * Native, Expo and Node imports (see this folder's tsconfig.json), and of
 * `\p{…}` in a regular expression, which not every engine it runs on reads.
 */

// ─── Recent searches ─────────────────────────────────────────────────────────

/** Where each client keeps its list: one key, in its own storage. */
export const SEARCH_HISTORY_KEY = 'magicbooklet:public-search-history:v1';
export const SEARCH_HISTORY_LIMIT = 10;
const SEARCH_HISTORY_MIN_LENGTH = 2;
const SEARCH_QUERY_MAX_LENGTH = 100;

/**
 * A query as the server normalizes one (normalizePublicSearchQuery,
 * src/lib/public-search.ts): cut at 100 characters, counted as the database
 * counts them, so an emoji is one and is never cut in half.
 */
export function normalizeSearchHistoryQuery(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return normalized.length <= SEARCH_QUERY_MAX_LENGTH
    ? normalized
    : Array.from(normalized).slice(0, SEARCH_QUERY_MAX_LENGTH).join('');
}

/**
 * The server's rule of the same name: it strips leading @ before its two- and
 * three-character checks, so "@j" counts as one character. The length gates
 * count what the server counts.
 */
export function normalizeCreatorSearchQuery(value: string | null | undefined): string {
  return normalizeSearchHistoryQuery(value ?? '').replace(/^@+/, '');
}

/**
 * A query's length as the server counts it (publicSearchQueryLength, and the
 * database's char_length behind it): in characters, where `.length` counts an
 * emoji as two.
 */
export function searchQueryLength(value: string): number {
  return Array.from(value).length;
}

/** The list a client stored, read back: only queries, normalized, at most the limit. Never throws. */
export function parseSearchHistory(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeSearchHistoryQuery)
      .filter((value) => value.length >= SEARCH_HISTORY_MIN_LENGTH)
      .slice(0, SEARCH_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * The list with a search added at its head, or null when the query is too
 * short to keep. An entry the new query extends was a step on the way to it
 * ("po" and "por" before "port"), and goes; an exact repeat is its own prefix.
 */
export function searchHistoryWith(current: readonly string[], query: string): string[] | null {
  const normalized = normalizeSearchHistoryQuery(query);
  if (normalized.length < SEARCH_HISTORY_MIN_LENGTH) return null;
  const lowered = normalized.toLocaleLowerCase();
  return [normalized, ...current.filter((item) => !lowered.startsWith(item.toLocaleLowerCase()))]
    .slice(0, SEARCH_HISTORY_LIMIT);
}

/** What a person opened from a search's results: a kept search follows the reading that showed it. */
export type SearchOpenedResult = 'creator' | 'post' | 'recipe';

/**
 * The query a search is kept under among the recent ones.
 *
 * The rule, in one sentence: the typed query, unless what the person
 * committed to or opened was shown under the corrected spelling and found
 * something ("portrait" for a search typed "portriat").
 *
 * - Opened a creator: creators are never corrected, so the typed query (the
 *   one that finds that creator again).
 * - Opened a post or a recipe: that section's correction, if it had one.
 * - Committed (Enter, the Search key, a completion, leaving with results):
 *   the section the tab leads with. On Top that is the posts when there are
 *   any, else the recipes; Posts and Recipes are their own. A section read as
 *   typed keeps the typed query: another section's correction never stands in.
 * - Asked for as typed: always the typed query.
 */
export function searchHistoryQueryFor(search: {
  /** The query as the client normalizes it. */
  query: string;
  type: SearchTabId;
  /** The answer the search was committed on or opened from, or null while none has come. */
  answer: {
    correctedQuery?: SearchCorrectedQuery | null;
    posts: { items: readonly unknown[] };
    recipes: { items: readonly unknown[] };
  } | null | undefined;
  /** The person asked for the query as typed. */
  exact: boolean;
  /** What was opened, or null for a search committed without opening anything. */
  opened?: SearchOpenedResult | null;
}): string {
  const { answer } = search;
  if (search.exact || !answer?.correctedQuery) return search.query;
  const section: 'posts' | 'recipes' | null = search.opened
    ? (search.opened === 'creator' ? null : search.opened === 'post' ? 'posts' : 'recipes')
    : search.type === 'posts' || search.type === 'recipes'
      ? search.type
      : search.type === 'top'
        ? (answer.posts.items.length > 0 ? 'posts' : answer.recipes.items.length > 0 ? 'recipes' : null)
        : null;
  if (!section || answer[section].items.length === 0) return search.query;
  return answer.correctedQuery[section] ?? search.query;
}

/** The list without one search, whatever its case. */
export function searchHistoryWithout(current: readonly string[], query: string): string[] {
  const lowered = normalizeSearchHistoryQuery(query).toLocaleLowerCase();
  return current.filter((item) => item.toLocaleLowerCase() !== lowered);
}

// ─── Entities ────────────────────────────────────────────────────────────────

export const SEARCH_ENTITY_KINDS = ['model', 'tool'] as const;
export type SearchEntityKind = (typeof SEARCH_ENTITY_KINDS)[number];

/** A model or tool as a search result. */
export interface SearchEntity {
  kind: SearchEntityKind;
  /** Its key in search: `kling-2.6`. With the kind, its id. */
  key: string;
  /** The name posts print: `Kling 2.6`. */
  label: string;
  /** The posts the viewer may see that are made with it, counted to 1,000. */
  postCount: number;
  /** There are more than `postCount`. */
  postCountCapped: boolean;
}

// The server's keys hold letters, digits, dots and hyphens (search_entity_key);
// this refuses what could not be one without naming every letter of every script.
const SEARCH_ENTITY_ID = /^(model|tool):([^\s:/?#&%"'<>\\]{1,80})$/;

/** `model:kling-2.6`: what a made-with filter names an entity by. */
export function searchEntityId(entity: { kind: SearchEntityKind; key: string }): string {
  return `${entity.kind}:${entity.key}`;
}

/** An entity id read back, or null when it could not be one. */
export function parseSearchEntityId(value: string | null | undefined): { kind: SearchEntityKind; key: string } | null {
  if (typeof value !== 'string') return null;
  const parts = SEARCH_ENTITY_ID.exec(value);
  if (!parts || parts[2] !== parts[2].toLowerCase()) return null;
  return { kind: parts[1] as SearchEntityKind, key: parts[2] };
}

/** "14 posts", "1 post", "1,000+ posts". */
export function searchEntityCountLabel(entity: Pick<SearchEntity, 'postCount' | 'postCountCapped'>): string {
  const count = Math.max(0, Math.floor(entity.postCount));
  const figure = String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (entity.postCountCapped) return `${figure}+ posts`;
  return `${figure} ${count === 1 ? 'post' : 'posts'}`;
}

/** What an entity is, in a word, beside its name. */
export function searchEntityKindLabel(kind: SearchEntityKind): string {
  return kind === 'model' ? 'Model' : 'Tool';
}

// ─── Filters on a Posts search ───────────────────────────────────────────────

export const SEARCH_MEDIA_KINDS = ['image', 'video'] as const;
export type SearchMediaKind = (typeof SEARCH_MEDIA_KINDS)[number];

/** What narrows a Posts search. */
export interface SearchFilters {
  /** An entity id (`model:kling-2.6`), or null. */
  madeWith: string | null;
  mediaKind: SearchMediaKind | null;
  hasRecipe: boolean;
  /** Only posts by creators the viewer follows. A visitor with no account follows nobody, and the server leaves it out. */
  following: boolean;
}

export const NO_SEARCH_FILTERS: SearchFilters = Object.freeze({
  madeWith: null,
  mediaKind: null,
  hasRecipe: false,
  following: false,
});

export function hasSearchFilters(filters: SearchFilters): boolean {
  return filters.madeWith !== null || filters.mediaKind !== null || filters.hasRecipe || filters.following;
}

/**
 * The parameters filters and the exact reading travel in, on `/api/search` and
 * in the web page's address alike. Only what is on is named.
 */
export const SEARCH_FILTER_PARAMS = {
  madeWith: 'madeWith',
  // Not `media`: a post's way back to the page it was opened from drops the
  // viewer's own `post` and `media` (stripShowcaseViewerState, src/lib/share.ts),
  // and would drop this filter with them.
  mediaKind: 'kind',
  hasRecipe: 'recipe',
  following: 'following',
  exact: 'exact',
} as const;

export function searchFilterParams(filters: SearchFilters, exact: boolean): Record<string, string> {
  return {
    ...(filters.madeWith ? { [SEARCH_FILTER_PARAMS.madeWith]: filters.madeWith } : {}),
    ...(filters.mediaKind ? { [SEARCH_FILTER_PARAMS.mediaKind]: filters.mediaKind } : {}),
    ...(filters.hasRecipe ? { [SEARCH_FILTER_PARAMS.hasRecipe]: '1' } : {}),
    ...(filters.following ? { [SEARCH_FILTER_PARAMS.following]: '1' } : {}),
    ...(exact ? { [SEARCH_FILTER_PARAMS.exact]: '1' } : {}),
  };
}

export type SearchFilterParamsReading =
  | { ok: true; filters: SearchFilters; exact: boolean }
  /** The parameter that names something it cannot. */
  | { ok: false; parameter: keyof typeof SEARCH_FILTER_PARAMS };

function readFlag(value: string | null | undefined): boolean | null {
  if (value === null || value === undefined) return false;
  return value === '1' ? true : null;
}

/**
 * The filters and the exact reading a request or an address names. A
 * parameter left out is off; one that names an unknown value is refused, by
 * name, never read as off.
 */
export function readSearchFilterParams(get: (name: string) => string | null | undefined): SearchFilterParamsReading {
  const rawMadeWith = get(SEARCH_FILTER_PARAMS.madeWith);
  const madeWith = rawMadeWith === null || rawMadeWith === undefined ? null : parseSearchEntityId(rawMadeWith);
  if (rawMadeWith !== null && rawMadeWith !== undefined && !madeWith) return { ok: false, parameter: 'madeWith' };

  const rawMediaKind = get(SEARCH_FILTER_PARAMS.mediaKind);
  const mediaKind = rawMediaKind === null || rawMediaKind === undefined
    ? null
    : SEARCH_MEDIA_KINDS.find((kind) => kind === rawMediaKind) ?? undefined;
  if (mediaKind === undefined) return { ok: false, parameter: 'mediaKind' };

  const hasRecipe = readFlag(get(SEARCH_FILTER_PARAMS.hasRecipe));
  if (hasRecipe === null) return { ok: false, parameter: 'hasRecipe' };
  const following = readFlag(get(SEARCH_FILTER_PARAMS.following));
  if (following === null) return { ok: false, parameter: 'following' };
  const exact = readFlag(get(SEARCH_FILTER_PARAMS.exact));
  if (exact === null) return { ok: false, parameter: 'exact' };

  return {
    ok: true,
    filters: { madeWith: madeWith ? searchEntityId(madeWith) : null, mediaKind, hasRecipe, following },
    exact,
  };
}

/**
 * One string per set of filters and reading, '' for none: what tells two
 * searches of one query apart, in a client's cache key and in a cursor.
 */
export function searchFilterKey(filters: SearchFilters, exact: boolean): string {
  return Object.entries(searchFilterParams(filters, exact))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** The switches a Posts search offers, in the order both clients draw them. */
export const SEARCH_FILTER_SWITCHES = [
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'recipe', label: 'Has recipe' },
  { id: 'following', label: 'Following' },
] as const;
export type SearchFilterSwitchId = (typeof SEARCH_FILTER_SWITCHES)[number]['id'];

export function isSearchFilterSwitchOn(filters: SearchFilters, id: SearchFilterSwitchId): boolean {
  if (id === 'image' || id === 'video') return filters.mediaKind === id;
  return id === 'recipe' ? filters.hasRecipe : filters.following;
}

/** The filters after a switch is pressed: Images and Videos are one choice, pressed again it is off. */
export function toggleSearchFilterSwitch(filters: SearchFilters, id: SearchFilterSwitchId): SearchFilters {
  if (id === 'image' || id === 'video') return { ...filters, mediaKind: filters.mediaKind === id ? null : id };
  if (id === 'recipe') return { ...filters, hasRecipe: !filters.hasRecipe };
  return { ...filters, following: !filters.following };
}

/** "Made with Kling 2.6": the chip of a made-with filter that is on. */
export function searchMadeWithChipLabel(label: string): string {
  return `Made with ${label}`;
}

// ─── The corrected reading ───────────────────────────────────────────────────

/** How posts and recipes read the query, where either read it as something else. */
export interface SearchCorrectedQuery {
  posts: string | null;
  recipes: string | null;
}

/**
 * The line a search shows when it read the query as something else, for the
 * tab in front, or null when what that tab draws was read as typed. Top draws
 * posts and recipes, which are corrected against their own words and can
 * differ.
 */
export function searchCorrectionNotice(
  corrected: SearchCorrectedQuery | null | undefined,
  type: 'top' | 'creators' | 'posts' | 'recipes',
): string | null {
  if (!corrected) return null;
  const posts = type === 'top' || type === 'posts' ? corrected.posts : null;
  const recipes = type === 'top' || type === 'recipes' ? corrected.recipes : null;
  if (posts && recipes && posts !== recipes) return `Showing posts for “${posts}” and recipes for “${recipes}”`;
  const readAs = posts ?? recipes;
  return readAs ? `Showing results for “${readAs}”` : null;
}

/** The control beside that line, which searches for the query as typed. */
export function searchInsteadLabel(query: string): string {
  return `Search instead for “${query}”`;
}

/** The line of a search that was asked to read the query as typed. */
export function searchExactNotice(query: string): string {
  return `Showing results for “${query}” as typed`;
}

/** The control beside that line, which goes back to the corrected reading. */
export const SEARCH_CORRECTED_AGAIN_LABEL = 'Use suggested spelling';

// ─── Tabs, orders and how long a query must be ───────────────────────────────

/** The tabs of a search, in the order both clients draw them. */
export const SEARCH_TABS = [
  { id: 'top', label: 'Top' },
  { id: 'creators', label: 'Creators' },
  { id: 'posts', label: 'Posts' },
  { id: 'recipes', label: 'Recipes' },
] as const;
export type SearchTabId = (typeof SEARCH_TABS)[number]['id'];

/**
 * The orders of a Posts or Recipes search. The values are the `sort`
 * parameter's and do not change; "Best match" names the ranked order, which
 * was called "Top" beside a tab of the same name.
 */
export const SEARCH_SORT_OPTIONS = [
  { value: 'top', label: 'Best match' },
  { value: 'latest', label: 'Latest' },
] as const;

/** The server's minimums (src/lib/public-search.ts), counted as searchQueryLength counts. */
export const SEARCH_MIN_CREATOR_QUERY_LENGTH = 2;
export const SEARCH_MIN_CONTENT_QUERY_LENGTH = 3;

/**
 * Whether a tab is searched for a query of this length, counted without a
 * leading "@" (normalizeCreatorSearchQuery): Top and Creators from two
 * characters, Posts and Recipes from three. Below that the tab shows the idle
 * state and asks nothing: no tab is dimmed, and none is switched for another.
 */
export function searchTabRuns(type: SearchTabId, queryLength: number): boolean {
  return queryLength >= (type === 'posts' || type === 'recipes'
    ? SEARCH_MIN_CONTENT_QUERY_LENGTH
    : SEARCH_MIN_CREATOR_QUERY_LENGTH);
}

/**
 * Whether an answer that found nothing is said to have found nothing. Under
 * three characters only creators are looked for, and half a word is no
 * verdict: the idle state stands instead of "No results".
 */
export function searchSaysNoResults(queryLength: number): boolean {
  return queryLength >= SEARCH_MIN_CONTENT_QUERY_LENGTH;
}

/**
 * How many of each kind a Top answer holds at most (the server's takes,
 * public-search-service.ts reads them from here). Top carries no cursor, so a
 * full section is the sign it has more on its own tab.
 */
export const SEARCH_TOP_SECTION_SIZES = { creators: 5, posts: 12, recipes: 6 } as const;
export type SearchTopSection = keyof typeof SEARCH_TOP_SECTION_SIZES;

export function searchTopSectionHasMore(section: SearchTopSection, shown: number): boolean {
  return shown >= SEARCH_TOP_SECTION_SIZES[section];
}

// ─── What the clients say around them ────────────────────────────────────────

/**
 * The text in every search field: the web page's, the top bar's and the app's.
 * Plain "Search": it names no product, so the clients agree without the
 * question of how the app's wordmark is spelled (hig-branding.test.ts).
 */
export const SEARCH_PLACEHOLDER = 'Search';
/** What every search field is called to a screen reader. */
export const SEARCH_FIELD_LABEL = 'Search creators, posts, and recipes';
export const SEARCH_CLEAR_FIELD_LABEL = 'Clear search';

/** Before a search: an invitation, never a rule about how much to type. */
export const SEARCH_IDLE_TITLE = 'Find creators, posts and recipes';
export const SEARCH_IDLE_BODY = 'Try a creator’s name, a model, or an idea like “neon portrait”.';

export function searchNoResultsTitle(query: string): string {
  return `No results for “${query}”`;
}
export const SEARCH_NO_RESULTS_BODY = 'Try a shorter phrase, check the spelling, or search for a creator handle.';

/** A search that failed: the title says what happened, the body what to do, the button does it. */
export const SEARCH_FAILED_TITLE = 'Search did not load';
export const SEARCH_FAILED_BODY = 'Something went wrong.';
export const SEARCH_OFFLINE_BODY = 'Check your connection.';
export function searchBusyBody(retryAfterSeconds: number | null): string {
  return retryAfterSeconds ? `Too many searches at once. Wait ${retryAfterSeconds} s.` : 'Too many searches at once. Wait a moment.';
}
export const SEARCH_RETRY_LABEL = 'Try again';
/** A failure under results still on screen: one line, title and body together. */
export function searchFailedLine(body: string): string {
  return `${SEARCH_FAILED_TITLE}. ${body}`;
}

export const SEARCH_SEARCHING_LABEL = 'Searching…';
export const SEARCH_SHOW_MORE_LABEL = 'Show more';
export const SEARCH_LOADING_MORE_LABEL = 'Loading…';

/** Beside a Top section's heading: opens the section's own tab. */
export const SEARCH_SEE_ALL_LABEL = 'See all';
/** What both "See all" controls of a Top section say: the link by its heading and the button under its last row. */
export function searchSeeAllLabel(section: SearchTopSection): string {
  return `See all ${section}`;
}

function countWords(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function sentence(text: string | null | undefined): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean ? `. ${clean}` : '';
}

/**
 * What a result says to a screen reader: everything its card shows a sighted
 * person, in an order and with pauses that read as words, where the card's
 * text run together read "Untitled Creationlibath4 saves1".
 */
export function searchPostCardLabel(post: {
  title: string;
  /** The creator as the card names them: by handle (searchPostCreatorName). */
  creatorName: string;
  saveCount: number;
  commentCount: number;
  /** The card's cover is a clip. */
  video?: boolean;
  /** What it was made with, as the card's line says it (searchPostMadeWithLine's label). */
  madeWith?: string | null;
  /** The card's badges, in their order: "Free recipe", "250 credits", "Remixable". */
  badges?: readonly string[];
  /** The card's date, as drawn. */
  date?: string | null;
}): string {
  const details = [
    post.video ? 'video' : null,
    post.madeWith ? `made with ${post.madeWith}` : null,
    ...(post.badges ?? []),
    post.date ?? null,
  ].filter((detail): detail is string => Boolean(detail));
  return `Open post ${post.title} by ${post.creatorName}, ${details.map((detail) => `${detail}, `).join('')}${countWords(post.saveCount, 'save', 'saves')}, ${countWords(post.commentCount, 'comment', 'comments')}`;
}

/**
 * The creator as a post card names them: by handle, as the post page, Home and
 * Explore do (the audit saw "Sassy23b" on a card whose post said "@batman");
 * by name only where there is no handle.
 */
export function searchPostCreatorName(creator: { name: string; username?: string | null }): string {
  const handle = creator.username?.trim();
  return handle ? `@${handle}` : creator.name;
}

/** A card's quiet line for the model or tool a post was made with: "Made with Nano Banana 2.0". */
export function searchPostMadeWithLine(label: string): string {
  return `Made with ${label}`;
}

/** A card's badge for a post that can be remixed, beside its recipe's price. */
export const SEARCH_POST_REMIXABLE_BADGE = 'Remixable';
export function searchRecipeCardLabel(recipe: { title: string; sellerName: string; price: string; summary?: string | null }): string {
  return `Open recipe ${recipe.title} by ${recipe.sellerName}, ${recipe.price}${sentence(recipe.summary)}`;
}
export function searchCreatorCardLabel(creator: {
  displayName: string;
  username: string;
  isFollowing: boolean;
  publicPostCount: number;
  bio?: string | null;
}): string {
  return `Open ${creator.displayName}'s profile, @${creator.username}${creator.isFollowing ? ', following' : ''}, ${countWords(creator.publicPostCount, 'post', 'posts')}${sentence(creator.bio)}`;
}

/**
 * The page's title while a query is searched: "nano · Search", from the two
 * characters a search starts at (counted as searchQueryLength counts, without a
 * leading "@"), so the server's title and the page's agree. The site's own
 * suffix is the page's to add.
 */
export function searchDocumentTitle(query: string): string {
  const normalized = normalizeSearchHistoryQuery(query);
  return searchQueryLength(normalizeCreatorSearchQuery(normalized)) >= SEARCH_MIN_CREATOR_QUERY_LENGTH
    ? `${normalized} · Search`
    : 'Search';
}

/** The search page's one heading, for a screen reader: the field is what a sighted person sees first. */
export const SEARCH_PAGE_HEADING = 'Search';
export const SEARCH_ENTITIES_HEADING = 'Models and tools';
export const SEARCH_RECENTS_HEADING = 'Recent searches';
export const SEARCH_RECENTS_CLEAR_LABEL = 'Clear all';
export const SEARCH_RECENTS_CLEAR_ACTION_LABEL = 'Clear all recent searches';
export function searchRecentAgainLabel(query: string): string {
  return `Search again for ${query}`;
}
export function searchRecentRemoveLabel(query: string): string {
  return `Remove ${query} from recent searches`;
}
export const SEARCH_FILTERS_GROUP_LABEL = 'Filter posts';
export const SEARCH_FILTERS_CLEAR_LABEL = 'Clear filters';
/** A filtered Posts search that found nothing: the filters are the first thing to try without. */
export const SEARCH_FILTERED_EMPTY_BODY = 'No post matches these filters. Remove one, or clear them all.';

/** What an entity's row says to a screen reader: "Kling 2.6, model, 14 posts. Show posts made with it". */
export function searchEntityActionLabel(entity: SearchEntity): string {
  return `${entity.label}, ${searchEntityKindLabel(entity.kind).toLowerCase()}, ${searchEntityCountLabel(entity)}. Show posts made with it`;
}

/** What the chip of a made-with filter that is on says to a screen reader. */
export function searchMadeWithRemoveLabel(label: string): string {
  return `Remove filter: made with ${label}`;
}

// ─── Related posts ───────────────────────────────────────────────────────────
//
// Posts that mean what a query says without holding its words (`related` on
// the answer of /api/search, up to eight feed cards), drawn as a second group
// under the search's own results. The server looks for them only for a
// request that asks (`related=1`), and each new query a viewer asks about
// spends one of that viewer's forty a day. So a client asks for a search a
// person has settled on, never at each step of the typing.

/** The parameter a client asks for related posts with; its one value is `1`. */
export const SEARCH_RELATED_PARAM = 'related';

/** The heading of the group. */
export const SEARCH_RELATED_HEADING = 'Related posts';

/**
 * How long a search's answer stands, the search unchanged, before the search
 * counts as settled without a word from the person: long enough to have read
 * that the answer is thin, and several times the pause a search waits for
 * after a letter, so a person still typing does not settle on each word.
 */
export const SEARCH_RELATED_SETTLE_MS = 1500;

/**
 * An answer with fewer posts than this is thin: the server looks for related
 * posts only under one (`SEARCH_RELATED_THIN_POST_COUNT`, src/lib/search-embeddings.ts),
 * so a client does not ask again for an answer that is not.
 */
export const SEARCH_RELATED_THIN_POSTS = 6;

/** A query shorter than this is not searched for posts at all. */
const SEARCH_RELATED_MIN_QUERY_LENGTH = 3;

/**
 * Whether related posts can come with a search at all: the first page of a
 * Top or Posts search in the ranked order, with no filter and not read as
 * typed, from three characters. The server's own conditions; anywhere else
 * it ignores the parameter, and a client does not send it.
 *
 * Never for a handle search (a query that begins with "@"): that is a look
 * for a creator, which the typeahead reads the same way, and posts that mean
 * what the handle's letters say are not what it asks for. The server would
 * look all the same, and spend one of the viewer's lookups on it.
 *
 * `query` is the search as the client normalizes it. `narrowing` is the
 * filters and the exact reading as one string (`searchFilterKey`), '' for
 * none; `queryLength` is counted as the server counts it
 * (`searchQueryLength` of the query less a leading "@").
 */
export function searchRelatedApplies(search: {
  query: string;
  type: string;
  sort: string;
  narrowing: string;
  queryLength: number;
  /** A later page of the same search: `cursor` is set. */
  laterPage: boolean;
}): boolean {
  return !search.query.trimStart().startsWith('@')
    && (search.type === 'top' || search.type === 'posts')
    && search.sort === 'top'
    && search.narrowing === ''
    && search.queryLength >= SEARCH_RELATED_MIN_QUERY_LENGTH
    && !search.laterPage;
}

/**
 * Whether an answer on hand is thin enough that asking again, for related
 * posts, can bring any: few posts, and on Posts no further page of them.
 */
export function isSearchAnswerThin(
  type: string,
  posts: { items: readonly unknown[]; nextCursor: string | null },
): boolean {
  return posts.items.length < SEARCH_RELATED_THIN_POSTS && (type !== 'posts' || posts.nextCursor === null);
}

/**
 * When a client asks for related posts, as one rule for both.
 *
 * - With the search itself, when the person had already settled on it as the
 *   request is sent: the Search key or Enter, a suggestion pressed, a recent
 *   search opened (`settled`).
 * - Otherwise once, after the search's own answer: at once when the person
 *   settles on it then, or when the answer has stood for
 *   SEARCH_RELATED_SETTLE_MS with the search unchanged. Only for a thin
 *   answer, and never twice for one answer (`relatedAsked`).
 *
 * Returns how long to wait before asking again, in milliseconds, or null for
 * not at all.
 */
export function searchRelatedFollowUpDelay(answer: {
  /** Related posts can come with this search (searchRelatedApplies). */
  applies: boolean;
  /** The answer on hand was asked for with `related=1`, or has been asked about since. */
  relatedAsked: boolean;
  /** The answer on hand is thin (isSearchAnswerThin). */
  thin: boolean;
  /** The person settled on this search. */
  settled: boolean;
}): number | null {
  if (!answer.applies || answer.relatedAsked || !answer.thin) return null;
  return answer.settled ? 0 : SEARCH_RELATED_SETTLE_MS;
}

/**
 * The related posts an answer brings, to draw: none for an answer without the
 * field (they were not looked for, or the server is from before them), and
 * none on a tab that has no posts group.
 */
export function searchRelatedPosts<Post>(
  type: string,
  answer: { related?: { posts?: readonly Post[] | null } | null },
): readonly Post[] {
  if (type !== 'top' && type !== 'posts') return NO_RELATED_POSTS as readonly Post[];
  const posts = answer.related?.posts;
  return Array.isArray(posts) ? posts : (NO_RELATED_POSTS as readonly Post[]);
}
const NO_RELATED_POSTS: readonly never[] = Object.freeze([]);

/** What a screen reader is told of them, after the search's own count: "3 related posts". */
export function searchRelatedStatus(count: number): string {
  return count <= 0 ? '' : `${count} related ${count === 1 ? 'post' : 'posts'}`;
}
