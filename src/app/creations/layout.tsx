import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'My Creations',
    'Review and manage your private generation history, downloads, and showcase publishing state inside UGC copy.'
);

export default function CreationsLayout({ children }: { children: React.ReactNode }) {
    return children;
}

