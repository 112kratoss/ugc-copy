'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, Gift } from 'lucide-react';

import { buildProfileSetupPath } from '@/lib/auth-onboarding';
import { supabase } from '@/lib/supabase';

type WelcomeStatus = { status: string; amount: number; identityComplete: boolean | null };

// One read shared by the strip and the rail (one of the two is hidden at any
// width), kept only for a few seconds: a claim or a sign-in change later in
// the session must be seen on the next visit to Home.
const SHARED_READ_TTL_MS = 5_000;
let welcomeStatusPromise: Promise<WelcomeStatus | null> | null = null;
let welcomeStatusReadAt = 0;

async function readWelcomeStatus(): Promise<WelcomeStatus | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const response = await fetch('/api/credits/welcome', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const body = await response.json() as Partial<WelcomeStatus>;
  return typeof body.status === 'string'
    ? {
      status: body.status,
      amount: typeof body.amount === 'number' ? body.amount : 0,
      identityComplete: typeof body.identityComplete === 'boolean' ? body.identityComplete : null,
    }
    : null;
}

/**
 * Unclaimed welcome credits, with the way to claim them. The welcome page is
 * reached only through the redirect after sign-in, so a creator who chose
 * "Claim later" had no way back on the web; the app shows this card on Home.
 *
 * Before that, the setup itself: an account without a claimed handle reads
 * `not_eligible`, and someone who skipped setup at sign-in was never asked
 * again. The app's resume card checks identity above the reward; so does this.
 */
export default function WelcomeCreditsCard() {
  const [welcome, setWelcome] = useState<WelcomeStatus | null>(null);

  useEffect(() => {
    let active = true;
    if (!welcomeStatusPromise || Date.now() - welcomeStatusReadAt > SHARED_READ_TTL_MS) {
      welcomeStatusPromise = readWelcomeStatus().catch(() => null);
      welcomeStatusReadAt = Date.now();
    }
    void welcomeStatusPromise.then((result) => {
      if (active) setWelcome(result);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!welcome) return null;

  const needsSetup = welcome.identityComplete === false
    && (welcome.status === 'not_eligible' || welcome.status === 'eligible');
  if (!needsSetup && welcome.status !== 'eligible') return null;

  return (
    <Link
      href={needsSetup ? buildProfileSetupPath('/') : '/welcome-reward?next=%2F'}
      className="ui-focus-ring mb-4 flex items-center gap-3 rounded-2xl border border-[rgba(255,122,89,0.28)] bg-[var(--ui-surface-1)] px-4 py-3 text-sm transition hover:border-[var(--ui-primary)]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
        <Gift className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold text-[var(--ui-text-primary)]">
          {needsSetup ? 'Finish your creator setup' : 'Your welcome credits are waiting'}
        </span>
        <span className="block text-xs text-[var(--ui-text-muted)]">
          {needsSetup ? 'Pick the name people will see.' : `Claim ${welcome.amount} creation credits.`}
        </span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-[var(--ui-primary)]" aria-hidden />
    </Link>
  );
}
