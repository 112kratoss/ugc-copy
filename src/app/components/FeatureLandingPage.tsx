import Link from 'next/link';
import { ArrowRight, CheckCircle2, Newspaper, PlayCircle, Sparkles } from 'lucide-react';

import { Button, Kicker, SectionHeader, Surface, Text } from '@/app/components/DesignSystem';
import { JsonLd } from '@/app/components/JsonLd';
import { PRICING_CURRENCY, PRICING_PLAN_MAP } from '@/lib/pricing';
import { buildSoftwareApplicationSchema } from '@/lib/seo';

type LandingStep = {
    title: string;
    description: string;
};

type LandingLink = {
    title: string;
    description: string;
    href: string;
    label: string;
};

type FeatureLandingPageProps = {
    pagePath: string;
    badge: string;
    title: string;
    description: string;
    primaryCtaHref: string;
    primaryCtaLabel: string;
    secondaryCtaHref: string;
    secondaryCtaLabel: string;
    highlights: string[];
    steps: LandingStep[];
    relatedLinks: LandingLink[];
    featureList: string[];
};

export default function FeatureLandingPage({
    pagePath,
    badge,
    title,
    description,
    primaryCtaHref,
    primaryCtaLabel,
    secondaryCtaHref,
    secondaryCtaLabel,
    highlights,
    steps,
    relatedLinks,
    featureList,
}: FeatureLandingPageProps) {
    return (
        <div className="ui-page ui-page-ambient overflow-hidden">
            <JsonLd
                data={buildSoftwareApplicationSchema({
                    name: title,
                    path: pagePath,
                    description,
                    featureList,
                    offers: [
                        {
                            name: `${PRICING_PLAN_MAP.starter.name} credits`,
                            price: PRICING_PLAN_MAP.starter.priceInr,
                            priceCurrency: PRICING_CURRENCY,
                            url: '/pricing',
                        },
                    ],
                })}
            />

            <div className="fixed inset-0 pointer-events-none">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_40%)]" />
            </div>

            <main className="studio-shell ui-section-gap relative py-20">
                <section className="grid gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
                    <div className="space-y-8">
                        <Kicker icon={Sparkles} className="rounded-full border border-[rgba(255,122,89,0.28)] bg-[var(--ui-primary-soft)] px-4 py-2 text-[var(--ui-primary-strong)]">
                            {badge}
                        </Kicker>
                        <div className="space-y-5">
                            <Text as="h1" variant="display" className="max-w-4xl">
                                {title}
                            </Text>
                            <Text variant="body" className="max-w-3xl text-lg leading-8 sm:text-xl">
                                {description}
                            </Text>
                        </div>
                        <div className="flex flex-col gap-4 sm:flex-row">
                            <Button
                                href={primaryCtaHref}
                                variant="primary"
                                icon={ArrowRight}
                                className="min-h-12 px-7"
                            >
                                {primaryCtaLabel}
                            </Button>
                            <Button
                                href={secondaryCtaHref}
                                variant="secondary"
                                className="min-h-12 px-7"
                            >
                                {secondaryCtaLabel}
                            </Button>
                        </div>
                    </div>

                    <Surface variant="panel" padding="lg" className="backdrop-blur-xl">
                        <Kicker>Why teams use it</Kicker>
                        <div className="mt-6 space-y-4">
                            {highlights.map((highlight) => (
                                <Surface
                                    as="article"
                                    variant="soft"
                                    padding="sm"
                                    key={highlight}
                                    className="flex items-start gap-3 bg-black/30"
                                >
                                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                                    <Text variant="bodySm" className="text-zinc-300">{highlight}</Text>
                                </Surface>
                            ))}
                        </div>
                    </Surface>
                </section>

                <section className="space-y-8">
                    <SectionHeader
                        eyebrow="How it works"
                        title="Move from idea to publish-ready creative without bouncing across tools"
                    />
                    <div className="grid gap-6 md:grid-cols-3">
                        {steps.map((step, index) => (
                            <Surface
                                as="article"
                                key={step.title}
                                variant="card"
                                padding="lg"
                                interactive
                            >
                                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-lg font-bold text-white">
                                    {index + 1}
                                </div>
                                <Text as="h3" variant="cardTitle">{step.title}</Text>
                                <Text variant="bodySm" className="mt-3">{step.description}</Text>
                            </Surface>
                        ))}
                    </div>
                </section>

                <section className="space-y-8">
                    <SectionHeader
                        eyebrow="Keep exploring"
                        title="Build authority around the feature, not just a single page"
                    />
                    <div className="grid gap-6 md:grid-cols-3">
                        {relatedLinks.map((link) => (
                            <Link
                                key={link.href}
                                href={link.href}
                                className="ui-card ui-card-interactive ui-focus-ring group p-6"
                            >
                                <Kicker>
                                    {link.href.startsWith('/blog') ? (
                                        <Newspaper className="h-4 w-4" />
                                    ) : (
                                        <PlayCircle className="h-4 w-4" />
                                    )}
                                    Linked path
                                </Kicker>
                                <Text as="h3" variant="cardTitle" className="mt-4">{link.title}</Text>
                                <Text variant="bodySm" className="mt-3">{link.description}</Text>
                                <span className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-[var(--ui-primary)]">
                                    {link.label}
                                    <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                                </span>
                            </Link>
                        ))}
                    </div>
                </section>
            </main>
        </div>
    );
}
