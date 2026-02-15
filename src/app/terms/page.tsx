import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function TermsOfService() {
    return (
        <div className="min-h-screen bg-black text-white">
            <div className="max-w-4xl mx-auto px-6 py-16">
                <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-8"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to Home
                </Link>

                <h1 className="text-4xl font-bold mb-4">Terms of Service</h1>
                <p className="text-zinc-400 mb-12">Last updated: February 9, 2026</p>

                <div className="space-y-8 text-zinc-300">
                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">1. Acceptance of Terms</h2>
                        <p>
                            By accessing and using UGC Creator (&ldquo;the Service&rdquo;), you accept and agree to be bound by
                            these Terms of Service. If you do not agree to these terms, please do not use our Service.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">2. Description of Service</h2>
                        <p>
                            UGC Creator is an AI-powered platform that enables users to create video content by
                            animating static images using reference videos. The Service uses generative AI technology
                            to transfer motion from reference videos to user-provided images.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">3. User Accounts</h2>
                        <p className="mb-4">To use certain features of the Service, you may need to create an account. You agree to:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Provide accurate and complete registration information</li>
                            <li>Maintain the security of your account credentials</li>
                            <li>Accept responsibility for all activities under your account</li>
                            <li>Notify us immediately of any unauthorized account use</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">4. Payments and Credits</h2>
                        <p className="mb-4">
                            Our Service operates on a credit-based system. By purchasing credits, you agree to:
                        </p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>All purchases are final and non-refundable unless required by law</li>
                            <li>Credits have no cash value and cannot be transferred</li>
                            <li>Unused credits do not expire as long as your account remains active</li>
                            <li>Pricing may change with reasonable advance notice</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">5. Acceptable Use</h2>
                        <p className="mb-4">You agree NOT to use the Service to:</p>
                        <ul className="list-disc list-inside space-y-2 ml-4">
                            <li>Create content that is illegal, harmful, or infringes on others&apos; rights</li>
                            <li>Generate deepfakes or content intended to deceive or defraud</li>
                            <li>Create content depicting minors in any inappropriate context</li>
                            <li>Violate any applicable laws or regulations</li>
                            <li>Attempt to reverse-engineer or exploit the Service</li>
                            <li>Use automated systems to abuse the Service</li>
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">6. Intellectual Property</h2>
                        <p className="mb-4">
                            <strong>Your Content:</strong> You retain ownership of images and videos you upload.
                            By uploading content, you grant us a limited license to process it for providing the Service.
                        </p>
                        <p>
                            <strong>Generated Content:</strong> You own the videos generated through our Service,
                            subject to compliance with these Terms. You are responsible for ensuring you have rights
                            to all input content.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">7. Disclaimer of Warranties</h2>
                        <p>
                            The Service is provided &ldquo;as is&rdquo; without warranties of any kind. We do not guarantee that
                            the Service will be uninterrupted, error-free, or meet your specific requirements.
                            AI-generated content quality may vary.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">8. Limitation of Liability</h2>
                        <p>
                            To the maximum extent permitted by law, we shall not be liable for any indirect,
                            incidental, special, or consequential damages arising from your use of the Service.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">9. Termination</h2>
                        <p>
                            We reserve the right to suspend or terminate your access to the Service at any time
                            for violations of these Terms or for any other reason at our discretion. Upon termination,
                            your right to use the Service ceases immediately.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">10. Changes to Terms</h2>
                        <p>
                            We may update these Terms from time to time. We will notify you of material changes
                            by posting the updated Terms on our website. Continued use of the Service after changes
                            constitutes acceptance of the new Terms.
                        </p>
                    </section>

                    <section>
                        <h2 className="text-2xl font-semibold text-white mb-4">11. Contact Us</h2>
                        <p>
                            If you have any questions about these Terms, please contact us at{" "}
                            <a href="mailto:support@ugccreator.com" className="text-purple-400 hover:text-purple-300">
                                support@ugccreator.com
                            </a>
                        </p>
                    </section>
                </div>

                <div className="mt-16 pt-8 border-t border-zinc-800 text-center text-zinc-500 text-sm">
                    <p>© 2026 UGC Creator. All rights reserved.</p>
                </div>
            </div>
        </div>
    );
}
