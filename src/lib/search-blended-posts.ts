import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendEvent } from '@/lib/backend-logger';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import type { PublicSearchCursor, PublicSearchFilters } from '@/lib/public-search';
import {
  SEARCH_EMBEDDING_MODEL,
  type RelatedPostsDependencies,
  findSearchQueryEmbedding,
  isSearchSemanticDisabled,
  normalizeSearchQueryForEmbedding,
  searchEmbeddingLiteral,
  searchQueryEmbeddingHash,
} from '@/lib/search-embeddings';

import {
  readSearchMatchedBy,
  type SearchMatchSource,
} from '../../ugc-mobile/lib/public-search-policy/search-blend';

/**
 * The blended Posts order (hybrid ranking): the server half of `blend=1`.
 *
 * `search_blended_posts` (migration `20261115130046_search_blended_posts.sql`) merges two
 * lists by reciprocal rank fusion: the word list, which is
 * `search_public_posts` itself, and the meaning list, the posts nearest the
 * query's vector over `post_search_embeddings` (public text only). This file
 * decides when it is called and with which vector, and answers `null`
 * whenever the blend cannot be made, so the caller reads the word order as it
 * always has.
 *
 * A first page costs one database call when the query's vector is in the
 * cache: the function reads the cache itself, by the hash sent with the
 * query. When it is not, the function answers that page in the word order and
 * says so (`no_vector`); the vector is then asked for under the same
 * allowance, cap and kill switch as related posts
 * (`findSearchQueryEmbedding`), waited on for a bounded time, and the
 * function called once more with it. Past the bound the word-order page
 * already in hand is the answer.
 *
 * A later page is blended only from a cursor that carries a place in the
 * window (`PublicSearchCursor.window`) and only from the cache: nothing is
 * embedded for a page. Without the vector the caller continues in the word
 * order from the cursor's floor (from its top without one), which passes
 * over no post that holds the words and can repeat posts already shown.
 *
 * THE CONTRACT OF A LATER PAGE, blended or not: it may hold a post an earlier
 * page already showed, and it never skips a post where that can be avoided.
 * A client leaves out, by id, the posts it has shown
 * (`withoutShownSearchPosts`, search-blend.ts).
 */

/** A row of `search_blended_posts`: a post search row, and where it stands in the blended list. */
export type BlendedPostRow = {
  post_id: string;
  creator_user_id: string;
  /** The word score; null for a post only the meaning list holds. */
  search_score: number | null;
  created_at: string;
  corrected_query: string | null;
  /** `fused`: blended. `no_vector`, `corrected`: the word order, unblended. */
  blend_state: 'fused' | 'no_vector' | 'corrected';
  matched_by: SearchMatchSource;
  /** The row's place in the list, from 1. */
  blend_position: number;
  /** Inside the blended window; past it the list is the word order. */
  in_window: boolean;
  /**
   * The last row of the unbroken run of the word order shown up to this
   * one: where the word order continues from if the blend cannot, passing
   * over no post that holds the words (it can repeat ones shown from further
   * down). Null while the first row of the word order is still to come, or
   * no post holds the words: the word order then starts from its top.
   */
  floor_score: number | null;
  floor_post_id: string | null;
};

type Environment = Record<string, string | undefined>;

export type BlendedPostsDependencies = {
  env?: Environment;
  findSearchQueryEmbedding?: typeof findSearchQueryEmbedding;
  logEvent?: typeof logBackendEvent;
  runAfterResponse?: RunAfterResponse;
  /**
   * What the vector's lookup takes: the request's one lookup of query
   * vectors (`queryVectors`), shared with related posts so a search is
   * counted and embedded once, and the function, limits and timers a test
   * replaces.
   */
  queryVector?: RelatedPostsDependencies;
};

export type BlendedPostsInput = {
  /** The query as the posts search takes it (normalised). */
  query: string;
  viewerUserId: string | null;
  viewerKey: string;
  guestNetworkKey: string | null;
  /** The instant the search is scored at. */
  asOf: Date;
  /** The cursor of a later page; null for the first. */
  after: PublicSearchCursor | null;
  /** Rows to read: the page and one more. */
  limit: number;
  filters: PublicSearchFilters;
};

const BLEND_STATES = new Set(['fused', 'no_vector', 'corrected']);

