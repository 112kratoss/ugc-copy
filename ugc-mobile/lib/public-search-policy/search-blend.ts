/**
 * The blended Posts order: the rules both search clients and the server
 * share for `blend=1` on `GET /api/search`.
 *
 * A search that asks for it has its posts ordered by two lists merged into
 * one: the posts that hold the query's words, in the word order search has
 * always had, and the posts that mean what the query says (their public text
 * measured against the query's), nearest first. A post in both lists rises; a
 * post only the meaning list holds can be among the results, with no word of
 * the query in it. The server blends only the first window of a ranked search
 * of two words or more and falls back, without saying so, to the word order
 * whenever it cannot blend (no vector for the query in time, the lookup
 * switched off, a query read corrected): an answer is never worse for asking.
 *
 * Shared by relative import with the web and the server, like the rest of
 * this folder: no React Native, Expo or Node imports.
 */

/** The request parameter: `blend=1`. Any other value is refused (400), as `related`'s is. */
export const SEARCH_BLEND_PARAM = 'blend';

/** A search is blended from this many words: one word is never blended. */
export const SEARCH_BLEND_MIN_WORDS = 2;

/** How many words a query has: runs of characters between spaces. */
export function searchQueryWordCount(query: string): number {
  return query.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Whether a search is one the server blends, and so whether a client sends
 * `blend=1` with it.
 *
 * - Posts are in the answer and in the ranked order: the Top tab, or Posts
 *   sorted Top. Latest is the word matches newest first and is never blended.
 * - The query has two words or more. A single word is the commonest search
 *   and its word matches are what was asked for.
 * - Not a handle search (a query that begins with "@"): that is a look for a
 *   creator.
 * - Not read as typed (`exact`): "Search instead for …" asks for the words.
 * - The person settled on it (`settled`): the Search key or Enter, a
 *   suggestion, a recent or a starter search pressed, never a step of typing.
 *   A new query costs an embedding, counted against the viewer's forty a day,
 *   and a list that reorders under the fingers while typing is worse than
 *   either order. The server cannot see this and reads every request that
 *   sends the parameter as settled.
 *
 * Filters do not matter: a filtered search is blended inside its filters. A
 * client sends the parameter with every page of a search it sent it with on
 * the first; the server continues a blended list only from a cursor it issued
 * for one.
 *
 * `query` is the search as the person wrote it, a leading "@" kept.
 */
export function searchBlendApplies(search: {
  query: string;
  type: string;
  sort: string;
  exact: boolean;
  settled: boolean;
}): boolean {
  const query = search.query.trim();
  return search.settled
    && !search.exact
    && (search.type === 'top' || search.type === 'posts')
    && search.sort === 'top'
    && !query.startsWith('@')
    && searchQueryWordCount(query) >= SEARCH_BLEND_MIN_WORDS;
}

/** The parameter as a request carries it, or nothing. */
export function searchBlendParams(applies: boolean): Record<string, string> {
  return applies ? { [SEARCH_BLEND_PARAM]: '1' } : {};
}

/**
 * How a post of a blended answer matched: its words hold the query (`words`),
 * it means what the query says and holds none of its words as search matches
 * them (`meaning`), or both lists hold it (`both`).
 */
export const SEARCH_MATCH_SOURCES = ['words', 'meaning', 'both'] as const;
export type SearchMatchSource = (typeof SEARCH_MATCH_SOURCES)[number];

/** A post result's `matchedBy` as a known source, or null for an answer without it. */
export function readSearchMatchedBy(value: unknown): SearchMatchSource | null {
  return SEARCH_MATCH_SOURCES.includes(value as SearchMatchSource) ? value as SearchMatchSource : null;
}

/**
 * How a post result matched. Every post of an answer to a request that sent
 * `blend=1` says so (`matchedBy`); a post without it (the parameter was not
 * sent, or the server is from before it) matched by its words, as every
 * result did before the blend.
 */
export function searchPostMatchedBy(post: { matchedBy?: unknown }): SearchMatchSource {
  return readSearchMatchedBy(post.matchedBy) ?? 'words';
}

/** Whether a post is in the answer for what it means alone: no word of the query matched it. */
export function isSearchMeaningOnlyMatch(post: { matchedBy?: unknown }): boolean {
  return searchPostMatchedBy(post) === 'meaning';
}
