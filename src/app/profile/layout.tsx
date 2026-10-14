import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequireAuth } from '@/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';
import { getServerAuthState } from '@/lib/supabase-server';

import ProfileSignInRedirect from './ProfileSignInRedirect';

export const metadata: Metadata = createNoIndexMetadata(
  'Profile',
  'Manage your creator profile, public identity, and showcase links inside magicbooklet.'
);

export default async function ProfileLayout({ children }: { children: React.ReactNode }) {
  // Every /profile page comes back to itself after sign-in (/profile/blocked
  // and /profile/edit landed on /profile). The layout cannot read the address,
  // so a signed-out visitor is sent on from the browser; a page that reads the
  // account redirects on the server with its own return path first.
  const auth = await getServerAuthState();
  if (!auth.session?.user) {
    return <ProfileSignInRedirect />;
  }

  // Signed in by now (the auth state is read once per request), so this only
  // provides the session to the pages.
  return <RequireAuth returnTo="/profile">{children}</RequireAuth>;
}
