import { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { createMetadata, siteConfig } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'Contact',
    description:
        `Get in touch with the ${siteConfig.name} team for support, partnerships, and questions about AI video generation, motion transfer, or pricing.`,
    path: '/contact',
});

export default function ContactLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <>{children}</>;
}
