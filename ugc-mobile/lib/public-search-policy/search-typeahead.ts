/**
 * Typeahead: what a search box offers while a person types, before they
 * commit a search (`GET /api/search/suggest`). The rules both search boxes
 * follow, in one copy the web's search page and the app's search overlay
 * share by relative import, and the server reads for the answer's shape and
 * its caps:
 *
 *   - when a request is made (the pause in typing it waits for, what text is
 *     worth asking about) and what is drawn meanwhile (the answer to the text
 *     the box holds now, or, until that arrives, the answer before it, so the
 *     list does not go and come back at every letter; only while the box has
 *     the focus, never once the person has dismissed it or committed the
 *     search), and how long an answer may be kept to draw again;
 *   - the sections and their order: the recent searches the text matches,
 *     creators, models and tools, completions; and where a box offers only
 *     what changes the query (the web's search page, whose own results draw
 *     the creators and the models live);
 *   - what choosing a row does: a creator opens their profile, a model or tool
 *     opens Posts narrowed to it, a completion fills the box and searches;
 *     and when a press on a row counts (not for a moment after the row came
 *     to stand where the press landed: the person aimed at what stood there);
 *   - how the highlight moves under the arrow keys, which part of a row's text
 *     is drawn heavier (what the person has not typed), and the words a screen
 *     reader is told.
 *
 * Each client brings its own timer, request and drawing. Metro, Next.js and
 * Vitest all compile this file, so it stays free of React Native, Expo and
 * Node imports (see this folder's tsconfig.json), and of `\p{…}` in a regular
 * expression, which not every engine it runs on reads.
 */
import {
  SEARCH_ENTITIES_HEADING,
  SEARCH_ENTITY_KINDS,
  SEARCH_RECENTS_HEADING,
  normalizeCreatorSearchQuery,
  normalizeSearchHistoryQuery,
  searchEntityActionLabel,
  searchEntityId,
  searchRecentAgainLabel,
  searchQueryLength,
  type SearchEntity,
  type SearchEntityKind,
} from './public-search-policy';

// ─── The answer ──────────────────────────────────────────────────────────────

/** The most each list of an answer holds: the server's caps, and what a client draws at most. */
export const SEARCH_TYPEAHEAD_MAX_CREATORS = 5;
export const SEARCH_TYPEAHEAD_MAX_ENTITIES = 3;
export const SEARCH_TYPEAHEAD_MAX_COMPLETIONS = 6;

/** What a creator row draws. A subset of a search result's creator, under the same names. */
export interface SearchSuggestCreator {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isFollowing: boolean;
}

/** A query to search for: what was typed, with its last word completed. */
export interface SearchSuggestCompletion {
  text: string;
}

