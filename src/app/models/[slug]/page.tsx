import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, CheckCircle2 } from 'lucide-react';

import { Button, Kicker, SectionHeader, Surface, Text } from '@/app/components/DesignSystem';
import { JsonLd } from '@/app/components/JsonLd';
import { PRICING_CURRENCY, PRICING_PLAN_MAP } from '@/lib/pricing';
import {
    MODEL_KIND_CREATE_PATHS,
    MODEL_KIND_FEATURE_PATHS,
    MODEL_KIND_GUIDANCE,
    MODEL_KIND_LABELS,
    MODEL_KIND_NOUNS,
    buildScaleCosts,
    describeModelCapabilities,
    findModelBySlug,
    formatCost,
    getBaselineCost,
    listPublicModels,
    positionAgainstPeers,
    summarizeModelControls,
    toModelSlug,
    toOrdinal,
} from '@/lib/model-pages';
import {
    buildBreadcrumbSchema,
    buildFaqSchema,
    buildSoftwareApplicationSchema,
    createMetadata,
} from '@/lib/seo';

/**
 * One reference page per model in the catalog.
 *
 * These exist because the product knows something its competitors do not
 * publish: what a single generation actually costs. Competitors quote monthly
 * subscriptions, which answers a different question than "what does one more
 * video cost me". Everything on the page is read from the catalog the studio
 * validates against, so adding a model adds a page and nothing here can drift
 * from what the product will really run.
 */

type ModelPageProps = {
    params: Promise<{ slug: string }>;
};

/**
 * Rendered on demand and cached, not prerendered.
 *
 * The published catalog lives in the database in production, so enumerating
 * slugs at build time would either require database access during the build or
 * bake in whatever the code catalog happened to contain. Rendering on first
 * request against the live catalog keeps a newly published model's page correct
 * without a deploy.
 */
export const revalidate = 3600;

export async function generateMetadata({ params }: ModelPageProps): Promise<Metadata> {
    const { slug } = await params;
    const model = await findModelBySlug(slug);

    if (!model) {
        return { title: 'Model Not Found' };
    }

    const cost = await getBaselineCost(model);
    const noun = MODEL_KIND_NOUNS[model.kind];
    const costSentence = cost
        ? ` A ${noun} starts at ${cost.credits} credits, about ₹${cost.inr.toFixed(2)}.`
        : '';

    return createMetadata({
        title: `${model.displayName} — Cost & Capabilities`,
        description:
            `What ${model.displayName} does, what it costs per generation, and the settings it accepts.${costSentence}`,
        path: `/models/${slug}`,
        keywords: [
            model.displayName,
            `${model.displayName} pricing`,
            `${model.displayName} cost`,
            MODEL_KIND_LABELS[model.kind],
        ],
    });
}

