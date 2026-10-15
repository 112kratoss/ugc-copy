import Link from 'next/link';
import { AlertCircle, ArrowLeft, LogIn, RotateCcw, WandSparkles } from 'lucide-react';

import {
  getPasswordRecoveryNextPath,
  getSafeAuthNextPath,
  isPasswordRecoveryPath,
} from '@/lib/auth-onboarding';

interface AuthCodeErrorPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function getFirstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AuthCodeErrorPage({ searchParams }: AuthCodeErrorPageProps) {
  const params = searchParams ? await searchParams : {};
  const next = getSafeAuthNextPath(getFirstParam(params.next));
  const isRecovery = isPasswordRecoveryPath(next);
  // /auth/continue finishes a password sign-in and says so with method=password;
  // no link was involved, so the link-centric advice would mislead.
  const isPasswordSignIn = !isRecovery && getFirstParam(params.method) === 'password';
  const retryNext = isRecovery ? getPasswordRecoveryNextPath(next) : next;
  const retryHref = `/login?returnUrl=${encodeURIComponent(retryNext)}${isRecovery ? '&recovery=1' : ''}`;

  return (
    <div className="ui-page ui-page-ambient flex min-h-screen flex-col p-4 sm:p-6">
      <Link href="/" className="ui-focus-ring flex w-fit items-center gap-2 rounded-2xl text-[var(--ui-text-primary)]">
        <span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[var(--ui-primary)] text-[var(--ui-primary-on)]">
          <WandSparkles className="h-5 w-5" aria-hidden />
        </span>
        <span className="text-sm font-extrabold">magicbooklet</span>
      </Link>

      <div className="flex flex-1 items-center justify-center py-10">
        <main className="w-full max-w-md rounded-[28px] border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-6 shadow-[var(--ui-shadow-panel)] sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-300/20 bg-rose-400/10 text-rose-200">
            <AlertCircle className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
            {isRecovery ? 'This recovery link is no longer valid' : 'We could not finish signing you in'}
          </h1>
          <p className="mt-3 text-sm leading-6 text-[var(--ui-text-muted)]">
            {isRecovery
              ? 'The link may have expired or already been used. New reset links can’t be sent by email.'
              : isPasswordSignIn
                ? 'Try again.'
                : 'The sign-in link may have expired, already been used, or opened in a different browser. Try again to continue where you left off.'}
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            {/* For a recovery link, the sign-in page's recovery notice names Google and the support address. */}
            <Link
              href={retryHref}
              className="ui-focus-ring inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
            >
              {isRecovery ? <LogIn className="h-4 w-4" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
              {isRecovery ? 'Back to sign in' : 'Try sign in again'}
            </Link>
            <Link
              href="/"
              className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-5 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back home
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}
