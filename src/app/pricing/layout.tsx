import { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'Pricing',
    description:
        'Compare magicbooklet credit packs for AI image generation, AI video generation, motion transfer, and reusable workflow production.',
    path: '/pricing',
});

export default function PricingLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <>{children}</>;
}
