import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/app/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
    'Studio',
    'Review and manage your private generation history, downloads, and showcase publishing state inside magicbooklet.'
);

export default async function CreationsLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth returnTo="/creations">{children}</RequireAuth>;
}
