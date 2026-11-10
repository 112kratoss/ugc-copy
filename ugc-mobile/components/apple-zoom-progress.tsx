import type { ReelTouches } from '@/lib/reel-touches';

/** Android's flight mounts the reel's top controls once it has landed (`useMediaZoomLanded`). */
export function AppleZoomTopControlsCue(_props: { onShownChange: (shown: boolean) => void }) { return null; }

/** Android's flight lands its own picture; no tile holds one for UIKit's zoom there. */
export function AppleZoomReturnLandingCue(_props: { surfaceId: string | null; itemId: string | null; touches: ReelTouches }) { return null; }
