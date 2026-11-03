import { useEffect, useMemo, useState } from 'react';

import { useAuth } from './auth';
import { env } from './env';
import { buildMediaSource, isAuthenticatedMediaProxy } from './media-source';
import {
  PRIVATE_MEDIA_ROUTE_WITHIN_MS,
  getPrivateMediaExpiry,
  isPrivateMediaNearExpiry,
  privateMediaRouteUrl,
} from './media-url-expiry';
import { whenClockReaches } from './wall-clock-timer';

/**
 * The source to load `url` from: a private signed address goes through the
 * authenticated route once its signature is within 30 s of its end, with the
 * session that route needs.
 *
 * All of it is worked out once per address, and again only when the clock
 * reaches that address's end (`whenClockReaches`). It used to be worked out on
 * every render: two URL parses and a token decode to date the address, and two
 * more parses to ask whether it was the route. On Android that was 15–25% of
 * the JS a tab switch ran (Hermes CPU profile, 2026-11-03), for every image
 * mounted.
 */
export function useMediaSource(url: string) {
  const { session } = useAuth();
  const expiry = useMemo(() => getPrivateMediaExpiry(url, env.supabaseUrl), [url]);
  const routeUrl = useMemo(() => (expiry ? privateMediaRouteUrl(expiry, env.apiBaseUrl) : null), [expiry]);
  // An address that arrives that close to its end goes to the route from its
  // first render, which reads the clock once for it, not on every render.
  const endedOnArrival = useMemo(() => Boolean(expiry && isPrivateMediaNearExpiry(expiry, Date.now())), [expiry]);
  // One that gets there while it is drawn is marked as the clock gets there.
  const [endedUrl, setEndedUrl] = useState<string | null>(null);
  const effectiveUrl = routeUrl && (endedOnArrival || endedUrl === url) ? routeUrl : url;
  useEffect(() => {
    if (!expiry || effectiveUrl !== url) return undefined;
    return whenClockReaches(expiry.expiresAt - PRIVATE_MEDIA_ROUTE_WITHIN_MS, () => setEndedUrl(url));
  }, [expiry, effectiveUrl, url]);
  const authenticated = useMemo(() => isAuthenticatedMediaProxy(effectiveUrl, env.apiBaseUrl), [effectiveUrl]);
  const token = authenticated ? session?.access_token : undefined;
  const source = useMemo(() => buildMediaSource(effectiveUrl, env.apiBaseUrl, token), [effectiveUrl, token]);
  // Retrying after sign-in or token renewal must release an old failure latch.
  // This identity deliberately excludes the credential itself.
  const requestKey = authenticated && session
    ? `${session.user.id}:${session.expires_at ?? ''}`
    : '';
  return { source, requestKey };
}
