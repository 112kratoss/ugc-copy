import Link from 'next/link';

const AGREEMENT_LINK_CLASS = 'font-bold text-[var(--ui-text-secondary)] underline underline-offset-2 hover:text-[var(--ui-text-primary)]';

/**
 * What a person agrees to by pressing Continue with Google, which makes an
 * account as well as signing one in (audit 01-6): the Terms, the Privacy
 * Policy, and that prompts and media are processed by the AI providers it
 * lists. Every Google button on the web carries it, tied to the button with
 * aria-describedby: the login page's tabs and the creators' sign-up sheet.
 */
export default function GoogleSignInAgreement({ id, className }: { id: string; className?: string }) {
  return (
    <p id={id} className={className ?? 'mt-3 text-center text-xs leading-5 text-[var(--ui-text-muted)]'}>
      By continuing you agree to the{' '}
      <Link href="/terms" prefetch={false} className={AGREEMENT_LINK_CLASS}>Terms</Link>
      {' '}and the{' '}
      <Link href="/privacy" prefetch={false} className={AGREEMENT_LINK_CLASS}>Privacy Policy</Link>
      . Prompts and media you generate are processed by the AI providers{' '}
      <Link href="/privacy#ai-processing" prefetch={false} className={AGREEMENT_LINK_CLASS}>listed in the policy</Link>
      .
    </p>
  );
}
