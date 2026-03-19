import Link from 'next/link';
import { ArrowRight, CheckCircle2, Newspaper, PlayCircle, Sparkles } from 'lucide-react';

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
        <div className="min-h-screen overflow-hidden bg-black text-white">
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
                <div className="absolute left-[-10%] top-[-5%] h-[32rem] w-[32rem] rounded-full bg-fuchsia-700/15 blur-[140px]" />
                <div className="absolute bottom-[-10%] right-[-10%] h-[28rem] w-[28rem] rounded-full bg-cyan-500/10 blur-[140px]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_40%)]" />
            </div>

            <main className="relative mx-auto flex max-w-6xl flex-col gap-20 px-6 py-20 sm:px-10 lg:px-12">
                <section className="grid gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
                    <div className="space-y-8">
                        <div className="inline-flex items-center gap-2 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-4 py-2 text-sm text-fuchsia-200">
                            <Sparkles className="h-4 w-4" />
                            {badge}
                        </div>
                        <div className="space-y-5">
                            <h1 className="max-w-4xl text-5xl font-black tracking-tight sm:text-6xl lg:text-7xl">
                                {title}
                            </h1>
                            <p className="max-w-3xl text-lg leading-8 text-zinc-300 sm:text-xl">
                                {description}
                            </p>
                        </div>
                        <div className="flex flex-col gap-4 sm:flex-row">
                            <Link
                                href={primaryCtaHref}
                                className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-7 py-4 font-semibold text-black transition hover:scale-[1.02] hover:bg-zinc-200"
                            >
                                {primaryCtaLabel}
                                <ArrowRight className="h-4 w-4" />
                            </Link>
                            <Link
                                href={secondaryCtaHref}
                                className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-7 py-4 font-semibold text-white transition hover:border-white/25 hover:bg-white/10"
                            >
                                {secondaryCtaLabel}
                            </Link>
                        </div>
                    </div>

                    <div className="rounded-[2rem] border border-white/10 bg-white/5 p-8 backdrop-blur-xl">
                        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-zinc-400">
                            Why teams use it
                        </p>
                        <div className="mt-6 space-y-4">
                            {highlights.map((highlight) => (
                                <div
                                    key={highlight}
                                    className="flex items-start gap-3 rounded-2xl border border-white/6 bg-black/30 p-4"
                                >
                                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                                    <p className="text-sm leading-6 text-zinc-300">{highlight}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                <section className="space-y-8">
                    <div className="space-y-3">
                        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-zinc-400">
                            How it works
                        </p>
                        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                            Move from idea to publish-ready creative without bouncing across tools
                        </h2>
                    </div>
                    <div className="grid gap-6 md:grid-cols-3">
                        {steps.map((step, index) => (
                            <article
                                key={step.title}
                                className="rounded-[1.75rem] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_20px_50px_rgba(0,0,0,0.3)]"
                            >
                                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-lg font-bold text-white">
                                    {index + 1}
                                </div>
                                <h3 className="text-xl font-semibold text-white">{step.title}</h3>
                                <p className="mt-3 text-sm leading-6 text-zinc-400">{step.description}</p>
                            </article>
                        ))}
                    </div>
                </section>

                <section className="space-y-8">
                    <div className="space-y-3">
                        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-zinc-400">
                            Keep exploring
                        </p>
                        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                            Build authority around the feature, not just a single page
                        </h2>
                    </div>
                    <div className="grid gap-6 md:grid-cols-3">
                        {relatedLinks.map((link) => (
                            <Link
                                key={link.href}
                                href={link.href}
                                className="group rounded-[1.75rem] border border-white/8 bg-white/[0.03] p-6 transition hover:-translate-y-1 hover:border-fuchsia-400/40 hover:bg-white/[0.05]"
                            >
                                <div className="flex items-center gap-2 text-sm uppercase tracking-[0.18em] text-zinc-500">
                                    {link.href.startsWith('/blog') ? (
                                        <Newspaper className="h-4 w-4" />
                                    ) : (
                                        <PlayCircle className="h-4 w-4" />
                                    )}
                                    Linked path
                                </div>
                                <h3 className="mt-4 text-xl font-semibold text-white">{link.title}</h3>
                                <p className="mt-3 text-sm leading-6 text-zinc-400">{link.description}</p>
                                <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-fuchsia-300">
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
