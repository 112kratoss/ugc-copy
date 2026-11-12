import 'server-only';

import type { SearchEntityResult } from '@/lib/public-search';
import { entityResult } from '@/lib/public-search-service';
import {
  SEARCH_SUGGEST_MAX_COMPLETIONS,
  SEARCH_SUGGEST_MAX_CREATORS,
  SEARCH_SUGGEST_MAX_ENTITIES,
  type SearchSuggestCompletion,
  type SearchSuggestCreator,
  type SearchSuggestResponse,
} from '@/lib/search-suggest';
import { createServiceClient } from '@/lib/server-helpers';

type SearchSuggestServiceDependencies = {
  createServiceClient?: typeof createServiceClient;
};

export type SearchSuggestOptions = {
  /** The query as it was sent, trimmed: echoed back. */
  query: string;
  /** The query as searchSuggestQuery read it. */
  normalizedQuery: string;
  handlesOnly: boolean;
  /** The verified viewer, a guest included, or null for a visitor with no token. */
  viewerUserId: string | null;
};

const UNEXPECTED_ANSWER = 'search_suggestions returned an unexpected answer.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The database's rows, held to their shape. A row that does not have it is a
 * migration and this file out of step, which must be seen as a failure, not
 * drawn as a creator with no handle or served as an empty list.
 */
function creatorFromRow(row: unknown): SearchSuggestCreator {
  if (
    !isRecord(row)
    || !isText(row.id)
    || !isText(row.username)
    || !isText(row.display_name)
    || !(row.avatar_url === null || typeof row.avatar_url === 'string')
    || typeof row.is_following !== 'boolean'
  ) {
    throw new Error(UNEXPECTED_ANSWER);
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isFollowing: row.is_following,
  };
}

/**
 * A model or tool, named as full search names it (entityResult: a model made
 * here by its catalog name, anything else by the name its posts print), so a
 * row in the box and the result it opens read the same.
 */
function entityFromRow(row: unknown): SearchEntityResult {
  if (
    !isRecord(row)
    || !(row.kind === 'model' || row.kind === 'tool')
    || !isText(row.key)
    || !isText(row.label)
    || typeof row.post_count !== 'number'
    || !Number.isFinite(row.post_count)
    || typeof row.post_count_capped !== 'boolean'
  ) {
    throw new Error(UNEXPECTED_ANSWER);
  }
  return entityResult({
    kind: row.kind,
    key: row.key,
    label: row.label,
    post_count: row.post_count,
    post_count_capped: row.post_count_capped,
  });
}

function completionFromRow(row: unknown): SearchSuggestCompletion {
  if (!isRecord(row) || !isText(row.text)) throw new Error(UNEXPECTED_ANSWER);
  return { text: row.text };
}

/**
 * The typeahead read: one call to `search_suggestions`, which leaves out, in
 * the database and before its limits, everyone and everything a suggestion
 * must never show (a guest, a suspended or deleting account, either side of a
 * block with the viewer; a word fewer than two creators write, or one only a
 * labelled, private or hidden post or a paid recipe's locked text holds; a
 * model or tool no post the viewer may see names, or only one creator uses).
 *
 * Unlike searchPublicContent this makes no second pass over blocks: the
 * function reads them in the statement that picks the creators, and a block
 * made in the milliseconds after it is shown by the next keystroke's answer.
 */
export async function suggestSearch(
  options: SearchSuggestOptions,
  dependencyOverrides?: SearchSuggestServiceDependencies,
): Promise<SearchSuggestResponse> {
  const client = (dependencyOverrides?.createServiceClient ?? createServiceClient)();
  const { data, error } = await client.rpc('search_suggestions', {
    p_query: options.normalizedQuery,
    p_viewer_user_id: options.viewerUserId,
    p_handles_only: options.handlesOnly,
    p_creator_limit: SEARCH_SUGGEST_MAX_CREATORS,
    p_completion_limit: SEARCH_SUGGEST_MAX_COMPLETIONS,
  });
  if (error) throw error;
  if (!isRecord(data) || !Array.isArray(data.creators) || !Array.isArray(data.completions)) {
    throw new Error(UNEXPECTED_ANSWER);
  }
  // A database from before 20261112192423 answers no `entities`: none are
  // offered. One that answers them answers a list.
  if (data.entities !== undefined && !Array.isArray(data.entities)) throw new Error(UNEXPECTED_ANSWER);
  const entityRows = (data.entities ?? []) as unknown[];

  return {
    query: options.query,
    normalizedQuery: options.normalizedQuery,
    // The caps are the database's too; held here so the answer's size never
    // rests on one side alone.
    creators: data.creators.slice(0, SEARCH_SUGGEST_MAX_CREATORS).map(creatorFromRow),
    entities: entityRows.slice(0, SEARCH_SUGGEST_MAX_ENTITIES).map(entityFromRow),
    completions: data.completions.slice(0, SEARCH_SUGGEST_MAX_COMPLETIONS).map(completionFromRow),
  };
}
