import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Create',
    'Launch your UGC copy workspace to generate AI images, videos, motion-transfer ads, and reusable workflows.'
);

export default function CreateLayout({ children }: { children: React.ReactNode }) {
    return children;
}

