import { useSyncExternalStore } from 'react';

/**
 * A page's own control kept in its address, so that a refresh, Back from a page it linked to and
 * a copied link return to it (owner's report, 2026-11-15: a filter or sort chosen on a page came
 * back as its default).
 *
 * The address is the control's state: the page reads it with `useAddressParam` and changes it
 * with `writeAddressParam`, in place, without a navigation and without a history entry. The write
 * is the search page's (`writeSearchPageAddress`): it keeps the entry's state, Next's mark
 * included, so Next hands it straight to the browser. A write Next took for its own would end a
 * navigation still loading: a template pressed, then a filter while it loads, and the template
 * never opened (review of #815). Back and Forward still reach the entry, and Next takes the
 * address it finds there as the page's. What that costs: Next's router keeps the address the
 * page opened at, and writes it back at a commit on this page that does not leave it (a refresh,
 * a server action; in development a hot update); the pages that use this do none of these, and
 * none reads `useSearchParams` for these parameters.
 *
 * Read from the browser's address, never from the render: a page drawn ahead of time cannot read
 * it, and Back draws the render Next kept, from before the control last changed (`FeedClient`'s
 * lane is the same). The server, and hydration, read no value: the control's default.
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

/** The value the browser's address gives a parameter, or null where it gives none. */
export function readAddressParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

/** A parameter of the browser's address, followed as it changes; null on the server and while hydrating. */
export function useAddressParam(name: string): string | null {
  return useSyncExternalStore(subscribe, () => readAddressParam(name), () => null);
}

/**
 * Puts a parameter into the browser's address in place, or takes it out (`null`: the control's
 * default, which the address leaves unsaid). Call it from the press that changes the control, never
 * later: a write landing after Back had changed the address would rename the entry gone back to.
 */
export function writeAddressParam(name: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name); else url.searchParams.set(name, value);
  if (url.href === window.location.href) return;
  try {
    window.history.replaceState({ ...window.history.state, __NA: true }, '', url);
  } catch {
    // Safari refuses more than 100 history writes in 30 seconds; the next change writes again.
    return;
  }
  for (const listener of listeners) listener();
}
