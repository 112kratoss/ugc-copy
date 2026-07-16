import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Create Image',
    'Generate images inside the magicbooklet app using prompt-driven and reference-guided AI image workflows.'
);

export default function CreateImageLayout({ children }: { children: React.ReactNode }) {
    return children;
}
