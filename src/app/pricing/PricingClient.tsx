'use client';

import { useEffect, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { ArrowLeft, ArrowRight, Check, Crown, Gift, Loader2, Sparkles, Zap, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";

import { JsonLd } from "@/app/components/JsonLd";
import { PRICING_CURRENCY, PRICING_PLANS, type PricingPlanId } from "@/lib/pricing";
import { supabase } from "@/lib/supabase";
import { buildSoftwareApplicationSchema, siteConfig } from "@/lib/seo";
import {
    convertFromUsd,
    formatMoney,
    inferCurrencyFromCountry,
    inferCurrencyFromNavigator,
    type SupportedCurrency,
} from "@/lib/currency";

interface PricingClientProps {
    initialCountryCode?: string | null;
}

const iconByPlanId: Record<PricingPlanId, LucideIcon> = {
    starter: Sparkles,
    creator: Zap,
    pro: Crown,
};

const plans = PRICING_PLANS.map((plan) => ({
    ...plan,
    icon: iconByPlanId[plan.id],
}));

const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
        {
            "@type": "Question",
            "name": "What are credits?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "Credits are used to generate AI images, AI videos, and motion-transfer outputs. The cost depends on the workflow, duration, and quality settings you choose."
            }
        },
        {
            "@type": "Question",
            "name": "Do credits expire?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "No. Credits stay available on your account while your account remains active."
            }
        },
        {
            "@type": "Question",
            "name": "What payment methods do you accept?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "Checkout is handled through Razorpay and supports cards, UPI, net banking, and digital wallets."
            }
        },
        {
            "@type": "Question",
            "name": "Which currency is used at checkout?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "Prices are shown in your local currency as an estimate. Checkout is processed in INR through Razorpay."
            }
        },
        {
            "@type": "Question",
            "name": "How long does generation take?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "Most outputs are generated within a few minutes depending on the selected workflow, duration, and current queue demand."
            }
        }
    ]
};

const pricingSchema = buildSoftwareApplicationSchema({
    name: `${siteConfig.name} pricing`,
    path: '/pricing',
    description:
        `Compare ${siteConfig.name} credit packs for AI image generation, AI video generation, motion transfer, and reusable workflow production.`,
    featureList: [
        'Credit packs for AI image generation, AI video generation, and motion transfer',
        'Pay-as-you-go pricing without a subscription lock-in',
        'Checkout processed in INR through Razorpay',
    ],
    offers: PRICING_PLANS.map((plan) => ({
        name: `${plan.name} credits`,
        price: plan.priceInr,
        priceCurrency: PRICING_CURRENCY,
        url: '/pricing',
    })),
});

const relatedLinks = [
    {
        href: '/ai-motion-transfer',
        title: 'See motion-transfer pricing context',
        description: 'Understand how motion-transfer workflows fit into your credit budget before you start testing ads.',
    },
    {
        href: '/ai-video-generator',
        title: 'Map pricing to video generation',
        description: 'Compare plan sizes against the kind of AI video iteration you want to run each month.',
    },
    {
        href: '/showcase',
        title: 'Check public output quality',
        description: 'Browse real examples so you can match your plan choice to the level of experimentation you want.',
    },
];

const CURRENCY_STORAGE_KEY = 'magicbooklet_currency';
const LEGACY_CURRENCY_STORAGE_KEYS = ['emptybooklet_currency', 'ugc_currency'];

const currencyOptions: Array<{ value: SupportedCurrency; label: string }> = [
    { value: 'INR', label: 'INR' },
    { value: 'USD', label: 'USD' },
    { value: 'EUR', label: 'EUR' },
    { value: 'GBP', label: 'GBP' },
    { value: 'AUD', label: 'AUD' },
    { value: 'CAD', label: 'CAD' },
    { value: 'SGD', label: 'SGD' },
];

function isSupportedCurrency(value: string): value is SupportedCurrency {
    return currencyOptions.some((option) => option.value === value);
}

