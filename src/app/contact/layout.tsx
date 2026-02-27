import { Metadata } from 'next';

export const metadata: Metadata = {
    title: "Contact Us | UGC copy",
    description: "Get in touch with the UGC copy team. We're here to help with your AI video generation questions, support, or partnership inquiries.",
    alternates: {
        canonical: '/contact',
    }
};

export default function ContactLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <>{children}</>;
}
