'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';

export function ContactForm() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    subject: 'general',
    message: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to send message');
      }

      setSubmitted(true);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to send message. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="text-center py-12">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20">
          <Send className="h-8 w-8 text-green-400" />
        </div>
        <h3 className="mb-2 text-xl font-semibold">Message Sent!</h3>
        <p className="text-zinc-400">
          Thank you for reaching out. We&apos;ll get back to you within 24 hours.
        </p>
        <button
          type="button"
          onClick={() => {
            setSubmitted(false);
            setFormData({ name: '', email: '', subject: 'general', message: '' });
          }}
          className="mt-6 text-purple-400 hover:text-purple-300"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label htmlFor="name" className="mb-2 block text-sm font-medium">
          Your Name
        </label>
        <input
          type="text"
          id="name"
          required
          value={formData.name}
          onChange={(event) => setFormData({ ...formData, name: event.target.value })}
          className="w-full rounded-lg border border-zinc-700 bg-black px-4 py-3 transition-colors focus:border-purple-500 focus:outline-none"
          placeholder="John Doe"
        />
      </div>

      <div>
        <label htmlFor="email" className="mb-2 block text-sm font-medium">
          Email Address
        </label>
        <input
          type="email"
          id="email"
          required
          value={formData.email}
          onChange={(event) => setFormData({ ...formData, email: event.target.value })}
          className="w-full rounded-lg border border-zinc-700 bg-black px-4 py-3 transition-colors focus:border-purple-500 focus:outline-none"
          placeholder="john@example.com"
        />
      </div>

      <div>
        <label htmlFor="subject" className="mb-2 block text-sm font-medium">
          Subject
        </label>
        <select
          id="subject"
          value={formData.subject}
          onChange={(event) => setFormData({ ...formData, subject: event.target.value })}
          className="w-full rounded-lg border border-zinc-700 bg-black px-4 py-3 transition-colors focus:border-purple-500 focus:outline-none"
        >
          <option value="general">General Inquiry</option>
          <option value="support">Technical Support</option>
          <option value="billing">Billing Question</option>
          <option value="partnership">Partnership</option>
          <option value="feedback">Feedback</option>
        </select>
      </div>

      <div>
        <label htmlFor="message" className="mb-2 block text-sm font-medium">
          Message
        </label>
        <textarea
          id="message"
          required
          rows={5}
          value={formData.message}
          onChange={(event) => setFormData({ ...formData, message: event.target.value })}
          className="w-full resize-none rounded-lg border border-zinc-700 bg-black px-4 py-3 transition-colors focus:border-purple-500 focus:outline-none"
          placeholder="How can we help you?"
        />
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-500 px-6 py-3 font-medium transition-all hover:bg-purple-600 disabled:bg-purple-500/50"
      >
        {isSubmitting ? (
          <>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Sending...
          </>
        ) : (
          <>
            <Send className="h-5 w-5" />
            Send Message
          </>
        )}
      </button>
    </form>
  );
}
