import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Create Video',
    'Generate AI videos inside the UGC copy app with multi-shot prompts, reference images, and export controls.'
);

export default function CreateVideoLayout({ children }: { children: React.ReactNode }) {
    return children;
}

