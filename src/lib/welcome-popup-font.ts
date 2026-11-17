import localFont from 'next/font/local';

/*
 * The welcome-credits popup's copy of the display face (`display-font.ts`): Bricolage
 * Grotesque 700/800 from the same committed Latin file, never preloaded. Next names a
 * preloaded face's file with a `.p.` (`…-s.p.<hash>.woff2`) and this one without it, so the
 * two URLs differ: a browser that loaded /login's copy downloads this one again (about
 * 41 KB) when the popup opens, the price of no other page preloading it. The root layout reaches the
 * popup through two dynamic imports and Next preloads a font on every route whose module
 * graph reaches its loader, async chunks included, so a popup that took `displayFont`
 * made every page (/terms, /admin, the not-found page) preload the display face and
 * Caveat for a popup that opens for some signed-in visitors. This loader is the popup's
 * alone: the face downloads when the popup opens (`display: 'swap'`, as before, with the
 * fallback until it lands) and no page preloads it.
 *
 * Latin only: the popup's headline and figure are English words and digits.
 */

export const welcomePopupFont = localFont({
  src: [
    { path: '../fonts/bricolage-grotesque-latin.woff2', weight: '700', style: 'normal' },
    { path: '../fonts/bricolage-grotesque-latin.woff2', weight: '800', style: 'normal' },
  ],
  declarations: [{ prop: 'font-stretch', value: '100%' }],
  display: 'swap',
  preload: false,
});
