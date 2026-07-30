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
 */
export function hasNavigatedInThisDocument() {
  return navigationToken > 0;
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
