import { routeForSystemLink } from '@/lib/oauth-callback-link';

/**
 * Every link the system hands the app (a deep link, a universal link, Google sign-in's redirect)
 * passes here before expo-router navigates to it. The sign-in redirect is the auth session's to
 * read, never a screen: without this, Android opened "Not Found" over the sign-in page while the
 * code was exchanged (`lib/oauth-callback-link.ts`). Everything else goes through unchanged.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  return routeForSystemLink(path, initial);
}
