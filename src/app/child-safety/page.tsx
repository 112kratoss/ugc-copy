import Link from 'next/link';

import { resolveChildSafetyContact } from '@/lib/child-safety-contact';
import { siteConfig } from '@/lib/seo';

const reportSubject = encodeURIComponent('Urgent child-safety concern');
const reportBody = encodeURIComponent(
  [
    'Content URL or in-app report ID:',
    '',
    'Reason for concern:',
    '',
    'Do not attach, download, or redistribute suspected abusive material.',
  ].join('\n'),
);

export default function ChildSafetyPage() {
  const contact = resolveChildSafetyContact();
  const reportHref = `mailto:${contact.email}?subject=${reportSubject}&body=${reportBody}`;

  return (
    <div className="ui-page ui-page-ambient min-h-screen px-6 py-10 text-[var(--ui-text-primary)] sm:py-16">
      <div className="mx-auto max-w-4xl">
        <nav className="mb-14 flex items-center justify-between gap-4" aria-label="Safety page navigation">
          <Link
            className="ui-focus-ring rounded-xl text-lg font-extrabold tracking-tight text-[var(--ui-text-primary)]"
            href="/"
          >
            magicbooklet
          </Link>
          <Link
            className="ui-focus-ring rounded-full border border-[var(--ui-border-default)] px-4 py-2 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
            href="/contact"
          >
            General support
          </Link>
        </nav>

        <p className="text-sm font-bold uppercase tracking-[0.2em] text-rose-300">
          Trust and safety
        </p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">
          Child Safety Standards
        </h1>
        <p className="mt-5 max-w-3xl text-base leading-7 text-[var(--ui-text-secondary)]">
          {siteConfig.name} has zero tolerance for child sexual abuse material, grooming,
          sexual exploitation of children, or content that sexualizes a minor. The service
          is intended only for people aged 18 or older.
        </p>

        <section className="mt-10 rounded-[28px] border border-rose-400/25 bg-rose-400/[0.07] p-6 sm:p-8">
          <h2 className="text-2xl font-bold text-rose-100">Report a child-safety concern</h2>
          <p className="mt-4 max-w-3xl leading-7 text-[var(--ui-text-secondary)]">
            Use the in-app report control when it is available. For urgent child-safety
            escalation, email the content URL or in-app report ID to the safety contact.
            Do not download, screenshot, attach, or redistribute suspected abusive material.
          </p>
          <a
            className="ui-focus-ring mt-6 inline-flex min-h-12 items-center justify-center rounded-full bg-rose-200 px-6 py-3 font-extrabold text-rose-950 transition hover:bg-rose-100"
            href={reportHref}
          >
            Email {contact.email}
          </a>
          <p className="mt-4 text-sm leading-6 text-[var(--ui-text-muted)]">
            If a child is in immediate danger, contact local emergency services or the
            appropriate child-protection authority first.
          </p>
        </section>

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <section className="ui-card p-6 sm:p-7">
            <h2 className="text-xl font-bold">What we prohibit</h2>
            <ul className="mt-4 list-disc space-y-3 pl-5 leading-7 text-[var(--ui-text-secondary)]">
              <li>Child sexual abuse or exploitation material, whether real or AI-generated.</li>
              <li>Grooming, solicitation, trafficking, sextortion, or sexualized communication involving minors.</li>
              <li>Requests, prompts, uploads, links, or marketplace content that sexualize or endanger a minor.</li>
              <li>Attempts to evade safety controls or redistribute previously removed material.</li>
            </ul>
          </section>

          <section className="ui-card p-6 sm:p-7">
            <h2 className="text-xl font-bold">How reports are handled</h2>
            <ul className="mt-4 list-disc space-y-3 pl-5 leading-7 text-[var(--ui-text-secondary)]">
              <li>Safety reports are prioritized for restricted staff review.</li>
              <li>Content and accounts may be restricted while a report is investigated.</li>
              <li>Confirmed violations are removed and may lead to permanent account termination.</li>
              <li>We preserve only the evidence needed and make legally required reports to the relevant authorities.</li>
            </ul>
          </section>
        </div>

        <section className="ui-card mt-8 p-6 sm:p-8">
          <h2 className="text-2xl font-bold">Information that helps us act</h2>
          <p className="mt-4 leading-7 text-[var(--ui-text-secondary)]">
            Include the content URL, creator profile, or report ID; where you encountered
            it; and a brief non-graphic explanation of the concern. Do not send the media
            itself. We may request limited follow-up information necessary to locate the
            content or protect an affected person.
          </p>
        </section>

        <p className="mt-10 text-sm leading-6 text-[var(--ui-text-muted)]">
          These standards supplement our{' '}
          <Link className="text-[var(--ui-primary)] underline underline-offset-4" href="/terms">
            Terms of Service
          </Link>{' '}
          and{' '}
          <Link className="text-[var(--ui-primary)] underline underline-offset-4" href="/privacy">
            Privacy Policy
          </Link>
          . General support is available through our{' '}
          <Link className="text-[var(--ui-primary)] underline underline-offset-4" href="/contact">
            contact page
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
