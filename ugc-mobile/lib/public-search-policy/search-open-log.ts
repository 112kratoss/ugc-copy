/**
 * What the search log is told beside the query (search benchmark 2026-11-15,
 * gap 4): how a search was entered, and which result was opened from it. One
 * copy of the names and of the two wire formats, read by the server
 * (`src/lib/public-search-route-adapter-service.ts`,
 * `src/lib/search-opened-route-adapter-service.ts`), the web's search page and
 * the app's search overlay.
 *
 *   - `entry` on `GET /api/search`: one of SEARCH_ENTRIES. Left out, the
 *     search is logged with none (every client installed before this). Any
 *     other value is a 400.
 *   - `POST /api/search/opened`: the body of `searchOpenBody`. Answered 204
 *     with no body whether or not the id names anything, so the route says
 *     nothing about what exists or may be seen.
 *
 * Neither holds a person: the server keys both rows on the per-day visitor
 * code it already makes for the search log, which is how an open is tied to
 * its search within a day and to nothing else.
 *
 * Metro, Next.js and Vitest all compile this file, so it stays free of React
 * Native, Expo and Node imports (see this folder's tsconfig.json).
 */

import { parseSearchEntityId, searchEntityId, type SearchTabId } from './public-search-policy';

// ─── How a search was entered ────────────────────────────────────────────────

/**
 * How a search was started:
 *
 *   typed       the Search key, Enter, or live typing;
 *   suggestion  a completion row of the typeahead;
 *   entity      a model or tool row (typeahead, start screen or results);
 *   recent      a recent search;
 *   starter     a start-screen row or chip that is not a model or tool;
 *   related     a related-search chip;
 *   link        an address or a deep link the screen was opened on.
 *
 * An entry belongs to the query, not to the request: it stays the same while
 * the person changes tab, order or filters or pages on, and is replaced only
 * when the query changes by another road. A query edited by hand is `typed`
 * again, whatever it started as. "Search instead for …" is the same query
 * read another way, so it keeps the entry the query has: it was a value of
 * its own (`correction`) until the review of #826 found that no search row
 * could ever hold it, since a search read as typed writes none.
 */
export const SEARCH_ENTRIES = [
  'typed', 'suggestion', 'entity', 'recent', 'starter', 'related', 'link',
] as const;
export type SearchEntry = (typeof SEARCH_ENTRIES)[number];

/** The request parameter of `GET /api/search` and the body field of an open. */
export const SEARCH_ENTRY_PARAM = 'entry';

export function isSearchEntry(value: unknown): value is SearchEntry {
  return typeof value === 'string' && (SEARCH_ENTRIES as readonly string[]).includes(value);
}

export type SearchEntryReading = { ok: true; entry: SearchEntry | null } | { ok: false };

/** A request's entry: none when left out, refused when it is not one of the list. */
export function readSearchEntry(raw: unknown): SearchEntryReading {
  if (raw === null || raw === undefined) return { ok: true, entry: null };
  return isSearchEntry(raw) ? { ok: true, entry: raw } : { ok: false };
}

/** The parameter a search request carries its entry in; nothing without one. */
export function searchEntryParams(entry: SearchEntry | null | undefined): Record<string, string> {
  return entry ? { [SEARCH_ENTRY_PARAM]: entry } : {};
}

/**
 * The entry of a search started by choosing a text from the typeahead: `typed`
 * when it is the text already in the box (the "Search for …" row), `recent`
 * when this device's recent searches hold it, else `suggestion`. The texts are
 * compared as the server reads a query (NFKC, one space between words) and
 * without case: a row's text is normalized that way, the box holds what was
 * typed, and a full-width "ｎｅｏｎ" is the same search as its row's "neon".
 */
export function searchEntryForChosenText(
  chosen: string,
  typed: string,
  recents: readonly string[],
): SearchEntry {
  const fold = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const text = fold(chosen);
  if (text === fold(typed)) return 'typed';
  return recents.some((recent) => fold(recent) === text) ? 'recent' : 'suggestion';
}

// ─── An opened result ────────────────────────────────────────────────────────

export const SEARCH_OPENED_PATH = '/api/search/opened';

/** What can be opened from a search: a post, a creator, a recipe, or a model or tool row. */
export const SEARCH_OPEN_KINDS = ['post', 'creator', 'recipe', 'entity'] as const;
export type SearchOpenKind = (typeof SEARCH_OPEN_KINDS)[number];

/** Places are 1-based and kept to this: a result pressed further down is logged at it. */
export const SEARCH_OPEN_MAX_POSITION = 500;

