import { useAutoplayPreviewsEnabled } from '@/lib/autoplay-preference';
import { useReducedMotion } from '@/lib/motion';

/**
 * Whether a preview clip may play at all: Autoplay previews is not Never
 * (Settings → Playback) and Reduce Motion is off. Either keeps an elected tile
 * on its poster without moving the election. Every tile that plays a preview,
 * and every badge that says whether one plays, asks this one question, so a
 * condition added here reaches the feed's tiles, Explore's badge and the Home
 * shelf's cards alike. Its own module: `lib/autoplay-preference.ts` stays free
 * of React Native for the pure modules that read the policy.
 */
export function usePreviewPlaybackAllowed(): boolean {
  const previewsEnabled = useAutoplayPreviewsEnabled();
  const reducedMotion = useReducedMotion();
  return previewsEnabled && !reducedMotion;
}
