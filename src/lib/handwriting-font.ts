import localFont from 'next/font/local';

/*
 * The first sign-up intro's handwriting: Caveat Bold, as the app carries it
 * (`ugc-mobile/assets/fonts/Caveat_700Bold.ttf`). Imported only by the intro.
 *
 * Served from `src/fonts/` like the display face (`display-font.ts` says how:
 * one file and `unicode-range` per Google subset, the Latin face carries the
 * class, the variable and the fallback metrics; the subset faces declare the
 * exported const's name as their family, which is what the class names).
 */

const handwritingFontCyrillicExt = localFont({
  src: [
    { path: '../fonts/caveat-700-cyrillic-ext.woff2', weight: '700', style: 'normal' },
  ],
  declarations: [
    { prop: 'font-family', value: 'handwritingFont' },
    { prop: 'unicode-range', value: 'U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F' },
  ],
  display: 'swap',
  adjustFontFallback: false,
  preload: false,
});

const handwritingFontCyrillic = localFont({
  src: [
    { path: '../fonts/caveat-700-cyrillic.woff2', weight: '700', style: 'normal' },
  ],
  declarations: [
    { prop: 'font-family', value: 'handwritingFont' },
    { prop: 'unicode-range', value: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116' },
  ],
  display: 'swap',
  adjustFontFallback: false,
  preload: false,
});

const handwritingFontLatinExt = localFont({
  src: [
    { path: '../fonts/caveat-700-latin-ext.woff2', weight: '700', style: 'normal' },
  ],
  declarations: [
    { prop: 'font-family', value: 'handwritingFont' },
    { prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF' },
  ],
  display: 'swap',
  adjustFontFallback: false,
  preload: false,
});

export const handwritingFont = localFont({
  src: [
    { path: '../fonts/caveat-700-latin.woff2', weight: '700', style: 'normal' },
  ],
  declarations: [
    { prop: 'unicode-range', value: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' },
  ],
  display: 'swap',
  variable: '--font-handwriting',
});

/** The subset faces `handwritingFont` does not carry, kept referenced so no bundler drops their CSS. */
export const handwritingFontSubsetFaces = [handwritingFontCyrillicExt, handwritingFontCyrillic, handwritingFontLatinExt];
