import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Create Video',
    'Generate AI videos inside the magicbooklet app with multi-shot prompts, reference images, and export controls.'
);

export default function CreateVideoLayout({ children }: { children: React.ReactNode }) {
    return children;
}
