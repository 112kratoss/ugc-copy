import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
    'Unlocked recipes',
    'Open a recipe you unlocked, including recipes whose post the creator has since removed.'
);

export default async function UnlocksLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth returnTo="/creations?view=unlocks">{children}</RequireAuth>;
}
