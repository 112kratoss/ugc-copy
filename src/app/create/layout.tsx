import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/app/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
    'Create',
    'Launch your magicbooklet workspace to generate AI images, videos, motion-transfer ads, and reusable workflows.'
);

export default async function CreateLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth returnTo="/create">{children}</RequireAuth>;
}
