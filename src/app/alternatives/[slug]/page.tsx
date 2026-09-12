import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, CheckCircle2 } from 'lucide-react';

import { Button, Kicker, SectionHeader, Surface, Text } from '@/components/DesignSystem';
import { JsonLd } from '@/components/JsonLd';
import { ALTERNATIVES, findAlternative } from '@/lib/alternatives';
import {
    buildBreadcrumbSchema,
    buildFaqSchema,
    createMetadata,
    siteConfig,
} from '@/lib/seo';

type AlternativePageProps = {
    params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
    return ALTERNATIVES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: AlternativePageProps): Promise<Metadata> {
    const { slug } = await params;
    const entry = findAlternative(slug);

    if (!entry) {
        return { title: 'Comparison Not Found' };
    }

    return createMetadata({
        title: `${entry.competitor} Alternative`,
        description:
            `An honest comparison of ${entry.competitor} and ${siteConfig.name} for AI ad creative — where each one is stronger, how the pricing models differ, and which to pick.`,
        path: `/alternatives/${slug}`,
        keywords: [
            `${entry.competitor} alternative`,
            `${entry.competitor} vs ${siteConfig.name}`,
            `${entry.competitor} comparison`,
            'AI UGC ad tools',
        ],
    });
}

export default async function AlternativePage({ params }: AlternativePageProps) {
    const { slug } = await params;
    const entry = findAlternative(slug);

    if (!entry) {
        notFound();
    }

    const others = ALTERNATIVES.filter((item) => item.slug !== entry.slug);

    return (
        <div className="ui-page ui-page-ambient overflow-hidden">
            <JsonLd
                data={[
                    buildBreadcrumbSchema([
                        { name: 'Home', path: '/' },
                        { name: 'Alternatives', path: '/alternatives' },
                        { name: `${entry.competitor} alternative`, path: `/alternatives/${slug}` },
                    ]),
                    buildFaqSchema(entry.faqs),
                ]}
            />

            <main className="studio-shell ui-section-gap relative py-20">
                <section className="space-y-6">
                    <Kicker>Comparison</Kicker>
                    <Text as="h1" variant="display" className="max-w-4xl">
                        {entry.competitor} alternative: an honest comparison
                    </Text>
                    <Text variant="body" className="max-w-3xl text-lg leading-8">
                        {entry.positioning}
                    </Text>
                    <Text variant="body" className="max-w-3xl leading-7">
                        Below is where {entry.competitor} is genuinely the better choice, where{' '}
                        {siteConfig.name} differs, and how to tell which one fits your work. Pricing
                        plans change, so this compares how each product charges rather than quoting
                        figures that will be out of date — check{' '}
                        <a
                            href={entry.pricingUrl}
                            rel="nofollow noopener"
                            target="_blank"
                            className="ui-focus-ring rounded-sm text-[var(--ui-primary)] hover:underline"
                        >
                            {entry.competitor}&apos;s own pricing page
                        </a>{' '}
                        and <Link href="/pricing" className="ui-focus-ring rounded-sm text-[var(--ui-primary)] hover:underline">ours</Link> for current numbers.
                    </Text>
                </section>

                <section className="space-y-6">
                    <SectionHeader
                        eyebrow="Be fair about this"
                        title={`Where ${entry.competitor} is stronger`}
                    />
                    <ul className="max-w-3xl space-y-3">
                        {entry.strongerAt.map((line) => (
                            <li key={line} className="flex items-start gap-3">
                                <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-400" />
                                <Text variant="bodySm" className="leading-6">{line}</Text>
                            </li>
                        ))}
                    </ul>
                </section>

                <section className="space-y-6">
                    <SectionHeader
                        eyebrow="Differences"
                        title={`How ${siteConfig.name} is different`}
                    />
                    <div className="max-w-3xl space-y-8">
                        {entry.differences.map((difference) => (
                            <div key={difference.heading} className="space-y-3">
                                <Text as="h3" variant="cardTitle">{difference.heading}</Text>
                                <Text variant="body" className="leading-7">{difference.body}</Text>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="space-y-6">
                    <SectionHeader eyebrow="Decide" title="Which one should you pick?" />
                    <div className="grid gap-6 md:grid-cols-2">
                        <Surface as="article" variant="card" padding="lg">
                            <Text as="h3" variant="cardTitle">Pick {entry.competitor}</Text>
                            <Text variant="bodySm" className="mt-3 leading-6">{entry.chooseThem}</Text>
                        </Surface>
                        <Surface as="article" variant="card" padding="lg">
                            <Text as="h3" variant="cardTitle">Pick {siteConfig.name}</Text>
                            <Text variant="bodySm" className="mt-3 leading-6">{entry.chooseUs}</Text>
                        </Surface>
                    </div>
                    <div className="flex flex-col gap-4 pt-2 sm:flex-row">
                        <Button href="/models" variant="primary" icon={ArrowRight} className="min-h-12 px-7">
                            See what each generation costs
                        </Button>
                        <Button href="/showcase" variant="secondary" className="min-h-12 px-7">
                            Browse real output
                        </Button>
                    </div>
                </section>

                <section className="space-y-6">
                    <SectionHeader
                        eyebrow="Questions"
                        title={`${entry.competitor} vs ${siteConfig.name}: common questions`}
                    />
                    <div className="grid gap-4 md:grid-cols-2">
                        {entry.faqs.map((faq) => (
                            <Surface as="article" key={faq.question} variant="card" padding="lg">
                                <Text as="h3" variant="cardTitle">{faq.question}</Text>
                                <Text variant="bodySm" className="mt-3 leading-6">{faq.answer}</Text>
                            </Surface>
                        ))}
                    </div>
                </section>

                {others.length > 0 ? (
                    <section className="space-y-6">
                        <SectionHeader eyebrow="Keep comparing" title="Other tools people evaluate" />
                        <div className="grid gap-6 md:grid-cols-3">
                            {others.map((other) => (
                                <Link
                                    key={other.slug}
                                    href={`/alternatives/${other.slug}`}
                                    className="ui-card ui-card-interactive ui-focus-ring p-6"
                                >
                                    <Text as="h3" variant="cardTitle">{other.competitor}</Text>
                                    <Text variant="bodySm" className="mt-3 line-clamp-3">{other.positioning}</Text>
                                </Link>
                            ))}
                        </div>
                    </section>
                ) : null}
            </main>
        </div>
    );
}
