import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequestHintedOptionalAuth } from '@/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';

/**
 * The OAuth consent screen (`/oauth/consent`), for a signed-in account only: the page sends a
 * signed-out visitor to sign in and refuses a guest, so it is never indexed. The optional-auth
 * boundary gives the page the verified session it decides with.
 */
export const metadata: Metadata = createNoIndexMetadata(
  'Connect an app',
  'Allow an AI assistant to act with your Magicbooklet account.'
);

export default function OAuthLayout({ children }: { children: React.ReactNode }) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
