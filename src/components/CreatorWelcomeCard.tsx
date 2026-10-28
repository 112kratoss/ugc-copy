'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Check, Gift, X } from 'lucide-react';
import clsx from 'clsx';

import { useAuth } from '@/components/AuthProvider';
import { Button, getAccentClasses, IconButton, Surface, Text } from '@/components/DesignSystem';
import PublicIdentityFields from '@/components/PublicIdentityFields';
import { withoutCreatorReturnFlags } from '@/lib/auth-onboarding';
import type { WelcomeCreditStatus } from '@/lib/onboarding';
import {
  claimPublicIdentity,
  getInitialPublicIdentity,
  loadOwnProfile,
  validatePublicIdentity,
  type PublicIdentityDraft,
  type PublicIdentityErrors,
} from '@/lib/public-identity';
import { describeReferralClaim } from '@/lib/referral-claim-copy';
import type { ProfileApiResponse } from '@/lib/profile';

/**
 * What the post-auth redirect tells a creator about an account back from
 * sign-up: `?welcome=1`, with the invite's outcome as `?referral=`.
 */
export type CreatorWelcome = { referral: string | null };

type WelcomeCredits = {
  status: WelcomeCreditStatus;
  amount: number;
  credits: number;
  identityComplete: boolean;
};

type CardState =
  /** The name and handle unlock the credits (the claim refuses an account without them). */
  | { kind: 'identity'; amount: number }
  /** The name and handle are there, the credits not yet added. */
  | { kind: 'claim'; amount: number }
  | { kind: 'added'; amount: number }
  /** Nothing to add: the account is back, and so is its form. */
  | { kind: 'back'; note: string | null }
  /** The welcome credits could not be read: said, with a way to ask again. */
  | { kind: 'unread' }
  | { kind: 'loading' }
  | { kind: 'closed' };

async function welcomeRequest(path: string, accessToken: string, init?: RequestInit): Promise<WelcomeCredits> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...init?.headers },
  });
  const body = await response.json().catch(() => null) as (WelcomeCredits & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || 'Your welcome credits could not be added. Try again.');
  return body;
}

/**
 * The address without the flags that brought the account here, so a reload does
 * not greet it again. Passed to Next's own history handling (a null state), so
 * the router and its back-forward entries keep the new address as well.
 */
function dropWelcomeFlags() {
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const cleaned = withoutCreatorReturnFlags(here);
  if (cleaned !== here) window.history.replaceState(null, '', cleaned);
}

/**
 * The creator's greeting for an account back from the sign-up a visitor opened
 * at Generate (owner, 2026-10-28). The welcome credits need a name and a handle
 * (`claim_credit_grant_program` refuses an account without them), so a new
 * account gets one card, filled in from the sign-in, whose one press saves both
 * and adds the credits. Nothing runs: Generate is theirs to press.
 */
