import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequireAuth } from '@/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
  'Message support',
  'Write to Magic Booklet support about a creation, a purchase or your account, and read our replies.'
);

/** A signed-out visitor is sent to sign in and brought back here. */
export default async function SupportLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth returnTo="/support">{children}</RequireAuth>;
}
