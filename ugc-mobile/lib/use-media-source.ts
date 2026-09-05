import { useEffect, useMemo, useState } from 'react';

import { useAuth } from './auth';
import { env } from './env';
import { buildMediaSource, isAuthenticatedMediaProxy } from './media-source';
import { getPrivateMediaExpiry, resolveMediaUrlForExpiry } from './media-url-expiry';

export function useMediaSource(url: string) {
  const { session } = useAuth();
  const [expiryCheck, updateExpiry] = useState(0);
  const expiry = useMemo(() => getPrivateMediaExpiry(url, env.supabaseUrl), [url]);
  const effectiveUrl = resolveMediaUrlForExpiry(url, env.supabaseUrl, env.apiBaseUrl, Date.now());
  useEffect(() => {
    if (!expiry || effectiveUrl !== url) return;
    const timer = setTimeout(() => updateExpiry(value => value + 1),
      Math.min(2_147_483_647, Math.max(0, expiry.expiresAt - 30_000 - Date.now())));
    return () => clearTimeout(timer);
  }, [expiry, effectiveUrl, url, expiryCheck]);
  const authenticated = isAuthenticatedMediaProxy(effectiveUrl, env.apiBaseUrl);
  const token = authenticated ? session?.access_token : undefined;
  const source = useMemo(() => buildMediaSource(effectiveUrl, env.apiBaseUrl, token), [effectiveUrl, token]);
  // Retrying after sign-in or token renewal must release an old failure latch.
  // This identity deliberately excludes the credential itself.
  const requestKey = authenticated && session
    ? `${session.user.id}:${session.expires_at ?? ''}`
    : '';
  return { source, requestKey };
}
