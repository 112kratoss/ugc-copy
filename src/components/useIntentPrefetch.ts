'use client';

import { useCallback, type FocusEvent, type PointerEvent } from 'react';
import { useRouter } from 'next/navigation';

/** Focus the keyboard gave, which a press of a mouse or a finger does not (`:focus-visible`). */
export function isKeyboardFocus(element: Element) {
  try {
    return element.matches(':focus-visible');
  } catch {
    // An engine without the selector: any focus counts.
    return true;
  }
}

/**
 * A link prefetched when the reader shows they may follow it: a mouse pointer resting on it, or the
 * keyboard's focus. Its `<Link>` draws with `prefetch={false}`, so nothing is fetched as the page
 * paints (#7, "defer nonessential route prefetches": every link in view, on every page, on every
 * load); with nothing prefetched, a press waited on the server with only the progress bar to show
 * for it (owner's recording, 2026-11-16: about a second to Marketplace).
 *
 * Each intent just asks: Next keeps a prefetched route a few minutes and its scheduler skips one it
 * holds fresh or is still fetching, so a place is fetched again only once its copy has gone stale.
 * Never the place already open (`active`). Not on a finger: its pointer arrives with the press
 * itself, about 100 ms before the click, and a navigation that starts while the prefetch's first
 * request is out waits about 300 ms longer than one with no prefetch at all (production-build probe,
 * 2026-11-16); a tap's focus, which comes just before its click, is passed over the same way.
 *
 * The side navigation's places use it, and since 2026-11-20 the secondary links of a post's page
 * (its creator, "View creator", "Create your own"), which prefetched the creator page and `/create`
 * on every view of every post.
 */
export function useIntentPrefetch(href: string, active = false) {
  const router = useRouter();
  const onPointerEnter = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!active && event.pointerType === 'mouse') router.prefetch(href);
  }, [active, href, router]);
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    if (!active && isKeyboardFocus(event.currentTarget)) router.prefetch(href);
  }, [active, href, router]);
  return { onPointerEnter, onFocus };
}
