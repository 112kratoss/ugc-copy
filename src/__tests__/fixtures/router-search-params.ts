import { act, useMemo, useSyncExternalStore } from 'react';

/**
 * A stand-in for Next's `useSearchParams` that hands the page's own history
 * writes to its readers when Next does: a microtask later, in a render of their
 * own. Next 16.3's patched pushState and replaceState dispatch the new address
 * to the router (`next/dist/client/components/app-router.js`), whose state comes
 * from a promise (`app-router-instance.js`). So a handler that sets the page's
 * state and then writes the history draws the page once with its new state and
 * the old query. Back and Forward reach the readers with the popstate, before
 * the page's own handler (Next listens from hydration). A page that mounts
 * reads the address bar. `address-bar-search-params.ts` runs ahead of Next.
 *
 *   vi.mock('next/navigation', async () => {
 *     const { useRouterSearchParams } = await import('./fixtures/router-search-params');
 *     return { usePathname: () => '/profile', useRouter: () => routerMock, useSearchParams: useRouterSearchParams };
 *   });
 */

const listeners = new Set<() => void>();
// The query the router holds while a page reads it, read again from the
// address bar whenever none does.
let routerSearch = '';

function deliver() {
  routerSearch = window.location.search;
  listeners.forEach((listener) => listener());
}

// Patched once, when the mock first loads, as Next patches them once at
// hydration: a spy a test puts on either method wraps this one, and restoring
// the spy puts it back.
for (const method of ['pushState', 'replaceState'] as const) {
  const write = window.history[method];
  window.history[method] = function writeThenTellRouter(this: History, ...args: Parameters<History['pushState']>) {
    write.apply(this, args);
    queueMicrotask(() => {
      if (listeners.size === 0) return;
      // Inside act where the test expects one (outside Testing Library's
      // waits), so the readers draw before the test reads the page.
      if ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT) act(deliver);
      else deliver();
    });
  };
}

function subscribe(onChange: () => void) {
  const onPopState = () => {
    routerSearch = window.location.search;
    onChange();
  };
  listeners.add(onChange);
  window.addEventListener('popstate', onPopState);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('popstate', onPopState);
  };
}

function readRouterSearch() {
  if (listeners.size === 0) routerSearch = window.location.search;
  return routerSearch;
}

export function useRouterSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, readRouterSearch, readRouterSearch);
  return useMemo(() => new URLSearchParams(search), [search]);
}
