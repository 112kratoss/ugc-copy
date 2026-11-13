/**
 * Search before anything is typed (`GET /api/search/starter`): what both
 * search screens can show under the empty box, and on a search that finds
 * nothing (search UX audit 2026-11-13, findings 2 and 8). Three short lists
 * from one public read:
 *
 *   - Popular models and tools: the models and tools most used in the newest
 *     public posts, each counted as Posts narrowed to it counts it;
 *   - Creators to follow: accounts that posted publicly in the last 30 days,
 *     the most active first, then the most followed;
 *   - Try searching for: a hand-picked list of plain searches (kept in
 *     `src/lib/search-starter.ts`), each offered only while it finds a post.
 *
 * The answer's shape, its caps, the section headings and order, what a row
 * does, and a reader that turns any body into an answer a client may draw.
 * The web's search page and the app's search screen draw it; the server
 * reads the shape and the caps from here. Metro, Next.js and Vitest all
 * compile this file, so it stays free of React Native, Expo and Node imports
 * (see this folder's tsconfig.json), and of `\p{…}` in a regular expression.
 */
import {
  SEARCH_ENTITY_KINDS,
  searchEntityId,
  type SearchEntity,
  type SearchEntityKind,
} from './public-search-policy';

// ─── The answer ──────────────────────────────────────────────────────────────

/** The most each list of an answer holds: the server's caps, and what a client draws at most. */
export const SEARCH_STARTER_MAX_ENTITIES = 8;
export const SEARCH_STARTER_MAX_CREATORS = 6;
export const SEARCH_STARTER_MAX_SEARCHES = 8;

/** A creator, in the shape a search's creator result has. */
export interface SearchStarterCreator {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  /** Their public posts, as a creator search result counts them. */
  publicPostCount: number;
  /** Always false: a creator the viewer follows is not offered. Kept so the shape is a search result's. */
  isFollowing: boolean;
}

/** A search to offer: the text to put in the box and search for. */
export interface SearchStarterSearch {
  text: string;
}

export interface SearchStarterResponse {
  /** Models and tools, as a search result names them, most posts first. */
  entities: SearchEntity[];
  /** In the order to show them. */
  creators: SearchStarterCreator[];
  /** In the order to show them. */
  searches: SearchStarterSearch[];
}

/** The answer of a server that offers nothing (switched off, or nothing to offer yet). */
export const SEARCH_STARTER_EMPTY_RESPONSE: SearchStarterResponse = Object.freeze({
  entities: [],
  creators: [],
  searches: [],
}) as SearchStarterResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readEntity(value: unknown): SearchEntity | null {
  if (
    !isRecord(value)
    || !SEARCH_ENTITY_KINDS.includes(value.kind as SearchEntityKind)
    || !isText(value.key)
    || !isText(value.label)
    || typeof value.postCount !== 'number'
    || !Number.isFinite(value.postCount)
  ) {
    return null;
  }
  return {
    kind: value.kind as SearchEntityKind,
    key: value.key,
    label: value.label,
    postCount: Math.max(0, Math.floor(value.postCount)),
    postCountCapped: value.postCountCapped === true,
  };
}

function readCreator(value: unknown): SearchStarterCreator | null {
  if (!isRecord(value) || !isText(value.id) || !isText(value.username) || !isText(value.displayName)) return null;
  return {
    id: value.id,
    username: value.username,
    displayName: value.displayName,
    bio: typeof value.bio === 'string' && value.bio ? value.bio : null,
    avatarUrl: typeof value.avatarUrl === 'string' && value.avatarUrl ? value.avatarUrl : null,
    publicPostCount: typeof value.publicPostCount === 'number' && Number.isFinite(value.publicPostCount)
      ? Math.max(0, Math.floor(value.publicPostCount))
      : 0,
    isFollowing: value.isFollowing === true,
  };
}

function readSearch(value: unknown): SearchStarterSearch | null {
  return isRecord(value) && isText(value.text) && value.text.trim() ? { text: value.text.trim() } : null;
}

