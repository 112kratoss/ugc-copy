import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
    'Sign in',
    'Sign in to Magic Booklet with Apple or Google, or with the email your account was made with.'
);

export default function LoginLayout({ children }: { children: React.ReactNode }) {
    return children;
}
