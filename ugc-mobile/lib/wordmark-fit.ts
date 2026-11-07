/**
 * The size the large "Magicbooklet" wordmark is drawn at so it fits its row.
 *
 * The welcome screen's header gives the name the room left between Skip and a
 * matching spacer: 258pt on a 402pt-wide iPhone, 191pt beside the glyph on a
 * 375pt one (iPhone SE, mini). At 30pt the name is 199pt wide, so it is cut on
 * the smaller phones, and on every phone once the text size is raised. The
 * shared text primitives do not shrink to fit (React Native 0.83 floors that at
 * 4pt and ignores `minimumFontScale`), so the size is worked out here instead,
 * from the name's width at its full size and the width it has.
 *
 * Text width grows in step with font size, so the fitted size is the full size
 * scaled by how much room there is. It never goes above the full size, and
 * never below `minSize` (the compact lockup's size): past that the name is cut
 * with an ellipsis as before, rather than drawn smaller than a section title.
 */
export function fittedWordmarkSize({
  fullSize,
  minSize,
  naturalWidth,
  availableWidth,
}: {
  /** The type role's own size, in points. */
  fullSize: number;
  /** The smallest size it may be drawn at. */
  minSize: number;
  /** The name's width at `fullSize`, measured on the device (Dynamic Type included). */
  naturalWidth: number;
  /** The width the name may take. */
  availableWidth: number;
}): number {
  if (!(naturalWidth > 0) || !(availableWidth > 0)) return fullSize;
  if (naturalWidth <= availableWidth) return fullSize;
  // Rounded down to a tenth of a point so a width that only just fits at the
  // computed size is not lost again to rounding in the text engine.
  const fitted = Math.floor(((fullSize * availableWidth) / naturalWidth) * 10) / 10;
  return Math.max(minSize, Math.min(fullSize, fitted));
}
