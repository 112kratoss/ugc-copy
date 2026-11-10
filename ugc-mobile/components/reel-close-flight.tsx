/**
 * Android flies every close itself (components/media-zoom.tsx): the picture's
 * own flight on Back is iOS's (components/reel-close-flight.ios.tsx), and here
 * its pieces draw and do nothing.
 */
import { createContext, type ReactElement } from 'react';

import type { ZoomRect } from '@/lib/media-zoom-transition';

export interface ReelCloseFlightReel {
  reelId: number;
  surfaceId: string | null;
  activeItemId: string | null;
  enabled: boolean;
  back: ZoomRect;
}

export const ReelCloseFlightContext = createContext<ReelCloseFlightReel | null>(null);

export function ReelCloseFlightArm(_props: {
  postId: string;
  picture: { url: string; cacheKey?: string | null };
  aspectRatio: number | null | undefined;
  width: number;
  height: number;
}) {
  return null;
}

export function ReelCloseFlightTouches({ children }: { children: ReactElement }) {
  return children;
}

export function ReelCloseFlightLayer() {
  return null;
}
