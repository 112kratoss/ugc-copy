import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendEvent } from '@/lib/backend-logger';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import type { PublicSearchResponse, PublicSearchType } from '@/lib/public-search';
import { hashFeedIdentity } from '@/lib/showcase-feed-identity';

/**
 * The anonymous search log, `public.search_query_events`: one row per first-page `/api/search`
 * answer, so ranking work has a zero-result rate and a list of failing queries to tune against.
 * Written by the service role after the response is out (`recordSearchAnswer` only schedules the
 * insert) and never in the way of it: any failure is logged and swallowed.
 *
 * A row holds the lowercased query (at most 100 characters), the search type, whether a session
 * was presented, a per-day visitor hash, and how many creators, posts and recipes the answer
 * held. The hash is sha256 over (the feed identity salt, the viewer's rate-limit key, the UTC
 * date): the key is a user id or the hashed network address and is never stored, and the date is
 * inside the hash, so a visitor cannot be joined across days or back to an account. It exists so
 * the report can collapse "po" → "por" → "port" from one visitor into one search.
 */

export const SEARCH_QUERY_EVENTS_TABLE = 'search_query_events';
export const SEARCH_QUERY_LOG_MAX_QUERY_LENGTH = 100;

const VISITOR_DAY_NAMESPACE = 'search-visitor-day';

type Environment = Record<string, string | undefined>;

export type SearchQueryEventRow = {
  query: string;
  search_type: PublicSearchType;
  signed_in: boolean;
  visitor_day: string;
  creator_count: number;
  post_count: number;
  recipe_count: number;
};

export type SearchAnswerLogInput = {
  /** A request with a cursor asks for a later page of a search already counted. */
  hasCursor: boolean;
  normalizedQuery: string;
  type: PublicSearchType;
  /** The rate-limit key the adapter computed: the user id, or the hashed network address. */
  viewerKey: string;
  /** A session was presented (a guest's counts). */
  signedIn: boolean;
  response: PublicSearchResponse;
};

export type SearchQueryLogDependencies = {
  createClient: () => SupabaseClient;
  runAfterResponse: RunAfterResponse;
  logEvent?: typeof logBackendEvent;
  env?: Environment;
  now?: () => Date;
};

/** `SEARCH_QUERY_LOG_DISABLED=1` (or `true`) is the kill switch. */
export function isSearchQueryLogDisabled(env: Environment = process.env): boolean {
  const value = env.SEARCH_QUERY_LOG_DISABLED?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** The row for an answer, or null when the query is blank after trimming. */
export function buildSearchQueryEventRow(
  input: Omit<SearchAnswerLogInput, 'hasCursor'>,
  now: Date,
): SearchQueryEventRow | null {
  const query = Array.from(input.normalizedQuery.trim().toLowerCase())
    .slice(0, SEARCH_QUERY_LOG_MAX_QUERY_LENGTH)
    .join('')
    .trim();
  if (!query) return null;
  const utcDate = now.toISOString().slice(0, 10);
  return {
    query,
    search_type: input.type,
    signed_in: input.signedIn,
    visitor_day: hashFeedIdentity(VISITOR_DAY_NAMESPACE, `${input.viewerKey}:${utcDate}`),
    creator_count: input.response.creators.items.length,
    post_count: input.response.posts.items.length,
    recipe_count: input.response.recipes.items.length,
  };
}

/**
 * Schedules the log row of a first-page answer behind the response. Returns at once and never
 * throws: the insert runs in `runAfterResponse` (Next's `after`), and an error from it, from
 * building the client or from the scheduler itself goes to the log, query text left out.
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
    if (input.hasCursor || isSearchQueryLogDisabled(dependencies.env)) return;
    const row = buildSearchQueryEventRow(input, (dependencies.now ?? (() => new Date()))());
    if (!row) return;
    dependencies.runAfterResponse(async () => {
      try {
        const { error } = await dependencies.createClient().from(SEARCH_QUERY_EVENTS_TABLE).insert(row);
        if (error) failed(error);
      } catch (error) {
        failed(error);
      }
    });
  } catch (error) {
    failed(error);
  }
}
