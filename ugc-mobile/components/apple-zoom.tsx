/**
 * Everywhere but iOS — Android, and the test runner — the zoom is not a thing:
 * a tile is its own view, the reel marks nothing, and nothing is re-pointed.
 * The iOS bindings are in `apple-zoom.ios.tsx`; see `lib/apple-zoom.ts`.
 */
import type { ReactNode } from 'react';

import type { ZoomRect } from '@/lib/media-zoom-transition';

export function AppleZoomSource({ children }: { identifier: string | null; children: ReactNode }) {
  return children;
}

export function AppleZoomTarget(_props: { rect: ZoomRect }) {
  return null;
}

export function useAppleZoomSourceId(): string | null {
  return null;
}

export function useAppleZoomRetarget(_activeItemId: string | null) {}
