/**
 * Where the app is listed. Both listings are live (0.1.8 on the App Store since
 * 2026-10-13 and on Google Play since 2026-09-29), and the app carries the same
 * two links (`ugc-mobile/lib/env.ts`), so they are written here: until
 * 2026-11-10 they came only from `NEXT_PUBLIC_APP_STORE_URL` and
 * `NEXT_PUBLIC_PLAY_STORE_URL`, which production never set, and no page of the
 * site led to either store. The variables still win where they are set.
 *
 * Read in the browser as well as on the server: no `server-only` here.
 */
export const DEFAULT_APP_STORE_URL = 'https://apps.apple.com/app/id6773286115';
export const DEFAULT_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.magicbooklet.mobile';

export type AppStoreLinks = { appStore: string; playStore: string };

export function getAppStoreLinks(): AppStoreLinks {
  return {
    appStore: process.env.NEXT_PUBLIC_APP_STORE_URL?.trim() || DEFAULT_APP_STORE_URL,
    playStore: process.env.NEXT_PUBLIC_PLAY_STORE_URL?.trim() || DEFAULT_PLAY_STORE_URL,
  };
}
