'use client';

import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Gift } from 'lucide-react';

import { buildProfileSetupPath } from '@/lib/auth-onboarding';
import { supabase } from '@/lib/supabase';

type WelcomeStatus = {
  status: string;
  amount: number;
  identityComplete: boolean | null;
  /** The account the status is for: Later is kept per account. */
  userId: string | null;
};

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
      userId: data.session?.user?.id ?? null,
    }
    : null;
}

/*
 * Later on the setup prompt holds, as the app's "Choose a name later" does
 * (`identityDeferredAt`): kept in this browser, per account. Both copies of
 * the card hear it, so the copy shown at the other width stays away too.
 */
const SETUP_LATER_KEY_PREFIX = 'magicbooklet:creator-setup-later:v1:';
const setupLaterListeners = new Set<() => void>();
// Where storage is blocked, Later holds for this page instead.
const setupLaterThisPage = new Set<string>();

function subscribeToSetupLater(listener: () => void) {
  setupLaterListeners.add(listener);
  return () => {
    setupLaterListeners.delete(listener);
  };
}

function isSetupLater(accountKey: string) {
  if (setupLaterThisPage.has(accountKey)) return true;
  try {
    return window.localStorage.getItem(`${SETUP_LATER_KEY_PREFIX}${accountKey}`) !== null;
  } catch {
    return false;
  }
}

function chooseSetupLater(accountKey: string) {
  try {
    window.localStorage.setItem(`${SETUP_LATER_KEY_PREFIX}${accountKey}`, new Date().toISOString());
  } catch {
    setupLaterThisPage.add(accountKey);
  }
  setupLaterListeners.forEach((listener) => listener());
}

/**
 * Unclaimed welcome credits, with the way to claim them. The welcome page is
 * reached only through the redirect after sign-in, so a creator who chose
 * "Claim later" had no way back on the web; the app shows this card on Home.
 *
 * Before that, the setup itself, for every account without a claimed handle
 * whatever its credit status, until Later: an account older than the
 * programme reads `legacy_ineligible`, and it is the one most likely to still
 * carry a generated `creator-xxxxxxxx` handle. The app's resume card decides
 * the same way (`ugc-mobile/lib/onboarding-destination.ts`).
 */
export default function WelcomeCreditsCard() {
  const [welcome, setWelcome] = useState<WelcomeStatus | null>(null);
  const accountKey = welcome?.userId ?? 'signed-in';
  const setupLater = useSyncExternalStore(
    subscribeToSetupLater,
    () => isSetupLater(accountKey),
    () => false,
  );

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

  // A guest has no handle to claim; the app never asks one either.
  const needsSetup = welcome.identityComplete === false
    && welcome.status !== 'requires_account'
    && !setupLater;
  if (!needsSetup && welcome.status !== 'eligible') return null;

  return (
    <div className="mb-4 flex items-center rounded-2xl border border-[rgba(255,122,89,0.28)] bg-[var(--ui-surface-1)] text-sm transition hover:border-[var(--ui-primary)]">
      <Link
        href={needsSetup ? buildProfileSetupPath('/') : '/welcome-reward?next=%2F'}
        className="ui-focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-4 py-3"
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
      {needsSetup ? (
        <button
          type="button"
          onClick={() => chooseSetupLater(accountKey)}
          aria-label="Finish your creator setup later"
          className="ui-focus-ring mr-2 inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-xs font-bold text-[var(--ui-text-muted)] transition hover:text-[var(--ui-text-primary)]"
        >
          Later
        </button>
      ) : null}
    </div>
  );
}
