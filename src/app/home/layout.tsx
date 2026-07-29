import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequestHintedOptionalAuth } from '@/app/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';

/**
 * Internal rewrite target for signed-in `/` (see `resolveRootHomeRouting` in
 * src/proxy.ts). Never a public URL — direct hits are redirected back to `/`
 * by the middleware, robots.ts disallows it, and the metadata below is
 * noindex. The optional-auth boundary verifies the hinted cookie once;
 * `getServerAuthState` is request-cached, so the page's own call is free.
 */
export const metadata: Metadata = createNoIndexMetadata(
  'Home',
  'Your magicbooklet workspace: community feed, active generations, and quick starts.'
);

/**
 * Note: post links from this route do NOT open the overlay that
 * `src/app/@modal` provides elsewhere. Interception is matched against the
 * `Next-Url` header, which carries the browser path `/`, while this segment is
 * what the middleware rewrote to — so no slot's rule matches. Signed-in home
 * navigates to the full post page instead (client-side, so the shell stays).
 * Removing the rewrite would restore the overlay here; see
 * `resolveRootHomeRouting` in src/proxy.ts.
 */
export default function HomeDashboardLayout({ children }: { children: React.ReactNode }) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
