import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/app/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
    'My Creations',
    'Review and manage your private generation history, downloads, and showcase publishing state inside UGC copy.'
);

export default async function CreationsLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth returnTo="/creations">{children}</RequireAuth>;
}
