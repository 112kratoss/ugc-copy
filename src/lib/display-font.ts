import { Bricolage_Grotesque } from 'next/font/google';

/*
 * The app's display face (`DISPLAY_FONT` in `ugc-mobile/lib/theme.ts`) for the
 * onboarding screens: the sign-in page's headline and wordmark, the
 * welcome-credits popup and the first sign-up intro. Imported only where it is
 * used, never by the root layout, so no other page loads it.
 */
export const displayFont = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['700', '800'],
  display: 'swap',
  variable: '--font-display',
});
