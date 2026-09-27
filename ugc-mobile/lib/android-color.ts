/**
 * Palette colours as Android reads them, for Jetpack Compose views from Expo UI.
 *
 * Expo UI hands a colour prop to Android as the string it was given, and
 * Android parses it with `Color.parseColor`, which knows `#RRGGBB`, `#AARRGGBB`
 * and a few names but not the `rgba()` the palettes use for translucent tokens.
 * An unreadable colour fails the whole prop: the view keeps Compose's default
 * and every render logs an error. Eight-digit hex is the quieter trap: CSS and
 * React Native read `#RRGGBBAA`, Android reads `#AARRGGBB`, so the same string
 * draws a different colour instead of failing.
 */

const CSS_HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
const RGB_FUNCTION = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i;

function hexByte(value: number) {
  return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0');
}

/**
 * `#RRGGBB` when the colour is opaque, `#AARRGGBB` (alpha first) when it is not.
 * Anything else comes back unchanged; the palette test keeps every token in a
 * shape this reads.
 */
export function toAndroidColor(color: string): string {
  const hex = CSS_HEX.exec(color);
  if (hex) return hex[2] ? `#${hex[2]}${hex[1]}` : color;

  const rgb = RGB_FUNCTION.exec(color);
  if (!rgb) return color;
  const [, red, green, blue, alpha = '1'] = rgb;
  const channels = [red, green, blue].map((channel) => hexByte(Number(channel))).join('');
  const alphaByte = hexByte(Number(alpha) * 255);
  return alphaByte === 'ff' ? `#${channels}` : `#${alphaByte}${channels}`;
}
