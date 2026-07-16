import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequireAuth } from '@/app/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
  'Invite & Earn',
  'Share magicbooklet with friends and track the bonus credits earned from verified top-ups.'
);

export default async function InviteLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth returnTo="/invite">{children}</RequireAuth>;
}
