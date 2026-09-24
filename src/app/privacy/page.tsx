import { Metadata } from "next";
import Link from "next/link";

import { AI_MODEL_MAKERS } from "@/lib/ai-data-recipients";
import { createMetadata, siteConfig } from "@/lib/seo";

export const metadata: Metadata = createMetadata({
    title: "Privacy Policy",
    description:
        `Review how ${siteConfig.name} collects, processes, stores, and protects data across its AI image, video, and motion-transfer workflows.`,
    path: '/privacy',
});

export default function PrivacyPolicy() {
    return (
        <div className="min-h-screen bg-black text-white">
            <div className="max-w-4xl mx-auto px-6 py-16">

                <h1 className="text-4xl font-bold mb-4">Privacy Policy</h1>
                <p className="text-zinc-400 mb-12">Last updated: September 25, 2026</p>

                <div className="space-y-8 text-zinc-300">
                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">1. Introduction</h2>
                        <p>
                            {siteConfig.name} (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) is committed to protecting your privacy.
                            This Privacy Policy explains how we collect, use, disclose, and safeguard your
                            information when you use our AI video generation service.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">2. Information We Collect</h2>

                        <h3 className="text-xl font-medium text-white mb-3 mt-6">Personal Information</h3>
                        <p className="mb-4">When you create an account or use our services, we may collect:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Email address</li>
                            <li>Name (optional)</li>
                            <li>Payment information (processed securely via third-party providers)</li>
                            <li>Account preferences</li>
                        </ul>

                        <h3 className="text-xl font-medium text-white mb-3 mt-6">Content You Upload</h3>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Prompts you write</li>
                            <li>Images, videos, and audio you upload or choose as references</li>
                            <li>The images and videos you generate</li>
                        </ul>

                        <h3 className="text-xl font-medium text-white mb-3 mt-6">Usage Information</h3>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Device and browser information</li>
                            <li>IP address</li>
                            <li>Pages visited and features used</li>
                            <li>Onboarding steps viewed, completion or skip status, and the creation goal you select</li>
                            <li>Time and date of visits</li>
                        </ul>

                        <h3 className="text-xl font-medium text-white mb-3 mt-6">Referral Information</h3>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Referral codes, link visits, attribution dates, and the destination opened</li>
                            <li>Whether an attributed account completed a qualifying purchase</li>
                            <li>Promotional credits granted, reversed, or restored</li>
                            <li>Privacy-protective hashes derived from network, browser, or app-installation signals for fraud prevention</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">3. How We Use Your Information</h2>
                        <p className="mb-4">We use the collected information to:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Provide and maintain our Service</li>
                            <li>Process your image, video, and motion generation requests</li>
                            <li>Process payments and manage your account</li>
                            <li>Send you important service updates</li>
                            <li>Improve the quality of the Service</li>
                            <li>Detect and prevent fraud or abuse</li>
                            <li>Attribute referrals, issue promotional credits, and measure referral-program performance</li>
                            <li>Measure onboarding completion and help creators reach their first successful generation</li>
                            <li>Comply with legal obligations</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">4. Data Storage and Security</h2>
                        <p className="mb-4">
                            We implement industry-standard security measures to protect your data:
                        </p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Encrypted data transmission (HTTPS/TLS)</li>
                            <li>Secure cloud storage with access controls</li>
                            <li>Regular security audits and updates</li>
                            <li>Limited employee access to personal data</li>
                        </ul>
                        <p className="mt-4">
                            Uploaded content is stored temporarily for processing and may be deleted after
                            a reasonable period. Generated videos are stored in your account until you delete them.
                        </p>
                        <p className="mt-4">
                            Raw onboarding interaction events use a pseudonymous installation identifier and are retained for up to 90 days. They do not include your prompts, uploaded media, email address, or arbitrary profile content; longer-term reporting uses aggregated results.
                        </p>
                        <p className="mt-4">
                            One-time promotional credits (such as the welcome bonus) are recorded against a one-way cryptographic digest of your sign-in identifiers so each promotion is granted once per person. The digest cannot be reversed into your email address or identity, contains no profile content, and is retained after account deletion solely to prevent repeat claims through re-registration.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">5. Third-Party Services</h2>
                        <p className="mb-4">We use trusted third-party services for:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li><strong>Payment Processing:</strong> Razorpay, Apple, Google, and RevenueCat - for secure payment and purchase verification</li>
                            <li><strong>Cloud Storage:</strong> Supabase - for file storage</li>
                            <li><strong>AI Processing:</strong> Kie.ai and the model makers listed in section 6 - for image, video, and motion generation and prompt enhancement</li>
                            <li><strong>Service Improvement:</strong> To understand how our Service is used and improve performance</li>
                        </ul>
                        <p className="mt-4">
                            These providers have their own privacy policies and are bound by data protection agreements.
                        </p>
                    </section>

                    <section id="ai-processing" className="scroll-mt-24">
                        <h2 className="text-2xl font-semibold text-white mb-4">6. AI Processing</h2>
                        <p className="mb-4">
                            When you generate an image, video, or motion clip, run a template, or use Enhance prompt,
                            we send what that request needs to the AI services that produce the result.
                        </p>

                        <h3 className="text-xl font-medium text-white mb-3 mt-6">What we send</h3>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Your prompt and the settings you choose, such as the model, aspect ratio, and length</li>
                            <li>Any images, videos, or audio you upload or choose as references, including the video and character image for motion transfer and the media of a post you remix</li>
                            <li>For Enhance prompt, the text of your prompt</li>
                        </ul>
                        <p className="mt-4">
                            We do not send your name, email address, payment details, or contacts with these requests.
                        </p>

                        <h3 className="text-xl font-medium text-white mb-3 mt-6">Who receives it</h3>
                        <p className="mb-4">
                            <strong>Kie.ai</strong>, which runs the AI models on our behalf, receives every request and
                            passes it to the company that made the model you choose:
                        </p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            {AI_MODEL_MAKERS.map(({ maker, models }) => (
                                <li key={maker}><strong>{maker}</strong>: {models}</li>
                            ))}
                        </ul>

                        <h3 className="text-xl font-medium text-white mb-3 mt-6">Why, and for how long</h3>
                        <p className="mb-4">
                            We send this data only to create the result you asked for. We do not sell it or use it for
                            advertising. Section 4 covers how long we keep your uploads and creations. Kie.ai and the
                            model makers process the data under their own terms and privacy policies, and may keep it for
                            a limited time, for example to deliver the result or to prevent abuse.
                        </p>
                        <p>
                            We share this data only with AI providers that are bound to protect it with the same or equal
                            protection as this Privacy Policy provides.
                        </p>

                        <h3 className="text-xl font-medium text-white mb-3 mt-6">Your choice</h3>
                        <p>
                            The {siteConfig.name} mobile app asks for your permission before it first sends a prompt or
                            media to these services, and you can withdraw that permission at any time in Settings &rarr; AI
                            data sharing. Nothing more is sent until you allow it again. On the website, starting a
                            generation, running a template, or using Enhance prompt sends the request as described here.
                            You can delete your uploads, your creations, or your whole account at any time.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">7. Your Rights</h2>
                        <p className="mb-4">You have the right to:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li><strong>Access:</strong> Request a copy of your personal data</li>
                            <li><strong>Correction:</strong> Update inaccurate information</li>
                            <li><strong>Deletion:</strong> Request deletion of your data and account</li>
                            <li><strong>Portability:</strong> Export your data in a standard format</li>
                            <li><strong>Objection:</strong> Opt out of certain data processing</li>
                        </ul>
                        <p className="mt-4">
                            To exercise these rights, contact us at{" "}
                            <a href={`mailto:${siteConfig.privacyEmail}`} className="text-[var(--ui-primary)] hover:text-[var(--ui-primary-strong)]">
                                {siteConfig.privacyEmail}
                            </a>
                            . For permanent account deletion instructions, visit our{" "}
                            <Link href="/delete-account" className="text-[var(--ui-primary)] hover:text-[var(--ui-primary-strong)]">
                                account deletion page
                            </Link>.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">8. Cookies</h2>
                        <p className="mb-4">
                            We use essential cookies to maintain your session and preferences. When you open a referral link, we also use an opaque first-party referral cookie for up to 30 days so a new-account signup can be attributed to the correct inviter.
                        </p>
                        <p>
                            Referral visit and fraud-prevention signals are retained in identifiable or pseudonymous form only as long as needed to operate and protect the program. Short-lived visit signals are normally removed or aggregated after 90 days, while purchase and reward records may be retained for account, financial, dispute, and legal obligations. You can control cookies through your browser settings, although blocking the referral cookie prevents automatic attribution.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">9. Children&apos;s Privacy</h2>
                        <p>
                            Our Service is not intended for users under 18 years of age. We do not
                            knowingly collect personal information from children. If you believe a
                            child has provided us with personal data, please contact us immediately.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">10. International Data Transfers</h2>
                        <p>
                            Your information may be transferred to and processed in countries other than
                            your country of residence. We ensure appropriate safeguards are in place to
                            protect your data in compliance with applicable laws.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">11. Changes to This Policy</h2>
                        <p>
                            We may update this Privacy Policy periodically. We will notify you of significant
                            changes by posting the new policy on our website and updating the &ldquo;Last updated&rdquo; date.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">12. Contact Us</h2>
                        <p>
                            For any questions or concerns about this Privacy Policy, please contact us at:
                        </p>
                        <ul className="mt-4 space-y-2">
                            <li>
                                Email:{" "}
                                <a href={`mailto:${siteConfig.privacyEmail}`} className="text-[var(--ui-primary)] hover:text-[var(--ui-primary-strong)]">
                                    {siteConfig.privacyEmail}
                                </a>
                            </li>
                        </ul>
                    </section>
                </div>

                <div className="mt-16 pt-8 border-t border-zinc-800 text-center text-zinc-500 text-sm">
                    <p>© 2026 {siteConfig.name}. All rights reserved.</p>
                </div>
            </div>
        </div>
    );
}
