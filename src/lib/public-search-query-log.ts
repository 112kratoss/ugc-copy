import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendEvent } from '@/lib/backend-logger';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import {
  publicSearchTypeHasFilters,
  publicSearchTypeHasSorts,
  type PublicSearchFilters,
  type PublicSearchResponse,
  type PublicSearchSort,
  type PublicSearchType,
} from '@/lib/public-search';

/**
 * The anonymous search log, `public.search_query_events`: one row per first-page `/api/search`
 * answer, so ranking work has a zero-result rate and a list of failing queries to tune against.
 * Written by the service role after the response is out (`recordSearchAnswer` only schedules the
 * insert) and never in the way of it: any failure is logged and swallowed.
 *
 * A row holds the lowercased query (control characters removed, at most 100 characters), the
 * search type, whether a registered account was presented, a per-day visitor hash, how many
 * creators, posts and recipes the answer held, the order a Posts or Recipes search asked for
 * (null for Top and Creators, which have one), what narrowed a Posts search (the made-with
 * entity, the media kind, "has a recipe", "from creators I follow": each null when off, and
 * the last says only that the filter was on, never who is followed), whether the answer's posts
 * or recipes were found on a corrected reading of the query, and when the request arrived.
 *
 * A search asked to read the query as typed ("search instead for") writes no row: it is the
 * second asking of a search already counted, and by its nature finds no post or recipe, so it
 * would count as a failed search in the report.
 *
 * The visitor hash is HMAC-SHA256 of the viewer's rate-limit key (a user id or the hashed network
 * address, never stored) under a random key made for that UTC day alone (`search_visitor_day_keys`).
 * The retention sweep deletes the key once the day is more than 48 hours old, so the hash is
 * pseudonymous for 48 hours to whoever holds the service role and unlinkable after: nobody can
 * recompute it from an account or an address. It exists so the report can collapse "po" → "por" →
 * "port" from one visitor into one search. When the key cannot be read the row gets a fresh random
 * value, never a hash under any other secret.
 */

export const SEARCH_QUERY_EVENTS_TABLE = 'search_query_events';
export const SEARCH_QUERY_LOG_MAX_QUERY_LENGTH = 100;

type Environment = Record<string, string | undefined>;

export type SearchQueryEventRow = {
  created_at: string;
  query: string;
  search_type: PublicSearchType;
  signed_in: boolean;
  visitor_day: string;
  creator_count: number;
  post_count: number;
  recipe_count: number;
  /** The order a Posts or Recipes search was read in; null for Top and Creators. */
  sort: PublicSearchSort | null;
  /** A Posts search's made-with filter (`model:kling-2.6`); null without one. */
  made_with: string | null;
  /** A Posts search's media filter; null without one. */
  media_kind: 'image' | 'video' | null;
  /** True when a Posts search asked only for posts with a recipe; null otherwise. */
  has_recipe: true | null;
  /** True when a Posts search asked only for posts by creators the viewer follows; null otherwise. */
  followed_only: true | null;
  /** Whether the answer's posts or recipes were found on a corrected reading; null for Creators. */
  corrected: boolean | null;
};

export type SearchAnswerLogInput = {
  /** A request with a cursor asks for a later page of a search already counted. */
  hasCursor: boolean;
  normalizedQuery: string;
  type: PublicSearchType;
  /** The order the search was read in (the applied one). */
  sort: PublicSearchSort;
  /** What narrowed the search (the applied filters); none when left out. */
  filters?: PublicSearchFilters;
  /** The search was asked to read the query as typed: it writes no row. */
  exact?: boolean;
  /** The rate-limit key the adapter computed: the user id, or the hashed network address. */
  viewerKey: string;
  /** A registered (non-guest) account was presented. */
  signedIn: boolean;
  /** When the request arrived: the row's created_at, so a slow answer still sorts where it was asked. */
  requestedAt: Date;
  response: PublicSearchResponse;
};

/** The day's keys already read, by UTC date. Promises, so concurrent answers share one read. */
export type SearchDayKeyCache = Map<string, Promise<string | null>>;

export type SearchQueryLogDependencies = {
  createClient: () => SupabaseClient;
  runAfterResponse: RunAfterResponse;
  logEvent?: typeof logBackendEvent;
  env?: Environment;
  keyCache?: SearchDayKeyCache;
};

