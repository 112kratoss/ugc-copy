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

export default function HomeDashboardLayout({ children }: { children: React.ReactNode }) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
