import type { Metadata } from 'next';
import Link from 'next/link';

import { Kicker, SectionHeader, Surface, Text } from '@/app/components/DesignSystem';
import { JsonLd } from '@/app/components/JsonLd';
import { ALTERNATIVES } from '@/lib/alternatives';
import {
    buildBreadcrumbSchema,
    buildItemListSchema,
    createMetadata,
    siteConfig,
} from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'AI UGC Ad Tool Comparisons',
    description:
        'Honest comparisons between magicbooklet and the other tools teams evaluate for AI ad creative — including where each competitor is the better choice.',
    path: '/alternatives',
    keywords: [
        'AI UGC ad tools compared',
        'Arcads alternative',
        'Creatify alternative',
        'HeyGen alternative',
    ],
});

export default function AlternativesIndexPage() {
    return (
        <div className="ui-page ui-page-ambient overflow-hidden">
            <JsonLd
                data={[
                    buildItemListSchema(
                        'Tool comparisons',
                        '/alternatives',
                        ALTERNATIVES.map((entry) => ({
                            name: `${entry.competitor} alternative`,
                            path: `/alternatives/${entry.slug}`,
                        }))
                    ),
                    buildBreadcrumbSchema([
                        { name: 'Home', path: '/' },
                        { name: 'Alternatives', path: '/alternatives' },
                    ]),
                ]}
            />

            <main className="studio-shell ui-section-gap relative py-20">
                <section className="space-y-5">
                    <Kicker>Comparisons</Kicker>
                    <Text as="h1" variant="display" className="max-w-4xl">
                        How {siteConfig.name} compares
                    </Text>
                    <Text variant="body" className="max-w-3xl text-lg leading-8">
                        Every comparison here says plainly where the other tool is the better
                        choice, because most of the time that depends on what you are making rather
                        than on which product is better. No competitor pricing figures are quoted —
                        plans change, and a stale number helps nobody. What is compared is how each
                        product charges, which stays true when the numbers move.
                    </Text>
                </section>

                <section className="space-y-6">
                    <SectionHeader eyebrow="Tools" title="Pick a comparison" />
                    <div className="grid gap-6 md:grid-cols-3">
                        {ALTERNATIVES.map((entry) => (
                            <Link
                                key={entry.slug}
                                href={`/alternatives/${entry.slug}`}
                                className="ui-card ui-card-interactive ui-focus-ring p-6"
                            >
                                <Text as="h3" variant="cardTitle">
                                    {entry.competitor} alternative
                                </Text>
                                <Text variant="bodySm" className="mt-3">{entry.positioning}</Text>
                            </Link>
                        ))}
                    </div>
                </section>

                <section className="space-y-6">
                    <SectionHeader eyebrow="Context" title="What is actually different here" />
                    <div className="grid gap-6 md:grid-cols-3">
                        <Surface as="article" variant="card" padding="lg">
                            <Text as="h3" variant="cardTitle">Per-generation pricing</Text>
                            <Text variant="bodySm" className="mt-3 leading-6">
                                Most tools in this category sell a monthly plan with a video
                                allowance. Here you buy credits that do not expire and every model
                                publishes what one generation costs before you run it.
                            </Text>
                        </Surface>
                        <Surface as="article" variant="card" padding="lg">
                            <Text as="h3" variant="cardTitle">More than presenters</Text>
                            <Text variant="bodySm" className="mt-3 leading-6">
                                A UGC ad is rarely all talking head. Image generation, staged
                                text-to-video, and motion transfer sit together, chained by
                                reusable workflows.
                            </Text>
                        </Surface>
                        <Surface as="article" variant="card" padding="lg">
                            <Text as="h3" variant="cardTitle">You choose the model</Text>
                            <Text variant="bodySm" className="mt-3 leading-6">
                                Generations run on a catalog of models with different cost and
                                quality profiles, so you can explore broadly on cheap ones and
                                finish on an expensive one.
                            </Text>
                        </Surface>
                    </div>
                </section>
            </main>
        </div>
    );
}
