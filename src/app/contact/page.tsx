import Link from "next/link";
import { Mail, MapPin, MessageSquare, Phone } from "lucide-react";
import { siteConfig } from "@/lib/seo";
import { ContactForm } from "./ContactForm";

export default function Contact() {
    // Stripe and other payment processors often require a public India phone number and address.
    // These are meant to be shown publicly; env vars can override without a code change.
    const defaultSupportPhone = "+91 73565 68282";
    const defaultBusinessAddress = ["WISHCRAFTER", "PNA Road, Manjeri", "Malappuram 676123", "Kerala, India"].join("\n");

    const supportPhone = process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? defaultSupportPhone;
    const supportPhoneTel = supportPhone ? supportPhone.replace(/[^\d+]/g, "") : null;
    const businessAddress = process.env.NEXT_PUBLIC_BUSINESS_ADDRESS ?? defaultBusinessAddress;

    return (
        <div className="ui-page ui-page-ambient min-h-screen">
            <div className="max-w-4xl mx-auto px-6 py-16">

                <div className="text-center mb-12">
                    <h1 className="mb-4 text-4xl font-extrabold tracking-tight text-[var(--ui-text-primary)] sm:text-5xl">
                        Get in Touch
                    </h1>
                    <p className="text-xl text-zinc-400 max-w-2xl mx-auto">
                        Have questions, feedback, or need support? We&apos;re here to help.
                    </p>
                </div>

                <div className="grid md:grid-cols-2 gap-12">
                    {/* Contact Info */}
                    <div className="space-y-8">
                        <div>
                            <h2 className="text-2xl font-semibold mb-6">Contact Information</h2>
                            <div className="space-y-6">
                                <div className="flex items-start gap-4">
                                    <div className="rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-primary-soft)] p-3">
                                        <Mail className="h-6 w-6 text-[var(--ui-primary)]" />
                                    </div>
                                    <div>
                                        <h3 className="font-medium mb-1">Email Support</h3>
                                        <a
                                            href={`mailto:${siteConfig.supportEmail}`}
                                            className="text-[var(--ui-primary)] hover:text-[var(--ui-primary-strong)]"
                                        >
                                            {siteConfig.supportEmail}
                                        </a>
                                        <p className="text-sm text-zinc-500 mt-1">We respond within 24 hours</p>
                                    </div>
                                </div>

                                <div className="flex items-start gap-4">
                                    <div className="rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-primary-soft)] p-3">
                                        <MessageSquare className="h-6 w-6 text-[var(--ui-primary)]" />
                                    </div>
                                    <div>
                                        <h3 className="font-medium mb-1">General Inquiries</h3>
                                        <a
                                            href={`mailto:${siteConfig.helloEmail}`}
                                            className="text-[var(--ui-primary)] hover:text-[var(--ui-primary-strong)]"
                                        >
                                            {siteConfig.helloEmail}
                                        </a>
                                        <p className="text-sm text-zinc-500 mt-1">For partnerships and press</p>
                                    </div>
                                </div>

                                {!!supportPhone && !!supportPhoneTel && (
                                    <div className="flex items-start gap-4">
                                        <div className="rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-primary-soft)] p-3">
                                            <Phone className="h-6 w-6 text-[var(--ui-primary)]" />
                                        </div>
                                        <div>
                                            <h3 className="font-medium mb-1">Phone</h3>
                                            <a
                                                href={`tel:${supportPhoneTel}`}
                                                className="text-[var(--ui-primary)] hover:text-[var(--ui-primary-strong)]"
                                            >
                                                {supportPhone}
                                            </a>
                                            <p className="text-sm text-zinc-500 mt-1">India support number</p>
                                        </div>
                                    </div>
                                )}

                                {!!businessAddress && (
                                    <div className="flex items-start gap-4">
                                        <div className="rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-primary-soft)] p-3">
                                            <MapPin className="h-6 w-6 text-[var(--ui-primary)]" />
                                        </div>
                                        <div>
                                            <h3 className="font-medium mb-1">Registered Address</h3>
                                            <p className="text-sm text-zinc-300 whitespace-pre-wrap">{businessAddress}</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-6">
                            <h3 className="font-semibold mb-3">Quick Links</h3>
                            <ul className="space-y-3 text-zinc-400">
                                <li>
                                    <Link href="/pricing" className="hover:text-white transition-colors">
                                        → View Pricing Plans
                                    </Link>
                                </li>
                                <li>
                                    <Link href="/cancellation" className="hover:text-white transition-colors">
                                        → Cancellation &amp; Refund Policy
                                    </Link>
                                </li>
                                <li>
                                    <Link href="/terms" className="hover:text-white transition-colors">
                                        → Terms of Service
                                    </Link>
                                </li>
                                <li>
                                    <Link href="/privacy" className="hover:text-white transition-colors">
                                        → Privacy Policy
                                    </Link>
                                </li>
                            </ul>
                        </div>
                    </div>

                    {/* Contact Form */}
                    <div className="rounded-[28px] border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-8 shadow-[var(--ui-shadow-panel)]">
                        <ContactForm />
                    </div>
                </div>

                <div className="mt-16 pt-8 border-t border-zinc-800 text-center text-zinc-500 text-sm">
                    <p>© 2026 {siteConfig.name}. All rights reserved.</p>
                    <div className="flex justify-center gap-6 mt-4">
                        <Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link>
                        <Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link>
                        <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
