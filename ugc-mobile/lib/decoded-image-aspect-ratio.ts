// Some creations have no dimensions in their media descriptor. Keep the
// shape expo-image actually decoded so the tile and viewer align the same way.
// URLs, rather than post IDs, prevent recycled cells sharing another image's size.
const MAX_IMAGES = 256;
const ratios = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

export function decodedImageAspectRatio(url: string | null | undefined): number | null {
  return url ? ratios.get(url) ?? null : null;
}

export function subscribeDecodedImageAspectRatio(url: string | null | undefined, listener: () => void) {
  if (!url) return () => {};
  const group = listeners.get(url) ?? new Set<() => void>();
  group.add(listener);
  listeners.set(url, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(url);
  };
}

export function rememberDecodedImageAspectRatio(url: string, width: number, height: number) {
  if (!url || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const ratio = width / height;
  const previous = ratios.get(url);
  ratios.delete(url);
  ratios.set(url, ratio);
  if (previous !== ratio) listeners.get(url)?.forEach((listener) => listener());
  if (ratios.size > MAX_IMAGES) {
    const oldest = ratios.keys().next().value!;
    ratios.delete(oldest);
    listeners.get(oldest)?.forEach((listener) => listener());
  }
}
