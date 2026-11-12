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

// ─── What the clients say around them ────────────────────────────────────────

export const SEARCH_ENTITIES_HEADING = 'Models and tools';
export const SEARCH_RECENTS_HEADING = 'Recent searches';
export const SEARCH_RECENTS_CLEAR_LABEL = 'Clear all';
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
