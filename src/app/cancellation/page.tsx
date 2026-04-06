import type { Metadata } from "next";

import { createMetadata } from "@/lib/seo";

export const metadata: Metadata = createMetadata({
    title: "Cancellation & Refund Policy",
    description:
        "Read UGC copy's cancellation and refund policy for digital credit purchases and AI generation services.",
    path: "/cancellation",
});

export default function CancellationAndRefundPolicy() {
    return (
        <div className="min-h-screen bg-black text-white">
            <div className="max-w-4xl mx-auto px-6 py-16">
                <h1 className="text-4xl font-bold mb-4">Cancellation &amp; Refund Policy</h1>
                <p className="text-zinc-400 mb-12">Last updated: April 6, 2026</p>

                <div className="space-y-8 text-zinc-300">
                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">1. Overview</h2>
                        <p>
                            This policy explains when you can request a cancellation or refund for purchases made on
                            UGC copy (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;). If local law requires a refund in
                            a particular situation, we will follow the applicable legal requirements.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">2. Digital Credits and Services</h2>
                        <p>
                            UGC copy sells digital credits and provides AI-powered generation services (for example,
                            AI image generation, AI video generation, and motion transfer). Credits are typically
                            delivered immediately to your account after payment is confirmed.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">3. Cancellations</h2>
                        <p>
                            Because credit purchases are delivered digitally and can be used immediately, we generally
                            do not support cancellations after an order is completed. If you believe a purchase was
                            made by mistake, contact us as soon as possible and we will review the request.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">4. Refund Eligibility</h2>
                        <p className="mb-4">You may be eligible for a refund in limited cases, such as:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Duplicate payment for the same order</li>
                            <li>Payment succeeded but credits were not delivered to your account due to a technical issue</li>
                            <li>Incorrect amount charged due to a confirmed billing error</li>
                        </ul>
                        <p className="mt-4">
                            Refund requests are reviewed case-by-case. Where approved, refunds are typically issued
                            only for unused credits associated with the affected purchase.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">5. Non-Refundable Cases</h2>
                        <p className="mb-4">Refunds are generally not provided for:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Credits that have already been used</li>
                            <li>Change of mind after purchase</li>
                            <li>Dissatisfaction with AI-generated output quality (AI results can vary)</li>
                            <li>Account inactivity or unused credits unrelated to a billing or delivery issue</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">6. How to Request a Refund</h2>
                        <p className="mb-4">
                            Email us at{" "}
                            <a href="mailto:support@ugccopy.com" className="text-purple-400 hover:text-purple-300">
                                support@ugccopy.com
                            </a>{" "}
                            with:
                        </p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>The email address used on your UGC copy account</li>
                            <li>Order/payment reference (if available)</li>
                            <li>A short description of the issue</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">7. Refund Processing Time</h2>
                        <p>
                            If a refund is approved, we aim to process it within 5 to 10 business days. The final time
                            for funds to appear in your account may vary depending on your bank or payment method.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">8. Chargebacks</h2>
                        <p>
                            If you have a billing concern, please contact us first so we can help resolve it quickly.
                            Unnecessary chargebacks may result in account restrictions to prevent fraud and abuse.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">9. Contact</h2>
                        <p>
                            Questions about this policy? Email{" "}
                            <a href="mailto:support@ugccopy.com" className="text-purple-400 hover:text-purple-300">
                                support@ugccopy.com
                            </a>
                            .
                        </p>
                    </section>
                </div>

                <div className="mt-16 pt-8 border-t border-zinc-800 text-center text-zinc-500 text-sm">
                    <p>© 2026 UGC copy. All rights reserved.</p>
                </div>
            </div>
        </div>
    );
}

