import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequestHintedOptionalAuth } from '@/components/RouteAuthBoundary';
import { reopenCreatorNameStepFromHome } from '@/lib/creator-name-step-server';
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
  'Your Magic Booklet workspace: community feed and recent creations.'
);

export default async function HomeDashboardLayout({ children }: { children: React.ReactNode }) {
  // An account without a creator name is sent to the name step first, once
  // per browser session (owner, 2026-11-08 for the app: "Yes, reopen it").
  await reopenCreatorNameStepFromHome();
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
