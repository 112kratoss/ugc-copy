import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';
import { RequireAuth } from '@/app/components/RouteAuthBoundary';

export const metadata: Metadata = createNoIndexMetadata(
    'Workflow Canvas',
    'Open the UGC copy workflow canvas to connect prompts, media inputs, generation nodes, and reusable automations.'
);

export default async function CreateWorkflowLayout({ children }: { children: React.ReactNode }) {
    return <RequireAuth returnTo="/create-workflow">{children}</RequireAuth>;
}
