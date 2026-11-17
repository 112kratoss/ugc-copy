import localFont from 'next/font/local';

/*
 * The app's display face (`DISPLAY_FONT` in `ugc-mobile/lib/theme.ts`) for the
 * onboarding screens: the sign-in page's headline and wordmark, the
 * first sign-up intro. Imported only by the routes that draw it (`/login`,
 * `/onboarding`), and nothing the root layout reaches may import it, however
 * lazily: Next preloads a font on every route whose module graph reaches its
 * loader, async chunks included, and the welcome-credits popup, which the root
 * layout lazy-loads, took this face until 2026-11-17 and made all 71 routes
 * preload it (and Caveat, which shares its CSS chunk). The popup has its own,
 * `welcome-popup-font.ts`; `root-layout-font-graph.test.ts` holds the line.
 *
 * Bricolage Grotesque, served from `src/fonts/` (the files `next/font/google`
 * produced, see `src/fonts/README.md`) so the build never reaches Google. A face
 * is one file per Google subset with that subset's `unicode-range`, as Google's
 * stylesheet is, so a character outside Latin loads only the file that has it:
 * `displayFontVietnamese` and `displayFontLatinExt` exist to put their faces on
 * the page, and only `displayFont`, the Latin face, is preloaded and gives the
 * class, the variable and the fallback metrics.
 *
 * Family name: next/font/local names the class and the variable's family after the
 * const (here `displayFont`), whatever a `font-family` declaration says, so the
 * subset faces declare that name, and `no-google-fonts-at-build.test.ts` holds
 * every declared family to the exported const's name. Renaming the const means
 * renaming the declarations.
 */

const displayFontVietnamese = localFont({
  src: [
    { path: '../fonts/bricolage-grotesque-vietnamese.woff2', weight: '700', style: 'normal' },
    { path: '../fonts/bricolage-grotesque-vietnamese.woff2', weight: '800', style: 'normal' },
  ],
  declarations: [
    { prop: 'font-family', value: 'displayFont' },
    { prop: 'unicode-range', value: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB' },
    { prop: 'font-stretch', value: '100%' },
  ],
  display: 'swap',
  adjustFontFallback: false,
  preload: false,
});

const displayFontLatinExt = localFont({
  src: [
    { path: '../fonts/bricolage-grotesque-latin-ext.woff2', weight: '700', style: 'normal' },
    { path: '../fonts/bricolage-grotesque-latin-ext.woff2', weight: '800', style: 'normal' },
  ],
  declarations: [
    { prop: 'font-family', value: 'displayFont' },
    { prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF' },
    { prop: 'font-stretch', value: '100%' },
  ],
  display: 'swap',
  adjustFontFallback: false,
  preload: false,
});

export const displayFont = localFont({
  src: [
    { path: '../fonts/bricolage-grotesque-latin.woff2', weight: '700', style: 'normal' },
    { path: '../fonts/bricolage-grotesque-latin.woff2', weight: '800', style: 'normal' },
  ],
  declarations: [
    { prop: 'unicode-range', value: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' },
    { prop: 'font-stretch', value: '100%' },
  ],
  display: 'swap',
  variable: '--font-display',
});

/** The subset faces `displayFont` does not carry, kept referenced so no bundler drops their CSS. */
export const displayFontSubsetFaces = [displayFontVietnamese, displayFontLatinExt];
