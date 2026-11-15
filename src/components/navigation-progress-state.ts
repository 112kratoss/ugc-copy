type NavigationListener = (token: number) => void;

// A monotonic counter rather than a boolean: two navigations in a row must each
// register, and a number keeps `getSnapshot` referentially stable for
// useSyncExternalStore.
let navigationToken = 0;
const listeners = new Set<NavigationListener>();
// Whether the latest navigation was the browser's Back or Forward (a `popstate`)
// rather than one announced here (a link click, an announced push).
let lastNavigationWasTraversal = false;
// The pathname the latest announced navigation was going to, where it said.
let lastAnnouncedPathname: string | null = null;

if (typeof window !== 'undefined') {
  // Registered as this module loads, with the root layout, so before the router's
  // own listener; the router renders a traversal in a transition, after both.
  window.addEventListener('popstate', () => {
    lastNavigationWasTraversal = true;
  });
}

/**
 * Announce that a navigation is starting. Call this immediately before an
 * imperative `router.push`, with the `href` it pushes — link clicks are picked
 * up by NavigationProgress's own document listener and do not need it.
 */
export function publishNavigationStart(href?: string) {
  navigationToken += 1;
  lastNavigationWasTraversal = false;
  lastAnnouncedPathname = href === undefined ? null : new URL(href, window.location.href).pathname;
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
  publishNavigationStart(href);
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
 * Whether the page at `pathname` was reached inside this document, by a client
 * navigation, rather than being the page the document was loaded at as it was
 * loaded (a shared link, a refresh, a new tab) or as the browser's Back or
 * Forward returns to it. Any other page counts whatever brought the viewer there
 * (a link, a router push or replace, a traversal), so no imperative navigation is
 * missed. The first page counts only when the latest announced navigation (a
 * link, an announced push) went to it: not when a trip elsewhere comes back to it
 * by a replace (a sign-in from it, which lands back on it with the sign-in page's
 * entry replaced, so a step back would only reach the first page again). It
 * cannot hold for the first page as it loads however late a part of it mounts,
 * and it is false on the server, so a server render and the hydration of the
 * first page agree.
 *
 * Keyed on the address, not on the history entry: Back or Forward onto a later
 * visit of the first page takes it for the first page itself, and draws nothing.
 */
export function isPageReachedInThisDocument(pathname: string) {
  if (documentPathname === null) return false;
  if (pathname !== documentPathname) return true;
  return lastAnnouncedPathname === documentPathname && !lastNavigationWasTraversal;
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
