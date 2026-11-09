import { Caveat } from 'next/font/google';

/*
 * The first sign-up intro's handwriting: Caveat Bold, as the app carries it
 * (`ugc-mobile/assets/fonts/Caveat_700Bold.ttf`). Imported only by the intro.
 */
export const handwritingFont = Caveat({
  subsets: ['latin'],
  weight: '700',
  display: 'swap',
  variable: '--font-handwriting',
});
