import {
  isPublicSearchQueryTooLong,
  normalizeCreatorSearchQuery,
  normalizePublicSearchQuery,
  publicSearchQueryLength,
} from '@/lib/public-search';

import {
  SEARCH_TYPEAHEAD_MAX_COMPLETIONS,
  SEARCH_TYPEAHEAD_MAX_CREATORS,
  SEARCH_TYPEAHEAD_MAX_ENTITIES,
} from '../../ugc-mobile/lib/public-search-policy/search-typeahead';

export type {
  SearchSuggestCompletion,
  SearchSuggestCreator,
  SearchSuggestResponse,
} from '../../ugc-mobile/lib/public-search-policy/search-typeahead';

/**
 * Typeahead: what a search box shows while a person types, before they commit
 * a search. `GET /api/search/suggest?q=…` answers three short lists from one
 * database call (`search_suggestions`, migrations
 * `20261112144018_search_suggestions_typeahead.sql` and
 * `20261112192423_search_suggestions_entities.sql`): creators whose handle or
 * name starts with the query, the models and tools it names, and words that
 * complete the one being typed. No page, no cursor, no row in the search log.
 *
 * The answer's shape and its caps are the search clients' shared rules
 * (`ugc-mobile/lib/public-search-policy/search-typeahead.ts`), which both
 * search boxes draw by; this module is the server's reading of a request.
 */

/** One character is enough to offer handles; a completion needs two letters of its word, an entity three characters. */
export const SEARCH_SUGGEST_MIN_QUERY_LENGTH = 1;
/** The most the answer ever holds, whatever the database returns. */
export const SEARCH_SUGGEST_MAX_CREATORS = SEARCH_TYPEAHEAD_MAX_CREATORS;
export const SEARCH_SUGGEST_MAX_ENTITIES = SEARCH_TYPEAHEAD_MAX_ENTITIES;
export const SEARCH_SUGGEST_MAX_COMPLETIONS = SEARCH_TYPEAHEAD_MAX_COMPLETIONS;

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

export type SearchSuggestQuery = {
  /** What was sent, control characters taken out and trimmed: echoed back as `query`. */
  query: string;
  /**
   * Trimmed, NFKC, one space between words, a leading `@` taken off (and the
   * space it leaves, as in `@ lu`): the search query's own reading
   * (normalizeCreatorSearchQuery). The database lower-cases it, as it does a
   * search's.
   */
  normalizedQuery: string;
  /** The query was typed as a handle (`@lu`): people by handle, and no models, tools or words. */
  handlesOnly: boolean;
};

export type SearchSuggestQueryResult =
  | ({ ok: true } & SearchSuggestQuery)
  | { ok: false; error: string };

/**
 * `q` with its control characters taken out, before anything else reads it:
 * Postgres refuses a text that holds U+0000, so `q=a%00` reached the database
 * as a 500. A tab or a line break is a space between words, as search's
 * normaliser reads one; every other control character is nothing a person
 * typed.
 */
function withoutControlCharacters(value: string | null | undefined): string {
  return (value ?? '').replace(/\s/g, ' ').replace(/\p{Cc}/gu, '');
}

/**
 * Reads `q` as search reads it, by search's own normaliser and its own count
 * of characters (code points, as the database counts them).
 */
export function searchSuggestQuery(value: string | null | undefined): SearchSuggestQueryResult {
  const typed = withoutControlCharacters(value);
  if (isPublicSearchQueryTooLong(typed)) {
    return { ok: false, error: 'q must be at most 100 characters.' };
  }
  // The normaliser trims before it takes the @ off, so `@ lu` is left ` lu`.
  const normalizedQuery = normalizeCreatorSearchQuery(typed).trim();
  if (publicSearchQueryLength(normalizedQuery) < SEARCH_SUGGEST_MIN_QUERY_LENGTH) {
    return { ok: false, error: `q must contain at least ${SEARCH_SUGGEST_MIN_QUERY_LENGTH} character.` };
  }
  return {
    ok: true,
    query: typed.trim(),
    normalizedQuery,
    handlesOnly: normalizePublicSearchQuery(typed).startsWith('@'),
  };
}
