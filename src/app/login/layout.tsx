import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Log In',
    'Sign in to your magicbooklet account to manage credits, projects, and AI generation workflows.'
);

export default function LoginLayout({ children }: { children: React.ReactNode }) {
    return children;
}
