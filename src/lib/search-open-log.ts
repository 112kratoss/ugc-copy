import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendEvent } from '@/lib/backend-logger';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import { normalizeCreatorSearchQuery, publicSearchTypeHasSorts } from '@/lib/public-search';
import {
  isSearchQueryLogDisabled,
  readSearchDayKey,
  sanitizeSearchQuery,
  searchVisitorDay,
  type SearchDayKeyCache,
} from '@/lib/public-search-query-log';
import type { SearchOpen } from '../../ugc-mobile/lib/public-search-policy/search-open-log';

/**
 * The opened results of the anonymous search log, `public.search_result_opens`: one row per result
 * a person pressed from a search (`POST /api/search/opened`), so ranking has what was chosen for a
 * query beside what was asked. Written by the service role after the response is out and never in
 * the way of it: any failure is logged and swallowed.
 *
 * A row holds the query cleaned exactly as the search row's is (the same normalizing, lowercasing,
 * control-character and length handling, so the two match as text), the tab, the order of a Posts
 * or Recipes list (null for Top and Creators, which have one), the search's entry, the kind, id and
 * 1-based place of what was pressed, the per-day visitor code and when the request arrived. No user
 * id, no network address, no signed-in flag.
 *
 * The visitor code is the search row's: HMAC of the same rate-limit key under the same UTC day's
 * key (`searchVisitorDay`). It ties an open to its search within that day and to nothing else, and
 * cannot be recomputed once the day key is deleted (48 hours).
 *
 * The id is stored as sent. Nothing here asks whether it exists or may be seen, so the route's
 * answer cannot say; the report counts an open only while its id is public (`search_query_report`).
 *
 * The switch is the search log's: `SEARCH_QUERY_LOG_DISABLED` stops both rows.
 */

export const SEARCH_RESULT_OPENS_TABLE = 'search_result_opens';

type Environment = Record<string, string | undefined>;

export type SearchResultOpenRow = {
  created_at: string;
  query: string;
  search_type: SearchOpen['type'];
  /** The order the list was in; null for Top and Creators. */
  sort: SearchOpen['sort'] | null;
  /** How the search was entered, as the client says it; null when it said nothing. */
  entry: SearchOpen['entry'];
  visitor_day: string;
  result_kind: SearchOpen['kind'];
  result_id: string;
  result_position: number;
};

export type SearchOpenLogInput = {
  open: SearchOpen;
  /** The rate-limit key the adapter computed, as `/api/search` computes it: the user id, or the hashed network address. */
  viewerKey: string;
  /** When the request arrived: the row's created_at. */
  requestedAt: Date;
};

export type SearchOpenLogDependencies = {
  createClient: () => SupabaseClient;
  runAfterResponse: RunAfterResponse;
  logEvent?: typeof logBackendEvent;
  env?: Environment;
  keyCache?: SearchDayKeyCache;
};

/** The query as the search row holds it: `/api/search`'s normalizing, then the log's cleaning. */
export function searchOpenLogQuery(query: string): string {
  return sanitizeSearchQuery(normalizeCreatorSearchQuery(query));
}

/** The row for an open, or null when the query is blank after cleaning. */
export function buildSearchResultOpenRow(
  input: SearchOpenLogInput,
  dayKey: string | null,
): SearchResultOpenRow | null {
  const query = searchOpenLogQuery(input.open.query);
  if (!query) return null;
  return {
    created_at: input.requestedAt.toISOString(),
    query,
    search_type: input.open.type,
    sort: publicSearchTypeHasSorts(input.open.type) ? input.open.sort : null,
    entry: input.open.entry,
    visitor_day: searchVisitorDay(dayKey, input.viewerKey),
    result_kind: input.open.kind,
    result_id: input.open.id,
    result_position: input.open.position,
  };
}

/**
 * Schedules the row of an opened result behind the response. Returns at once and never throws: the
 * key read and the insert run in `runAfterResponse`, and an error from them, from building the
 * client or from the scheduler itself goes to the log, with neither the query nor the id.
 */
export function recordSearchOpen(
  dependencies: SearchOpenLogDependencies,
  input: SearchOpenLogInput,
): void {
  const logEvent = dependencies.logEvent ?? logBackendEvent;
  const failed = (error: unknown) => {
    logEvent('warn', 'search_open_log_failed', { error });
  };
  try {
    if (isSearchQueryLogDisabled(dependencies.env)) return;
    if (!searchOpenLogQuery(input.open.query)) return;
    dependencies.runAfterResponse(async () => {
      try {
        const client = dependencies.createClient();
        const day = input.requestedAt.toISOString().slice(0, 10);
        const dayKey = await readSearchDayKey(client, day, dependencies.keyCache);
        const row = buildSearchResultOpenRow(input, dayKey);
        if (!row) return;
        const { error } = await client.from(SEARCH_RESULT_OPENS_TABLE).insert(row);
        if (error) failed(error);
      } catch (error) {
        failed(error);
      }
    });
  } catch (error) {
    failed(error);
  }
}
