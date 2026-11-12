import {
  isPublicSearchQueryTooLong,
  normalizeCreatorSearchQuery,
  normalizePublicSearchQuery,
  publicSearchQueryLength,
} from '@/lib/public-search';

/**
 * Typeahead: what a search box shows while a person types, before they commit
 * a search. `GET /api/search/suggest?q=…` answers two short lists from one
 * database call (`search_suggestions`, migration
 * `20261112144018_search_suggestions_typeahead.sql`): creators whose handle or
 * name starts with the query, and words that complete the one being typed.
 * No page, no cursor, no row in the search log.
 *
 * This module is client-safe: the types and limits both clients share.
 */

/** One character is enough to offer handles; a completion needs two letters of its word. */
export const SEARCH_SUGGEST_MIN_QUERY_LENGTH = 1;
/** The most the answer ever holds, whatever the database returns. */
export const SEARCH_SUGGEST_MAX_CREATORS = 5;
export const SEARCH_SUGGEST_MAX_COMPLETIONS = 6;

/**
 * Sized for typing, and apart from full search's `public-search:read`
 * (180 per 10 minutes), which a typed query would spend in under a minute:
 * 120 a minute is two a second sustained, and the whole minute's allowance
 * can be spent in one burst, which is what fast typing behind a short
 * debounce looks like. Keyed like search: the account, or the network for a
 * visitor with no token.
 */
export const SEARCH_SUGGEST_RATE_LIMIT = {
  scope: 'public-search:suggest',
  limit: 120,
  windowSeconds: 60,
} as const;

/** What a creator row draws. A subset of search's `CreatorSearchResult`, under the same names. */
export interface SearchSuggestCreator {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isFollowing: boolean;
}

/** A query to search for: what was typed, with its last word completed. */
export interface SearchSuggestCompletion {
  text: string;
}

export interface SearchSuggestResponse {
  /** The query as it was sent, trimmed. */
  query: string;
  /** The query as it was read (searchSuggestQuery): a client drops an answer that is not for what its box holds now. */
  normalizedQuery: string;
  /** In the order to show them: at most SEARCH_SUGGEST_MAX_CREATORS. */
  creators: SearchSuggestCreator[];
  /** In the order to show them: at most SEARCH_SUGGEST_MAX_COMPLETIONS. Empty for a query typed as a handle. */
  completions: SearchSuggestCompletion[];
  // SEAM (model and tool suggestions): `entities: SearchSuggestEntity[]` joins
  // here as a third list, from the single source of entities, without changing
  // the two above. The SQL marks the same place in search_suggestions.
}

export type SearchSuggestQuery = {
  /**
   * Trimmed, NFKC, one space between words, a leading `@` taken off: the
   * search query's own reading (normalizeCreatorSearchQuery). The database
   * lower-cases it, as it does a search's.
   */
  normalizedQuery: string;
  /** The query was typed as a handle (`@lu`): people by handle, and no words. */
  handlesOnly: boolean;
};

export type SearchSuggestQueryResult =
  | ({ ok: true } & SearchSuggestQuery)
  | { ok: false; error: string };

/**
 * Reads `q` as search reads it, by search's own normaliser and its own count
 * of characters (code points, as the database counts them).
 */
export function searchSuggestQuery(value: string | null | undefined): SearchSuggestQueryResult {
  if (isPublicSearchQueryTooLong(value)) {
    return { ok: false, error: 'q must be at most 100 characters.' };
  }
  const normalizedQuery = normalizeCreatorSearchQuery(value);
  if (publicSearchQueryLength(normalizedQuery) < SEARCH_SUGGEST_MIN_QUERY_LENGTH) {
    return { ok: false, error: `q must contain at least ${SEARCH_SUGGEST_MIN_QUERY_LENGTH} character.` };
  }
  return {
    ok: true,
    normalizedQuery,
    handlesOnly: normalizePublicSearchQuery(value).startsWith('@'),
  };
}