const instanceKeyCache: SearchDayKeyCache = new Map();

/** `SEARCH_QUERY_LOG_DISABLED=1` (or `true`) is the kill switch. */
export function isSearchQueryLogDisabled(env: Environment = process.env): boolean {
  const value = env.SEARCH_QUERY_LOG_DISABLED?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** The query as logged: control characters gone (they would reach an operator's terminal), capped, trimmed; '' when nothing is left. */
export function sanitizeSearchQuery(normalizedQuery: string): string {
  return Array.from(normalizedQuery.replace(/\p{Cc}/gu, '').trim().toLowerCase())
    .slice(0, SEARCH_QUERY_LOG_MAX_QUERY_LENGTH)
    .join('')
    .trim();
}

/**
 * The row for an answer, or null when the query is blank after cleaning. `dayKey` is the
 * request's UTC day key; null (it could not be read) gives a random visitor value.
 */
export function buildSearchQueryEventRow(
  input: Omit<SearchAnswerLogInput, 'hasCursor' | 'exact'>,
  dayKey: string | null,
): SearchQueryEventRow | null {
  const query = sanitizeSearchQuery(input.normalizedQuery);
  if (!query) return null;
  const filters = publicSearchTypeHasFilters(input.type) ? input.filters : undefined;
  // An answer from before the reading was reported says nothing of it.
  const corrected = input.response.correctedQuery;
  return {
    created_at: input.requestedAt.toISOString(),
    query,
    search_type: input.type,
    signed_in: input.signedIn,
    visitor_day: dayKey
      ? createHmac('sha256', dayKey).update(input.viewerKey).digest('hex')
      : randomBytes(32).toString('hex'),
    creator_count: input.response.creators.items.length,
    post_count: input.response.posts.items.length,
    recipe_count: input.response.recipes.items.length,
    sort: publicSearchTypeHasSorts(input.type) ? input.sort : null,
    made_with: filters?.madeWith ?? null,
    media_kind: filters?.mediaKind ?? null,
    has_recipe: filters?.hasRecipe ? true : null,
    followed_only: filters?.following ? true : null,
    corrected: input.type === 'creators' || !corrected
      ? null
      : corrected.posts !== null || corrected.recipes !== null,
  };
}

/** Today's key, read once per instance and day; a failed read is not cached, so the next answer retries. */
async function readDayKey(
  client: SupabaseClient,
  day: string,
  cache: SearchDayKeyCache,
): Promise<string | null> {
  const cached = cache.get(day);
  if (cached) return cached;
  const reading = (async () => {
    const { data, error } = await client.rpc('search_visitor_day_key', { p_day: day });
    if (error || typeof data !== 'string' || !/^[0-9a-f]{64}$/u.test(data)) {
      cache.delete(day);
      return null;
    }
    return data;
  })().catch(() => {
    cache.delete(day);
    return null;
  });
  for (const stale of cache.keys()) if (stale !== day) cache.delete(stale);
  cache.set(day, reading);
  return reading;
}

/**
 * Schedules the log row of a first-page answer behind the response. Returns at once and never
 * throws: the key read and the insert run in `runAfterResponse` (Next's `after`), and an error
 * from them, from building the client or from the scheduler itself goes to the log, query text
 * left out.
 */
export function recordSearchAnswer(
  dependencies: SearchQueryLogDependencies,
  input: SearchAnswerLogInput,
): void {
  const logEvent = dependencies.logEvent ?? logBackendEvent;
  const failed = (error: unknown) => {
    logEvent('warn', 'search_query_log_failed', { error });
  };
  try {
    if (input.hasCursor || input.exact || isSearchQueryLogDisabled(dependencies.env)) return;
    if (!sanitizeSearchQuery(input.normalizedQuery)) return;
    dependencies.runAfterResponse(async () => {
      try {
        const client = dependencies.createClient();
        const day = input.requestedAt.toISOString().slice(0, 10);
        const dayKey = await readDayKey(client, day, dependencies.keyCache ?? instanceKeyCache);
        const row = buildSearchQueryEventRow(input, dayKey);
        if (!row) return;
        const { error } = await client.from(SEARCH_QUERY_EVENTS_TABLE).insert(row);
        if (error) failed(error);
      } catch (error) {
        failed(error);
      }
    });
  } catch (error) {
    failed(error);
  }
}
