import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
  'Profile',
  'Manage your creator profile, public identity, and showcase links inside UGC copy.'
);

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
