import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/app/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
    'Your unlocks',
    'Open a resource unlock you purchased, including unlocks whose post the creator has since removed.'
);

export default async function UnlocksLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth returnTo="/creations?view=unlocks">{children}</RequireAuth>;
}
