import { Metadata } from 'next';

export const metadata: Metadata = {
    title: "Pricing | UGC copy",
    description: "Flexible pay-as-you-go pricing for AI video generation. Buy credits to create amazing AI-powered videos. No subscriptions, no hidden fees.",
    alternates: {
        canonical: '/pricing',
    }
};

export default function PricingLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <>{children}</>;
}
