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
/**
 * Fraction of the top inset the `media` variant holds at full opacity before it
 * starts to fade. The system draws the clock and the status icons in roughly the
 * middle of the inset — measured at 27–40pt of a 72pt inset on an iPhone 17 Pro —
 * so a gradient that is already half-faded there protects nothing on bright
 * content. Holding to 0.6 covers that band on a notched device and most of a
 * short inset, and the remaining 40% is what keeps it from reading as a bar.
 */
const MEDIA_SCRIM_HOLD = 0.6;

export function TopScrim({ topInset, over = 'app' }: { topInset: number; over?: 'app' | 'media' }) {
  const ground = appTheme.colors.background;
  return (
    <LinearGradient
      colors={over === 'media'
        ? [ground, ground, `${ground}00`]
        : [ground, `${ground}00`]}
      locations={over === 'media' ? [0, MEDIA_SCRIM_HOLD, 1] : undefined}
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topInset }}
    />
  );
}
