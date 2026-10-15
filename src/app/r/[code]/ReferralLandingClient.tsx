'use client';

import { ArrowRight, CheckCircle2, Gift, Loader2, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

type VisitState = 'saving' | 'ready' | 'error';

/** The part of the visit answer's `program` (the `/api/referrals/me` shape) this page prints. */
type ReferralProgram = {
  inviteeFirstPurchasePercent: number;
  attributionWindowDays: number;
};

const numberFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });

function positiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// Null when the visit carries no terms (no active program, or they could not
// be read): the page then leaves the numbers out rather than print its own.
function readProgram(value: unknown): ReferralProgram | null {
  if (!value || typeof value !== 'object') return null;
  const program = value as Record<string, unknown>;
  const inviteeFirstPurchasePercent = positiveNumber(program.inviteeFirstPurchasePercent);
  const attributionWindowDays = positiveNumber(program.attributionWindowDays);
  return inviteeFirstPurchasePercent !== null && attributionWindowDays !== null
    ? { inviteeFirstPurchasePercent, attributionWindowDays }
    : null;
}

export default function ReferralLandingClient({
  appStoreUrl,
  code,
  destination,
  playStoreUrl,
}: {
  appStoreUrl: string | null;
  code: string;
  destination: string;
  playStoreUrl: string | null;
}) {
  const [state, setState] = useState<VisitState>('saving');
  const [error, setError] = useState<string | null>(null);
  const [program, setProgram] = useState<ReferralProgram | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    void fetch('/api/referrals/visit', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, source: 'web', next: destination }),
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json().catch(() => null) as { error?: string; program?: unknown } | null;
      if (!response.ok) throw new Error(payload?.error || 'Could not save this invite.');
      setProgram(readProgram(payload?.program));
      setState('ready');
    }).catch((nextError: unknown) => {
      if (nextError instanceof DOMException && nextError.name === 'AbortError') return;
      setState('error');
      setError(nextError instanceof Error ? nextError.message : 'Could not save this invite.');
    });

    return () => controller.abort();
  }, [code, destination, retryKey]);

  const signupPath = `/login?mode=signup&next=${encodeURIComponent(destination)}`;
  const message = state === 'saving'
    ? 'Securely saving this invite.'
    : state === 'error'
      ? error ?? 'Could not save this invite.'
      : program
        ? `Invite saved for ${numberFormatter.format(program.attributionWindowDays)} days. Create your new account to keep the first top-up bonus.`
        : 'Invite saved. Create your new account to keep the first top-up bonus.';

  return (
    <main className="ui-page ui-page-ambient min-h-screen px-4 py-10 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="ui-focus-ring inline-flex rounded-full px-3 py-2 text-sm font-extrabold text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]">
          magicbooklet
        </Link>

        <section className="mt-8 overflow-hidden rounded-[32px] border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] shadow-[var(--ui-shadow-panel)]">
          <div className="bg-[linear-gradient(135deg,var(--ui-primary-soft),var(--ui-surface-1)_58%,rgba(242,185,94,0.12))] px-6 py-10 text-center sm:px-12 sm:py-14">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[var(--ui-accent-commerce)] text-zinc-950 shadow-lg">
              <Gift className="h-8 w-8" aria-hidden />
            </span>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.2em] text-[var(--ui-accent-commerce)]">A Magicbooklet invite</p>
            <h1 className="mx-auto mt-3 max-w-xl text-4xl font-black tracking-tight text-[var(--ui-text-primary)] sm:text-5xl">
              {program
                ? `Get ${numberFormatter.format(program.inviteeFirstPurchasePercent)}% bonus credits on your first top-up.`
                : 'Get bonus credits on your first top-up.'}
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-[var(--ui-text-muted)]">
              Create images, videos, motion, audio, prompts, and workflows. The friend who invited you may also earn bonus credits.
            </p>
          </div>

          <div className="space-y-6 px-6 py-8 sm:px-12">
            <div
              role="status"
              aria-live="polite"
              className={`flex items-start gap-3 rounded-2xl border p-4 ${state === 'error' ? 'border-amber-400/40 bg-amber-400/10' : 'border-[var(--ui-border-default)] bg-[var(--ui-surface-2)]'}`}
            >
              {state === 'saving' ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[var(--ui-primary)]" aria-hidden /> : null}
              {state === 'ready' ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" aria-hidden /> : null}
              {state === 'error' ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden /> : null}
              <div className="min-w-0 flex-1">
                <p className="font-extrabold text-[var(--ui-text-primary)]">
                  {state === 'saving' ? 'Saving your invite' : state === 'ready' ? 'Invite ready' : 'Invite not saved yet'}
                </p>
                <p className="mt-1 text-sm leading-6 text-[var(--ui-text-muted)]">{message}</p>
              </div>
              {state === 'error' ? (
                <button
                  type="button"
                  onClick={() => {
                    setState('saving');
                    setError(null);
                    setRetryKey((value) => value + 1);
                  }}
                  className="ui-focus-ring inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-sm font-extrabold text-[var(--ui-primary)] hover:bg-[var(--ui-primary-soft)]"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden /> Retry
                </button>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
              <Link
                href={signupPath}
                aria-disabled={state !== 'ready'}
                onClick={(event) => { if (state !== 'ready') event.preventDefault(); }}
                className={`ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-5 text-sm font-black transition ${state === 'ready' ? 'bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:brightness-105' : 'cursor-not-allowed bg-[var(--ui-surface-3)] text-[var(--ui-text-faint)]'}`}
              >
                Create new account <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <div className="grid gap-1.5">
                <Link
                  href="/login"
                  aria-describedby="referral-existing-account-note"
                  className="ui-focus-ring inline-flex min-h-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] px-5 text-sm font-black text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-2)]"
                >
                  I already have an account
                </Link>
                {/* The claim refuses an existing account (`existing_account`). */}
                <p id="referral-existing-account-note" className="text-center text-xs leading-5 text-[var(--ui-text-faint)]">
                  New accounts only: signing in does not apply this invite.
                </p>
              </div>
            </div>

            {appStoreUrl || playStoreUrl ? (
              <div className="rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] p-4">
                <p className="flex items-center gap-2 text-sm font-extrabold text-[var(--ui-text-primary)]"><Smartphone className="h-4 w-4" aria-hidden /> Prefer the mobile app?</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {appStoreUrl ? <a href={appStoreUrl} className="ui-focus-ring rounded-full border border-[var(--ui-border-default)] px-4 py-2 text-sm font-bold text-[var(--ui-text-secondary)]">Open App Store</a> : null}
                  {playStoreUrl ? <a href={playStoreUrl} className="ui-focus-ring rounded-full border border-[var(--ui-border-default)] px-4 py-2 text-sm font-bold text-[var(--ui-text-secondary)]">Open Google Play</a> : null}
                </div>
              </div>
            ) : null}

            <p className="text-center text-xs leading-5 text-[var(--ui-text-faint)]">
              New accounts only. Offer applies to the first verified credit-pack purchase within the referral rules. Refunds, disputes, self-referrals, and abuse are ineligible. See the <Link href="/terms" className="underline underline-offset-2">Invite &amp; Earn terms</Link>.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
