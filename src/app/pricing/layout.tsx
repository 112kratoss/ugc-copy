import { Metadata } from 'next';

import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'Pricing',
    description:
        'Compare UGC copy credit packs for AI image generation, AI video generation, motion transfer, and reusable workflow production.',
    path: '/pricing',
});

export default function PricingLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <>{children}</>;
}
