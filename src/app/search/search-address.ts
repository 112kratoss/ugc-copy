import {
  NO_PUBLIC_SEARCH_FILTERS,
  normalizePublicSearchQuery,
  parsePublicSearchSort,
  parsePublicSearchType,
  readPublicSearchFilterParams,
  type PublicSearchFilters,
  type PublicSearchSort,
  type PublicSearchType,
} from '@/lib/public-search';

/** The search page's own path: its address is this and the search's parameters. */
export const SEARCH_PAGE_PATH = '/search';

/** The search an address names: what the page opens on. */
export type SearchPageOpening = {
  query: string;
  type: PublicSearchType;
  /** A shared link's order; one it does not name, or names wrongly, is the ranked one. */
  sort: PublicSearchSort;
  /** A shared link's filters; an address that names one wrongly opens unfiltered. */
  filters: PublicSearchFilters;
  /** A shared link asked for the query as typed. */
  exact: boolean;
};

/**
 * Reads the search an address names. One reading for the server's render of
 * the page and for the page's own reading of its address when history brings
 * it back (below), so the two cannot differ.
 */
export function readSearchPageOpening(param: (name: string) => string | null): SearchPageOpening {
  const narrowing = readPublicSearchFilterParams(param);
  return {
    query: normalizePublicSearchQuery(param('q')),
    type: parsePublicSearchType(param('type')) ?? 'top',
    sort: parsePublicSearchSort(param('sort')) ?? 'top',
    filters: narrowing.ok ? narrowing.filters : NO_PUBLIC_SEARCH_FILTERS,
    exact: narrowing.ok ? narrowing.exact : false,
  };
}

const here = () => `${window.location.pathname}${window.location.search}`;

// The address the last Back or Forward landed on, until the page that mounts
// for it has read it. Noted in the capture phase, so before Next's own
// popstate listener starts drawing the entry. The module is loaded with the
// page's first visit, which any return to it within this document follows.
let traversalAddress: string | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => { traversalAddress = here(); }, { capture: true });
}

/**
 * The search the browser's address names, when Back or Forward has just
 * brought the page back to it; null on the server and for every other mount.
 *
 * The page writes its address as the search changes (below), and Next never
 * hears of it. So when Back or Forward returns to the page, Next draws the
 * entry from the render it kept, which holds the search the page was first
 * opened with, whatever the address has said since: the box came back with
 * the query of the first load. The address is the search the person left, so
 * a mount that a traversal landed on its own address reads it.
 *
 * Only then. At a first load the props are the server's reading of the same
 * address. On a navigation here the address is still the page before's while
 * this one first renders, and that page can be the search page itself (a link
 * to another search, were one drawn on it): read then, the address would open
 * the search being left in place of the one asked for.
 */
export function readSearchPageAddress(): SearchPageOpening | null {
  if (typeof window === 'undefined' || window.location.pathname !== SEARCH_PAGE_PATH) return null;
  if (traversalAddress !== here()) return null;
  const params = new URLSearchParams(window.location.search);
  return readSearchPageOpening((name) => params.get(name));
}

/** The page has mounted: the traversal that brought it back, if one did, is spent. */
export function forgetSearchPageTraversal(): void {
  traversalAddress = null;
}

/**
 * Makes the browser's address the search's, without a navigation.
 *
 * The write carries the entry's own history state, Next's mark (`__NA`)
 * included. Next patches `history.replaceState` and hands a write so marked
 * straight to the browser; any other it takes for a navigation of its own
 * (to keep `usePathname` and `useSearchParams` in step), and a navigation
 * discards the one still loading. Written that way a pause after the last
 * letter, the page's address ended every navigation a person had started
 * inside that pause: a result, a suggestion, a link of the header, pressed,
 * opened nothing. A write the router never hears of cannot end one, whoever
 * started it and whenever this runs.
 *
 * What that costs: the router keeps the address the page was opened at, and
 * writes it back if it commits on this page without leaving it (a refresh; in
 * development a hot update). The page writes again at its next change and at
 * the next press anywhere, so the address is right again before it can matter
 * to a navigation. Nothing on the page reads `useSearchParams`.
 *
 * Safari refuses more than 100 history writes in 30 seconds with an exception;
 * the next write says what this one could not.
 *
 * Only while the address is the search page's own. Back pressed inside the
 * pause changes the address before Next takes the page away, and a write in
 * that gap (the pause's timer) would rename the entry of the page gone back
 * to.
 */
export function writeSearchPageAddress(path: string): void {
  if (window.location.pathname !== SEARCH_PAGE_PATH) return;
  if (here() === path) return;
  try {
    window.history.replaceState({ ...window.history.state, __NA: true }, '', path);
  } catch {
    // Refused (see above): the address stays as it was until the next write.
  }
}
