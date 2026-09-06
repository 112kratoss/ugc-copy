import type { Metadata } from 'next';
import Link from 'next/link';

import { Kicker, SectionHeader, Text } from '@/app/components/DesignSystem';
import { JsonLd } from '@/app/components/JsonLd';
import {
    CREDIT_RATE_INR,
    CREDIT_RATE_USD,
    MODEL_KIND_FEATURE_PATHS,
    MODEL_KIND_LABELS,
    getBaselineCost,
    listPublicModels,
    toModelSlug,
} from '@/lib/model-pages';
import type { GenerationModelKind } from '@/lib/generation-model-catalog';
import {
    buildBreadcrumbSchema,
    buildFaqSchema,
    buildItemListSchema,
    createMetadata,
} from '@/lib/seo';

/**
 * Every model the product runs, with what one generation costs.
 *
 * This is the page the individual model pages exist to feed, and the one worth
 * linking to: nobody else in the category publishes a per-generation price,
 * because nobody else has one to publish — competitors sell monthly seats.
 */

export const revalidate = 3600;

export const metadata: Metadata = createMetadata({
    title: 'AI Model Costs Compared',
    description:
        'What one generation actually costs on every AI image, video, and motion-transfer model — in credits and in currency, not monthly subscription tiers.',
    path: '/models',
    keywords: [
        'AI video model pricing',
        'AI image model cost',
        'AI model comparison',
        'cost per AI video',
        'AI generation pricing',
    ],
});

const KIND_ORDER: GenerationModelKind[] = ['video', 'image', 'motion'];

export default async function ModelsIndexPage() {
    const models = await listPublicModels();
    const rows = await Promise.all(models.map(async (model) => ({
        model,
        cost: await getBaselineCost(model),
    })));

    const byKind = KIND_ORDER
        .map((kind) => ({
            kind,
            entries: rows
                .filter((row) => row.model.kind === kind)
                .sort((left, right) => (left.cost?.credits ?? Infinity) - (right.cost?.credits ?? Infinity)),
        }))
        .filter((group) => group.entries.length > 0);

    const faqs = [
        {
            question: 'What is a credit worth?',
            answer:
                `Credits are priced at one flat rate across every pack — one credit is about ₹${CREDIT_RATE_INR.toFixed(2)} (roughly $${CREDIT_RATE_USD.toFixed(2)}). A 500-credit pack is ₹415 and a 10,000-credit pack is ₹8,300, so the rate does not change with pack size.`,
        },
        {
            question: 'Why do costs differ so much between models?',
            answer:
                'Cost tracks what the model actually costs to run, which scales with resolution, duration, and how much computation the model does per second of output. A fast exploratory model and a cinematic one differ by more than an order of magnitude, which is why it pays to explore on the cheap ones and finish on the expensive ones.',
        },
        {
            question: 'Are these the exact prices I will pay?',
            answer:
                'These are the costs at each model\'s default settings. Raising resolution or duration raises the cost, and the exact figure for your settings is shown in the studio before a generation runs — nothing is spent before you see it.',
        },
        {
            question: 'Do credits expire?',
            answer: 'No. Credits stay available while your account remains active.',
        },
    ];

    return (
        <div className="ui-page ui-page-ambient overflow-hidden">
            <JsonLd
                data={[
                    buildItemListSchema(
                        'AI generation models',
                        '/models',
                        models.map((model) => ({
                            name: model.displayName,
                            path: `/models/${toModelSlug(model.id)}`,
                        }))
                    ),
                    buildBreadcrumbSchema([
                        { name: 'Home', path: '/' },
                        { name: 'Models', path: '/models' },
                    ]),
                    buildFaqSchema(faqs),
                ]}
            />

            <main className="studio-shell ui-section-gap relative py-20">
                <section className="space-y-5">
                    <Kicker>Model reference</Kicker>
                    <Text as="h1" variant="display" className="max-w-4xl">
                        What one AI generation actually costs
                    </Text>
                    <Text variant="body" className="max-w-3xl text-lg leading-8">
                        Every image, video, and motion-transfer model available here, with the cost
                        of a single generation at default settings. Most tools in this category
                        quote a monthly subscription, which answers a different question than the
                        one that matters when you are testing creative at volume: what does one
                        more video cost?
                    </Text>
                    <Text variant="bodySm" className="max-w-3xl leading-6">
                        Credits are a flat ₹{CREDIT_RATE_INR.toFixed(2)} each (about $
                        {CREDIT_RATE_USD.toFixed(2)}) at every pack size. Raising resolution or
                        duration raises the cost, and the exact figure is always shown before a
                        generation runs.
                    </Text>
                </section>

                {byKind.map((group) => (
                    <section key={group.kind} className="space-y-6">
                        <SectionHeader
                            eyebrow={`${group.entries.length} models`}
                            title={MODEL_KIND_LABELS[group.kind]}
                            actionHref={MODEL_KIND_FEATURE_PATHS[group.kind]}
                            actionLabel="How it works"
                        />
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[600px] border-collapse text-left">
                                <thead>
                                    <tr className="border-b border-[var(--ui-border-default)]">
                                        <th className="py-3 pr-4 text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">Model</th>
                                        <th className="py-3 pr-4 text-right text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">Credits</th>
                                        <th className="py-3 pr-4 text-right text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">₹ per run</th>
                                        <th className="py-3 text-right text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">$ per run</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {group.entries.map(({ model, cost }) => (
                                        <tr key={model.id} className="border-b border-[var(--ui-border-subtle)]">
                                            <td className="py-3 pr-4 align-top">
                                                <Link
                                                    href={`/models/${toModelSlug(model.id)}`}
                                                    className="ui-focus-ring rounded-sm text-sm font-semibold text-[var(--ui-text-primary)] hover:text-[var(--ui-primary)]"
                                                >
                                                    {model.displayName}
                                                </Link>
                                                <span className="mt-1 block max-w-md text-xs leading-5 text-[var(--ui-text-faint)]">
                                                    {model.description}
                                                </span>
                                            </td>
                                            <td className="py-3 pr-4 text-right align-top text-sm tabular-nums text-[var(--ui-text-primary)]">
                                                {cost ? cost.credits : '—'}
                                            </td>
                                            <td className="py-3 pr-4 text-right align-top text-sm tabular-nums text-[var(--ui-text-muted)]">
                                                {cost ? `₹${cost.inr.toFixed(2)}` : '—'}
                                            </td>
                                            <td className="py-3 text-right align-top text-sm tabular-nums text-[var(--ui-text-muted)]">
                                                {cost ? `$${cost.usd.toFixed(2)}` : '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                ))}

                <section className="space-y-6">
                    <SectionHeader eyebrow="Questions" title="How model pricing works here" />
                    <div className="grid gap-4 md:grid-cols-2">
                        {faqs.map((faq) => (
                            <article key={faq.question} className="ui-card p-6">
                                <Text as="h3" variant="cardTitle">{faq.question}</Text>
                                <Text variant="bodySm" className="mt-3 leading-6">{faq.answer}</Text>
                            </article>
                        ))}
                    </div>
                </section>
            </main>
        </div>
    );
}
