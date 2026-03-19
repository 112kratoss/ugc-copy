import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Motion Transfer Studio',
    'Run motion-transfer generations inside UGC copy using a character image and a reference performance clip.'
);

export default function CreateMotionLayout({ children }: { children: React.ReactNode }) {
    return children;
}

