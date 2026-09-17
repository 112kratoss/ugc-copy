import { LinearGradient } from 'expo-linear-gradient';

import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme } from '@/lib/theme';
import { viewerTopScrim } from '@/lib/viewer-chrome';

/**
 * Fades the status-bar strip back to the app background on screens whose list
 * scrolls underneath it. Without this the system clock sits directly on artwork
 * or, worse, on a card heading — which reads as clipping rather than as design.
 *
 * Render it as a sibling *immediately after the scroller and before any sheet*:
 * appended last it would paint a dark band across the top of an open sheet.
 * It is non-interactive, so the list still owns every touch in the strip.
 *
 * Lives here rather than in `components/ui.tsx` on purpose: `ui.tsx` is imported
 * by almost every screen and its tests, and `expo-linear-gradient` ships
 * untranspiled JSX in a `.js` file that vitest cannot parse. Keeping the
 * dependency out of the primitives barrel means a test for, say, a button never
 * has to mock a gradient library it has nothing to do with.
 *
 * The `media` variant is the reel's: over a full-bleed photo it has to keep the
 * clock readable on white, and it reaches down behind the reel's control row
 * with an eased fade — see `viewerTopScrim`, which `hig-full-screen.test.ts`
 * holds to both.
 */
export function TopScrim({ topInset, over = 'app' }: { topInset: number; over?: 'app' | 'media' }) {
  const ground = appTheme.colors.background;
  if (over === 'media') {
    const { height, stops } = viewerTopScrim(topInset);
    return (
      <LinearGradient
        colors={stops.map((stop) => hexWithAlpha(ground, stop.alpha)) as [string, string, ...string[]]}
        locations={stops.map((stop) => stop.offset / height) as [number, number, ...number[]]}
        pointerEvents="none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height }}
      />
    );
  }
  return (
    <LinearGradient
      colors={[ground, `${ground}00`]}
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topInset }}
    />
  );
}
