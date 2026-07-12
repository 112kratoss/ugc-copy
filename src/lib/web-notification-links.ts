const WEB_ORIGIN = 'https://magicbooklet.local';

/**
 * Converts notification deep links emitted for the mobile app into routes
 * that exist in the web app. Mobile push payloads continue to use their
 * original links; this adapter is only for browser navigation.
 */
export function resolveWebNotificationPath(deepLink: string | null | undefined) {
  if (!deepLink) return null;

  try {
    const url = new URL(deepLink, WEB_ORIGIN);
    if (url.origin !== WEB_ORIGIN && !deepLink.startsWith('/')) return null;

    const initialId = url.searchParams.get('initialId');

    if (url.pathname === '/viewer') {
      if (url.searchParams.get('source') === 'showcase-feed' && initialId) {
        return `/showcase/${encodeURIComponent(initialId)}`;
      }

      if (initialId) {
        return `/creations?generation=${encodeURIComponent(initialId)}`;
      }

      return '/creations';
    }

    if (url.pathname === '/studio') {
      return '/creations';
    }

    if (!url.pathname.startsWith('/')) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