function readList<T>(value: unknown, read: (item: unknown) => T | null, limit: number): T[] {
  if (!Array.isArray(value)) return [];
  const items: T[] = [];
  for (const item of value) {
    const row = read(item);
    if (row) items.push(row);
    if (items.length === limit) break;
  }
  return items;
}

/**
 * An answer as a client may draw it, or null for anything that is not one: a
 * failure's body, a rate limit's, another route's answer. The starter is an
 * extra, so a client draws what cannot be read as nothing, never as an
 * error. A row that is not whole is left out, and a missing list is empty.
 */
export function parseSearchStarterResponse(value: unknown): SearchStarterResponse | null {
  if (!isRecord(value) || !('entities' in value || 'creators' in value || 'searches' in value)) return null;
  return {
    entities: readList(value.entities, readEntity, SEARCH_STARTER_MAX_ENTITIES),
    creators: readList(value.creators, readCreator, SEARCH_STARTER_MAX_CREATORS),
    searches: readList(value.searches, readSearch, SEARCH_STARTER_MAX_SEARCHES),
  };
}

/** Whether an answer has nothing to draw: a client then shows what it showed before the starter. */
export function isSearchStarterEmpty(answer: SearchStarterResponse | null | undefined): boolean {
  return !answer || (answer.entities.length === 0 && answer.creators.length === 0 && answer.searches.length === 0);
}

// ─── Sections ────────────────────────────────────────────────────────────────

/** The sections, in the order they are drawn (under any recent searches, which stay on top). */
export const SEARCH_STARTER_SECTION_IDS = ['entities', 'creators', 'searches'] as const;
export type SearchStarterSectionId = (typeof SEARCH_STARTER_SECTION_IDS)[number];

export const SEARCH_STARTER_HEADINGS: Readonly<Record<SearchStarterSectionId, string>> = Object.freeze({
  entities: 'Popular models and tools',
  creators: 'Creators to follow',
  searches: 'Try searching for',
});

/** The label of the whole starter, for a screen reader's region. */
export const SEARCH_STARTER_LABEL = 'Ideas to start a search';

/** The heading over the starter on a search that found nothing (finding 8). */
export const SEARCH_STARTER_NO_RESULTS_HEADING = 'Try one of these instead';

export type SearchStarterSection =
  | { id: 'entities'; heading: string; entities: SearchEntity[] }
  | { id: 'creators'; heading: string; creators: SearchStarterCreator[] }
  | { id: 'searches'; heading: string; searches: SearchStarterSearch[] };

/** The sections an answer fills, in order; an empty list has no section. */
export function searchStarterSections(answer: SearchStarterResponse | null | undefined): SearchStarterSection[] {
  if (!answer) return [];
  const sections: SearchStarterSection[] = [];
  if (answer.entities.length) sections.push({ id: 'entities', heading: SEARCH_STARTER_HEADINGS.entities, entities: answer.entities });
  if (answer.creators.length) sections.push({ id: 'creators', heading: SEARCH_STARTER_HEADINGS.creators, creators: answer.creators });
  if (answer.searches.length) sections.push({ id: 'searches', heading: SEARCH_STARTER_HEADINGS.searches, searches: answer.searches });
  return sections;
}

// ─── What a row does ─────────────────────────────────────────────────────────

export type SearchStarterAction =
  /** Open the creator's profile. */
  | { type: 'creator'; username: string }
  /**
   * Search the entity's name on Posts, narrowed to it (`madeWith`): every
   * post the entity's count counted, since a post's document holds the
   * names it is made with.
   */
  | { type: 'entity'; entity: SearchEntity; query: string; madeWith: string }
  /** Put the text in the box and search for it. */
  | { type: 'search'; query: string };

export function searchStarterEntityAction(entity: SearchEntity): SearchStarterAction {
  return { type: 'entity', entity, query: entity.label, madeWith: searchEntityId(entity) };
}

export function searchStarterCreatorAction(creator: SearchStarterCreator): SearchStarterAction {
  return { type: 'creator', username: creator.username };
}

export function searchStarterSearchAction(search: SearchStarterSearch): SearchStarterAction {
  return { type: 'search', query: search.text };
}
