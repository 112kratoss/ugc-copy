import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequireAuth } from '@/app/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
  'Profile',
  'Manage your creator profile, public identity, and showcase links inside magicbooklet.'
);

export default async function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth returnTo="/profile">{children}</RequireAuth>;
}
