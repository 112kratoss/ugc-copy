import type { View } from 'react-native';

/**
 * Hands the tapped tile's on-screen rectangle to the immersive viewer so it
 * can open by growing out of that tile instead of fading in from black.
 *
 * A module-level hand-off rather than route params: the viewer's href is a
 * contract other code and tests pin, and a rectangle is only meaningful for
 * the next few hundred milliseconds anyway. The viewer consumes the origin
 * once; anything stale or for a different item is dropped.
 */
export interface ViewerOriginRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewerOrigin {
  /** Viewer item id (the href's `initialId`) the rectangle belongs to. */
  id: string;
  rect: ViewerOriginRect;
  /** What the tile was showing; the hero flies this image, not the full-res one. */
  previewUrl: string | null;
  /**
   * The cache key the tile loaded that image under. expo-image files entries
   * by key, so without it the hero misses the cache and flies blank.
   */
  cacheKey?: string | null;
  thumbhash?: string | null;
  /** Corner radius of the tile, so the hero starts with the tile's shape. */
  radius: number;
  /** Media aspect ratio (width / height) when the tile knows it. */
  aspectRatio?: number | null;
  recordedAt: number;
}

const ORIGIN_TTL_MS = 2500;

let pendingOrigin: ViewerOrigin | null = null;

export function setViewerOrigin(origin: ViewerOrigin) {
  pendingOrigin = origin;
}

/** Consumes the pending origin when it is fresh and belongs to `id`; otherwise clears it. */
export function takeViewerOrigin(id: string | null | undefined, now: number): ViewerOrigin | null {
  const origin = pendingOrigin;
  pendingOrigin = null;
  if (!origin || !id || origin.id !== id) return null;
  if (now - origin.recordedAt > ORIGIN_TTL_MS) return null;
  return origin;
}

type MeasurableNode = Pick<View, 'measureInWindow'> | null | undefined;

/** Window-relative rectangle of a mounted view; null when the node cannot be measured (tests, unmounted). */
export function measureViewerOrigin(node: MeasurableNode): Promise<ViewerOriginRect | null> {
  return new Promise((resolve) => {
    if (!node || typeof node.measureInWindow !== 'function') {
      resolve(null);
      return;
    }
    try {
      node.measureInWindow((x, y, width, height) => {
        resolve(width > 0 && height > 0 ? { x, y, width, height } : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Measures `node` and records it as the origin for `id`; resolves once the hand-off is in place. */
export async function recordViewerOrigin({
  node,
  now,
  ...origin
}: Omit<ViewerOrigin, 'rect' | 'recordedAt'> & { node: MeasurableNode; now: number }) {
  const rect = await measureViewerOrigin(node);
  if (!rect) return false;
  setViewerOrigin({ ...origin, rect, recordedAt: now });
  return true;
}

/** Where a `contain`-fitted image of `aspectRatio` lands inside `frame`; the whole frame when unknown. */
export function getContainedRect(
  frame: { width: number; height: number },
  aspectRatio: number | null | undefined,
): ViewerOriginRect {
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0 || frame.width <= 0 || frame.height <= 0) {
    return { x: 0, y: 0, width: frame.width, height: frame.height };
  }
  const frameRatio = frame.width / frame.height;
  if (aspectRatio >= frameRatio) {
    const height = frame.width / aspectRatio;
    return { x: 0, y: (frame.height - height) / 2, width: frame.width, height };
  }
  const width = frame.height * aspectRatio;
  return { x: (frame.width - width) / 2, y: 0, width, height: frame.height };
}
