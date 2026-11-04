import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Authentication',
    'Complete or recover your Magic Booklet authentication flow.'
);

export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return children;
}
