/** A covered list prepares the current post's tile before UIKit asks for it. */
const surfaces = new Map<string, (itemId: string) => void>();
const requested = new Map<string, string>();

export function registerAppleZoomSurface(surfaceId: string, reveal: (itemId: string) => void) {
  surfaces.set(surfaceId, reveal);
  const itemId = requested.get(surfaceId);
  if (itemId) reveal(itemId);
  return () => {
    if (surfaces.get(surfaceId) === reveal) surfaces.delete(surfaceId);
  };
}

export function prepareAppleZoomReturn(surfaceId: string, itemId: string) {
  requested.set(surfaceId, itemId);
  surfaces.get(surfaceId)?.(itemId);
}

export function clearAppleZoomReturn(surfaceId: string, itemId: string) {
  if (requested.get(surfaceId) === itemId) requested.delete(surfaceId);
}

export function forgetAppleZoomSurface(surfaceId: string) {
  surfaces.delete(surfaceId);
  requested.delete(surfaceId);
}