const SEARCH_OPEN_TABS: readonly SearchTabId[] = ['top', 'creators', 'posts', 'recipes'];
const SEARCH_OPEN_SORTS = ['top', 'latest'] as const;
export type SearchOpenSort = (typeof SEARCH_OPEN_SORTS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEARCH_OPEN_QUERY_MAX_LENGTH = 100;

export interface SearchOpen {
  /** The query as it was sent to `/api/search`: the server cleans it as it cleaned that one. */
  query: string;
  /** The tab the result was pressed on. */
  type: SearchTabId;
  /** The order the list was in; read only for Posts and Recipes. */
  sort: SearchOpenSort;
  /** The search's entry, or null when the client knows none. */
  entry: SearchEntry | null;
  kind: SearchOpenKind;
  /** A post's, creator's or recipe's id; an entity's `model:<key>` or `tool:<key>`. */
  id: string;
  /**
   * Its 1-based place in the list it was pressed in: the section's own list on
   * Top (the third post is 3 whatever stands above the posts), the whole list
   * on a tab, counted across the pages loaded.
   */
  position: number;
}

/** An opened result's id as the log keeps it, or null when it could not be one. */
function searchOpenId(kind: SearchOpenKind, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  if (kind === 'entity') {
    const entity = parseSearchEntityId(id);
    return entity ? searchEntityId(entity) : null;
  }
  const lowered = id.toLowerCase();
  return UUID.test(lowered) ? lowered : null;
}

export type SearchOpenBody = {
  q: string;
  type: SearchTabId;
  sort: SearchOpenSort;
  entry?: SearchEntry;
  kind: SearchOpenKind;
  id: string;
  position: number;
};

/**
 * The body a client posts for an opened result, or null when there is nothing
 * to report (no query, an id that is not one, a place that is not a number):
 * a client never sends what the server would refuse.
 */
export function searchOpenBody(open: SearchOpen): SearchOpenBody | null {
  const query = open.query.trim();
  if (!query) return null;
  const id = searchOpenId(open.kind, open.id);
  if (!id) return null;
  if (!Number.isFinite(open.position) || open.position < 1) return null;
  return {
    q: query,
    type: open.type,
    sort: open.sort,
    ...(open.entry ? { [SEARCH_ENTRY_PARAM]: open.entry } : {}),
    kind: open.kind,
    id,
    position: Math.min(Math.floor(open.position), SEARCH_OPEN_MAX_POSITION),
  };
}

export type SearchOpenBodyReading =
  | { ok: true; open: SearchOpen }
  | { ok: false; error: string };

/**
 * The server's reading of that body. It asks only whether the body is
 * well-formed, never whether the id names anything: a refusal here says the
 * request was malformed and nothing else.
 */
export function readSearchOpenBody(body: unknown): SearchOpenBodyReading {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'The body must be a JSON object.' };
  }
  const record = body as Record<string, unknown>;

  if (typeof record.q !== 'string' || !record.q.trim()) return { ok: false, error: 'q is required.' };
  if (Array.from(record.q.normalize('NFKC').trim().replace(/\s+/g, ' ')).length > SEARCH_OPEN_QUERY_MAX_LENGTH) {
    return { ok: false, error: `q must be at most ${SEARCH_OPEN_QUERY_MAX_LENGTH} characters.` };
  }

  const type = record.type === undefined || record.type === null
    ? 'top'
    : SEARCH_OPEN_TABS.find((tab) => tab === record.type);
  if (!type) return { ok: false, error: 'type must be top, creators, posts, or recipes.' };

  const sort = record.sort === undefined || record.sort === null
    ? 'top'
    : SEARCH_OPEN_SORTS.find((item) => item === record.sort);
  if (!sort) return { ok: false, error: 'sort must be top or latest.' };

  const entry = readSearchEntry(record[SEARCH_ENTRY_PARAM]);
  if (!entry.ok) return { ok: false, error: `${SEARCH_ENTRY_PARAM} must be one of ${SEARCH_ENTRIES.join(', ')}.` };

  const kind = SEARCH_OPEN_KINDS.find((item) => item === record.kind);
  if (!kind) return { ok: false, error: `kind must be one of ${SEARCH_OPEN_KINDS.join(', ')}.` };

  const id = searchOpenId(kind, record.id);
  if (!id) {
    return {
      ok: false,
      error: kind === 'entity' ? 'id must be model:<key> or tool:<key>.' : 'id must be a UUID.',
    };
  }

  if (typeof record.position !== 'number' || !Number.isInteger(record.position) || record.position < 1) {
    return { ok: false, error: 'position must be a whole number, 1 or more.' };
  }

  return {
    ok: true,
    open: {
      query: record.q,
      type,
      sort,
      entry: entry.entry,
      kind,
      id,
      position: Math.min(record.position, SEARCH_OPEN_MAX_POSITION),
    },
  };
}
