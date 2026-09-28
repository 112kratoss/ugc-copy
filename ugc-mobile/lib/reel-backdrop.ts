import { useNavigation } from 'expo-router';
import { useEffect } from 'react';

import { ZOOM_VEIL_LIFT_DELAY_MS, ZOOM_VEIL_LIFT_MS } from './zoom-veil';

/**
 * Black behind the navigator while a reel is on screen or being revealed
 * (`ReelBackdrop` in app/_layout.tsx).
 *
 * iOS 26 draws a screen that a pop is revealing with the display's rounded
 * corners until the transition is over, and whatever lies behind the navigator
 * shows in them: the app's ground, which is light on the light scheme. Around
 * a light page that is invisible. Around the reel, dark in both schemes, it
 * drew four light corners for up to half a second whenever a page pushed from
 * the reel — a creator profile — was popped back to it.
 *
 * The same ground showed around a pushed page a reel closes into: UIKit's zoom
 * scales such a page up from about 92% as the reel shrinks into it, over the
 * first quarter of a second, and the page is black under its veil all that
 * time (lib/zoom-veil.ts) — so the page grew inside a light frame. Screens that
 * fill the window, the tabs, are not scaled.
 *
 * Each reel holds the backdrop from the moment it starts to appear until a
 * page pushed over it has covered it, and again as a pop starts to reveal it —
 * Back and the edge swipe alike — and until its own close has landed. Back
 * takes the reel out of React before UIKit has run that close, so a reel on
 * its way out lets go only after the close's own length. It lets go once
 * covered because light pages popped back to one another above it want the
 * light ground behind their own corners.
 */
/** How long the backdrop outlasts a reel Back removed: the close, until its veil has lifted. */
export const REEL_BACKDROP_CLOSE_MS = ZOOM_VEIL_LIFT_DELAY_MS + ZOOM_VEIL_LIFT_MS;

const holders = new Set<object>();
const releases = new Set<ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function hold(holder: object, held: boolean) {
  const shown = holders.size > 0;
  if (held) holders.add(holder);
  else holders.delete(holder);
  if (shown !== holders.size > 0) listeners.forEach((listener) => listener());
}

export function isReelBackdropShown() {
  return holders.size > 0;
}

export function subscribeToReelBackdrop(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For the reel's screen: holds the backdrop while that screen is showing or being revealed. */
export function useReelBackdrop() {
  const navigation = useNavigation();
  useEffect(() => {
    const holder = {};
    let leaving = false;
    hold(holder, true);
    const listen = navigation.addListener as unknown as (
      type: 'transitionStart' | 'transitionEnd' | 'beforeRemove',
      listener: (event: { data?: { closing?: boolean } }) => void
    ) => () => void;
    const unsubscribers = [
      listen('transitionStart', (event) => {
        if (event.data?.closing === false) hold(holder, true);
      }),
      listen('transitionEnd', (event) => {
        if (event.data?.closing === true) hold(holder, false);
      }),
      listen('beforeRemove', () => {
        leaving = true;
        hold(holder, true);
      }),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      if (!leaving) {
        hold(holder, false);
        return;
      }
      const release = setTimeout(() => {
        releases.delete(release);
        hold(holder, false);
      }, REEL_BACKDROP_CLOSE_MS);
      releases.add(release);
    };
  }, [navigation]);
}

/** Test support. */
export function resetReelBackdrop() {
  releases.forEach(clearTimeout);
  releases.clear();
  holders.clear();
  listeners.clear();
}
