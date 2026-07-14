'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, Gift, Loader2, Sparkles } from 'lucide-react';

import { supabase } from '@/lib/supabase';

type WelcomeCreditResponse = {
  status: 'eligible' | 'claimed' | 'already_claimed' | 'legacy_ineligible' | 'not_eligible' | 'unavailable';
  amount: number;
  credits: number;
  promotionalCredits: number;
  claimedAt: string | null;
  identityComplete: boolean;
};

async function authorizedRequest(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error('Please sign in again to continue.');
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
      ...init?.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not load your Creator Pack.');
  return body as WelcomeCreditResponse;
}

export default function WelcomeRewardClient({ nextPath }: { nextPath: string }) {
  const [welcome, setWelcome] = useState<WelcomeCreditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setWelcome(await authorizedRequest('/api/credits/welcome'));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not load your Creator Pack.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void authorizedRequest('/api/credits/welcome')
      .then((result) => {
        if (active) setWelcome(result);
      })
      .catch((nextError) => {
        if (active) setError(nextError instanceof Error ? nextError.message : 'Could not load your Creator Pack.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const claim = async () => {
    setClaiming(true);
    setError(null);
    try {
      setWelcome(await authorizedRequest('/api/credits/welcome/claim', {
        method: 'POST',
        body: JSON.stringify({ sourceSurface: 'web' }),
      }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not claim your credits.');
    } finally {
      setClaiming(false);
    }
  };

  const claimed = welcome?.status === 'claimed' || welcome?.status === 'already_claimed';
  const legacy = welcome?.status === 'legacy_ineligible';

  return (
    <main className="ui-page ui-page-ambient min-h-screen py-10 sm:py-16">
      <div className="studio-shell relative z-10 flex min-h-[72vh] items-center justify-center">
        <section className="w-full max-w-2xl rounded-[32px] border border-[rgba(255,122,89,0.28)] bg-[var(--ui-surface-1)] p-6 text-center shadow-[var(--ui-shadow-panel)] sm:p-10">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
            <Sparkles className="h-9 w-9" aria-hidden />
          </div>
          <div className="mt-6 text-xs font-black uppercase tracking-[0.2em] text-[var(--ui-primary)]">Creator Pack</div>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)] sm:text-4xl">Your Creator Pack is ready</h1>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-7 text-[var(--ui-text-secondary)]">
            {legacy
              ? 'Your existing welcome credits are already active.'
              : claimed
                ? 'Your creation credits are ready for your first project.'
                : 'Claim creation-only credits for images, video, and motion.'}
          </p>

          {loading ? (
            <div className="mt-10 flex items-center justify-center gap-3 text-sm font-bold text-[var(--ui-text-muted)]">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> Checking your reward…
            </div>
          ) : (
            <div className="mt-8">
              <div aria-live="polite" className="text-6xl font-black tabular-nums text-[var(--ui-primary)]">{welcome?.amount ?? 25}</div>
              <div className="mt-1 text-sm font-bold text-[var(--ui-text-secondary)]">creation credits</div>
              <p className="mt-3 text-xs text-[var(--ui-text-muted)]">Creation credits cannot be used for marketplace purchases.</p>
            </div>
          )}

          {error ? <p role="alert" className="mt-6 text-sm font-semibold text-rose-300">{error}</p> : null}

          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            {welcome?.status === 'eligible' ? (
              <button
                type="button"
                disabled={claiming}
                onClick={() => void claim()}
                className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 text-sm font-black text-[var(--ui-primary-on)] disabled:opacity-60"
              >
                {claiming ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Gift className="h-4 w-4" aria-hidden />}
                {claiming ? 'Claiming…' : 'Claim 25 credits'}
              </button>
            ) : null}
            {welcome?.status !== 'eligible' || error ? (
              <Link href={nextPath} className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 text-sm font-black text-[var(--ui-primary-on)]">
                Start creating <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            ) : null}
            {welcome?.status === 'eligible' ? (
              <Link href={nextPath} className="ui-focus-ring inline-flex min-h-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] px-6 text-sm font-bold text-[var(--ui-text-secondary)]">
                Claim later
              </Link>
            ) : null}
            {error ? (
              <button type="button" onClick={() => void load()} className="ui-focus-ring inline-flex min-h-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] px-6 text-sm font-bold text-[var(--ui-text-secondary)]">
                Try again
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