export default async function ModelPage({ params }: ModelPageProps) {
    const { slug } = await params;
    const model = await findModelBySlug(slug);

    if (!model) {
        notFound();
    }

    const cost = await getBaselineCost(model);
    const capabilities = describeModelCapabilities(model);
    const controls = summarizeModelControls(model);
    const noun = MODEL_KIND_NOUNS[model.kind];
    const kindLabel = MODEL_KIND_LABELS[model.kind];
    const createPath = MODEL_KIND_CREATE_PATHS[model.kind];
    const featurePath = MODEL_KIND_FEATURE_PATHS[model.kind];
    const guidance = MODEL_KIND_GUIDANCE[model.kind];
    const scaleCosts = cost ? buildScaleCosts(cost) : [];

    // Peer positioning needs the whole catalog priced, which is the same set of
    // quotes the index page takes. Both pages revalidate hourly, so this runs
    // once an hour per model rather than per visit.
    const allModels = await listPublicModels();
    const pricedPeers = await Promise.all(
        allModels
            .filter((peer) => peer.kind === model.kind)
            .map(async (peer) => ({ model: peer, cost: await getBaselineCost(peer) }))
    );
    const position = positionAgainstPeers(model, pricedPeers);
    const cheaperAlternatives = pricedPeers
        .filter((peer) => peer.cost && cost && peer.cost.credits < cost.credits && peer.model.id !== model.id)
        .sort((left, right) => right.cost!.credits - left.cost!.credits)
        .slice(0, 3);

    const faqs = [
        ...(cost
            ? [{
                question: `How much does one ${model.displayName} generation cost?`,
                answer:
                    `At its default settings, a ${noun} costs ${formatCost(cost)}. Cost changes with resolution, duration, and quality, and the exact figure is shown in the studio before a generation runs.`,
            }]
            : []),
        {
            question: `What is ${model.displayName} best at?`,
            answer: `${model.description} It runs as a ${kindLabel.toLowerCase()} model.`,
        },
        ...(controls.length > 0
            ? [{
                question: `What settings does ${model.displayName} support?`,
                answer: controls
                    .map((control) => `${control.label}: ${control.values}.`)
                    .join(' '),
            }]
            : []),
        {
            question: 'Do credits expire?',
            answer: 'No. Credits stay available while your account remains active, so an unused balance carries across campaigns.',
        },
    ];

    return (
        <div className="ui-page ui-page-ambient overflow-hidden">
            <JsonLd
                data={[
                    buildSoftwareApplicationSchema({
                        name: `${model.displayName} on magicbooklet`,
                        path: `/models/${slug}`,
                        description: model.description,
                        applicationCategory: 'MultimediaApplication',
                        featureList: capabilities,
                        offers: [{
                            name: `${PRICING_PLAN_MAP.starter.name} credits`,
                            price: PRICING_PLAN_MAP.starter.priceInr,
                            priceCurrency: PRICING_CURRENCY,
                            url: '/pricing',
                        }],
                    }),
                    buildBreadcrumbSchema([
                        { name: 'Home', path: '/' },
                        { name: 'Models', path: '/models' },
                        { name: model.displayName, path: `/models/${slug}` },
                    ]),
                    buildFaqSchema(faqs),
                ]}
            />

            <main className="studio-shell ui-section-gap relative py-20">
                <section className="space-y-6">
                    <Kicker>{kindLabel}</Kicker>
                    <Text as="h1" variant="display" className="max-w-4xl">
                        {model.displayName}
                    </Text>
                    <Text variant="body" className="max-w-3xl text-lg leading-8">
                        {model.description}
                    </Text>

                    {cost ? (
                        <Surface variant="panel" padding="lg" className="max-w-2xl">
                            <Kicker>Cost per generation</Kicker>
                            <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
                                <Text as="span" variant="metric">{cost.credits}</Text>
                                <Text as="span" variant="body" className="text-lg">
                                    credits &middot; about ₹{cost.inr.toFixed(2)} / ${cost.usd.toFixed(2)}
                                </Text>
                            </div>
                            <Text variant="bodySm" className="mt-4 leading-6">
                                At this model&apos;s default settings. Resolution, duration, and quality
                                move the number, and the exact cost is shown in the studio before a
                                generation runs — nothing is spent before you see it.
                            </Text>
                        </Surface>
                    ) : null}

                    <div className="flex flex-col gap-4 pt-2 sm:flex-row">
                        <Button href={createPath} variant="primary" icon={ArrowRight} className="min-h-12 px-7">
                            Generate with {model.displayName}
                        </Button>
                        <Button href="/pricing" variant="secondary" className="min-h-12 px-7">
                            See credit packs
                        </Button>
                    </div>
                </section>

                {capabilities.length > 0 ? (
                    <section className="space-y-6">
                        <SectionHeader
                            eyebrow="Capabilities"
                            title={`What ${model.displayName} can do`}
                        />
                        <ul className="max-w-3xl space-y-3">
                            {capabilities.map((capability) => (
                                <li key={capability} className="flex items-start gap-3">
                                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-400" />
                                    <Text variant="bodySm" className="leading-6">{capability}</Text>
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}

                {controls.length > 0 ? (
                    <section className="space-y-6">
                        <SectionHeader
                            eyebrow="Settings"
                            title={`${model.displayName} settings and limits`}
                            description="Read directly from the generation catalog, so these are the values the model will actually accept."
                        />
                        <div className="max-w-3xl overflow-x-auto">
                            <table className="w-full min-w-[520px] border-collapse text-left">
                                <thead>
                                    <tr className="border-b border-[var(--ui-border-default)]">
                                        <th className="py-3 pr-4 text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">Setting</th>
                                        <th className="py-3 pr-4 text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">Available values</th>
                                        <th className="py-3 text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">Default</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {controls.map((control) => (
                                        <tr key={control.label} className="border-b border-[var(--ui-border-subtle)]">
                                            <td className="py-3 pr-4 align-top text-sm font-semibold text-[var(--ui-text-primary)]">
                                                {control.label}
                                            </td>
                                            <td className="py-3 pr-4 align-top text-sm text-[var(--ui-text-muted)]">
                                                {control.values}
                                            </td>
                                            <td className="py-3 align-top text-sm text-[var(--ui-text-muted)]">
                                                {control.defaultValue ?? '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                ) : null}

                {scaleCosts.length > 0 ? (
                    <section className="space-y-6">
                        <SectionHeader
                            eyebrow="Cost at scale"
                            title={`What a testing cycle on ${model.displayName} costs`}
                            description="Creative testing is a volume exercise, so the number that matters is rarely the cost of one run."
                        />
                        <div className="max-w-2xl overflow-x-auto">
                            <table className="w-full min-w-[380px] border-collapse text-left">
                                <thead>
                                    <tr className="border-b border-[var(--ui-border-default)]">
                                        <th className="py-3 pr-4 text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">Generations</th>
                                        <th className="py-3 pr-4 text-right text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">Credits</th>
                                        <th className="py-3 text-right text-xs font-bold uppercase tracking-[0.1em] text-[var(--ui-text-faint)]">Approx. cost</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {scaleCosts.map((row) => (
                                        <tr key={row.runs} className="border-b border-[var(--ui-border-subtle)]">
                                            <td className="py-3 pr-4 text-sm font-semibold text-[var(--ui-text-primary)]">{row.runs}</td>
                                            <td className="py-3 pr-4 text-right text-sm tabular-nums text-[var(--ui-text-muted)]">{row.credits.toLocaleString('en-IN')}</td>
                                            <td className="py-3 text-right text-sm tabular-nums text-[var(--ui-text-muted)]">₹{row.inr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {position ? (
                            <Text variant="bodySm" className="max-w-3xl leading-6">
                                Among the {position.total} {noun} models available here,{' '}
                                {model.displayName} is the{' '}
                                {position.rank === 1
                                    ? 'cheapest'
                                    : position.rank === position.total
                                        ? 'most expensive'
                                        : `${toOrdinal(position.rank)} cheapest`} per run.
                                {position.cheapest
                                    ? ` The least expensive is ${position.cheapest.name} at ${position.cheapest.credits} credits.`
                                    : ''}
                                {position.dearest
                                    ? ` The most expensive is ${position.dearest.name} at ${position.dearest.credits} credits.`
                                    : ''}
                            </Text>
                        ) : null}
                        {cheaperAlternatives.length > 0 ? (
                            <Text variant="bodySm" className="max-w-3xl leading-6">
                                Exploring broadly before committing? Cheaper {noun} models worth a
                                first pass:{' '}
                                {cheaperAlternatives.map((peer, index) => (
                                    <span key={peer.model.id}>
                                        {index > 0 ? ', ' : ''}
                                        <Link
                                            href={`/models/${toModelSlug(peer.model.id)}`}
                                            className="ui-focus-ring rounded-sm text-[var(--ui-primary)] hover:underline"
                                        >
                                            {peer.model.displayName}
                                        </Link>
                                        {` (${peer.cost!.credits} cr)`}
                                    </span>
                                ))}
                                .
                            </Text>
                        ) : null}
                    </section>
                ) : null}

                <section className="space-y-6">
                    <SectionHeader
                        eyebrow="Fit"
                        title={`When to reach for ${kindLabel}`}
                    />
                    <div className="grid gap-6 md:grid-cols-2">
                        <div className="space-y-3">
                            <Text as="h3" variant="cardTitle">Good for</Text>
                            <ul className="space-y-2">
                                {guidance.goodFor.map((line) => (
                                    <li key={line} className="flex items-start gap-3">
                                        <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-400" />
                                        <Text variant="bodySm" className="leading-6">{line}</Text>
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <div className="space-y-3">
                            <Text as="h3" variant="cardTitle">Not the right tool for</Text>
                            <ul className="space-y-2">
                                {guidance.poorFor.map((line) => (
                                    <li key={line} className="flex items-start gap-3">
                                        <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ui-text-faint)]" />
                                        <Text variant="bodySm" className="leading-6">{line}</Text>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                    <Text variant="body" className="max-w-3xl leading-7">{guidance.note}</Text>
                </section>

                <section className="space-y-6">
                    <SectionHeader
                        eyebrow="Questions"
                        title={`${model.displayName}: common questions`}
                    />
                    <div className="grid gap-4 md:grid-cols-2">
                        {faqs.map((faq) => (
                            <Surface as="article" key={faq.question} variant="card" padding="lg">
                                <Text as="h3" variant="cardTitle">{faq.question}</Text>
                                <Text variant="bodySm" className="mt-3 leading-6">{faq.answer}</Text>
                            </Surface>
                        ))}
                    </div>
                </section>

                <section className="space-y-6">
                    <SectionHeader eyebrow="Keep exploring" title="Where this model fits" />
                    <div className="grid gap-6 md:grid-cols-3">
                        <Link href={featurePath} className="ui-card ui-card-interactive ui-focus-ring group p-6">
                            <Text as="h3" variant="cardTitle">{kindLabel}</Text>
                            <Text variant="bodySm" className="mt-3">
                                How this kind of generation fits into an ad production workflow.
                            </Text>
                        </Link>
                        <Link href="/models" className="ui-card ui-card-interactive ui-focus-ring group p-6">
                            <Text as="h3" variant="cardTitle">Compare every model</Text>
                            <Text variant="bodySm" className="mt-3">
                                Per-generation cost for every model in one table.
                            </Text>
                        </Link>
                        <Link href="/showcase" className="ui-card ui-card-interactive ui-focus-ring group p-6">
                            <Text as="h3" variant="cardTitle">See real output</Text>
                            <Text variant="bodySm" className="mt-3">
                                Public creations from people using these models in production.
                            </Text>
                        </Link>
                    </div>
                </section>
            </main>
        </div>
    );
}
