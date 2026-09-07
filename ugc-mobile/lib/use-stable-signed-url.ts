import { useRef } from 'react';
import { env } from './env';
import { getPrivateMediaExpiry } from './media-url-expiry';

/** Adopt a fresh signature this close to the held one expiring. */
const ADOPT_WITHIN_MS = 60_000;

/** The object a URL addresses, ignoring its signature or other query parameters. */
export function signedMediaIdentity(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Whether a player that already loads `held` should move to `next`. A different
 * object always wins. The same object with a fresh signature is only adopted when
 * the held signature is about to expire; otherwise the player keeps its download.
 * URLs without a readable private signature follow the parent.
 */
export function shouldAdoptSignedUrl(held: string, next: string, now: number, storageBaseUrl: string): boolean {
  if (held === next) return false;
  if (signedMediaIdentity(held) !== signedMediaIdentity(next)) return true;
  const expiry = getPrivateMediaExpiry(held, storageBaseUrl);
  if (!expiry) return true;
  return expiry.expiresAt - now <= ADOPT_WITHIN_MS;
}

/**
 * A list refetch re-signs the same object about a second after the viewer opens.
 * Recreating the native player for that restarts its download from byte zero,
 * which on a capped connection is the difference between a first frame at three
 * seconds and the stalled-load deadline. Hold the URL the player already loads
 * until the parent addresses a different object or the signature nears expiry;
 * `useMediaSource` still renews the held URL through the authenticated route.
 */
export function useStableSignedUrl(url: string): string {
  const held = useRef(url);
  if (shouldAdoptSignedUrl(held.current, url, Date.now(), env.supabaseUrl)) held.current = url;
  return held.current;
}
