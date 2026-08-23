import { LinearGradient } from 'expo-linear-gradient';

import { appTheme } from '@/lib/theme';

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
 */
export function TopScrim({ topInset }: { topInset: number }) {
  return (
    <LinearGradient
      colors={[appTheme.colors.background, `${appTheme.colors.background}00`]}
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topInset }}
    />
  );
}
