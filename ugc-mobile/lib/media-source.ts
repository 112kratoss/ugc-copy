/** Only our private-media redirect may receive the app session. Never a CDN or provider URL. */
export function isAuthenticatedMediaProxy(url: string, apiBaseUrl: string): boolean {
  if (url.includes('\\')) return false;
  try {
    const base = new URL(apiBaseUrl);
    const parsed = new URL(url, base);
    return (base.protocol === 'https:' || base.protocol === 'http:')
      && parsed.origin === base.origin
      && !parsed.username && !parsed.password
      && (parsed.pathname === '/api/media' || parsed.pathname === '/api/media/');
  } catch {
    return false;
  }
}

export function buildMediaSource(url: string, apiBaseUrl: string, accessToken?: string | null): {
  uri: string;
  headers?: Record<string, string>;
} {
  if (!isAuthenticatedMediaProxy(url, apiBaseUrl)) return { uri: url };
  return {
    uri: new URL(url, apiBaseUrl).href,
    ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
  };
}
