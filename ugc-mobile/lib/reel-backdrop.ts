import { useNavigation } from 'expo-router';
import { useEffect } from 'react';

/**
 * Black behind the navigator while a pop reveals a reel (`ReelBackdrop` in
 * app/_layout.tsx).
 *
 * iOS 26 draws a screen that a pop is revealing with the display's rounded
 * corners until the transition is over, and whatever lies behind the navigator
 * shows in them: the app's ground, which is light on the light scheme. Around
 * a light page that is invisible. Around the reel, dark in both schemes, it
 * drew four light corners for up to half a second whenever a page pushed from
 * the reel — a creator profile — was popped back to it.
 *
 * Only then. UIKit's zoom shrinks a pushed page a reel grows out of — a
 * creator profile, the card list of a profile's own posts — to about 92% as
 * the reel grows, and scales it back up as the reel shrinks into it, and the
 * ground shows round that page meanwhile. The tabs, which fill the window, are
 * not scaled. No screen is darkened under the zoom since 2026-11-08: Instagram
 * leaves its pages lit round its post as it grows and shrinks (filmed on the
 * owner's iPhone 16e). Round a lit page the app's own ground, the colour of
 * the page, lets that small move read as depth; black drew a frame round it.
 *
 * So a reel holds the backdrop from a pop starting to reveal it — Back on the
 * page above, or that page's edge swipe — until that transition ends,
 * whichever way it ends. The page pushed over the reel having covered it is
 * what makes the next transition that brings the reel in a reveal, not the
 * reel's own push.
 */
const holders = new Set<object>();
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

/** For the reel's screen: holds the backdrop while a pop reveals that screen. */
export function useReelBackdrop() {
  const navigation = useNavigation();
  useEffect(() => {
    const holder = {};
    let covered = false;
    const listen = navigation.addListener as unknown as (
      type: 'transitionStart' | 'transitionEnd',
      listener: (event: { data?: { closing?: boolean } }) => void
    ) => () => void;
    const unsubscribers = [
      listen('transitionStart', (event) => {
        if (event.data?.closing === false && covered) hold(holder, true);
      }),
      listen('transitionEnd', (event) => {
        covered = event.data?.closing === true;
        hold(holder, false);
      }),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      hold(holder, false);
    };
  }, [navigation]);
}

/** Test support. */
export function resetReelBackdrop() {
  holders.clear();
  listeners.clear();
}
