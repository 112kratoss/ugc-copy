import 'server-only';

import { entityResult } from '@/lib/public-search-service';
import {
  SEARCH_STARTER_CREATOR_LIMIT,
  SEARCH_STARTER_ENTITY_LIMIT,
  SEARCH_STARTER_MAX_TERMS,
  SEARCH_STARTER_SEARCH_LIMIT,
  SEARCH_STARTER_SUGGESTED_SEARCHES,
  type SearchStarterCreator,
  type SearchStarterEntity,
  type SearchStarterResponse,
  type SearchStarterSearch,
} from '@/lib/search-starter';
import { createServiceClient } from '@/lib/server-helpers';

type SearchStarterServiceDependencies = {
  createServiceClient?: typeof createServiceClient;
  /** The hand-picked searches; SEARCH_STARTER_SUGGESTED_SEARCHES by default. */
  suggestedSearches?: readonly string[];
};

export type SearchStarterOptions = {
  /** The verified viewer, a guest included, or null for a visitor with no token. */
  viewerUserId: string | null;
};

const UNEXPECTED_ANSWER = 'search_starter returned an unexpected answer.';

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
function entityFromRow(row: unknown): SearchStarterEntity {
  if (
    !isRecord(row)
    || !isText(row.query)
    || !row.query.trim()
    || !(row.kind === 'model' || row.kind === 'tool')
    || !isText(row.key)
    || !isText(row.label)
    || typeof row.post_count !== 'number'
    || !Number.isFinite(row.post_count)
    || typeof row.post_count_capped !== 'boolean'
  ) {
    throw new Error(UNEXPECTED_ANSWER);
  }
  // Named as full search names it (a model made here by its catalog name),
  // and searched by the query the database counted, which can differ from
  // that name: the name is drawn, the query is sent.
  return {
    ...entityResult({
      kind: row.kind,
      key: row.key,
      label: row.label,
      post_count: row.post_count,
      post_count_capped: row.post_count_capped,
    }),
    query: row.query,
  };
}

function creatorFromRow(row: unknown): SearchStarterCreator {
  if (
    !isRecord(row)
    || !isText(row.id)
    || !isText(row.username)
    || !isText(row.display_name)
    || !(row.bio === null || typeof row.bio === 'string')
    || !(row.avatar_url === null || typeof row.avatar_url === 'string')
    || typeof row.public_post_count !== 'number'
    || !Number.isFinite(row.public_post_count)
    || typeof row.is_following !== 'boolean'
  ) {
    throw new Error(UNEXPECTED_ANSWER);
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    publicPostCount: Math.max(0, row.public_post_count),
    isFollowing: row.is_following,
  };
}

function searchFromRow(row: unknown): SearchStarterSearch {
  if (!isRecord(row) || !isText(row.text)) throw new Error(UNEXPECTED_ANSWER);
  return { text: row.text };
}

/**
 * The starter read: one call to `search_starter`, which leaves out, in the
 * database and before its limits, everything the lists must never show: a
 * guest, a suspended or deleting account, either side of a block with the
 * viewer, a creator the viewer follows and the viewer; a model or tool one
 * creator alone uses or whose name holds a withdrawn word; a search that
 * finds no post this viewer may see or holds a withdrawn word. Labelled,
 * private and hidden posts count for nothing.
 */
export async function getSearchStarter(
  options: SearchStarterOptions,
  dependencyOverrides?: SearchStarterServiceDependencies,
): Promise<SearchStarterResponse> {
  const client = (dependencyOverrides?.createServiceClient ?? createServiceClient)();
  const terms = (dependencyOverrides?.suggestedSearches ?? SEARCH_STARTER_SUGGESTED_SEARCHES)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, SEARCH_STARTER_MAX_TERMS);
  const { data, error } = await client.rpc('search_starter', {
    p_viewer_user_id: options.viewerUserId,
    p_terms: terms,
    p_entity_limit: SEARCH_STARTER_ENTITY_LIMIT,
    p_creator_limit: SEARCH_STARTER_CREATOR_LIMIT,
    p_search_limit: SEARCH_STARTER_SEARCH_LIMIT,
  });
  if (error) throw error;
  if (
    !isRecord(data)
    || !Array.isArray(data.entities)
    || !Array.isArray(data.creators)
    || !Array.isArray(data.searches)
  ) {
    throw new Error(UNEXPECTED_ANSWER);
  }

  return {
    // The caps are the database's too; held here so the answer's size never
    // rests on one side alone.
    entities: data.entities.slice(0, SEARCH_STARTER_ENTITY_LIMIT).map(entityFromRow),
    creators: data.creators.slice(0, SEARCH_STARTER_CREATOR_LIMIT).map(creatorFromRow),
    searches: data.searches.slice(0, SEARCH_STARTER_SEARCH_LIMIT).map(searchFromRow),
  };
}
