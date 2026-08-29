import type { ShowcaseFeedItem } from '@/lib/showcase';

export const PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH = 2;
export const PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH = 3;
export const PUBLIC_SEARCH_MAX_QUERY_LENGTH = 100;
export const PUBLIC_SEARCH_DEFAULT_LIMIT = 20;
export const PUBLIC_SEARCH_MAX_LIMIT = 24;

export const PUBLIC_SEARCH_TYPES = ['top', 'creators', 'posts', 'recipes'] as const;
export type PublicSearchType = (typeof PUBLIC_SEARCH_TYPES)[number];

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
  salesCount: number;
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
  creators: PublicSearchPage<CreatorSearchResult>;
  posts: PublicSearchPage<ShowcaseFeedItem>;
  recipes: PublicSearchPage<RecipeSearchResult>;
}

export type PublicSearchCursor = {
  version: 1;
  type: Exclude<PublicSearchType, 'top'>;
  score?: number;
  id?: string;
  offset?: number;
};

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

export function isPublicSearchQueryTooLong(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').length > PUBLIC_SEARCH_MAX_QUERY_LENGTH;
}

export function parsePublicSearchType(value: string | null | undefined): PublicSearchType | null {
  return PUBLIC_SEARCH_TYPES.includes(value as PublicSearchType) ? value as PublicSearchType : null;
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
    ...(cursor.score !== undefined ? { s: cursor.score } : {}),
    ...(cursor.id ? { i: cursor.id } : {}),
    ...(cursor.offset !== undefined ? { o: cursor.offset } : {}),
  }), 'utf8').toString('base64url');
}

export function decodePublicSearchCursor(
  value: string | null | undefined,
  expectedType: PublicSearchType,
): PublicSearchCursor | null {
  if (!value || value.length > 512 || expectedType === 'top') return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.t !== expectedType) return null;
    if (expectedType === 'recipes') {
      if (!Number.isSafeInteger(parsed.o) || Number(parsed.o) < 0) return null;
      return { version: 1, type: expectedType, offset: Number(parsed.o) };
    }
    // The id feeds a uuid RPC parameter; rejecting malformed ids here keeps a
    // hand-built cursor a 400 instead of a Postgres cast error surfacing as 500.
    if (
      typeof parsed.s !== 'number'
      || !Number.isFinite(parsed.s)
      || typeof parsed.i !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.i)
    ) {
      return null;
    }
    return { version: 1, type: expectedType, score: parsed.s, id: parsed.i };
  } catch {
    return null;
  }
}
