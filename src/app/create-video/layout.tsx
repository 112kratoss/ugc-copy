import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/app/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
    'Create Video',
    'Generate AI videos inside the magicbooklet app with multi-shot prompts, reference images, and export controls.'
);

export default async function CreateVideoLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth returnTo="/create-video">{children}</RequireAuth>;
}
