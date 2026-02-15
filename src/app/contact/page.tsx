'use client';

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Mail, MessageSquare, Send } from "lucide-react";

export default function Contact() {
    const [formData, setFormData] = useState({
        name: '',
        email: '',
        subject: 'general',
        message: ''
    });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);

        // Simulate form submission
        await new Promise(resolve => setTimeout(resolve, 1000));

        setIsSubmitting(false);
        setSubmitted(true);
    };

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

                <div className="text-center mb-12">
                    <h1 className="text-4xl sm:text-5xl font-bold mb-4 bg-gradient-to-b from-white to-zinc-500 text-transparent bg-clip-text">
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
                                    <div className="p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                                        <Mail className="w-6 h-6 text-purple-400" />
                                    </div>
                                    <div>
                                        <h3 className="font-medium mb-1">Email Support</h3>
                                        <a
                                            href="mailto:support@ugccreator.com"
                                            className="text-purple-400 hover:text-purple-300"
                                        >
                                            support@ugccreator.com
                                        </a>
                                        <p className="text-sm text-zinc-500 mt-1">We respond within 24 hours</p>
                                    </div>
                                </div>

                                <div className="flex items-start gap-4">
                                    <div className="p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                                        <MessageSquare className="w-6 h-6 text-purple-400" />
                                    </div>
                                    <div>
                                        <h3 className="font-medium mb-1">General Inquiries</h3>
                                        <a
                                            href="mailto:hello@ugccreator.com"
                                            className="text-purple-400 hover:text-purple-300"
                                        >
                                            hello@ugccreator.com
                                        </a>
                                        <p className="text-sm text-zinc-500 mt-1">For partnerships and press</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
                            <h3 className="font-semibold mb-3">Quick Links</h3>
                            <ul className="space-y-3 text-zinc-400">
                                <li>
                                    <Link href="/pricing" className="hover:text-white transition-colors">
                                        → View Pricing Plans
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
                    <div className="bg-zinc-900 rounded-xl p-8 border border-zinc-800">
                        {submitted ? (
                            <div className="text-center py-12">
                                <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                                    <Send className="w-8 h-8 text-green-400" />
                                </div>
                                <h3 className="text-xl font-semibold mb-2">Message Sent!</h3>
                                <p className="text-zinc-400">
                                    Thank you for reaching out. We&apos;ll get back to you within 24 hours.
                                </p>
                                <button
                                    onClick={() => {
                                        setSubmitted(false);
                                        setFormData({ name: '', email: '', subject: 'general', message: '' });
                                    }}
                                    className="mt-6 text-purple-400 hover:text-purple-300"
                                >
                                    Send another message
                                </button>
                            </div>
                        ) : (
                            <form onSubmit={handleSubmit} className="space-y-6">
                                <div>
                                    <label htmlFor="name" className="block text-sm font-medium mb-2">
                                        Your Name
                                    </label>
                                    <input
                                        type="text"
                                        id="name"
                                        required
                                        value={formData.name}
                                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                        className="w-full px-4 py-3 bg-black border border-zinc-700 rounded-lg focus:outline-none focus:border-purple-500 transition-colors"
                                        placeholder="John Doe"
                                    />
                                </div>

                                <div>
                                    <label htmlFor="email" className="block text-sm font-medium mb-2">
                                        Email Address
                                    </label>
                                    <input
                                        type="email"
                                        id="email"
                                        required
                                        value={formData.email}
                                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                        className="w-full px-4 py-3 bg-black border border-zinc-700 rounded-lg focus:outline-none focus:border-purple-500 transition-colors"
                                        placeholder="john@example.com"
                                    />
                                </div>

                                <div>
                                    <label htmlFor="subject" className="block text-sm font-medium mb-2">
                                        Subject
                                    </label>
                                    <select
                                        id="subject"
                                        value={formData.subject}
                                        onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                                        className="w-full px-4 py-3 bg-black border border-zinc-700 rounded-lg focus:outline-none focus:border-purple-500 transition-colors"
                                    >
                                        <option value="general">General Inquiry</option>
                                        <option value="support">Technical Support</option>
                                        <option value="billing">Billing Question</option>
                                        <option value="partnership">Partnership</option>
                                        <option value="feedback">Feedback</option>
                                    </select>
                                </div>

                                <div>
                                    <label htmlFor="message" className="block text-sm font-medium mb-2">
                                        Message
                                    </label>
                                    <textarea
                                        id="message"
                                        required
                                        rows={5}
                                        value={formData.message}
                                        onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                                        className="w-full px-4 py-3 bg-black border border-zinc-700 rounded-lg focus:outline-none focus:border-purple-500 transition-colors resize-none"
                                        placeholder="How can we help you?"
                                    />
                                </div>

                                <button
                                    type="submit"
                                    disabled={isSubmitting}
                                    className="w-full py-3 px-6 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/50 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                                >
                                    {isSubmitting ? (
                                        <>
                                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                            Sending...
                                        </>
                                    ) : (
                                        <>
                                            <Send className="w-5 h-5" />
                                            Send Message
                                        </>
                                    )}
                                </button>
                            </form>
                        )}
                    </div>
                </div>

                <div className="mt-16 pt-8 border-t border-zinc-800 text-center text-zinc-500 text-sm">
                    <p>© 2026 UGC Creator. All rights reserved.</p>
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
