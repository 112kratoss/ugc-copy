export interface PreviewSize {
  width: number;
  height: number;
}

/**
 * The one rule for whether a recorded preview size may be used.
 *
 * The consumer is an aspect ratio — the showcase grid divides a column width by
 * it to lay a card out before the image arrives — so a width without a height
 * says nothing, and a zero is not a flatter picture but a broken one that would
 * produce an infinite card. Half a size is therefore no size.
 *
 * Shared by the three places that would otherwise each invent it: the feed
 * serializer reading the column, the backfill writing it, and the preview
 * pipeline measuring the bytes it just stored. A card with no usable size falls
 * back to the client measuring the image itself, which is where it already
 * safely was before these columns existed.
 */
export function toUsablePreviewSize(
  width: number | null | undefined,
  height: number | null | undefined,
): PreviewSize | null {
  const usable = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;

  const usableWidth = usable(width);
  const usableHeight = usable(height);
  return usableWidth && usableHeight ? { width: usableWidth, height: usableHeight } : null;
}
