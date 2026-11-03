function signedTokenExpiresAt(source: URL): number | null {
  const payload = source.searchParams.get('token')?.split('.')[1];
  if (!payload) return null;
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as { exp?: unknown };
  if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp) || parsed.exp <= 0) return null;
  return parsed.exp * 1000;
}

type PrivateMediaExpiry = Readonly<{
  expiresAt: number;
  bucket: string;
  path: string;
}>;

/** The addresses dated last, by Storage base and address, oldest first. */
const datedAddresses = new Map<string, PrivateMediaExpiry | null>();
const MAX_DATED_ADDRESSES = 256;

/**
 * Metadata only: the server still authorizes the replacement URL.
 *
 * Worked out once per address. Every picture asks it of its address several
 * times over (`StableMediaImage`'s key and its move to a newer signature,
 * `useMediaSource`), and each answer parses two URLs and decodes a token: on a
 * list read again, which signs every file anew, that was every tile on screen
 * at once. The answer is one frozen object, the same each time.
 */
export function getPrivateMediaExpiry(url: string, storageBaseUrl: string): PrivateMediaExpiry | null {
  const key = `${storageBaseUrl}\n${url}`;
  const dated = datedAddresses.get(key);
  if (dated !== undefined) return dated;
  const expiry = readPrivateMediaExpiry(url, storageBaseUrl);
  datedAddresses.set(key, expiry);
  if (datedAddresses.size > MAX_DATED_ADDRESSES) datedAddresses.delete(datedAddresses.keys().next().value!);
  return expiry;
}

function readPrivateMediaExpiry(url: string, storageBaseUrl: string): PrivateMediaExpiry | null {
  try {
    const source = new URL(url);
    const storage = new URL(storageBaseUrl);
    if (source.origin !== storage.origin || source.username || source.password || url.includes('\\')) return null;
    const match = /^\/storage\/v1\/object\/sign\/(generated_images|generated_videos|generated_audio|generation_inputs)\/(.+)$/.exec(source.pathname);
    if (!match) return null;
    const expiresAt = signedTokenExpiresAt(source);
    if (expiresAt === null) return null;
    const path = decodeURIComponent(match[2]);
    if (!path || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) return null;
    return Object.freeze({ expiresAt, bucket: match[1], path });
  } catch {
    return null;
  }
}

/**
 * When a signed Storage link stops working, in any bucket, or null for a URL
 * this cannot date. It only ever decides that media needs a fresh link and is
 * never turned into one, so unlike getPrivateMediaExpiry it is not limited to
 * the buckets the media proxy serves.
 */
export function signedStorageUrlExpiresAt(url: string, storageBaseUrl: string): number | null {
  try {
    const source = new URL(url);
    const storage = new URL(storageBaseUrl);
    if (source.origin !== storage.origin || !source.pathname.startsWith('/storage/v1/object/sign/')) return null;
    return signedTokenExpiresAt(source);
  } catch {
    return null;
  }
}

/** How close to its end a signed address is read through the authenticated media route instead. */
export const PRIVATE_MEDIA_ROUTE_WITHIN_MS = 30_000;

/** Whether a signed address dated by `getPrivateMediaExpiry` is within `PRIVATE_MEDIA_ROUTE_WITHIN_MS` of its end. */
export function isPrivateMediaNearExpiry(expiry: { expiresAt: number }, now: number): boolean {
  return expiry.expiresAt <= now + PRIVATE_MEDIA_ROUTE_WITHIN_MS;
}

/** The authenticated media route's address for a private object, which signs it afresh on each request. */
export function privateMediaRouteUrl(expiry: { bucket: string; path: string }, apiBaseUrl: string): string {
  const proxy = new URL('/api/media', apiBaseUrl);
  proxy.search = new URLSearchParams({ bucket: expiry.bucket, path: expiry.path }).toString();
  return proxy.href;
}

export function resolveMediaUrlForExpiry(url: string, storageBaseUrl: string, apiBaseUrl: string, now: number): string {
  const expiry = getPrivateMediaExpiry(url, storageBaseUrl);
  if (!expiry || !isPrivateMediaNearExpiry(expiry, now)) return url;
  return privateMediaRouteUrl(expiry, apiBaseUrl);
}
