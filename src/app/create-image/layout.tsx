import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/app/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
    'Create Image',
    'Generate images inside the UGC copy app using prompt-driven and reference-guided AI image workflows.'
);

export default async function CreateImageLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth returnTo="/create-image">{children}</RequireAuth>;
}
