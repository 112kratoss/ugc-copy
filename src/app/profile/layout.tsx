import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/app/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
  'Profile',
  'Manage your creator profile, public identity, and showcase links inside magicbooklet.'
);

export default async function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth returnTo="/profile">{children}</RequireAuth>;
}
