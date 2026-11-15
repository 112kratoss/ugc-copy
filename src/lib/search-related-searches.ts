import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { logBackendEvent } from '@/lib/backend-logger';

import {
  SEARCH_RELATED_SEARCHES_MAX,
  type SearchRelatedSearch,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

export type { SearchRelatedSearch };

type Environment = Record<string, string | undefined>;

/**
 * `SEARCH_RELATED_SEARCHES_DISABLED=1` (or `true`) is the kill switch, read
 * on every search: `/api/search` then answers no related searches whatever a
 * client asks, with no database call for them
 * (docs/production-deployment-runbook.md, "Search Suggestions").
 */
export function isSearchRelatedSearchesDisabled(env: Environment = process.env): boolean {
  const value = env.SEARCH_RELATED_SEARCHES_DISABLED?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

export type RelatedSearchesOptions = {
  /** The query as the request normalised it. */
  query: string;
  /** The query as the spelling correction read it for the posts, or null. */
  correctedQuery: string | null;
  /** The posts of the result page, as the ranked read returned them. */
  postIds: string[];
  viewerUserId: string | null;
};

/**
 * Related searches for a result page: one call to `search_related_searches`
 * (migration `20261115105944_search_content_suggestions.sql`), which reads
 * each post again as search reads one for this viewer (a search document,
 * unlabelled, neither side of a block) and answers the phrases, and at most
 * two model or tool names, that two of them hold; never the query or its
 * corrected reading. So nothing a visitor cannot see decides one, and each
 * finds at least two posts.
 *
 * They are an extra beside the results: a read that fails answers none, with
 * a line in the log, and the search stands without them.
 */
export async function findRelatedSearches(
  client: SupabaseClient,
  options: RelatedSearchesOptions,
  dependencies: { logEvent: typeof logBackendEvent },
): Promise<SearchRelatedSearch[]> {
  if (options.postIds.length === 0) return [];
  try {
    const { data, error } = await client.rpc('search_related_searches', {
      p_query: options.query,
      p_viewer_user_id: options.viewerUserId,
      p_post_ids: options.postIds,
      p_corrected_query: options.correctedQuery,
      p_limit: SEARCH_RELATED_SEARCHES_MAX,
    });
    if (error) throw error;
    const searches: SearchRelatedSearch[] = [];
    for (const row of Array.isArray(data) ? data : []) {
      const text = (row as { related?: unknown } | null)?.related;
      if (typeof text === 'string' && text.trim()) searches.push({ text: text.trim() });
      if (searches.length === SEARCH_RELATED_SEARCHES_MAX) break;
    }
    return searches;
  } catch (error) {
    dependencies.logEvent('warn', 'public_search_related_searches_failed', { error });
    return [];
  }
}
