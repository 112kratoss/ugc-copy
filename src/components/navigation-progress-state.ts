type NavigationListener = (token: number) => void;

// A monotonic counter rather than a boolean: two navigations in a row must each
// register, and a number keeps `getSnapshot` referentially stable for
// useSyncExternalStore.
let navigationToken = 0;
const listeners = new Set<NavigationListener>();

/**
 * Announce that a navigation is starting. Call this immediately before an
 * imperative `router.push` — link clicks are picked up by NavigationProgress's
 * own document listener and do not need it.
 */
export function publishNavigationStart() {
  navigationToken += 1;
  listeners.forEach((listener) => listener(navigationToken));
}

/**
 * `publishNavigationStart` before a push to `href`, when the push leaves the
 * current page. One that changes only the search or the hash never changes
 * the pathname the bar waits for, so it would creep until its failsafe; link
 * clicks are filtered the same way.
 */
export function publishNavigationStartTo(href: string) {
  if (new URL(href, window.location.href).pathname === window.location.pathname) return;
  publishNavigationStart();
}

export function readNavigationToken() {
  return navigationToken;
}

/**
 * Whether the viewer has navigated at least once inside this document.
 *
 * The module resets on every hard load, so this is false for someone who
 * arrived from a shared link, a refresh, or a search result — exactly the cases
 * where stepping back in history would take them out of the app rather than to
 * the page they came from. Lets a "back" affordance choose between a cheap
 * history pop and a real navigation to its stated destination.
 *
 * It counts navigations as they start (a link click, a push that announces
 * itself), not as they land, and a `router.replace` never counts: one that
 * swapped the first page for another leaves no page of the site to step back to.
 */
export function hasNavigatedInThisDocument() {
  return navigationToken > 0;
}

/**
 * The pathname this document was loaded at. The root layout's NavigationProgress
 * imports this module, so it is read as the first page loads, before any client
 * navigation; there is none on the server.
 */
const documentPathname = typeof window === 'undefined' ? null : window.location.pathname;

/**
 * Whether the page at `pathname` was reached inside this document, by any client
 * navigation (a link, a router push or replace, the browser's Back to another
 * page), rather than being the page the document was loaded at (a shared link, a
 * refresh, a new tab, or a return to that page by the browser's Back). Unlike the
 * navigation count it misses no imperative navigation, and it cannot hold for the
 * first page however late a part of it mounts. False on the server, so a server
 * render and the hydration of the first page agree.
 */
export function isPageReachedInThisDocument(pathname: string) {
  return documentPathname !== null && pathname !== documentPathname;
}

/**
 * The server and the first client render must agree, so hydration always starts
 * from "no navigation in flight" regardless of what the module has seen.
 */
export function readServerNavigationToken() {
  return 0;
}

export function subscribeToNavigationStart(listener: NavigationListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
