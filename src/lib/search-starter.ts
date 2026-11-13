import {
  SEARCH_STARTER_EMPTY_RESPONSE,
  SEARCH_STARTER_MAX_CREATORS,
  SEARCH_STARTER_MAX_ENTITIES,
  SEARCH_STARTER_MAX_SEARCHES,
} from '../../ugc-mobile/lib/public-search-policy/search-starter';

export { SEARCH_STARTER_EMPTY_RESPONSE };

export type {
  SearchStarterCreator,
  SearchStarterEntity,
  SearchStarterResponse,
  SearchStarterSearch,
} from '../../ugc-mobile/lib/public-search-policy/search-starter';

/**
 * The search screen before anything is typed. `GET /api/search/starter`
 * answers three short lists from one database call (`search_starter`,
 * migration `20261113100423_search_starter.sql`): popular models and tools,
 * creators to follow, and searches to try. No query, no page, no row in the
 * search log.
 *
 * The answer's shape and its caps are the search clients' shared rules
 * (`ugc-mobile/lib/public-search-policy/search-starter.ts`); this module is
 * the server's side: the caps it asks the database for, its rate limit, and
 * the hand-picked searches.
 */

export const SEARCH_STARTER_ENTITY_LIMIT = SEARCH_STARTER_MAX_ENTITIES;
export const SEARCH_STARTER_CREATOR_LIMIT = SEARCH_STARTER_MAX_CREATORS;
export const SEARCH_STARTER_SEARCH_LIMIT = SEARCH_STARTER_MAX_SEARCHES;

/**
 * The searches "Try searching for" offers, in the order to offer them: plain
 * words a newcomer would type (styles, subjects, model names). EDIT HERE to
 * change the list; a deploy is all it takes.
 *
 * The database offers a term only while at least one post search may show the
 * viewer matches it as typed, and never one holding a word of
 * `search_suggestion_denylist`, so a term with nothing behind it is skipped
 * rather than shown as an empty search. At most the first 20 are read and 8
 * are offered: list a few more than 8 so a term that finds nothing today
 * leaves room for the next. Each must be 3 to 100 characters.
 *
 * Until the search log feeds this list (the audit's "log-based list later"),
 * it is the only source: no query anyone typed reaches it.
 */
export const SEARCH_STARTER_SUGGESTED_SEARCHES: readonly string[] = Object.freeze([
  'portrait',
  'anime',
  'cinematic',
  'product photo',
  'fantasy',
  'landscape',
  'fashion',
  'cyberpunk',
  'nano banana',
  'kling',
  'logo',
  'food',
  'car',
  'architecture',
]);

/** How many terms the database reads (its own cap is the same). */
export const SEARCH_STARTER_MAX_TERMS = 20;

/**
 * Asked once each time a search screen opens empty, and a visitor's answer
 * is the edge's to keep for a few minutes, so few requests reach this: 60 a
 * minute is a screen opened every second for a minute. Keyed like search:
 * the account, or the network for a visitor with no token.
 */
export const SEARCH_STARTER_RATE_LIMIT = {
  scope: 'public-search:starter',
  limit: 60,
  windowSeconds: 60,
} as const;
