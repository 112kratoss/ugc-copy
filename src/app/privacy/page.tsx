import { Metadata } from "next";

import { createMetadata } from "@/lib/seo";

export const metadata: Metadata = createMetadata({
    title: "Privacy Policy",
    description:
        "Review how UGC copy collects, processes, stores, and protects data across its AI image, video, and motion-transfer workflows.",
    path: '/privacy',
});

export default function PrivacyPolicy() {
    return (
        <div className="min-h-screen bg-black text-white">
            <div className="max-w-4xl mx-auto px-6 py-16">

                <h1 className="text-4xl font-bold mb-4">Privacy Policy</h1>
                <p className="text-zinc-400 mb-12">Last updated: February 9, 2026</p>

                <div className="space-y-8 text-zinc-300">
                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">1. Introduction</h2>
                        <p>
                            UGC copy (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) is committed to protecting your privacy.
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
                            <li>Images you upload for video generation</li>
                            <li>Reference videos you provide</li>
                            <li>Generated video content</li>
                        </ul>

                        <h3 className="text-xl font-medium text-white mb-3 mt-6">Usage Information</h3>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Device and browser information</li>
                            <li>IP address</li>
                            <li>Pages visited and features used</li>
                            <li>Time and date of visits</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">3. How We Use Your Information</h2>
                        <p className="mb-4">We use the collected information to:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Provide and maintain our Service</li>
                            <li>Process your video generation requests</li>
                            <li>Process payments and manage your account</li>
                            <li>Send you important service updates</li>
                            <li>Improve our AI models and Service quality</li>
                            <li>Detect and prevent fraud or abuse</li>
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
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">5. Third-Party Services</h2>
                        <p className="mb-4">We use trusted third-party services for:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li><strong>Payment Processing:</strong> Razorpay - for secure payment handling</li>
                            <li><strong>Cloud Storage:</strong> Supabase - for file storage</li>
                            <li><strong>AI Processing:</strong> Kie.ai - for video generation</li>
                            <li><strong>Service Improvement:</strong> To understand how our Service is used and improve performance</li>
                        </ul>
                        <p className="mt-4">
                            These providers have their own privacy policies and are bound by data protection agreements.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">6. Your Rights</h2>
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
                            <a href="mailto:privacy@ugccopy.com" className="text-purple-400 hover:text-purple-300">
                                privacy@ugccopy.com
                            </a>
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">7. Cookies</h2>
                        <p>
                            We use essential cookies to maintain your session and preferences.
                            We may use essential cookies required for the Service to function properly.
                            You can control cookies through your browser settings.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">8. Children&apos;s Privacy</h2>
                        <p>
                            Our Service is not intended for users under 18 years of age. We do not
                            knowingly collect personal information from children. If you believe a
                            child has provided us with personal data, please contact us immediately.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">9. International Data Transfers</h2>
                        <p>
                            Your information may be transferred to and processed in countries other than
                            your country of residence. We ensure appropriate safeguards are in place to
                            protect your data in compliance with applicable laws.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">10. Changes to This Policy</h2>
                        <p>
                            We may update this Privacy Policy periodically. We will notify you of significant
                            changes by posting the new policy on our website and updating the &ldquo;Last updated&rdquo; date.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">11. Contact Us</h2>
                        <p>
                            For any questions or concerns about this Privacy Policy, please contact us at:
                        </p>
                        <ul className="mt-4 space-y-2">
                            <li>
                                Email:{" "}
                                <a href="mailto:privacy@ugccopy.com" className="text-purple-400 hover:text-purple-300">
                                    privacy@ugccopy.com
                                </a>
                            </li>
                        </ul>
                    </section>
                </div>

                <div className="mt-16 pt-8 border-t border-zinc-800 text-center text-zinc-500 text-sm">
                    <p>© 2026 UGC copy. All rights reserved.</p>
                </div>
            </div>
        </div>
    );
}