function getStoredCurrencyPreference(): SupportedCurrency | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const candidates = [
        window.localStorage.getItem(CURRENCY_STORAGE_KEY),
        ...LEGACY_CURRENCY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)),
    ];

    return candidates.find((value): value is SupportedCurrency => (
        typeof value === 'string' && isSupportedCurrency(value)
    )) ?? null;
}

function inferDefaultCurrency(initialCountryCode?: string | null): SupportedCurrency {
    const countryCurrency = inferCurrencyFromCountry(initialCountryCode);
    if (countryCurrency) {
        return countryCurrency;
    }

    if (typeof navigator !== 'undefined') {
        return inferCurrencyFromNavigator(Array.from(navigator.languages ?? []));
    }

    return 'USD';
}

export function PricingClient({ initialCountryCode = null }: PricingClientProps) {
    const [userId, setUserId] = useState<string | null>(null);
    const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
    const [selectedCurrency, setSelectedCurrency] = useState<SupportedCurrency>(() => (
        inferCurrencyFromCountry(initialCountryCode) ?? 'INR'
    ));
    const [fxRates, setFxRates] = useState<Record<string, number> | null>(null);
    const [fxUpdatedAt, setFxUpdatedAt] = useState<string | null>(null);
    const [fxStatus, setFxStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
    const router = useRouter();

    useEffect(() => {
        const fetchUser = async () => {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                setUserId(user.id);
            }
        };
        fetchUser();
    }, []);

    useEffect(() => {
        const storedCurrency = getStoredCurrencyPreference();

        // Browser storage and locale are available only after the server-safe first render.
        setSelectedCurrency(storedCurrency ?? inferDefaultCurrency(initialCountryCode));

        const fetchFx = async () => {
            try {
                setFxStatus('loading');
                const response = await fetch('/api/fx');
                if (!response.ok) {
                    throw new Error('FX unavailable');
                }

                const data = await response.json();
                if (!data || data.base !== 'INR' || !data.rates) {
                    throw new Error('Invalid FX response');
                }

                setFxRates(data.rates as Record<string, number>);
                setFxUpdatedAt(typeof data.updatedAt === 'string' ? data.updatedAt : null);
                setFxStatus('ready');
            } catch (error) {
                console.warn('FX fetch failed:', error);
                setFxRates(null);
                setFxUpdatedAt(null);
                setFxStatus('unavailable');
            }
        };

        fetchFx();
    }, [initialCountryCode]);

    const handlePayment = async (planId: string) => {
        if (!userId) {
            router.push('/login?redirect=/pricing');
            return;
        }

        try {
            setLoadingPlan(planId);

            const { data: { session } } = await supabase.auth.getSession();
            const token = session?.access_token;

            if (!token) {
                throw new Error("Authentication token not found. Please log in again.");
            }

            const orderRes = await fetch('/api/razorpay/order', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ planId, userId }),
            });

            const orderData = await orderRes.json();

            if (!orderRes.ok) {
                throw new Error(orderData.error || 'Failed to create order');
            }

            const options = {
                key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
                amount: orderData.amount,
                currency: orderData.currency,
                name: 'magicbooklet',
                description: `Purchase ${planId} credits`,
                order_id: orderData.orderId,
                handler: async function (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) {
                    try {
                        const verifyRes = await fetch('/api/razorpay/verify', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}`
                            },
                            body: JSON.stringify({
                                razorpay_payment_id: response.razorpay_payment_id,
                                razorpay_order_id: response.razorpay_order_id,
                                razorpay_signature: response.razorpay_signature,
                                userId,
                            }),
                        });

                        const verifyData = await verifyRes.json();

                        if (verifyRes.ok && verifyData.success) {
                            alert("Payment successful! Credits added to your account.");
                            window.location.href = '/';
                        } else {
                            alert("Payment verification failed. Please contact support.");
                        }
                    } catch (err) {
                        console.error("Verification error:", err);
                        alert("An error occurred while verifying the payment.");
                    }
                },
                theme: {
                    color: '#ff7a59',
                },
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rzp = new (window as any).Razorpay(options);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rzp.on('payment.failed', function (response: any) {
                console.error("Payment failed:", response.error ? response.error.description : response);
                alert(`Payment failed: ${response.error ? response.error.description : 'Please try again.'}`);
            });

            rzp.open();

        } catch (error: unknown) {
            console.error("Payment initiation error:", error);
            alert(error instanceof Error ? error.message : "An error occurred while initiating payment.");
        } finally {
            setLoadingPlan(null);
        }
    };

    const canConvertCurrency =
        selectedCurrency !== 'INR' &&
        (selectedCurrency === 'USD' ||
            (fxStatus === 'ready' &&
                fxRates !== null &&
                typeof fxRates.USD === 'number' &&
                Number.isFinite(fxRates.USD) &&
                typeof fxRates[selectedCurrency] === 'number' &&
                Number.isFinite(fxRates[selectedCurrency])));

    const locale = typeof navigator !== 'undefined' ? navigator.language : undefined;

    return (
        <div className="ui-page ui-page-ambient min-h-screen">
            <JsonLd data={[faqSchema, pricingSchema]} />
            <Script
                id="razorpay-checkout-js"
                src="https://checkout.razorpay.com/v1/checkout.js"
            />

            <div className="studio-shell py-10 sm:py-14">
                <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-8"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to Home
                </Link>

                <div className="ui-enter mb-12 mt-6 text-center">
                    <div className="mb-5 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary)]">
                        <Sparkles className="h-4 w-4" />
                        Pay as you go
                    </div>
                    <h1 className="mb-5 text-4xl font-extrabold tracking-[-0.035em] text-[var(--ui-text-primary)] sm:text-5xl">
                        Simple, transparent pricing
                    </h1>
                    <p className="mx-auto max-w-3xl text-xl font-light leading-relaxed text-zinc-400">
                        Buy credits for AI images, AI videos, motion transfer, and reusable creative workflows.
                        No subscription lock-in, no hidden platform fee.
                    </p>
                    <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-zinc-500">
                        Prices are shown in your local currency as an estimate. Checkout is processed in{' '}
                        <strong className="text-zinc-300">INR</strong> through Razorpay.
                    </p>

                    <div className="mt-6 flex flex-col items-center gap-3">
                        <label
                            htmlFor="pricing-currency"
                            className="text-xs font-semibold uppercase tracking-[0.25em] text-zinc-500"
                        >
                            Currency
                        </label>
                        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200">
                            <select
                                id="pricing-currency"
                                value={selectedCurrency}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    if (!isSupportedCurrency(value)) {
                                        return;
                                    }

                                    setSelectedCurrency(value);
                                    window.localStorage.setItem(CURRENCY_STORAGE_KEY, value);
                                    LEGACY_CURRENCY_STORAGE_KEYS.forEach((key) => {
                                        window.localStorage.removeItem(key);
                                    });
                                }}
                                className="bg-transparent text-zinc-100 outline-none"
                            >
                                {currencyOptions.map((option) => (
                                    <option key={option.value} value={option.value} className="bg-zinc-950">
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <span className="text-xs text-zinc-500">
                                {fxStatus === 'loading'
                                    ? 'Updating FX...'
                                    : fxStatus === 'unavailable'
                                        ? 'FX unavailable'
                                        : fxUpdatedAt
                                            ? `Updated ${fxUpdatedAt}`
                                            : null}
                            </span>
                        </div>
                    </div>
                </div>

                <section
                    aria-label="Invite and earn bonus credits"
                    className="mb-10 overflow-hidden rounded-[28px] border border-amber-300/20 bg-[linear-gradient(110deg,rgba(242,185,94,0.12),rgba(255,122,89,0.06),rgba(25,25,28,0.96))] p-5 shadow-[var(--ui-shadow-panel)] sm:p-6"
                >
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 gap-4">
                            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-amber-300/20 bg-amber-400/10 text-amber-200">
                                <Gift className="h-5 w-5" aria-hidden />
                            </span>
                            <div>
                                <p className="text-sm font-extrabold text-amber-100">Invite friends. Earn creation credits.</p>
                                <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-300">
                                    Your friend gets 5% bonus credits on their first verified top-up. You earn 5% bonus credits every time they top up.
                                </p>
                            </div>
                        </div>
                        <Link
                            href="/invite"
                            className="ui-focus-ring inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-full border border-amber-300/25 bg-amber-300 px-5 text-sm font-extrabold text-[#1a0d08] transition hover:bg-amber-200 active:scale-[0.985]"
                        >
                            Invite &amp; Earn
                            <ArrowRight className="h-4 w-4" aria-hidden />
                        </Link>
                    </div>
                </section>

                <div className="ui-stagger mb-16 grid gap-5 md:grid-cols-3">
                    {plans.map((plan) => (
                        <div
                            key={plan.id}
                            className={`relative rounded-[28px] p-6 transition duration-200 sm:p-7 ${plan.popular
                                ? "z-10 border border-amber-300/30 bg-[var(--ui-surface-raised)] shadow-[var(--ui-shadow-panel)]"
                                : "border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] hover:border-[var(--ui-border-default)]"
                                }`}
                        >
                            {plan.popular ? (
                                <div className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full border border-amber-200/30 bg-amber-300 px-4 py-1.5 text-xs font-extrabold uppercase tracking-wider text-[#1a0d08] shadow-lg">
                                    Most Popular
                                </div>
                            ) : null}

                            <div className="mb-6 flex items-center gap-3">
                                <div className={`rounded-2xl p-3 ${plan.popular ? "border border-amber-300/25 bg-amber-400/10" : "border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)]"}`}>
                                    <plan.icon className={`h-6 w-6 ${plan.popular ? "text-amber-300" : "text-[var(--ui-text-muted)]"}`} />
                                </div>
                                <h2 className="text-2xl font-bold tracking-tight">{plan.name}</h2>
                            </div>

                            <div className="mb-2 flex items-baseline gap-2">
                                {canConvertCurrency ? (
                                    <>
                                        <span className={`text-5xl font-extrabold tracking-tighter ${plan.popular ? "text-white" : "text-zinc-200"}`}>
                                            {selectedCurrency === 'USD'
                                                ? formatMoney(plan.priceUsd, 'USD', locale)
                                                : `≈${formatMoney(convertFromUsd(plan.priceUsd, selectedCurrency, fxRates ?? {}), selectedCurrency, locale)}`}
                                        </span>
                                        <span className="font-medium text-zinc-500">{selectedCurrency}</span>
                                    </>
                                ) : (
                                    <>
                                        <span className={`text-5xl font-extrabold tracking-tighter ${plan.popular ? "text-white" : "text-zinc-200"}`}>
                                            ₹{plan.priceInr.toLocaleString('en-IN')}
                                        </span>
                                        <span className="font-medium text-zinc-500">INR</span>
                                    </>
                                )}
                            </div>
                            {canConvertCurrency ? (
                                <p className="mb-6 text-sm text-zinc-500">
                                    Charged ₹{plan.priceInr.toLocaleString('en-IN')} INR at checkout.
                                </p>
                            ) : (
                                <p className="mb-6 text-sm text-zinc-500">
                                    Charged in INR at checkout.
                                </p>
                            )}

                            <p className="mb-8 min-h-[48px] leading-relaxed text-zinc-400">{plan.description}</p>

                            <button
                                onClick={() => handlePayment(plan.id)}
                                disabled={loadingPlan === plan.id}
                                className="ui-focus-ring group relative flex min-h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-full bg-[var(--ui-primary)] px-6 py-3 font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <span className="relative z-10 flex items-center justify-center gap-2">
                                    {loadingPlan === plan.id ? (
                                        <>
                                            <Loader2 className="h-5 w-5 animate-spin" />
                                            Processing...
                                        </>
                                    ) : (
                                        `Get ${plan.credits.toLocaleString()} Credits`
                                    )}
                                </span>
                            </button>

                            <ul className="mt-8 space-y-4">
                                {plan.features.map((feature) => (
                                    <li key={feature} className="flex items-start gap-3">
                                        <Check className={`mt-0.5 h-5 w-5 shrink-0 ${plan.popular ? "text-amber-300" : "text-[var(--ui-text-faint)]"}`} />
                                        <span className={plan.popular ? "text-zinc-200" : "text-zinc-400"}>{feature}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>

                <section className="mx-auto max-w-3xl">
                    <h2 className="mb-8 text-center text-3xl font-bold">Frequently Asked Questions</h2>

                    <div className="space-y-6">
                        <div className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-6">
                            <h3 className="mb-2 text-lg font-semibold">What are credits?</h3>
                            <p className="text-zinc-400">
                                Credits are used to generate AI images, AI videos, and motion-transfer outputs.
                                Your usage depends on the workflow, quality, duration, and other settings you pick.
                            </p>
                        </div>

                        <div className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-6">
                            <h3 className="mb-2 text-lg font-semibold">Do credits expire?</h3>
                            <p className="text-zinc-400">
                                No, your credits stay available as long as your account remains active.
                            </p>
                        </div>

                        <div className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-6">
                            <h3 className="mb-2 text-lg font-semibold">Which currency is used at checkout?</h3>
                            <p className="text-zinc-400">
                                Prices are shown in your local currency as an estimate. Checkout is processed in INR through Razorpay.
                            </p>
                        </div>

                        <div className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-6">
                            <h3 className="mb-2 text-lg font-semibold">What payment methods do you accept?</h3>
                            <p className="text-zinc-400">
                                We accept cards, UPI, net banking, and popular digital wallets through our payment partner.
                            </p>
                        </div>

                        <div className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-6">
                            <h3 className="mb-2 text-lg font-semibold">Can I get a refund?</h3>
                            <p className="text-zinc-400">
                                Because AI generation creates immediate processing costs, refunds are generally limited.
                                If you hit a technical issue, contact support and we&apos;ll review the case.
                            </p>
                        </div>

                        <div className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-6">
                            <h3 className="mb-2 text-lg font-semibold">How long does generation take?</h3>
                            <p className="text-zinc-400">
                                Most outputs are generated within a few minutes depending on the workflow you choose and current demand.
                            </p>
                        </div>
                    </div>
                </section>

                <section className="mt-20">
                    <div className="mb-8 max-w-2xl">
                        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-zinc-500">
                            Plan before you buy
                        </p>
                        <h2 className="mt-3 text-3xl font-bold tracking-tight">
                            Match your credit pack to the workflow you actually want to run
                        </h2>
                    </div>
                    <div className="grid gap-6 md:grid-cols-3">
                        {relatedLinks.map((link) => (
                            <Link
                                key={link.href}
                                href={link.href}
                                className="ui-focus-ring rounded-[1.5rem] border border-white/8 bg-white/[0.03] p-6 transition hover:-translate-y-1 hover:border-[var(--ui-primary)]/40 hover:bg-white/[0.05]"
                            >
                                <h3 className="text-xl font-semibold text-white">{link.title}</h3>
                                <p className="mt-3 text-sm leading-6 text-zinc-400">{link.description}</p>
                            </Link>
                        ))}
                    </div>
                </section>

                <div className="mt-16 border-t border-zinc-800 pt-8 text-center text-sm text-zinc-500">
                    <p>© 2026 {siteConfig.name}. All rights reserved.</p>
                    <div className="mt-4 flex justify-center gap-6">
                        <Link href="/terms" className="transition-colors hover:text-white">Terms of Service</Link>
                        <Link href="/privacy" className="transition-colors hover:text-white">Privacy Policy</Link>
                        <Link href="/cancellation" className="transition-colors hover:text-white">Cancellation &amp; Refund</Link>
                        <Link href="/contact" className="transition-colors hover:text-white">Contact</Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
