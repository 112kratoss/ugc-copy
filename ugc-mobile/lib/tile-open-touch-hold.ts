import { makeMutable } from 'react-native-reanimated';

import { subscribeToTileOpen, tileOpenHoldsTouchesUntil, tileOpenSurface } from './media-zoom-transition';

/**
 * The surface (`MediaZoomSurface`) whose tile is opening a post, while that
 * screen leaves touches alone (`tileOpenHoldsTouchesUntil`); null when none
 * does. A Reanimated value, set inside the tap's own handler and read on the
 * UI thread, by the view over that surface (`TileOpenTouchShield`) and by the
 * gestures that view does not cover: react-native-gesture-handler finds its
 * handlers by walking the view tree itself and passes an empty view by, so
 * Android's pull to refresh asks here (`components/refresh-book.tsx`).
 */
export const tileOpenTouchHold = makeMutable<string | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;

function sync() {
  if (timer) clearTimeout(timer);
  timer = null;
  const now = Date.now();
  const until = tileOpenHoldsTouchesUntil(now);
  tileOpenTouchHold.set(until === null ? null : tileOpenSurface());
  // An open nothing ends lets go by the clock.
  if (until !== null) timer = setTimeout(sync, until - now + 1);
}

subscribeToTileOpen(sync);
