import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequireAuth } from '@/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
  'Credit history',
  'Every credit added to and used from your magicbooklet balance: purchases, rewards, refunds and creations.'
);

/** A signed-out visitor is sent to sign in and brought back here. */
export default async function CreditsLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth returnTo="/credits">{children}</RequireAuth>;
}
