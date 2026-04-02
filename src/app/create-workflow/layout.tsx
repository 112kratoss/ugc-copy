import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Workflow Canvas',
    'Open the UGC copy workflow canvas to connect prompts, media inputs, generation nodes, and reusable automations.'
);

export default function CreateWorkflowLayout({ children }: { children: React.ReactNode }) {
    return children;
}
