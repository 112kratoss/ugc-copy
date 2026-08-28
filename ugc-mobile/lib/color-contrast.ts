/**
 * WCAG AA relative luminance and contrast — the thresholds Accessibility
 * Inspector reports against: 4.5:1 for text up to 17pt, 3:1 for 18pt+ or bold.
 *
 * This lives in `lib` rather than inside a test helper because the adaptive tab
 * bar clamps its own fill against these numbers at runtime. A guard test and the
 * code it guards have to agree on the arithmetic, and two hand-copied versions
 * of the sRGB transfer function eventually disagree.
 */

/** WCAG's minimum for body text; the floor `hig-type-and-contrast.test.ts` enforces. */
export const MIN_BODY_CONTRAST = 4.5;

export function relativeLuminance(color: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The brightest a background may get while `foreground` still clears `minimum`
 * against it. Inverting the contrast formula is what lets the tab bar cap its
 * own adaptive fill instead of hoping a hand-picked palette happens to pass.
 */
export function maxBackgroundLuminance(foreground: string, minimum = MIN_BODY_CONTRAST) {
  return (relativeLuminance(foreground) + 0.05) / minimum - 0.05;
}
