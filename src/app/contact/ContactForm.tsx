'use client';

import { useRef, useState } from 'react';
import { Send } from 'lucide-react';

import { useFieldValueBeforeHydration } from '@/lib/use-field-value-before-hydration';
import { useTypedBeforeHydration } from '@/lib/use-typed-before-hydration';

type ContactFields = { name: string; email: string; subject: string; message: string };

const EMPTY_FORM: ContactFields = { name: '', email: '', subject: 'general', message: '' };

export function ContactForm() {
  const [formData, setFormData] = useState(EMPTY_FORM);
  // From the latest state, not this render's: the hand-overs below run one after another in one
  // commit, and a spread of this render's `formData` would undo the one before.
  const setField = (field: keyof ContactFields) => (value: string) => {
    setFormData((current) => ({ ...current, [field]: value }));
  };
  // The page is prerendered, so a visitor can fill the form in before its script runs, and
  // hydration does not read the fields back: Send posted an empty form (2026-11-05;
  // tests/e2e/contact-typed-before-script.spec.ts). The message takes only typed text, as the
  // creators' prompts do.
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLSelectElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  useFieldValueBeforeHydration(nameRef, { drawn: EMPTY_FORM.name, onValue: setField('name') });
  useFieldValueBeforeHydration(emailRef, { drawn: EMPTY_FORM.email, onValue: setField('email') });
  useFieldValueBeforeHydration(subjectRef, { drawn: EMPTY_FORM.subject, onValue: setField('subject') });
  useTypedBeforeHydration(messageRef, { drawn: EMPTY_FORM.message, enabled: true, onTyped: setField('message') });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

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
      setError(error instanceof Error ? error.message : 'Failed to send message. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div role="status" className="py-12 text-center">
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
            setFormData(EMPTY_FORM);
          }}
          className="ui-focus-ring mt-6 min-h-12 rounded-full px-4 font-bold text-[var(--ui-primary)] hover:bg-[var(--ui-primary-soft)]"
        >
          Send another message
        </button>
      </div>
    );
  }

  // No field has a name: Enter pressed before the page's script has run submits the form the
  // browser's own way, and a GET of named fields wrote the name, email and message into the
  // address. A post is no way out here: Vercel answers a post to this prerendered page itself,
  // with an empty 405. With nothing named, the GET sends nothing and the page loads again.
  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label htmlFor="name" className="mb-2 block text-sm font-bold">
          Your Name
        </label>
        <input
          type="text"
          ref={nameRef}
          id="name"
          required
          autoComplete="name"
          value={formData.name}
          onChange={(event) => setField('name')(event.target.value)}
          className="ui-focus-ring min-h-12 w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 outline-none transition focus:border-[var(--ui-focus)]"
          placeholder="John Doe"
        />
      </div>

      <div>
        <label htmlFor="email" className="mb-2 block text-sm font-bold">
          Email Address
        </label>
        <input
          type="email"
          ref={emailRef}
          id="email"
          required
          autoComplete="email"
          value={formData.email}
          onChange={(event) => setField('email')(event.target.value)}
          className="ui-focus-ring min-h-12 w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 outline-none transition focus:border-[var(--ui-focus)]"
          placeholder="john@example.com"
        />
      </div>

      <div>
        <label htmlFor="subject" className="mb-2 block text-sm font-bold">
          Subject
        </label>
        <select
          ref={subjectRef}
          id="subject"
          value={formData.subject}
          onChange={(event) => setField('subject')(event.target.value)}
          className="ui-focus-ring min-h-12 w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 outline-none transition focus:border-[var(--ui-focus)]"
        >
          <option value="general">General Inquiry</option>
          <option value="support">Technical Support</option>
          <option value="billing">Billing Question</option>
          <option value="partnership">Partnership</option>
          <option value="feedback">Feedback</option>
        </select>
      </div>

      <div>
        <label htmlFor="message" className="mb-2 block text-sm font-bold">
          Message
        </label>
        <textarea
          ref={messageRef}
          id="message"
          required
          rows={5}
          value={formData.message}
          onChange={(event) => setField('message')(event.target.value)}
          className="ui-focus-ring w-full resize-none rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 outline-none transition focus:border-[var(--ui-focus)]"
          placeholder="How can we help you?"
        />
      </div>

      {error ? (
        <div role="alert" className="rounded-2xl border border-rose-300/25 bg-rose-400/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="ui-focus-ring flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 py-3 font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:opacity-50"
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
