'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, Gift } from 'lucide-react';

import { supabase } from '@/lib/supabase';

type WelcomeStatus = { status: string; amount: number };

// One read per page load, shared by the strip and the rail (one of the two is
// hidden at any width).
let welcomeStatusPromise: Promise<WelcomeStatus | null> | null = null;

async function readWelcomeStatus(): Promise<WelcomeStatus | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const response = await fetch('/api/credits/welcome', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const body = await response.json() as Partial<WelcomeStatus>;
  return typeof body.status === 'string' ? { status: body.status, amount: typeof body.amount === 'number' ? body.amount : 0 } : null;
}

/**
 * Unclaimed welcome credits, with the way to claim them. The welcome page is
 * reached only through the redirect after sign-in, so a creator who chose
 * "Claim later" had no way back on the web; the app shows this card on Home.
 */
export default function WelcomeCreditsCard() {
  const [welcome, setWelcome] = useState<WelcomeStatus | null>(null);

  useEffect(() => {
    let active = true;
    welcomeStatusPromise ??= readWelcomeStatus().catch(() => null);
    void welcomeStatusPromise.then((result) => {
      if (active) setWelcome(result);
    });
    return () => {
      active = false;
    };
  }, []);

  if (welcome?.status !== 'eligible') return null;

  return (
    <Link
      href="/welcome-reward?next=%2F"
      className="ui-focus-ring mb-4 flex items-center gap-3 rounded-2xl border border-[rgba(255,122,89,0.28)] bg-[var(--ui-surface-1)] px-4 py-3 text-sm transition hover:border-[var(--ui-primary)]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
        <Gift className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold text-[var(--ui-text-primary)]">Your welcome credits are waiting</span>
        <span className="block text-xs text-[var(--ui-text-muted)]">{`Claim ${welcome.amount} creation credits.`}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-[var(--ui-primary)]" aria-hidden />
    </Link>
  );
}
