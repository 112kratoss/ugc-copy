import { normalizeSearchHistoryQuery } from './public-search-policy/public-search-policy';
import type { PublicSearchType } from './types';

/** Where Home and Explore open search: a fresh screen, an empty field. */
export const SEARCH_SCREEN_HREF = '/search';

const SEARCH_TYPES: readonly PublicSearchType[] = ['top', 'creators', 'posts', 'recipes'];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The search a link opens the screen on: `q` and `type`, as the web's search
 * address carries them (`/search?q=nano&type=posts`). A missing or empty `q`
 * is an empty field; an unknown `type` is Top.
 */
export function searchScreenParams(params: { q?: string | string[]; type?: string | string[] }): {
  query: string | null;
  type: PublicSearchType | null;
} {
  const query = normalizeSearchHistoryQuery(first(params.q) ?? '');
  const type = first(params.type);
  return {
    query: query || null,
    type: query && SEARCH_TYPES.includes(type as PublicSearchType) ? (type as PublicSearchType) : null,
  };
}
