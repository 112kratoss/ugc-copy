import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/app/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
    'Motion Transfer Studio',
    'Run motion-transfer generations inside magicbooklet using a character image and a reference performance clip.'
);

export default async function CreateMotionLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth returnTo="/create-motion">{children}</RequireAuth>;
}
