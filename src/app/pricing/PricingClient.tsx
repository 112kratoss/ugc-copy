'use client';

import { useEffect, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { ArrowLeft, Check, Crown, Loader2, Sparkles, Zap, type LucideIcon } from "lucide-react";
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

        if (storedCurrency) {
            setSelectedCurrency(storedCurrency);
        } else {
            setSelectedCurrency(inferDefaultCurrency(initialCountryCode));
        }

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
                    color: '#a855f7',
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
        <div className="min-h-screen bg-black text-white">
            <JsonLd data={[faqSchema, pricingSchema]} />
            <Script
                id="razorpay-checkout-js"
                src="https://checkout.razorpay.com/v1/checkout.js"
            />

            <div className="studio-shell py-16">
                <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-8"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to Home
                </Link>

                <div className="mt-8 mb-16 text-center">
                    <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-purple-500/20 bg-purple-500/10 px-3 py-1 text-sm font-medium text-purple-400">
                        <Sparkles className="h-4 w-4" />
                        Pay as you go
                    </div>
                    <h1 className="mb-6 bg-gradient-to-br from-white to-zinc-500 bg-clip-text text-5xl font-extrabold tracking-tight text-transparent sm:text-6xl">
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

                <div className="mb-20 grid gap-8 md:grid-cols-3">
                    {plans.map((plan) => (
                        <div
                            key={plan.id}
                            className={`relative rounded-3xl p-8 backdrop-blur-xl transition-all duration-500 hover:-translate-y-2 ${plan.popular
                                ? "z-10 border border-purple-500/50 bg-zinc-900/80 shadow-[0_0_40px_-15px_rgba(168,85,247,0.3)] hover:shadow-[0_0_50px_-10px_rgba(168,85,247,0.5)]"
                                : "border border-white/5 bg-black/40 hover:border-white/10 hover:bg-zinc-900/60"
                                }`}
                        >
                            {plan.popular ? (
                                <div className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-white shadow-lg">
                                    Most Popular
                                </div>
                            ) : null}

                            <div className="mb-6 flex items-center gap-3">
                                <div className={`rounded-2xl p-3 transition-transform duration-500 group-hover:scale-110 ${plan.popular ? "border border-purple-500/30 bg-purple-500/20" : "border border-zinc-700/50 bg-zinc-800/50"}`}>
                                    <plan.icon className={`h-6 w-6 ${plan.popular ? "text-purple-400 drop-shadow-[0_0_10px_rgba(192,132,252,0.5)]" : "text-zinc-400"}`} />
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
                                className={`group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl px-6 py-4 font-semibold transition-all duration-300 ${plan.popular
                                    ? "bg-purple-500 text-white hover:scale-[1.02] hover:shadow-[0_0_20px_-5px_rgba(168,85,247,0.5)] disabled:bg-purple-500/50 disabled:hover:shadow-none"
                                    : "bg-white text-black hover:scale-[1.02] hover:bg-zinc-200 disabled:bg-zinc-800 disabled:text-zinc-500"
                                    }`}
                            >
                                {plan.popular ? (
                                    <div className="absolute inset-0 bg-gradient-to-r from-purple-400 to-pink-500 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                                ) : null}
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
                                        <Check className={`mt-0.5 h-5 w-5 shrink-0 ${plan.popular ? "text-purple-400" : "text-zinc-600"}`} />
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
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                            <h3 className="mb-2 text-lg font-semibold">What are credits?</h3>
                            <p className="text-zinc-400">
                                Credits are used to generate AI images, AI videos, and motion-transfer outputs.
                                Your usage depends on the workflow, quality, duration, and other settings you pick.
                            </p>
                        </div>

                        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                            <h3 className="mb-2 text-lg font-semibold">Do credits expire?</h3>
                            <p className="text-zinc-400">
                                No, your credits stay available as long as your account remains active.
                            </p>
                        </div>

                        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                            <h3 className="mb-2 text-lg font-semibold">Which currency is used at checkout?</h3>
                            <p className="text-zinc-400">
                                Prices are shown in your local currency as an estimate. Checkout is processed in INR through Razorpay.
                            </p>
                        </div>

                        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                            <h3 className="mb-2 text-lg font-semibold">What payment methods do you accept?</h3>
                            <p className="text-zinc-400">
                                We accept cards, UPI, net banking, and popular digital wallets through our payment partner.
                            </p>
                        </div>

                        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                            <h3 className="mb-2 text-lg font-semibold">Can I get a refund?</h3>
                            <p className="text-zinc-400">
                                Because AI generation creates immediate processing costs, refunds are generally limited.
                                If you hit a technical issue, contact support and we&apos;ll review the case.
                            </p>
                        </div>

                        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
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
                                className="rounded-[1.5rem] border border-white/8 bg-white/[0.03] p-6 transition hover:-translate-y-1 hover:border-purple-400/40 hover:bg-white/[0.05]"
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
