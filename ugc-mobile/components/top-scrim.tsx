import { LinearGradient } from 'expo-linear-gradient';
import { View } from 'react-native';

import { hexWithAlpha, linearGradient } from '@/lib/eased-fade';
import { useAppTheme } from '@/lib/theme-context';
import { tabRootTopScrim } from '@/lib/top-scrim';
import { viewerTopScrim } from '@/lib/viewer-chrome';

/**
 * Covers the status-bar strip with the app background on screens whose list
 * scrolls underneath it. Without this the system clock sits directly on artwork
 * or, worse, on a card heading — which reads as clipping rather than as design.
 * The strip is solid and the fade runs out just below it (`tabRootTopScrim`):
 * a fade across the strip itself left the clock over content at half strength.
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
 * holds to both. It mounts as the reel opens, so it is React Native's own
 * gradient, as the reel's other shades are (`components/reel-chrome.tsx` says why).
 */
export function TopScrim({ topInset, over = 'app' }: { topInset: number; over?: 'app' | 'media' }) {
  const theme = useAppTheme();
  const ground = theme.colors.background;
  if (over === 'media') {
    const { height, stops } = viewerTopScrim(topInset);
    const shade = linearGradient('to bottom', stops.map((stop) => ({ color: hexWithAlpha(ground, stop.alpha), at: stop.offset / height })));
    return (
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height, experimental_backgroundImage: shade }}
      />
    );
  }
  const { height, stops } = tabRootTopScrim(topInset);
  const [first, second, ...rest] = stops;
  return (
    <LinearGradient
      colors={[hexWithAlpha(ground, first.alpha), hexWithAlpha(ground, second.alpha), ...rest.map((stop) => hexWithAlpha(ground, stop.alpha))]}
      locations={[first.offset / height, second.offset / height, ...rest.map((stop) => stop.offset / height)]}
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height }}
    />
  );
}
