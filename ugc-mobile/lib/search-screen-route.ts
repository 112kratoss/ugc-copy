import {
  hasSearchFilters,
  normalizeSearchHistoryQuery,
  readSearchFilterParams,
  searchFilterParams,
  type SearchFilters,
} from './public-search-policy/public-search-policy';
import type { SearchEntranceOrigin } from './search-entrance';
import type { PublicSearchSort, PublicSearchType } from './types';

/** Where Home and Explore open search: a fresh screen, an empty field. */
export const SEARCH_SCREEN_HREF = '/search';

const SEARCH_TYPES: readonly PublicSearchType[] = ['top', 'creators', 'posts', 'recipes'];
const SEARCH_SORTS: readonly PublicSearchSort[] = ['top', 'latest'];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A search as the screen draws it, and as its address carries it. */
export type SearchScreenSearch = {
  query: string;
  type: PublicSearchType;
  sort: PublicSearchSort;
  filters: SearchFilters;
  exact: boolean;
};

/**
 * The search's own address, as the web writes its search page's
 * (`searchPath` in src/app/search/SearchClient.tsx): `q`, then the tab and the
 * order where they are not Top, then the filters and the exact reading in the
 * parameters both clients send them in (`searchFilterParams`). Nothing typed
 * is the start, `/search`. Where a visitor's Follow comes back to once they
 * have signed up (review of #828, S5): the screen under the sign-up is popped
 * back to as it stood, and a screen opened anew on the address reads all of it
 * (`searchScreenParams`).
 */
export function searchScreenHref(search: SearchScreenSearch): string {
  const query = normalizeSearchHistoryQuery(search.query);
  if (!query) return SEARCH_SCREEN_HREF;
  const params: [string, string][] = [['q', query]];
  if (search.type !== 'top') params.push(['type', search.type]);
  if (search.sort !== 'top') params.push(['sort', search.sort]);
  params.push(...Object.entries(searchFilterParams(search.filters, search.exact)));
  return `${SEARCH_SCREEN_HREF}?${params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')}`;
}

/**
 * The search a link opens the screen on, as the web's search address carries
 * it (`/search?q=nano&type=posts&sort=latest&kind=video`): `q`, `type`, `sort`,
 * the filters and the exact reading. A missing or empty `q` is an empty field,
 * and nothing else is read without one; an unknown `type` is Top, an unknown
 * `sort` the tab's own order. Filters that name something they cannot are left
 * out with the exact reading, never half read: the search opens unnarrowed.
 */
export function searchScreenParams(params: Record<string, string | string[] | undefined>): {
  query: string | null;
  type: PublicSearchType | null;
  sort: PublicSearchSort | null;
  filters: SearchFilters | null;
  exact: boolean;
} {
  const query = normalizeSearchHistoryQuery(first(params.q) ?? '');
  if (!query) return { query: null, type: null, sort: null, filters: null, exact: false };
  const type = first(params.type);
  const sort = first(params.sort);
  const narrowing = readSearchFilterParams((name) => first(params[name]));
  return {
    query,
    type: SEARCH_TYPES.includes(type as PublicSearchType) ? (type as PublicSearchType) : null,
    sort: SEARCH_SORTS.includes(sort as PublicSearchSort) ? (sort as PublicSearchSort) : null,
    filters: narrowing.ok && hasSearchFilters(narrowing.filters) ? narrowing.filters : null,
    exact: narrowing.ok && narrowing.exact,
  };
}

/**
 * How long after a push another open is ignored when the screen has not
 * mounted yet: longer than the native push takes to take the touch.
 */
export const SEARCH_SCREEN_OPEN_GUARD_MS = 600;

/**
 * How long after a push the screen it mounts may grow out of the pressed
 * control: a screen mounts within a frame or two of its push.
 */
export const SEARCH_SCREEN_ORIGIN_TTL_MS = 1000;

/**
 * Home's magnifier, Explore's search bar and its compact button open search
 * through one opener (review of #795): a second tap while a push is on its way,
 * or while the screen is up, pushes nothing, so a quick double tap never
 * stacks two search screens. `app/search.tsx` says when the screen is up.
 */
export function createSearchScreenOpener({ push, now }: { push: (href: typeof SEARCH_SCREEN_HREF) => void; now: () => number }) {
  let pushedAt = Number.NEGATIVE_INFINITY;
  let mounted = 0;
  // The control the push was made from, for the screen's field to grow out of
  // (lib/search-entrance.ts). Handed to the screen once, as it mounts.
  let origin: SearchEntranceOrigin | null = null;
  return {
    open(from: SearchEntranceOrigin | null = null): boolean {
      if (mounted > 0 || now() - pushedAt < SEARCH_SCREEN_OPEN_GUARD_MS) return false;
      pushedAt = now();
      origin = from;
      push(SEARCH_SCREEN_HREF);
      return true;
    },
    /**
     * The control this opening was pressed from, for a screen mounting within
     * SEARCH_SCREEN_ORIGIN_TTL_MS of the push. Not cleared by the read, so a
     * render React repeats (Strict Mode) reads the same; a screen mounting
     * later (a link's, or one whose push never mounted) grows out of nothing
     * (review of #812, 3).
     */
    takeOrigin(): SearchEntranceOrigin | null {
      return now() - pushedAt <= SEARCH_SCREEN_ORIGIN_TTL_MS ? origin : null;
    },
    screenMounted() {
      mounted += 1;
    },
    screenUnmounted() {
      mounted = Math.max(0, mounted - 1);
      pushedAt = Number.NEGATIVE_INFINITY;
      origin = null;
    },
    /** Forgets every push and screen: for tests that open search again and again. */
    reset() {
      mounted = 0;
      pushedAt = Number.NEGATIVE_INFINITY;
      origin = null;
    },
  };
}

