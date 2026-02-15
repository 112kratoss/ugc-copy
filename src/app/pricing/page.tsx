'use client';

import Link from "next/link";
import { ArrowLeft, Check, Sparkles, Zap, Crown } from "lucide-react";

const plans = [
    {
        name: "Starter",
        price: 9,
        credits: 3,
        perVideo: "3.00",
        description: "Perfect for trying out our service",
        features: [
            "3 video generations",
            "Up to 30 seconds per video",
            "HD quality output",
            "Download in MP4 format",
            "Email support",
        ],
        icon: Sparkles,
        popular: false,
    },
    {
        name: "Creator",
        price: 29,
        credits: 15,
        perVideo: "1.93",
        description: "Best value for content creators",
        features: [
            "15 video generations",
            "Up to 30 seconds per video",
            "HD quality output",
            "Download in MP4 format",
            "Priority processing",
            "Priority email support",
        ],
        icon: Zap,
        popular: true,
    },
    {
        name: "Pro",
        price: 79,
        credits: 50,
        perVideo: "1.58",
        description: "For professional creators & agencies",
        features: [
            "50 video generations",
            "Up to 30 seconds per video",
            "HD quality output",
            "Download in MP4 format",
            "Priority processing",
            "Dedicated support",
            "Commercial usage rights",
        ],
        icon: Crown,
        popular: false,
    },
];

export default function Pricing() {
    return (
        <div className="min-h-screen bg-black text-white">
            <div className="max-w-6xl mx-auto px-6 py-16">
                <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-8"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to Home
                </Link>

                <div className="text-center mb-16">
                    <h1 className="text-4xl sm:text-5xl font-bold mb-4 bg-gradient-to-b from-white to-zinc-500 text-transparent bg-clip-text">
                        Simple, Transparent Pricing
                    </h1>
                    <p className="text-xl text-zinc-400 max-w-2xl mx-auto">
                        Pay only for what you use. No subscriptions, no hidden fees.
                        Buy credits and create amazing AI-powered videos.
                    </p>
                </div>

                <div className="grid md:grid-cols-3 gap-8 mb-16">
                    {plans.map((plan) => (
                        <div
                            key={plan.name}
                            className={`relative rounded-2xl p-8 ${plan.popular
                                    ? "bg-gradient-to-b from-purple-900/50 to-zinc-900 border-2 border-purple-500"
                                    : "bg-zinc-900 border border-zinc-800"
                                }`}
                        >
                            {plan.popular && (
                                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-purple-500 text-white text-sm font-medium px-4 py-1 rounded-full">
                                    Most Popular
                                </div>
                            )}

                            <div className="flex items-center gap-3 mb-4">
                                <div className={`p-2 rounded-lg ${plan.popular ? "bg-purple-500/20" : "bg-zinc-800"}`}>
                                    <plan.icon className={`w-6 h-6 ${plan.popular ? "text-purple-400" : "text-zinc-400"}`} />
                                </div>
                                <h3 className="text-xl font-semibold">{plan.name}</h3>
                            </div>

                            <div className="mb-4">
                                <span className="text-5xl font-bold">${plan.price}</span>
                                <span className="text-zinc-400 ml-2">USD</span>
                            </div>

                            <p className="text-zinc-400 mb-2">{plan.description}</p>
                            <p className="text-sm text-zinc-500 mb-6">
                                ${plan.perVideo} per video
                            </p>

                            <button
                                className={`w-full py-3 px-6 rounded-xl font-medium transition-all ${plan.popular
                                        ? "bg-purple-500 hover:bg-purple-600 text-white"
                                        : "bg-zinc-800 hover:bg-zinc-700 text-white"
                                    }`}
                            >
                                Get {plan.credits} Credits
                            </button>

                            <ul className="mt-8 space-y-4">
                                {plan.features.map((feature) => (
                                    <li key={feature} className="flex items-start gap-3">
                                        <Check className={`w-5 h-5 mt-0.5 ${plan.popular ? "text-purple-400" : "text-green-400"}`} />
                                        <span className="text-zinc-300">{feature}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>

                {/* FAQ Section */}
                <div className="max-w-3xl mx-auto">
                    <h2 className="text-3xl font-bold text-center mb-8">Frequently Asked Questions</h2>

                    <div className="space-y-6">
                        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
                            <h3 className="text-lg font-semibold mb-2">What are credits?</h3>
                            <p className="text-zinc-400">
                                Credits are used to generate videos. Each video generation costs 1 credit,
                                regardless of the video length (up to 30 seconds).
                            </p>
                        </div>

                        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
                            <h3 className="text-lg font-semibold mb-2">Do credits expire?</h3>
                            <p className="text-zinc-400">
                                No, your credits never expire as long as your account is active. Use them whenever you&apos;re ready.
                            </p>
                        </div>

                        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
                            <h3 className="text-lg font-semibold mb-2">What payment methods do you accept?</h3>
                            <p className="text-zinc-400">
                                We accept all major credit/debit cards, UPI, net banking, and popular digital wallets
                                through our secure payment partners.
                            </p>
                        </div>

                        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
                            <h3 className="text-lg font-semibold mb-2">Can I get a refund?</h3>
                            <p className="text-zinc-400">
                                Due to the nature of AI processing costs, we generally cannot offer refunds on purchased credits.
                                However, if you experience technical issues, please contact our support team.
                            </p>
                        </div>

                        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
                            <h3 className="text-lg font-semibold mb-2">How long does video generation take?</h3>
                            <p className="text-zinc-400">
                                Most videos are generated within 2-5 minutes depending on length and current demand.
                                Priority processing is available in Creator and Pro plans.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="mt-16 pt-8 border-t border-zinc-800 text-center text-zinc-500 text-sm">
                    <p>© 2026 UGC Creator. All rights reserved.</p>
                    <div className="flex justify-center gap-6 mt-4">
                        <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
                        <Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
                        <Link href="/contact" className="hover:text-white transition-colors">Contact</Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
