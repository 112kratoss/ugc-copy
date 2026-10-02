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

/**
 * A video source for a looping player, read through expo-video's disk cache.
 *
 * Android loops a clip by queueing it again behind itself, and its player
 * buffers 50 seconds ahead across those copies. Without the cache every copy is
 * a new download of the whole file: a paused 12s clip was fetched five times, a
 * 5s clip eleven times, and a playing clip once more on every loop (measured
 * 2026-10-02). Through the cache each copy after the first is read from disk.
 *
 * Only a network URL is cached. A file already on the device would be copied
 * into the cache, pushing downloaded media out of it.
 */
export function cachedVideoSource<Source extends { uri: string }>(source: Source): Source & { useCaching: boolean } {
  return { ...source, useCaching: /^https?:\/\//i.test(source.uri) };
}