export interface SearchSuggestResponse {
  /** The query as it was sent, trimmed. */
  query: string;
  /** The query as the server read it. */
  normalizedQuery: string;
  /** In the order to show them. */
  creators: SearchSuggestCreator[];
  /** Models and tools, as a search result names them. Empty under three characters and for a query typed as a handle. */
  entities: SearchEntity[];
  /** In the order to show them. Empty for a query typed as a handle. */
  completions: SearchSuggestCompletion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readCreator(value: unknown): SearchSuggestCreator | null {
  if (!isRecord(value) || !isText(value.id) || !isText(value.username) || !isText(value.displayName)) return null;
  return {
    id: value.id,
    username: value.username,
    displayName: value.displayName,
    avatarUrl: typeof value.avatarUrl === 'string' && value.avatarUrl ? value.avatarUrl : null,
    isFollowing: value.isFollowing === true,
  };
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

function readCompletion(value: unknown): SearchSuggestCompletion | null {
  return isRecord(value) && isText(value.text) ? { text: value.text } : null;
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
 * failure's body, a rate limit's, another route's answer. A suggestion is an
 * extra, so what cannot be read is drawn as nothing, never as an error. A row
 * that is not whole is left out; a server from before entities has none.
 */
export function parseSearchSuggestResponse(value: unknown): SearchSuggestResponse | null {
  if (!isRecord(value) || !Array.isArray(value.creators) || !Array.isArray(value.completions)) return null;
  return {
    query: typeof value.query === 'string' ? value.query : '',
    normalizedQuery: typeof value.normalizedQuery === 'string' ? value.normalizedQuery : '',
    creators: readList(value.creators, readCreator, SEARCH_TYPEAHEAD_MAX_CREATORS),
    entities: readList(value.entities, readEntity, SEARCH_TYPEAHEAD_MAX_ENTITIES),
    completions: readList(value.completions, readCompletion, SEARCH_TYPEAHEAD_MAX_COMPLETIONS),
  };
}

// ─── When to ask ─────────────────────────────────────────────────────────────

/**
 * The pause in typing a request waits for. Shorter than the pause full search
 * waits for (300 ms on the web): a suggestion is only worth having ahead of
 * the results. The request before it is aborted, so one is in flight at most.
 */
export const SEARCH_TYPEAHEAD_DEBOUNCE_MS = 140;

/**
 * How long an answer may be kept to draw again without asking (a letter
 * deleted, the same text typed again), and how many. An answer says whom its
 * viewer follows and leaves out whom they are blocked with, and a follow or a
 * block made on another page changes that: so a client keeps answers for one
 * focus of its box only, drops them with the account, and never draws a kept
 * one older than this.
 */
export const SEARCH_TYPEAHEAD_KEPT_ANSWER_MS = 30_000;
export const SEARCH_TYPEAHEAD_KEPT_ANSWERS = 30;

/** Entities are offered from the length Posts are searched from: pressing one opens Posts. */
const SEARCH_TYPEAHEAD_MIN_ENTITY_QUERY_LENGTH = 3;

// C0 and C1 controls and DEL: nothing a person types, and a U+0000 is refused by the database.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * What a box's text asks about: the text as the server reads it (NFKC, one
 * space between words, no control characters), a leading `@` kept, since it
 * says the person wants a handle. Null when there is nothing to ask: an empty
 * box, or an `@` with nothing after it. It is also what an answer is for: a
 * client draws an answer only while this, for the box's text now, is the text
 * it asked with.
 */
export function searchTypeaheadQuery(text: string | null | undefined): string | null {
  const typed = normalizeSearchHistoryQuery((text ?? '').replace(/\s/g, ' ').replace(CONTROL_CHARACTERS, ''));
  return searchQueryLength(normalizeCreatorSearchQuery(typed).trim()) >= 1 ? typed : null;
}

// ─── What is drawn ───────────────────────────────────────────────────────────

export const SEARCH_TYPEAHEAD_SECTION_IDS = ['recents', 'creators', 'entities', 'completions'] as const;
export type SearchTypeaheadSectionId = (typeof SEARCH_TYPEAHEAD_SECTION_IDS)[number];

/**
 * A row. A recent search is a query to put in the box as a completion is, so
 * it is a `completion` row marked `recent` (drawn with a clock): every place
 * that reads a completion's text and action reads a recent search's the same.
 */
export type SearchTypeaheadRow =
  | { kind: 'creator'; key: string; creator: SearchSuggestCreator }
  | { kind: 'entity'; key: string; entity: SearchEntity }
  | { kind: 'completion'; key: string; text: string; recent?: true };

export interface SearchTypeaheadSection {
  id: SearchTypeaheadSectionId;
  heading: string;
  rows: SearchTypeaheadRow[];
}

/** The name of the list, and of each section in it. */
export const SEARCH_TYPEAHEAD_LIST_LABEL = 'Search suggestions';
export const SEARCH_TYPEAHEAD_HEADINGS: Readonly<Record<SearchTypeaheadSectionId, string>> = {
  recents: SEARCH_RECENTS_HEADING,
  creators: 'Creators',
  entities: SEARCH_ENTITIES_HEADING,
  completions: 'Suggested searches',
};

/** The most recent searches a list offers for a text. */
export const SEARCH_TYPEAHEAD_MAX_RECENTS = 3;

/**
 * What a box offers:
 *   - `all`: every kind (the top bar's field, the app's search);
 *   - `query`: only what changes the query, the recent searches the text
 *     matches and the completions. The web's search page draws its own results
 *     live under the box, creators and models first, so a creator or a model
 *     row there would repeat the result drawn under it.
 */
export type SearchTypeaheadOffer = 'all' | 'query';

/** What a list is drawn with besides the server's answer. */
export interface SearchTypeaheadOptions {
  /** This device's recent searches, most recent first, as the client keeps them. */
  recents?: readonly string[];
  offer?: SearchTypeaheadOffer;
}

/** A query folded as rows are compared: lower case, no leading "@" (searchTypeaheadQuery keeps it). */
function foldedQuery(query: string): string {
  return normalizeSearchHistoryQuery(query).toLowerCase();
}

/**
 * The recent searches a text matches, in the order to offer them: the ones
 * that begin with what is typed first, then (from two characters, where one
 * letter would match nearly every search) the ones that hold it anywhere,
 * each group most recent first, at most SEARCH_TYPEAHEAD_MAX_RECENTS. A recent
 * search that is exactly what the box holds is not offered back.
 */
export function searchTypeaheadMatchingRecents(recents: readonly string[], query: string | null): string[] {
  if (query === null) return [];
  const typed = foldedQuery(query);
  if (!typed) return [];
  const beginning: string[] = [];
  const holding: string[] = [];
  const seen = new Set<string>([typed]);
  for (const recent of recents) {
    const text = normalizeSearchHistoryQuery(recent);
    const folded = text.toLowerCase();
    if (!text || seen.has(folded)) continue;
    seen.add(folded);
    if (folded.startsWith(typed)) beginning.push(text);
    else if (searchQueryLength(typed) >= 2 && folded.includes(typed)) holding.push(text);
  }
  return [...beginning, ...holding].slice(0, SEARCH_TYPEAHEAD_MAX_RECENTS);
}

/**
 * The sections an answer is drawn as, in their order, each with at most its
 * cap; a section with no row is left out. `query` is what the box asks about
 * now (searchTypeaheadQuery). The recent searches the text matches come first
 * and need no answer; a completion one of them already offers is not offered
 * twice. Entities are drawn only from three characters and never for a query
 * typed as a handle, whatever an answer carries; a completion that is what the
 * box already holds is not offered back. With `offer: 'query'` only the
 * recent searches and the completions are drawn.
 */
export function searchTypeaheadSections(
  answer: SearchSuggestResponse | null,
  query: string | null,
  { recents = [], offer = 'all' }: SearchTypeaheadOptions = {},
): SearchTypeaheadSection[] {
  if (query === null) return [];
  const asHandle = query.startsWith('@');
  const read = normalizeCreatorSearchQuery(query).trim();
  const typed = read.toLowerCase();
  const entitiesOffered = offer === 'all' && !asHandle && searchQueryLength(read) >= SEARCH_TYPEAHEAD_MIN_ENTITY_QUERY_LENGTH;

  const recentRows: SearchTypeaheadRow[] = searchTypeaheadMatchingRecents(recents, query)
    .map((text) => ({ kind: 'completion' as const, key: `recent:${text.toLowerCase()}`, text, recent: true as const }));

  const seenCompletions = new Set<string>([typed, foldedQuery(query), ...recentRows.map((row) => (row.kind === 'completion' ? row.text.toLowerCase() : ''))]);
  const completions: SearchTypeaheadRow[] = [];
  for (const completion of asHandle || !answer ? [] : answer.completions) {
    const text = normalizeSearchHistoryQuery(completion.text);
    const folded = text.toLowerCase();
    if (!text || seenCompletions.has(folded)) continue;
    seenCompletions.add(folded);
    completions.push({ kind: 'completion', key: `completion:${folded}`, text });
    if (completions.length === SEARCH_TYPEAHEAD_MAX_COMPLETIONS) break;
  }

  const sections: SearchTypeaheadSection[] = [
    { id: 'recents', heading: SEARCH_TYPEAHEAD_HEADINGS.recents, rows: recentRows },
    {
      id: 'creators',
      heading: SEARCH_TYPEAHEAD_HEADINGS.creators,
      rows: (offer === 'all' && answer ? answer.creators : []).slice(0, SEARCH_TYPEAHEAD_MAX_CREATORS)
        .map((creator) => ({ kind: 'creator' as const, key: `creator:${creator.id}`, creator })),
    },
    {
      id: 'entities',
      heading: SEARCH_TYPEAHEAD_HEADINGS.entities,
      rows: (entitiesOffered && answer ? answer.entities : []).slice(0, SEARCH_TYPEAHEAD_MAX_ENTITIES)
        .map((entity) => ({ kind: 'entity' as const, key: `entity:${searchEntityId(entity)}`, entity })),
    },
    { id: 'completions', heading: SEARCH_TYPEAHEAD_HEADINGS.completions, rows: completions },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

/** Every row of the sections, top to bottom: the order the arrow keys walk. */
export function searchTypeaheadRows(sections: readonly SearchTypeaheadSection[]): SearchTypeaheadRow[] {
  return sections.flatMap((section) => section.rows);
}

/** What a request found for a query. A null response is one that failed, was refused or could not be read. */
export interface SearchTypeaheadAnswer {
  query: string;
  response: SearchSuggestResponse | null;
}

// A name's words as a query's are compared with them: lower case, split at anything that is not a letter or a digit.
function foldedWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Whether an entity an earlier answer offered is still one for what the box
 * asks about now: every word typed begins a word of its name or its key.
 * Pressing an entity searches the box's text narrowed to it, so one the text
 * no longer names is not kept on show beside it.
 */
function entityStillNamed(entity: SearchEntity, query: string): boolean {
  const typed = foldedWords(query);
  if (typed.length === 0) return false;
  const named = [...foldedWords(entity.label), ...foldedWords(entity.key)];
  return typed.every((word) => named.some((name) => name.startsWith(word)));
}

/**
 * What is drawn for the answer in hand while the box asks about `query`.
 *
 * The answer to this text is drawn as it is. An answer to an earlier text is
 * kept on show until this text's arrives, `stale`, so that typing "lum" then
 * "lumi" changes the list once, when the new answer lands, and does not take
 * it away and bring it back at every letter. It goes at once when the box is
 * emptied, and when this text's own answer says there is nothing (or failed:
 * a client records a request it could not make as an answer with no response).
 *
 * A stale row must do what it shows whatever the box holds by then: a creator
 * opens that creator and a completion searches its own text, so both are kept
 * as they are; an entity narrows a search for the box's text, so it is kept
 * only while that text still names it. A client marks a stale list busy.
 *
 * The recent searches the text matches (`options.recents`) are this device's
 * own and never stale: they are drawn for the text the box holds now, from the
 * first letter, with or without an answer. `options.offer` says which kinds
 * the box offers (SearchTypeaheadOffer); a list whose answer adds nothing the
 * box offers is not stale.
 */
export function searchTypeaheadDrawn(
  answer: SearchTypeaheadAnswer | null,
  query: string | null,
  options: SearchTypeaheadOptions = {},
): { sections: SearchTypeaheadSection[]; stale: boolean } {
  if (query === null) return { sections: [], stale: false };
  const response = answer?.response ?? null;
  if (!answer || !response || answer.query === query) {
    return { sections: searchTypeaheadSections(answer?.query === query ? response : null, query, options), stale: false };
  }
  const sections = searchTypeaheadSections(
    { ...response, entities: response.entities.filter((entity) => entityStillNamed(entity, query)) },
    query,
    options,
  );
  return { sections, stale: sections.some((section) => section.id !== 'recents') };
}

// ─── Which part of a row is drawn heavier ────────────────────────────────────

/** A run of a row's text: `typed` is what the person typed, drawn plain; the rest is drawn heavier. */
export interface SearchTypeaheadTextRun {
  text: string;
  typed: boolean;
}

/**
 * A completion's or a recent search's text in runs, as Instagram, X and Reddit
 * draw a suggestion: the part the person typed plain, the part they have not
 * typed heavier, so the eye goes to what the row adds. The typed text is found
 * where it first stands in the row, ignoring case; a row that does not hold it
 * (a completion of another word) is all heavier. The row's accessible name is
 * its whole text: this is drawing only.
 */
export function searchTypeaheadTextRuns(text: string, query: string | null): SearchTypeaheadTextRun[] {
  if (!text) return [];
  const typed = query === null ? '' : normalizeSearchHistoryQuery(query).toLowerCase();
  const folded = text.toLowerCase();
  // Lower case can change a string's length (a dotted capital I): then the
  // places found in the folded text are not the text's own, and nothing is marked typed.
  const at = typed && folded.length === text.length ? folded.indexOf(typed) : -1;
  if (at < 0) return [{ text, typed: false }];
  return [
    { text: text.slice(0, at), typed: false },
    { text: text.slice(at, at + typed.length), typed: true },
    { text: text.slice(at + typed.length), typed: false },
  ].filter((run) => run.text.length > 0);
}

/**
 * Whether the list is drawn: only while the box has the focus and asks about
 * something, only with a row to show (searchTypeaheadDrawn: this text's
 * answer, or the one before it until this text's arrives), and not once the
 * person closed it (Escape) or committed the search (Enter, or a row) for this
 * same text: typing again opens it again.
 */
export function isSearchTypeaheadShown(state: {
  focused: boolean;
  /** What the box asks about now (searchTypeaheadQuery of its text). */
  query: string | null;
  /** The query the list was closed for, or null. */
  closedQuery: string | null;
  /** The rows of searchTypeaheadDrawn. */
  rowCount: number;
}): boolean {
  return state.focused
    && state.query !== null
    && state.closedQuery !== state.query
    && state.rowCount > 0;
}

// ─── What a row does ─────────────────────────────────────────────────────────

export type SearchTypeaheadAction =
  /** Open the creator's profile. */
  | { type: 'creator'; username: string }
  /** Open Posts narrowed to the entity and to nothing else, for the query in the box, as pressing an entity result does. */
  | { type: 'entity'; entity: SearchEntity; madeWith: string }
  /** Put the text in the box and search for it. */
  | { type: 'search'; query: string };

export function searchTypeaheadAction(row: SearchTypeaheadRow): SearchTypeaheadAction {
  if (row.kind === 'creator') return { type: 'creator', username: row.creator.username };
  if (row.kind === 'entity') return { type: 'entity', entity: row.entity, madeWith: searchEntityId(row.entity) };
  return { type: 'search', query: row.text };
}

// ─── When a press counts ─────────────────────────────────────────────────────

/**
 * How long a row must have stood in its place before a press on it counts.
 * About the time a person takes to see a change and stop a press already on
 * its way: a press that lands sooner was aimed at what stood there before.
 */
export const SEARCH_TYPEAHEAD_PRESS_SETTLE_MS = 250;

/** Where each drawn row stands, top to bottom, and since when (a clock's milliseconds). */
export type SearchTypeaheadPlacement = ReadonlyMap<string, { index: number; since: number }>;

/**
 * The rows' places after a draw. A list changes under a pointer or a finger
 * while it is on show: a letter typed takes a model away, an answer lands and
 * puts rows above the one aimed at. A row that stands where it stood keeps
 * the time it has stood there; a row that is new, or stands in another place
 * than it did, has stood there since `now`. `previous` is null for a list
 * that was not on show: nothing of it was there to be aimed at, so its rows
 * count at once.
 *
 * A row's place is its index: a row moves on screen only when a row above it
 * comes or goes, a section's heading with it, and that changes its index.
 */
export function placeSearchTypeaheadRows(
  previous: SearchTypeaheadPlacement | null,
  rows: readonly SearchTypeaheadRow[],
  now: number,
): SearchTypeaheadPlacement {
  const placement = new Map<string, { index: number; since: number }>();
  rows.forEach((row, index) => {
    const before = previous?.get(row.key);
    placement.set(row.key, {
      index,
      since: previous === null ? Number.NEGATIVE_INFINITY : before && before.index === index ? before.since : now,
    });
  });
  return placement;
}

/**
 * Whether a press on a row counts: the row is drawn and has stood where it is
 * for SEARCH_TYPEAHEAD_PRESS_SETTLE_MS. A press that does not count does
 * nothing, so the person presses what they now see: it never opens the row
 * that took the place of the one they aimed at. For a pointer and a finger
 * only: the keyboard's highlight is on a row by its key, wherever it stands.
 */
export function isSearchTypeaheadPressAccepted(
  placement: SearchTypeaheadPlacement | null,
  rowKey: string,
  now: number,
): boolean {
  const place = placement?.get(rowKey);
  return place !== undefined && now - place.since >= SEARCH_TYPEAHEAD_PRESS_SETTLE_MS;
}

/**
 * The rows of a list on show that are drawn as not yet taking a press: the
 * ones the list's last change brought to stand where they are (a row new to
 * the list, or one at another place than before), and the ones an earlier
 * change did that have not stood their time since. A row that stays where it
 * stood is never among them, so an answer that leaves the rows where they were
 * marks none, and a change marks only the rows it moved: the list does not
 * flicker as a person types.
 *
 * `before` is the order drawn until now and its rows that were still marked.
 * A client marks them from each change of the order until the order has stood
 * for SEARCH_TYPEAHEAD_PRESS_SETTLE_MS, which is as long as the press rule
 * above holds any of them, and a little longer than it holds a row that an
 * earlier change moved and this one did not. A list that comes on show marks
 * none: its rows take a press at once.
 */
export function searchTypeaheadUnsettledRows(
  before: { order: readonly string[]; unsettled: readonly string[] },
  order: readonly string[],
): string[] {
  return order.filter((key, index) => before.order[index] !== key || before.unsettled.includes(key));
}

// ─── The keys ────────────────────────────────────────────────────────────────

export type SearchTypeaheadMoveKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * Where the highlight goes: an index into searchTypeaheadRows, or null for the
 * box itself (Enter then searches what is typed). Down from the box is the
 * first row and Up from it the last; past either end the highlight returns to
 * the box, so what was typed is one key away. Home and End go to the first and
 * last row only while a row is highlighted: with none, they are the text
 * caret's keys, and the caller leaves them to the field.
 */
export function moveSearchTypeaheadHighlight(
  current: number | null,
  key: SearchTypeaheadMoveKey,
  rowCount: number,
): number | null {
  if (rowCount <= 0) return null;
  const at = current !== null && current >= 0 && current < rowCount ? current : null;
  if (key === 'ArrowDown') return at === null ? 0 : at + 1 < rowCount ? at + 1 : null;
  if (key === 'ArrowUp') return at === null ? rowCount - 1 : at > 0 ? at - 1 : null;
  if (at === null) return null;
  return key === 'Home' ? 0 : rowCount - 1;
}

// ─── What a screen reader is told ────────────────────────────────────────────

/** A row in words: "Luna Studio, @luna-studio, following. Open profile". */
export function searchTypeaheadRowLabel(row: SearchTypeaheadRow): string {
  if (row.kind === 'creator') {
    const { displayName, username, isFollowing } = row.creator;
    const name = displayName.toLowerCase() === username.toLowerCase() ? `@${username}` : `${displayName}, @${username}`;
    return `${name}${isFollowing ? ', following' : ''}. Open profile`;
  }
  if (row.kind === 'entity') return searchEntityActionLabel(row.entity);
  return row.recent ? searchRecentAgainLabel(row.text) : `Search for ${row.text}`;
}

/**
 * How long the list's count must stand before it is said. Each letter can
 * change the list (an answer kept from a moment ago is drawn at once), and a
 * count said at every letter talks over the person's own typing: it is said
 * once per pause, for this text's own answer and never for a stale list, and a
 * polite region that is given the same words again says nothing, so a count
 * that did not change is not repeated.
 */
export const SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS = 500;

/** The polite announcement when the list opens or changes: "5 suggestions". Nothing for none. */
export function searchTypeaheadStatus(rowCount: number): string {
  if (rowCount <= 0) return '';
  return `${rowCount} ${rowCount === 1 ? 'suggestion' : 'suggestions'}`;
}
