import type { ShowcaseFeedItem } from '@/lib/showcase';

import {
  NO_SEARCH_FILTERS,
  searchFilterKey,
  type SearchCorrectedQuery,
  type SearchEntity,
  type SearchEntityKind,
  type SearchFilters,
  type SearchMediaKind,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

// What a request may name, and the words both clients show, are one copy the
// web and the app share (ugc-mobile/lib/public-search-policy).
export {
  NO_SEARCH_FILTERS as NO_PUBLIC_SEARCH_FILTERS,
  hasSearchFilters as hasPublicSearchFilters,
  readSearchFilterParams as readPublicSearchFilterParams,
  searchEntityId,
  searchFilterKey as publicSearchFilterKey,
  searchFilterParams as publicSearchFilterParams,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';
export type {
  SearchCorrectedQuery as PublicSearchCorrectedQuery,
  SearchEntity as SearchEntityResult,
  SearchEntityKind as PublicSearchEntityKind,
  SearchFilters as PublicSearchFilters,
  SearchMediaKind as PublicSearchMediaKind,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

export const PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH = 2;
export const PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH = 3;
export const PUBLIC_SEARCH_MAX_QUERY_LENGTH = 100;
export const PUBLIC_SEARCH_DEFAULT_LIMIT = 20;
export const PUBLIC_SEARCH_MAX_LIMIT = 24;
/**
 * The deepest offset a recipes cursor may carry: the marketplace list's own
 * cap (MAX_MARKETPLACE_RESOURCE_OFFSET in
 * marketplace-resource-list-route-adapter-service.ts, which this client-safe
 * module cannot import; public-search.test.ts holds the two equal). Beyond it
 * a cursor is invalid, a 400, never an integer the list's RPC overflows on.
 */
export const PUBLIC_SEARCH_MAX_RECIPE_OFFSET = 960;

export const PUBLIC_SEARCH_TYPES = ['top', 'creators', 'posts', 'recipes'] as const;
export type PublicSearchType = (typeof PUBLIC_SEARCH_TYPES)[number];

/**
 * The order of a Posts or Recipes search: `top` is the ranked one
 * (search_post_score for posts, relevance for recipes), `latest` the same
 * matches newest first. The Top tab and Creators have one order, the ranked
 * one, whatever a request names.
 */
export const PUBLIC_SEARCH_SORTS = ['top', 'latest'] as const;
export type PublicSearchSort = (typeof PUBLIC_SEARCH_SORTS)[number];

/** Whether a tab can be read in another order than the ranked one. */
export function publicSearchTypeHasSorts(type: PublicSearchType): boolean {
  return type === 'posts' || type === 'recipes';
}

/** The order a search of `type` is read in when a request names `sort`. */
export function appliedPublicSearchSort(type: PublicSearchType, sort: PublicSearchSort): PublicSearchSort {
  return publicSearchTypeHasSorts(type) ? sort : 'top';
}

/** How many entities the Top tab offers. */
export const PUBLIC_SEARCH_ENTITY_LIMIT = 5;

/** Whether a tab's results can be narrowed: only Posts. */
export function publicSearchTypeHasFilters(type: PublicSearchType): boolean {
  return type === 'posts';
}

/**
 * The filters a search of `type` is read with when a request names
 * `filters`: its own on Posts, none anywhere else, as a sort is read. A
 * viewer with no registered account follows nobody, so `following` is left
 * out for one: the answer says which filters it applied.
 */
export function appliedPublicSearchFilters(
  type: PublicSearchType,
  filters: SearchFilters,
  viewerCanFollow: boolean,
): SearchFilters {
  if (!publicSearchTypeHasFilters(type)) return NO_SEARCH_FILTERS;
  return viewerCanFollow ? filters : { ...filters, following: false };
}

/** The filters an answer was read with: as asked, the made-with entity by its name. */
export interface PublicSearchAppliedFilters {
  madeWith: { kind: SearchEntityKind; key: string; label: string } | null;
  mediaKind: SearchMediaKind | null;
  hasRecipe: boolean;
  following: boolean;
}

export const NO_PUBLIC_SEARCH_APPLIED_FILTERS: PublicSearchAppliedFilters = Object.freeze({
  madeWith: null,
  mediaKind: null,
  hasRecipe: false,
  following: false,
});

export interface CreatorSearchResult {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  publicPostCount: number;
  isFollowing: boolean;
}

export interface RecipeSearchResult {
  id: string;
  postId: string;
  title: string;
  summary: string;
  previewText: string;
  accessMode: 'free' | 'paid';
  priceUsdCents: number;
  /** Paid unlocks. */
  salesCount: number;
  freeUnlockCount: number;
  allowRemix: boolean;
  resourceKinds: string[];
  createdAt: string;
  seller: {
    id: string;
    username: string | null;
    name: string;
    avatar: string | null;
  };
  post: {
    id: string;
    title: string;
    body: string;
    mediaUrl: string | null;
    mediaPreviewUrl: string | null;
    mediaKind: 'image' | 'video' | null;
  } | null;
  priceQuote: {
    formatted: string;
    currency: string;
    amountSubunits: number;
    note?: string | null;
  };
}

export interface PublicSearchPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PublicSearchResponse {
  query: string;
  normalizedQuery: string;
  type: PublicSearchType;
  /** The order the answer is in: `latest` only for a Posts or Recipes search that asked for it. */
  sort: PublicSearchSort;
  /**
   * The models and tools whose name holds the query, each with the posts the
   * viewer may see that are made with it. The Top tab only; empty elsewhere.
   */
  entities: SearchEntity[];
  /** What narrowed the posts: none except on a Posts search. */
  filters: PublicSearchAppliedFilters;
  /**
   * The query as the spelling correction read it for the posts and for the
   * recipes this answer holds; null where they were found on the query as
   * typed, or there are none.
   */
  correctedQuery: SearchCorrectedQuery;
  /** The request asked for the query as typed: nothing was corrected. */
  exact: boolean;
  creators: PublicSearchPage<CreatorSearchResult>;
  posts: PublicSearchPage<ShowcaseFeedItem>;
  recipes: PublicSearchPage<RecipeSearchResult>;
  /**
   * Posts that mean what the query says without holding its words, nearest
   * first, none of them in `posts`: at most eight, cards like any other.
   * Present only where they were looked for, which is the first page of a
   * Top or Posts search in the ranked order, with no filter and not read as
   * typed, whose own posts are few; `posts` may then be empty. Left out
   * everywhere else, when the lookup is switched off or could not be made,
   * and by a server from before it: a client draws nothing for an answer
   * without it. `posts` is never reordered or shortened for it.
   */
  related?: PublicSearchRelated;
}

export interface PublicSearchRelated {
  posts: ShowcaseFeedItem[];
}

export type PublicSearchCursor = {
  version: 1;
  type: Exclude<PublicSearchType, 'top'>;
  /** The order the cursor pages. Left out for `top`, as every cursor issued before sorts is. */
  sort?: PublicSearchSort;
  score?: number;
  id?: string;
  offset?: number;
  /**
   * Top posts: the instant the search began, in milliseconds. The post score
   * depends on the clock, so every page is scored at this instant. A cursor
   * issued before 2026-11-12 has none, and its page is scored at its own request.
   */
  asOf?: number;
  /** Latest posts: the last row's created_at, as the database wrote it (microseconds kept). */
  createdAt?: string;
  /**
   * Posts: a mark of the filters and reading the cursor was issued under
   * (publicSearchCursorFilterMark). Left out for none, as every cursor issued
   * before filters is. A cursor pages the search it came from and no other.
   */
  filters?: string;
};

/**
 * A short mark of a posts search's filters and reading, undefined for none.
 * Not a secret and not a signature: a cursor holds only a place in a list,
 * and the filters themselves come with every request. It tells a cursor of
 * one filter set from a request for another, which would otherwise page a
 * list the cursor's place means nothing in.
 */
export function publicSearchCursorFilterMark(filters: SearchFilters, exact: boolean): string | undefined {
  const key = searchFilterKey(filters, exact);
  if (!key) return undefined;
  // FNV-1a, 32 bits, over the key's UTF-16 units.
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// A timestamptz as PostgREST writes one: 2026-11-12T10:35:47.123456+00:00.
const CURSOR_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/;
// The years a cursor's time may name. Nothing here was made before 2020, and
// past 9999 toISOString writes a signed six-digit year: Postgres refuses that,
// as it refuses the year 0000.
const MIN_CURSOR_YEAR = 2020;
const MAX_CURSOR_YEAR = 9999;
const MIN_CURSOR_AS_OF_MS = Date.UTC(MIN_CURSOR_YEAR, 0, 1);
const MAX_CURSOR_AS_OF_MS = Date.UTC(MAX_CURSOR_YEAR, 11, 31, 23, 59, 59, 999);
// The widest offset from UTC any place keeps; Postgres refuses +16:00 and beyond.
const MAX_CURSOR_OFFSET_HOURS = 14;

/**
 * Whether a cursor's created_at is a time Postgres takes as a timestamptz.
 * `Date.parse` is no judge of that: V8 reads 2026-02-30 as 2 March and takes
 * an offset of +23:59, and Postgres refuses both, which reached the caller as
 * a 500. So the date and time must come back from a Date as they went in.
 */
function isCursorTimestamp(value: string): boolean {
  const parts = CURSOR_TIMESTAMP_PATTERN.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, offsetHours, offsetMinutes] = parts;
  if (Number(year) < MIN_CURSOR_YEAR || Number(year) > MAX_CURSOR_YEAR) return false;
  if (offsetHours !== undefined && (Number(offsetHours) > MAX_CURSOR_OFFSET_HOURS || Number(offsetMinutes) > 59)) {
    return false;
  }
  const wallClock = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const read = new Date(`${wallClock}Z`);
  return Number.isFinite(read.getTime()) && read.toISOString().slice(0, 19) === wallClock;
}

/**
 * A query as it is searched: NFKC, one space between words, at most 100
 * characters. The cut counts characters as the database does (char_length),
 * never UTF-16 units: `.slice(0, 100)` kept fifty emoji of a hundred, and
 * could leave half of one at the end.
 */
export function normalizePublicSearchQuery(value: string | null | undefined): string {
  const normalized = (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  // Most queries are short: only one that could be over the limit is counted.
  return normalized.length <= PUBLIC_SEARCH_MAX_QUERY_LENGTH
    ? normalized
    : Array.from(normalized).slice(0, PUBLIC_SEARCH_MAX_QUERY_LENGTH).join('');
}

export function normalizeCreatorSearchQuery(value: string | null | undefined): string {
  return normalizePublicSearchQuery(value).replace(/^@+/, '');
}

/**
 * A query's length as the database counts it (char_length): in characters,
 * where `.length` counts an emoji as two. search_public_creators and
 * search_public_posts raise below their minimums, so every gate ahead of them
 * counts this way; one emoji let through on `.length` was a 500.
 */
export function publicSearchQueryLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Whether a raw query is past the maximum, counted as the minimums are
 * (publicSearchQueryLength): in characters, as the database's char_length
 * counts them. Counted in UTF-16 units, 51 to 100 emoji were refused as too
 * long while the database takes them.
 */
export function isPublicSearchQueryTooLong(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return publicSearchQueryLength(value.normalize('NFKC').trim().replace(/\s+/g, ' ')) > PUBLIC_SEARCH_MAX_QUERY_LENGTH;
}

export function parsePublicSearchType(value: string | null | undefined): PublicSearchType | null {
  return PUBLIC_SEARCH_TYPES.includes(value as PublicSearchType) ? value as PublicSearchType : null;
}

/** The sort a request names; a request that names none reads `top`. Null for any other value. */
export function parsePublicSearchSort(value: string | null | undefined): PublicSearchSort | null {
  if (value === null || value === undefined) return 'top';
  return PUBLIC_SEARCH_SORTS.includes(value as PublicSearchSort) ? value as PublicSearchSort : null;
}

export function parsePublicSearchLimit(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return PUBLIC_SEARCH_DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > PUBLIC_SEARCH_MAX_LIMIT) return null;
  return parsed;
}

export function emptyPublicSearchPage<T>(): PublicSearchPage<T> {
  return { items: [], nextCursor: null };
}

export function encodePublicSearchCursor(cursor: PublicSearchCursor): string {
  return Buffer.from(JSON.stringify({
    v: cursor.version,
    t: cursor.type,
    ...(cursor.sort === 'latest' ? { r: cursor.sort } : {}),
    ...(cursor.score !== undefined ? { s: cursor.score } : {}),
    ...(cursor.id ? { i: cursor.id } : {}),
    ...(cursor.offset !== undefined ? { o: cursor.offset } : {}),
    ...(cursor.asOf !== undefined ? { a: cursor.asOf } : {}),
    ...(cursor.createdAt ? { c: cursor.createdAt } : {}),
    ...(cursor.filters ? { f: cursor.filters } : {}),
  }), 'utf8').toString('base64url');
}

/**
 * A cursor for a search of `expectedType` read in `expectedSort` (the applied
 * one: `top` for Creators whatever was asked), or null. A cursor pages the
 * order it was issued for and no other: one without a sort is a Top cursor,
 * so a cursor issued before sorts existed still pages. A posts cursor keeps
 * its filter mark for the caller to hold against the request's
 * (publicSearchCursorFilterMark): the applied filters are known only once the
 * viewer is.
 */
export function decodePublicSearchCursor(
  value: string | null | undefined,
  expectedType: PublicSearchType,
  expectedSort: PublicSearchSort = 'top',
): PublicSearchCursor | null {
  if (!value || value.length > 512 || expectedType === 'top') return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.t !== expectedType) return null;
    const sort = parsed.r === undefined ? 'top' : parsePublicSearchSort(typeof parsed.r === 'string' ? parsed.r : '');
    if (sort !== expectedSort) return null;
    const sortField = sort === 'latest' ? { sort } : {};
    // Only a posts search is filtered; a mark anywhere else, or one that is
    // not a mark, is no cursor this server issued.
    if (parsed.f !== undefined && (expectedType !== 'posts' || typeof parsed.f !== 'string' || !/^[0-9a-f]{8}$/.test(parsed.f))) {
      return null;
    }
    const filtersField = typeof parsed.f === 'string' ? { filters: parsed.f } : {};
    if (expectedType === 'recipes') {
      if (
        !Number.isSafeInteger(parsed.o)
        || Number(parsed.o) < 0
        || Number(parsed.o) > PUBLIC_SEARCH_MAX_RECIPE_OFFSET
      ) {
        return null;
      }
      return { version: 1, type: expectedType, ...sortField, offset: Number(parsed.o) };
    }
    // The id feeds a uuid RPC parameter; rejecting malformed ids here keeps a
    // hand-built cursor a 400 instead of a Postgres cast error surfacing as 500.
    if (
      typeof parsed.i !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.i)
    ) {
      return null;
    }
    if (expectedType === 'posts' && sort === 'latest') {
      // Feeds a timestamptz parameter, so held to a time Postgres takes for the same reason.
      if (typeof parsed.c !== 'string' || !isCursorTimestamp(parsed.c)) return null;
      return { version: 1, type: expectedType, sort, createdAt: parsed.c, id: parsed.i, ...filtersField };
    }
    if (typeof parsed.s !== 'number' || !Number.isFinite(parsed.s)) return null;
    if (expectedType === 'posts' && parsed.a !== undefined) {
      // An integer of milliseconds always makes a real date; the years are held as created_at's are.
      if (
        !Number.isSafeInteger(parsed.a)
        || Number(parsed.a) < MIN_CURSOR_AS_OF_MS
        || Number(parsed.a) > MAX_CURSOR_AS_OF_MS
      ) {
        return null;
      }
      return { version: 1, type: expectedType, score: parsed.s, id: parsed.i, asOf: Number(parsed.a), ...filtersField };
    }
    return { version: 1, type: expectedType, score: parsed.s, id: parsed.i, ...filtersField };
  } catch {
    return null;
  }
}
