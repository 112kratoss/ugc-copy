import type { ShowcaseFeedItem } from '@/lib/showcase';

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
  creators: PublicSearchPage<CreatorSearchResult>;
  posts: PublicSearchPage<ShowcaseFeedItem>;
  recipes: PublicSearchPage<RecipeSearchResult>;
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
};

// A timestamptz as PostgREST writes one: 2026-11-12T10:35:47.123456+00:00.
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
// The last millisecond of the year 9999: past it toISOString writes a signed
// six-digit year, which a timestamptz parameter refuses.
const MAX_CURSOR_AS_OF_MS = 253_402_300_799_999;

export function normalizePublicSearchQuery(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, PUBLIC_SEARCH_MAX_QUERY_LENGTH);
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

export function isPublicSearchQueryTooLong(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').length > PUBLIC_SEARCH_MAX_QUERY_LENGTH;
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
  }), 'utf8').toString('base64url');
}

/**
 * A cursor for a search of `expectedType` read in `expectedSort` (the applied
 * one: `top` for Creators whatever was asked), or null. A cursor pages the
 * order it was issued for and no other: one without a sort is a Top cursor,
 * so a cursor issued before sorts existed still pages.
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
      // Feeds a timestamptz parameter, so held to that shape for the same reason.
      if (
        typeof parsed.c !== 'string'
        || !CURSOR_TIMESTAMP_PATTERN.test(parsed.c)
        || !Number.isFinite(Date.parse(parsed.c))
      ) {
        return null;
      }
      return { version: 1, type: expectedType, sort, createdAt: parsed.c, id: parsed.i };
    }
    if (typeof parsed.s !== 'number' || !Number.isFinite(parsed.s)) return null;
    if (expectedType === 'posts' && parsed.a !== undefined) {
      if (!Number.isSafeInteger(parsed.a) || Number(parsed.a) <= 0 || Number(parsed.a) > MAX_CURSOR_AS_OF_MS) {
        return null;
      }
      return { version: 1, type: expectedType, score: parsed.s, id: parsed.i, asOf: Number(parsed.a) };
    }
    return { version: 1, type: expectedType, score: parsed.s, id: parsed.i };
  } catch {
    return null;
  }
}
