import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { maxBackgroundLuminance, relativeLuminance } from '@/lib/color-contrast';
import { appTheme } from '@/lib/theme';

/** Opaque neutral dock. Every fill is a departure from this, and falls back to it. */
export const DEFAULT_TAB_BAR_COLOR = '#1f1f24';
const BASE_RGB = [31, 31, 36] as const;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Inactive tab label on the adaptive bar. It lives here rather than beside the
 * other tab-bar colours because it is one of the two foregrounds the fill has to
 * stay legible under, and the cap below is derived from it — a colour and the
 * constraint it imposes should not be able to drift apart in separate files.
 */
export const ADAPTIVE_INACTIVE_COLOR = '#d2d2d6';

// Read like the theme colours in `magic-tab-bar.tsx`: focused component tests
// mock `@/lib/theme` down to a handful of values and have no `primary`.
const ACTIVE_TINT = appTheme.colors?.primary ?? '#ff7a59';

/**
 * The brightest the fill may get and still clear 4.5:1 for *both* tab-label
 * colours. The coral active tint binds — it is much lighter than the fill and
 * much darker than the inactive label — so this lands near 0.041, roughly three
 * times the neutral dock's own luminance. That is the real headroom: enough for
 * a clearly warm or clearly cool bar, nowhere near enough for a colour slab.
 */
export const MAX_FILL_LUMINANCE = Math.min(
  maxBackgroundLuminance(ACTIVE_TINT),
  maxBackgroundLuminance(ADAPTIVE_INACTIVE_COLOR)
);

/**
 * Rows of the preview to read, as a fraction of its height. The bar floats over
 * the *bottom* of a card, so the bottom band is both the honest sample and the
 * more coherent one — a whole-image mean averages sky into ground and lands on
 * mud almost every time.
 */
const BAND_TOP = 0.62;
const BAND_ROWS = 3;
const BAND_COLUMNS = 7;

// --- the taste knobs -------------------------------------------------------
// Everything below reasons in absolute chroma (max channel minus min), never in
// HSL saturation. HSL normalises chroma by `1 - |2L - 1|`, which explodes a
// rounding error into a strong hue as lightness approaches 0 or 1 — measured on
// round-tripped hashes, a flat #101014 night frame reported 0.20 "saturation"
// and a flat #ebebee studio frame 0.14, both of them purple, from an actual
// chroma of 0.016. Absolute chroma separates those neutrals (0.012-0.016) from
// genuinely coloured media (0.15+) by an order of magnitude.
//
// The floor is subtractive, so quantisation noise resolves to a truly grey bar
// and a grey photo is reported as grey rather than as a failure to adapt.
const CHROMA_NOISE_FLOOR = 0.04;
// The lift is multiplicative above that floor: it scales what the media has
// instead of imposing a minimum, so a vivid scene still out-saturates a muted
// one. Swapping it for a floor (`max(chroma, 0.15)`) would tint every post at
// the cost of flattening dull scenes into vivid ones — the failure this replaced.
const CHROMA_LIFT = 1.6;
const MAX_FILL_CHROMA = 0.22;
// Lightness is compressed into a narrow dark band rather than pinned to one
// value: the fill has to stay a dark panel, but a bright scene should still land
// at the top of the range and a night scene at the bottom. The contrast cap is
// the backstop for legibility; this is only about the fill staying a *panel*.
const MIN_FILL_LIGHTNESS = 0.14;
const MAX_FILL_LIGHTNESS = 0.26;

export type Hsl = { hue: number; saturation: number; lightness: number };
/** A sampled colour, kept in absolute chroma rather than HSL. See the knobs above. */
export type MediaTone = { hue: number; chroma: number; lightness: number };
type Rgb = readonly [number, number, number];

export type TabBarAmbientSource = {
  thumbhash?: string | null;
};

type AmbientViewToken = {
  index?: number | null;
  isViewable?: boolean;
  item?: { previewThumbhash?: string | null } | null;
};

function base64Value(character: string) {
  if (character === '-') return 62;
  if (character === '_') return 63;
  return BASE64_ALPHABET.indexOf(character);
}

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value));
}

function toHex(value: number) {
  return Math.round(value).toString(16).padStart(2, '0');
}

function rgbToHex(rgb: readonly number[]) {
  return `#${rgb.map(toHex).join('')}`;
}

