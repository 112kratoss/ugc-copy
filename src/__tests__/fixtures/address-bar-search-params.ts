import { useMemo, useSyncExternalStore } from 'react';

/**
 * The stand-in for Next's `useSearchParams` that the creator page's tests
 * share: the query is the address bar's. Next's hook follows the page's own
 * pushState and replaceState, Back and Forward, and a navigation to the page
 * that is open, and draws its readers again when the query changes.
 * `useSyncExternalStore` reads the address bar in every render (a hydration
 * test's server render too) and counts a changed query as an update. It runs
 * ahead of Next, which hands the page's own history calls to its readers a
 * microtask later, in a render of their own.
 *
 *   vi.mock('next/navigation', async () => {
 *     const { useAddressBarSearchParams } = await import('./fixtures/address-bar-search-params');
 *     return { usePathname: () => '/creators/creator-name', useRouter: () => routerMock, useSearchParams: useAddressBarSearchParams };
 *   });
 */

const navigationListeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  navigationListeners.add(onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    navigationListeners.delete(onChange);
  };
}

function readSearch() {
  return window.location.search;
}

export function useAddressBarSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, readSearch, readSearch);
  return useMemo(() => new URLSearchParams(search), [search]);
}

/**
 * Next's navigation to `href` on the page that is open (a `<Link>`, or
 * `router.push`): the address changes with a pushState and the query's readers
 * draw again; the page stays mounted with its state, and no popstate fires.
 * Call it inside `act`.
 */
export function navigateWithinPage(href: string) {
  window.history.pushState(null, '', href);
  navigationListeners.forEach((listener) => listener());
}
