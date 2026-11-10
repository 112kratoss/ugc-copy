/**
 * Everywhere but iOS — Android, and the test runner — the zoom is not a thing:
 * a tile is its own view, the reel marks nothing, and nothing is re-pointed.
 * The iOS bindings are in `apple-zoom.ios.tsx`; see `lib/apple-zoom.ts`.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ZoomPreview, ZoomRect, ZoomSize } from '@/lib/media-zoom-transition';

export function AppleZoomSource({ children }: {
  identifier: string | null;
  aspectRatio: number | null;
  tile: ZoomSize | null;
  pageShaped?: boolean;
  children: ReactNode;
}) {
  return children;
}

export function AppleZoomTarget(_props: { rect: ZoomRect }) {
  return null;
}

export function withholdAppleZoomSource(_identifier: string): () => void {
  return () => {};
}

export function useAppleZoomSourceId(): string | null {
  return null;
}

export function useAppleZoomRetarget(_activeItemId: string | null, _pictureReturns = false) {}

/** What a tile draws in the view a close shrinks the reel into: nothing, where no zoom runs. */
export interface AppleZoomReturnPicture {
  picture: ZoomPreview | null;
  covers: boolean;
  onDisplay: () => void;
}

const NO_RETURN_PICTURE: AppleZoomReturnPicture = { picture: null, covers: false, onDisplay: () => {} };

export function useAppleZoomReturnPicture(
  _surfaceId: string | null,
  _itemId: string,
  _preview: ZoomPreview | null
): AppleZoomReturnPicture {
  return NO_RETURN_PICTURE;
}

export function AppleZoomReturnPictureView({ radius }: { returnPicture?: AppleZoomReturnPicture; radius: number }) {
  return <View pointerEvents="none" collapsable={false} style={[StyleSheet.absoluteFill, { borderRadius: radius, borderCurve: 'continuous' }]} />;
}