function hexToRgb(color: string) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  return match ? match.slice(1).map((channel) => Number.parseInt(channel, 16)) : [...BASE_RGB];
}

function blendRgb(from: readonly number[], to: readonly number[], amount: number) {
  return from.map((channel, index) => channel * (1 - amount) + to[index] * amount);
}

function rgbToTone([red, green, blue]: readonly number[]): MediaTone {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const lightness = (maximum + minimum) / 2;

  if (chroma === 0) return { hue: 0, chroma: 0, lightness };

  let hue = maximum === red
    ? ((green - blue) / chroma) % 6
    : maximum === green
      ? (blue - red) / chroma + 2
      : (red - green) / chroma + 4;
  hue = ((hue * 60) + 360) % 360;

  return { hue, chroma, lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] = segment < 1 ? [chroma, secondary, 0]
    : segment < 2 ? [secondary, chroma, 0]
      : segment < 3 ? [0, chroma, secondary]
        : segment < 4 ? [0, secondary, chroma]
          : segment < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return [red + offset, green + offset, blue + offset];
}

function decodeBase64(value: string) {
  const trimmed = value.replace(/=+$/, '');
  const bytes = new Uint8Array((trimmed.length * 3) >> 2);
  let written = 0;
  let accumulator = 0;
  let bits = 0;

  for (let index = 0; index < trimmed.length; index += 1) {
    const sextet = base64Value(trimmed[index]);
    if (sextet < 0) return null;

    accumulator = (accumulator << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (accumulator >> bits) & 255;
      written += 1;
    }
  }

  return written === bytes.length ? bytes : bytes.subarray(0, written);
}

type ThumbhashChannels = {
  lDc: number;
  pDc: number;
  qDc: number;
  lAc: number[];
  pAc: number[];
  qAc: number[];
  lx: number;
  ly: number;
};

/**
 * Read a ThumbHash's luminance and chroma coefficients. This is the front half
 * of the reference `thumbHashToRGBA`, stopping before alpha — the dock is opaque
 * and the alpha plane is the only part of the format we can safely skip, since
 * it is decoded last and the shared read cursor never runs backwards.
 *
 * Decoding coefficients rather than pixels is the point: evaluating the basis at
 * 21 chosen sample points costs a fortieth of rasterising the full 32x32 frame
 * the reference decoder builds, and 31 of every 32 of those rows sit above the
 * band we care about anyway.
 */
function readThumbhashChannels(bytes: Uint8Array): ThumbhashChannels | null {
  if (bytes.length < 6) return null;

  const header24 = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
  const header16 = bytes[3] | (bytes[4] << 8);
  const lScale = ((header24 >> 18) & 31) / 31;
  const hasAlpha = header24 >>> 23;
  const isLandscape = header16 >>> 15;
  const lx = Math.max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7);
  const ly = Math.max(3, isLandscape ? header16 & 7 : (hasAlpha ? 5 : 7));

  let cursor = 0;
  const start = hasAlpha ? 6 : 5;
  const readChannel = (nx: number, ny: number, scale: number) => {
    const coefficients: number[] = [];

    for (let cy = 0; cy < ny; cy += 1) {
      for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx += 1) {
        const byte = bytes[start + (cursor >> 1)];
        if (byte === undefined) return null;
        coefficients.push((((byte >> ((cursor & 1) << 2)) & 15) / 7.5 - 1) * scale);
        cursor += 1;
      }
    }

    return coefficients;
  };

  const lAc = readChannel(lx, ly, lScale);
  // The reference decoder boosts chroma by 1.25x here to undo quantisation.
  const pAc = readChannel(3, 3, (((header16 >> 3) & 63) / 63) * 1.25);
  const qAc = readChannel(3, 3, (((header16 >> 9) & 63) / 63) * 1.25);
  if (!lAc || !pAc || !qAc) return null;

  return {
    lDc: (header24 & 63) / 63,
    pDc: ((header24 >> 6) & 63) / 31.5 - 1,
    qDc: ((header24 >> 12) & 63) / 31.5 - 1,
    lAc,
    pAc,
    qAc,
    lx,
    ly,
  };
}

/**
 * Evaluate the DCT at one point, in normalised coordinates. The reference
 * decoder writes its basis as `cos(PI / w * (x + 0.5) * cx)`; substituting
 * `u = (x + 0.5) / w` gives `cos(PI * u * cx)`, which drops the pixel grid — and
 * with it the aspect-ratio round-trip — out of the sampler entirely.
 */