function blendedRows(data: unknown): BlendedPostRow[] {
  return ((Array.isArray(data) ? data : []) as Array<Record<string, unknown>>).flatMap((row) => {
    const matchedBy = readSearchMatchedBy(row.matched_by);
    if (
      typeof row.post_id !== 'string'
      || typeof row.creator_user_id !== 'string'
      || typeof row.created_at !== 'string'
      || typeof row.blend_state !== 'string'
      || !BLEND_STATES.has(row.blend_state)
      || matchedBy === null
      || !Number.isInteger(row.blend_position)
    ) {
      return [];
    }
    return [{
      post_id: row.post_id,
      creator_user_id: row.creator_user_id,
      search_score: typeof row.search_score === 'number' ? row.search_score : null,
      created_at: row.created_at,
      corrected_query: typeof row.corrected_query === 'string' && row.corrected_query ? row.corrected_query : null,
      blend_state: row.blend_state as BlendedPostRow['blend_state'],
      matched_by: matchedBy,
      blend_position: row.blend_position as number,
      in_window: row.in_window === true,
      floor_score: typeof row.floor_score === 'number' ? row.floor_score : null,
      floor_post_id: typeof row.floor_post_id === 'string' ? row.floor_post_id : null,
    }];
  });
}

/**
 * A page of the blended list, or `null` when it could not be read and the
 * caller should read the word order instead (`search_public_posts`, from the
 * cursor's floor on a later page). Rows in the states `no_vector` and
 * `corrected` are that word order already: the same rows, in the same order,
 * as `search_public_posts` returns. Never throws.
 */
export async function loadBlendedPostRows(
  client: SupabaseClient,
  input: BlendedPostsInput,
  dependencyOverrides: BlendedPostsDependencies = {},
): Promise<BlendedPostRow[] | null> {
  const logEvent = dependencyOverrides.logEvent ?? logBackendEvent;
  try {
    const env = dependencyOverrides.env ?? process.env;
    // The kill switch of search by meaning covers the blend: no read at all.
    if (isSearchSemanticDisabled(env)) return null;
    const embeddedQuery = normalizeSearchQueryForEmbedding(input.query);
    if (!embeddedQuery) return null;

    const afterPosition = input.after?.window ?? 0;
    const read = async (vector: readonly number[] | null) => {
      const { data, error } = await client.rpc('search_blended_posts', {
        p_query: input.query,
        p_query_hash: searchQueryEmbeddingHash(embeddedQuery),
        p_query_embedding: vector ? searchEmbeddingLiteral(vector) : null,
        p_viewer_user_id: input.viewerUserId,
        p_as_of: input.asOf.toISOString(),
        p_after_position: afterPosition,
        p_limit: input.limit,
        p_made_with: input.filters.madeWith,
        p_media_kind: input.filters.mediaKind,
        p_has_recipe: input.filters.hasRecipe,
        p_followed_only: input.filters.following,
        p_embedding_model: SEARCH_EMBEDDING_MODEL,
        p_after_post_id: input.after?.window !== undefined ? input.after.last ?? null : null,
      });
      if (error) throw error;
      return blendedRows(data);
    };

    const rows = await read(null);
    if (input.after !== null) {
      // A later page is blended from the cache or not at all. No rows is "no
      // vector now" or "nothing left"; the word order from the floor answers
      // both, with the rest of the list or with nothing.
      return rows.length > 0 ? rows : null;
    }
    const state = rows[0]?.blend_state;
    if (state === 'fused' || state === 'corrected') return rows;

    // No vector in the cache (or no word match and no telling): ask for one,
    // within the allowance, the cap and the wait. Without it the page in hand
    // is the answer, in the word order.
    const vector = await (dependencyOverrides.findSearchQueryEmbedding ?? findSearchQueryEmbedding)(
      client,
      { query: input.query, viewerKey: input.viewerKey, guestNetworkKey: input.guestNetworkKey },
      { env, logEvent, runAfterResponse: dependencyOverrides.runAfterResponse, ...dependencyOverrides.queryVector },
    );
    if (!vector) return rows;
    try {
      return await read(vector);
    } catch (error) {
      logEvent('warn', 'public_search_blend_failed', { error });
      return rows;
    }
  } catch (error) {
    logEvent('warn', 'public_search_blend_failed', { error });
    return null;
  }
}

/** Whether a page was blended: its rows come from the merged window, or follow it. */
export function isBlendedPage(rows: readonly BlendedPostRow[] | null): boolean {
  return rows?.[0]?.blend_state === 'fused';
}

/**
 * The place a cursor issued after `last` continues from, `next` being the row
 * after it (the one read past the page). Always the floor, where there is
 * one: the word order continues from it whoever reads the cursor (this server
 * without a vector, or one from before the blend, which ignores the rest).
 * And, while the list is still inside the window, the place in it and the
 * post shown last, by which the next page finds that place again if the
 * window has moved.
 */
export function blendedCursorPlace(
  last: BlendedPostRow,
  next: BlendedPostRow | undefined,
): Pick<PublicSearchCursor, 'score' | 'id' | 'window' | 'last'> {
  return {
    // Both halves or neither, said outright: a cursor is never left the id of
    // a post that has no place in the word order.
    ...(last.floor_score !== null && last.floor_post_id !== null
      ? { score: last.floor_score, id: last.floor_post_id }
      : { score: undefined, id: undefined }),
    ...(next?.in_window ? { window: last.blend_position, last: last.post_id } : {}),
  };
}
