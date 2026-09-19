import { makeMutable } from 'react-native-reanimated';

/**
 * 1 while a reel drag is under way, 0 once it has settled.
 *
 * A neighbour slide keeps its rail and caption mounted, so a swipe reveals
 * them with the picture, but out of the draw walk (`display: none`) while the
 * reel is at rest: on Android every frame of a playing reel walks the whole
 * view tree, and the two neighbours' chrome was about two fifths of it (S24
 * traces, 2026-09-19, implementation evidence). The landed slide is shown by
 * its own `active` prop, so nothing here can hide what is on screen.
 *
 * Module state rather than a hook value, like `lib/zoom-underlay`: the viewer
 * screen is React Compiler-optimised, and a shared value written inside it
 * would make the compiler skip the screen.
 */
export const reelNeighbourChromeRevealed = makeMutable(0);

export function setReelNeighbourChromeRevealed(revealed: boolean) {
  reelNeighbourChromeRevealed.set(revealed ? 1 : 0);
}