function sampleAt(channels: ThumbhashChannels, u: number, v: number): Rgb {
  const { lDc, pDc, qDc, lAc, pAc, qAc, lx, ly } = channels;
  const fx: number[] = [];
  const fy: number[] = [];

  for (let cx = 0; cx < Math.max(lx, 3); cx += 1) fx[cx] = Math.cos(Math.PI * u * cx);
  for (let cy = 0; cy < Math.max(ly, 3); cy += 1) fy[cy] = Math.cos(Math.PI * v * cy);

  let luminance = lDc;
  for (let cy = 0, index = 0; cy < ly; cy += 1) {
    const fy2 = fy[cy] * 2;
    for (let cx = cy ? 0 : 1; cx * ly < lx * (ly - cy); cx += 1, index += 1) {
      luminance += lAc[index] * fx[cx] * fy2;
    }
  }

  let p = pDc;
  let q = qDc;
  for (let cy = 0, index = 0; cy < 3; cy += 1) {
    const fy2 = fy[cy] * 2;
    for (let cx = cy ? 0 : 1; cx < 3 - cy; cx += 1, index += 1) {
      const factor = fx[cx] * fy2;
      p += pAc[index] * factor;
      q += qAc[index] * factor;
    }
  }

  const blue = luminance - (2 / 3) * p;
  const red = (3 * luminance - blue + q) / 2;
  return [clampUnit(red), clampUnit(red - q), clampUnit(blue)];
}

/**
 * Reduce the sampled band to one colour.
 *
 * Hue is averaged as a vector, not as a number: 350deg and 10deg are neighbours
 * on the wheel but average arithmetically to cyan. Each sample is weighted by
 * its own chroma, so a mostly-grey band still reports the hue of whatever part
 * of it actually carries colour.
 *
 * The length of that resultant vector is the useful by-product. A band whose
 * hues agree produces a long vector; one with clashing hues produces a short
 * one, and scaling chroma by it means "no dominant hue" comes out neutral
 * rather than landing on an averaged colour that is in none of the pixels.
 */
function dominantBandTone(samples: Rgb[]): MediaTone | null {
  if (samples.length === 0) return null;

  let x = 0;
  let y = 0;
  let chroma = 0;
  let lightness = 0;

  for (const sample of samples) {
    const tone = rgbToTone(sample);
    const radians = (tone.hue * Math.PI) / 180;
    x += Math.cos(radians) * tone.chroma;
    y += Math.sin(radians) * tone.chroma;
    chroma += tone.chroma;
    lightness += tone.lightness;
  }

  const coherence = chroma > 0 ? Math.hypot(x, y) / chroma : 0;

  return {
    hue: chroma > 0 ? ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 : 0,
    chroma: (chroma / samples.length) * coherence,
    lightness: lightness / samples.length,
  };
}

/**
 * Map the colour sampled from the media onto the bar's fill. The hue passes
 * through untouched — inventing one is what made the previous bar read as a blue
 * slab under warm media — and only the two channels that decide whether the
 * result is still a *dock* are reshaped.
 *
 * The last line converts the target chroma back into HSL saturation at the
 * fill's own lightness, so the bar carries the chroma this function chose rather
 * than whatever a fixed saturation happens to produce down in the dark.
 */
export function toneMapMediaColor(media: MediaTone): Hsl {
  const lightness = MIN_FILL_LIGHTNESS
    + clampUnit(media.lightness) * (MAX_FILL_LIGHTNESS - MIN_FILL_LIGHTNESS);
  const chroma = Math.min(
    Math.max(0, media.chroma - CHROMA_NOISE_FLOOR) * CHROMA_LIFT,
    MAX_FILL_CHROMA
  );

  return {
    hue: media.hue,
    saturation: clampUnit(chroma / (1 - Math.abs(2 * lightness - 1))),
    lightness,
  };
}

/**
 * Pull a fill back toward the neutral dock until both tab-label colours clear
 * 4.5:1 against it. Binary search rather than a closed form: sRGB luminance is
 * not linear in the blend factor, so the factor that lands exactly on the
 * ceiling has no tidy expression. `high` is always the passing side, so the
 * result is guaranteed under the cap rather than merely near it.
 */
