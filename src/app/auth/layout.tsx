import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Authentication',
    'Complete or recover your magicbooklet authentication flow.'
);

export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return children;
}