export default function CreatorWelcomeCard({
  welcome,
  carriedDraft,
}: {
  welcome: CreatorWelcome;
  /** The visitor's draft came back with the account, so the form is as they left it. */
  carriedDraft: boolean;
}) {
  const auth = useAuth();
  const { session, updateCredits } = auth;
  const user = auth.user ?? session?.user ?? null;
  const accessToken = session?.access_token ?? null;
  const titleId = useId();
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [profile, setProfile] = useState<ProfileApiResponse | null>(null);
  const [identityEdits, setIdentityEdits] = useState<PublicIdentityDraft | null>(null);
  const [identityErrors, setIdentityErrors] = useState<PublicIdentityErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const referralLine = describeReferralClaim(welcome.referral);
  const identity = identityEdits ?? getInitialPublicIdentity(profile, user);
  const userId = user?.id ?? null;
  const backLine = carriedDraft
    ? 'Your prompt and settings are as you left them. Press Generate when you’re ready; nothing has been spent.'
    : 'Press Generate when you’re ready; nothing has been spent.';

  // Read on every run of the effect, and taken only while the card still waits: a
  // run cancelled under it (React runs a development effect twice) left the card
  // empty when a guard stopped the second run, and a token refreshed later must
  // not take the card back from "added". The flags leave the address once the
  // status is known, so a reload after a failed read asks again.
  useEffect(() => {
    if (!accessToken || !userId) return;
    let active = true;
    void Promise.all([
      welcomeRequest('/api/credits/welcome', accessToken).catch(() => null),
      loadOwnProfile(accessToken),
    ]).then(([credits, ownProfile]) => {
      if (!active) return;
      setProfile((current) => current ?? ownProfile);
      const next: CardState = !credits
        ? { kind: 'unread' }
        : credits.status === 'not_eligible' && !credits.identityComplete
          ? { kind: 'identity', amount: credits.amount }
          : credits.status === 'eligible'
            ? { kind: 'claim', amount: credits.amount }
            : { kind: 'back', note: null };
      if (next.kind !== 'unread') dropWelcomeFlags();
      setState((current) => (current.kind === 'loading' || current.kind === 'unread' ? next : current));
    });
    return () => {
      active = false;
    };
  }, [accessToken, attempt, userId]);

  const addCredits = async (token: string) => {
    const result = await welcomeRequest('/api/credits/welcome/claim', token, {
      method: 'POST',
      body: JSON.stringify({ sourceSurface: 'web' }),
    });
    if (result.status === 'claimed') {
      updateCredits(result.credits);
      setState({ kind: 'added', amount: result.amount });
    } else if (result.status === 'identity_already_claimed') {
      setState({ kind: 'back', note: 'This sign-in already had its welcome credits on another account.' });
    } else {
      // Added before (another tab), or not on offer: the shell reads the balance again.
      window.dispatchEvent(new Event('credits_updated'));
      setState({ kind: 'back', note: null });
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !accessToken || (state.kind !== 'identity' && state.kind !== 'claim')) return;
    setError(null);
    if (state.kind === 'identity') {
      const localErrors = validatePublicIdentity(identity, profile?.username);
      if (localErrors.displayName || localErrors.username) {
        setIdentityErrors(localErrors);
        return;
      }
    }
    setBusy(true);
    try {
      if (state.kind === 'identity') {
        const saved = await claimPublicIdentity(identity, accessToken);
        if (!saved.ok) {
          setIdentityErrors(saved.errors);
          setError(saved.errors.displayName || saved.errors.username ? null : saved.message);
          return;
        }
        setProfile(saved.profile);
      }
      await addCredits(accessToken);
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : 'Your welcome credits could not be added. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === 'loading' || state.kind === 'closed') return null;

  if (state.kind === 'unread') {
    return (
      <Surface as="section" variant="panel" padding="none" ariaLive="polite" className="p-4">
        <Text as="h2" variant="label">Your welcome credits could not be read</Text>
        <Text variant="bodySm" className="mt-1">{backLine}</Text>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setAttempt((count) => count + 1)}>Try again</Button>
          <Button variant="ghost" onClick={() => setState({ kind: 'closed' })}>Not now</Button>
        </div>
      </Surface>
    );
  }

  if (state.kind === 'added' || state.kind === 'back') {
    return (
      <Surface as="section" variant="panel" padding="none" ariaLive="polite" className="p-4">
        <div className="flex items-start gap-3">
          <span aria-hidden className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-full border', getAccentClasses('workflow').iconWrap)}>
            <Check className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <Text as="h2" variant="label">
              {state.kind === 'added' ? `You’re in: ${state.amount} free credits added` : 'You’re signed in'}
            </Text>
            <Text variant="bodySm" className="mt-1">{state.kind === 'back' && state.note ? `${state.note} ${backLine}` : backLine}</Text>
            {referralLine ? <Text variant="bodySm" className="mt-2">{referralLine}</Text> : null}
          </div>
          <IconButton label="Dismiss" icon={X} onClick={() => setState({ kind: 'closed' })} className="-mr-2 -mt-2 shrink-0" />
        </div>
      </Surface>
    );
  }

  const asksIdentity = state.kind === 'identity';
  return (
    <Surface as="section" variant="panel" padding="none" className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} noValidate aria-labelledby={titleId}>
        <div className="flex items-start gap-3">
          <span aria-hidden className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-full border', getAccentClasses('video').iconWrap)}>
            <Gift className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <Text as="h2" id={titleId} variant="label">
              {asksIdentity ? 'Pick your name and handle' : `${state.amount} free credits are waiting`}
            </Text>
            <Text variant="bodySm" className="mt-1">
              {asksIdentity
                ? `They show on what you post, and they add your ${state.amount} free credits. You can change them later in your profile.`
                : `Add them, then press Generate when you’re ready.${carriedDraft ? ' Your prompt and settings are as you left them.' : ''}`}
            </Text>
          </div>
        </div>
        {asksIdentity ? (
          <div className="mt-4">
            <PublicIdentityFields
              idPrefix="creator-welcome"
              value={identity}
              errors={identityErrors}
              disabled={busy}
              accessToken={accessToken}
              savedUsername={profile?.username}
              framed={false}
              stacked
              onChange={(next) => {
                setIdentityEdits(next);
                setIdentityErrors({});
              }}
            />
          </div>
        ) : null}
        {referralLine ? <Text variant="bodySm" className="mt-3">{referralLine}</Text> : null}
        {error ? <p role="alert" className="mt-3 text-sm text-[var(--ui-accent-danger)]">{error}</p> : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy} className="flex-1">
            {busy ? 'Adding…' : asksIdentity ? `Save and add ${state.amount} credits` : `Add ${state.amount} credits`}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setState({ kind: 'closed' })}>
            Not now
          </Button>
        </div>
      </form>
    </Surface>
  );
}