export function capFillLuminance(color: string) {
  if (relativeLuminance(color) <= MAX_FILL_LUMINANCE) return color;

  const target = hexToRgb(color);
  let low = 0;
  let high = 1;

  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (relativeLuminance(rgbToHex(blendRgb(target, BASE_RGB, mid))) > MAX_FILL_LUMINANCE) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return rgbToHex(blendRgb(target, BASE_RGB, high));
}

// Viewability fires on every settle; the same handful of cards are re-reported
// constantly as a feed is scrolled back and forth.
const fillCache = new Map<string, string>();
const FILL_CACHE_LIMIT = 128;

export function getTabBarFillFromThumbhash(thumbhash: string | null | undefined) {
  if (!thumbhash) return DEFAULT_TAB_BAR_COLOR;

  const cached = fillCache.get(thumbhash);
  if (cached) return cached;

  const bytes = decodeBase64(thumbhash);
  const channels = bytes && readThumbhashChannels(bytes);
  let fill = DEFAULT_TAB_BAR_COLOR;

  if (channels) {
    const samples: Rgb[] = [];
    for (let row = 0; row < BAND_ROWS; row += 1) {
      const v = BAND_TOP + ((row + 0.5) / BAND_ROWS) * (1 - BAND_TOP);
      for (let column = 0; column < BAND_COLUMNS; column += 1) {
        samples.push(sampleAt(channels, (column + 0.5) / BAND_COLUMNS, v));
      }
    }

    const media = dominantBandTone(samples);
    if (media) {
      const toned = toneMapMediaColor(media);
      fill = capFillLuminance(
        rgbToHex(hslToRgb(toned.hue, toned.saturation, toned.lightness).map((c) => c * 255))
      );
    }
  }

  if (fillCache.size >= FILL_CACHE_LIMIT) fillCache.clear();
  fillCache.set(thumbhash, fill);
  return fill;
}

export function getTabBarFillFromSource(source: TabBarAmbientSource | null | undefined) {
  // No media means no colour to report. The dock going neutral over a text post
  // is correct information, not a gap to paper over with a category colour.
  return getTabBarFillFromThumbhash(source?.thumbhash);
}

/** Select the visible card nearest the bottom dock, rather than the first one onscreen. */
export function selectBottomVisibleAmbientSource(viewableItems: AmbientViewToken[]) {
  let selected: AmbientViewToken | null = null;
  let selectedIndex = Number.NEGATIVE_INFINITY;

  for (let position = 0; position < viewableItems.length; position += 1) {
    const token = viewableItems[position];
    if (!token.isViewable || !token.item?.previewThumbhash) continue;
    const index = typeof token.index === 'number' ? token.index : position;
    if (index >= selectedIndex) {
      selected = token;
      selectedIndex = index;
    }
  }

  return selected?.item ? { thumbhash: selected.item.previewThumbhash } : null;
}

let currentColor = DEFAULT_TAB_BAR_COLOR;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentColor;
}

export function setTabBarAmbientSource(source: TabBarAmbientSource | null | undefined) {
  const nextColor = getTabBarFillFromSource(source);
  if (nextColor === currentColor) return;
  currentColor = nextColor;
  listeners.forEach((listener) => listener());
}

export function resetTabBarAmbientColor() {
  setTabBarAmbientSource(null);
}

export function useTabBarAmbientColor() {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_TAB_BAR_COLOR);
}

/**
 * Wiring for a scrolling media surface that should tint the dock. Returns a
 * viewability handler and owns the reset, so a screen adopting it cannot forget
 * the half that matters: a tab with no media inherits the neutral dock only
 * because the tab the user just left gave the colour back on blur.
 */
export function useTabBarAmbientFeed(isFocused: boolean) {
  const focused = useRef(isFocused);
  focused.current = isFocused;

  useEffect(() => {
    if (!isFocused) resetTabBarAmbientColor();
  }, [isFocused]);

  useEffect(() => () => resetTabBarAmbientColor(), []);

  return useCallback(({ viewableItems }: { viewableItems: AmbientViewToken[] }) => {
    // A viewability callback can land after the screen has blurred; repainting
    // the dock from a feed the user has already left is worse than not adapting.
    if (!focused.current) return;
    setTabBarAmbientSource(selectBottomVisibleAmbientSource(viewableItems));
  }, []);
}
