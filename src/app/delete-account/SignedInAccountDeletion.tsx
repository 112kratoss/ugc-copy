'use client';

import type { Session, User } from '@supabase/supabase-js';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';

import { describeAuthError } from '@/lib/auth-error-copy';
import { siteConfig } from '@/lib/seo';

type BrowserSupabase = typeof import('@/lib/supabase')['supabase'];

let supabaseLoad: Promise<BrowserSupabase> | null = null;

/**
 * Loaded once the page is up, not with it: a signed-out reader of this policy
 * page never needs the client. One load serves every caller.
 */
function getSupabase(): Promise<BrowserSupabase> {
  supabaseLoad ??= import('@/lib/supabase')
    .then(({ supabase }) => supabase)
    .catch((error: unknown) => {
      // A chunk that failed to load is asked for again next time.
      supabaseLoad = null;
      throw error;
    });
  return supabaseLoad;
}

/** The sign-in page returns here once the person has signed in again. */
const SIGN_IN_AGAIN_PATH = '/login?returnUrl=/delete-account';
/** Where a seller requests a payout. */
const PAYOUT_PATH = '/marketplace/sell';
const APPLE_REAUTH_CODES = new Set(['APPLE_REAUTH_REQUIRED', 'APPLE_REAUTH_FAILED']);
const UNCONFIRMED_DELETION_COPY = 'We could not confirm the deletion. Check the connection and try again.';

type Earnings =
  | { status: 'loading' }
  | { status: 'loaded'; availableTokenSubunits: number; availableUsd: string; canRequest: boolean }
  | { status: 'failed' };

type Stage =
  | { kind: 'confirm' }
  | { kind: 'reauthenticate' }
  | { kind: 'apple' }
  | { kind: 'session-ended' }
  | { kind: 'done'; alreadyDeleted: boolean };

type DeletionOutcome =
  | { kind: 'scheduled' }
  | { kind: 'deleted' }
  | { kind: 'reauthenticate' }
  | { kind: 'apple' }
  | { kind: 'session-ended' }
  | { kind: 'refused'; message: string };

function signInProviders(user: User): Set<string> {
  const providers = new Set<string>();
  for (const identity of user.identities ?? []) {
    if (typeof identity.provider === 'string') providers.add(identity.provider);
  }
  const listed: unknown = user.app_metadata?.providers;
  if (Array.isArray(listed)) {
    for (const provider of listed) {
      if (typeof provider === 'string') providers.add(provider);
    }
  }
  if (typeof user.app_metadata?.provider === 'string') providers.add(user.app_metadata.provider);
  return providers;
}

/** What `DELETE /api/account` said, in the terms this page acts on. */
async function readDeletionOutcome(response: Response): Promise<DeletionOutcome> {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    body = null;
  }
  const code = typeof body?.code === 'string' ? body.code : null;
  const message = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : 'Try again in a moment.';

  if (response.ok) return body?.deleted === true ? { kind: 'deleted' } : { kind: 'scheduled' };
  // A deletion already under way, from this page or the app.
  if (response.status === 409 && code === 'ACCOUNT_DELETING') return { kind: 'scheduled' };
  if (response.status === 403 && body?.reason === 'reauthentication_required') {
    return code && APPLE_REAUTH_CODES.has(code) ? { kind: 'apple' } : { kind: 'reauthenticate' };
  }
  if (response.status === 401) return { kind: 'session-ended' };
  // The route's 500 says whether the account was touched. A failure answered by
  // the platform rather than the route came after the request arrived, and the
  // scheduler finishes a deletion that started.
  if (response.status === 500) {
    return body?.deletionScheduled === false ? { kind: 'refused', message } : { kind: 'scheduled' };
  }
  if (response.status > 500 && !body) return { kind: 'scheduled' };
  return { kind: 'refused', message };
}

async function requestDeletion(accessToken: string): Promise<DeletionOutcome> {
  const response = await fetch('/api/account', {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ confirmation: 'DELETE' }),
  });
  return readDeletionOutcome(response);
}

/** Ends this browser's session; the server has already ended the account's others. */
async function signOutHere() {
  try {
    const supabase = await getSupabase();
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // Every request with the old session is refused from now on anyway.
  }
}

function describePasswordCheckError(error: unknown): string {
  const raw = error instanceof Error ? error.message.toLowerCase() : '';
  if (raw.includes('invalid login credentials') || raw.includes('invalid_credentials')) {
    return 'That password does not match this account. Try again.';
  }
  return describeAuthError(error, 'Could not check the password. Try again.');
}

/**
 * The sign-in page sends a visitor who is still signed in straight back, so
 * the fresh sign-in the deletion asks for could never happen: this signs out
 * here first.
 */
function SignInAgainLink({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isLeaving, setIsLeaving] = useState(false);

  const handleClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (isLeaving) return;
    setIsLeaving(true);
    await signOutHere();
    router.push(SIGN_IN_AGAIN_PATH);
  };

  return (
    <Link
      href={SIGN_IN_AGAIN_PATH}
      onClick={(event) => void handleClick(event)}
      aria-disabled={isLeaving}
      className="mt-3 inline-flex min-h-12 items-center justify-center rounded-full bg-white px-5 py-3 font-semibold text-black transition hover:bg-zinc-200"
    >
      {children}
    </Link>
  );
}

function EarningsWarning({ earnings }: { earnings: Earnings }) {
  if (earnings.status === 'loading') return null;
  if (earnings.status === 'failed') {
    // A liability is never dropped without a word, even when the balance could not be read.
    return (
      <li>
        Unpaid sales earnings, if you have any, will be forfeited.{' '}
        <Link className="text-white underline underline-offset-4" href={PAYOUT_PATH}>Check your balance</Link> first.
      </li>
    );
  }
  if (earnings.availableTokenSubunits <= 0) return null;
  return (
    <li>
      {`Unpaid sales earnings of ${earnings.availableUsd} will be forfeited.`}
      {earnings.canRequest ? (
        <>
          {' '}
          <Link className="text-white underline underline-offset-4" href={PAYOUT_PATH}>Request a payout first</Link>.
        </>
      ) : null}
    </li>
  );
}

function AppleAccountNotice() {
  return (
    <div role="status" className="mt-6 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-5">
      <h3 className="text-lg font-semibold text-white">Delete this account in the app</h3>
      <p className="mt-2 leading-7 text-zinc-300">
        {`This account uses Sign in with Apple, which this website does not offer. Open the ${siteConfig.name} app on an iPhone, tap the menu (☰) at the top left of Home, then choose Settings and Delete account.`}
      </p>
    </div>
  );
}

/**
 * Self-serve deletion for a signed-in visitor of `/delete-account`; signed-out
 * readers keep the page's instructions and the email route. The server answers
 * 202 once the account is locked and every session is ended, and finishes the
 * sweep behind that answer.
 */
export default function SignedInAccountDeletion() {
  const [session, setSession] = useState<Session | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'confirm' });
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [earningsRead, setEarningsRead] = useState<{ userId: string; earnings: Earnings } | null>(null);
  const user = session?.user ?? null;
  const userId = user?.id ?? null;
  const earnings: Earnings = earningsRead && earningsRead.userId === userId
    ? earningsRead.earnings
    : { status: 'loading' };
  const isConfirmed = confirmation.trim().toUpperCase() === 'DELETE';

  useEffect(() => {
    let isActive = true;
    let unsubscribe: (() => void) | undefined;
    getSupabase()
      .then((supabase) => {
        if (!isActive) return;
        // Answers at once with the current session (INITIAL_SESSION), then on every change.
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
          setSession(nextSession);
        });
        unsubscribe = () => subscription.unsubscribe();
      })
      .catch(() => {
        // Without the client this stays the signed-out page.
      });
    return () => {
      isActive = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    let isActive = true;
    void (async () => {
      try {
        const supabase = await getSupabase();
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error('No session to read the payout balance');
        const response = await fetch('/api/creator/payouts', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(`Payout balance request failed with ${response.status}`);
        const body = await response.json() as {
          availableTokenSubunits?: unknown;
          availableUsd?: unknown;
          canRequest?: unknown;
        };
        if (typeof body.availableTokenSubunits !== 'number' || typeof body.availableUsd !== 'string') {
          throw new Error('Payout balance answer was incomplete');
        }
        if (isActive) {
          setEarningsRead({
            userId,
            earnings: {
              status: 'loaded',
              availableTokenSubunits: body.availableTokenSubunits,
              availableUsd: body.availableUsd,
              canRequest: body.canRequest === true,
            },
          });
        }
      } catch {
        if (isActive) setEarningsRead({ userId, earnings: { status: 'failed' } });
      }
    })();
    return () => {
      isActive = false;
    };
  }, [userId]);

  const applyOutcome = async (outcome: DeletionOutcome) => {
    switch (outcome.kind) {
      case 'scheduled':
      case 'deleted':
        setStage({ kind: 'done', alreadyDeleted: outcome.kind === 'deleted' });
        await signOutHere();
        return;
      case 'reauthenticate':
        setStage({ kind: 'reauthenticate' });
        return;
      case 'apple':
        setStage({ kind: 'apple' });
        return;
      case 'session-ended':
        setStage({ kind: 'session-ended' });
        return;
      case 'refused':
        setError(`Your account was not deleted. ${outcome.message}`);
        return;
    }
  };

  const handleDelete = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isConfirmed || isWorking) return;
    setIsWorking(true);
    setError(null);
    try {
      const supabase = await getSupabase();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        setStage({ kind: 'session-ended' });
        return;
      }
      await applyOutcome(await requestDeletion(token));
    } catch {
      // The request may or may not have arrived; a retry is safe either way.
      setError(UNCONFIRMED_DELETION_COPY);
    } finally {
      setIsWorking(false);
    }
  };

  // A password sign-in refreshes the account's last sign-in, which is what the
  // route asks for; the deletion then goes on with the new session.
  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = user?.email;
    if (!password || !email || isWorking) return;
    const enteredPassword = password;
    setPassword('');
    setIsWorking(true);
    setError(null);
    try {
      const supabase = await getSupabase();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: enteredPassword,
      });
      if (signInError || !data.session) {
        setError(describePasswordCheckError(signInError));
        return;
      }
      const outcome = await requestDeletion(data.session.access_token);
      if (outcome.kind === 'reauthenticate') {
        // Left as it was, the card would look as if nothing had happened.
        setError('Your account was not deleted. The new sign-in was not accepted yet; try again in a moment.');
        return;
      }
      await applyOutcome(outcome);
    } catch {
      setError(UNCONFIRMED_DELETION_COPY);
    } finally {
      setIsWorking(false);
    }
  };

  if (stage.kind === 'done') {
    return (
      <section role="status" className="mt-10 rounded-3xl border border-emerald-400/25 bg-emerald-400/[0.06] p-6">
        <p className="text-lg font-semibold text-white">
          {stage.alreadyDeleted
            ? 'Your account has been deleted. You have been signed out.'
            : 'Your account is being deleted. You have been signed out.'}
        </p>
        <Link
          href="/login"
          className="mt-5 inline-flex min-h-12 items-center justify-center rounded-full bg-white px-5 py-3 font-semibold text-black transition hover:bg-zinc-200"
        >
          Continue
        </Link>
      </section>
    );
  }

  if (!user || user.is_anonymous) return null;

  const providers = signInProviders(user);
  const isAppleLinked = stage.kind === 'apple' || providers.has('apple');
  const canUsePassword = Boolean(user.email) && (providers.has('email') || providers.size === 0);
  const canUseGoogle = providers.has('google');

  return (
    <section
      aria-labelledby="signed-in-deletion-title"
      className="mt-10 rounded-3xl border border-rose-400/30 bg-rose-400/[0.06] p-6"
    >
      <h2 id="signed-in-deletion-title" className="text-xl font-semibold text-rose-100">Delete your account now</h2>
      <p className="mt-3 leading-7 text-zinc-300">
        {user.email
          ? `You are signed in as ${user.email}. Deletion is permanent and cannot be undone.`
          : 'You are signed in. Deletion is permanent and cannot be undone.'}
      </p>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-zinc-300">
        <EarningsWarning earnings={earnings} />
        <li>Your public posts and comments will be removed.</li>
        <li>People who bought your recipes keep them.</li>
      </ul>

      {error ? (
        <p role="alert" className="mt-6 rounded-2xl border border-rose-300/30 bg-rose-400/10 px-4 py-3 text-sm leading-6 text-rose-100">
          {error}
        </p>
      ) : null}

      {isAppleLinked ? (
        <AppleAccountNotice />
      ) : stage.kind === 'session-ended' ? (
        <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5">
          <p className="leading-7 text-zinc-300">Your session has ended. Sign in again, then confirm the deletion here.</p>
          <SignInAgainLink>Sign in again to continue</SignInAgainLink>
        </div>
      ) : stage.kind === 'reauthenticate' ? (
        <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5">
          <h3 className="text-lg font-semibold text-white">Confirm it is you</h3>
          <p className="mt-2 leading-7 text-zinc-300">
            For your security, deleting the account needs a fresh sign-in.
          </p>
          {canUsePassword ? (
            <form onSubmit={(event) => void handlePasswordSubmit(event)} className="mt-4 space-y-3">
              <label htmlFor="delete-account-password" className="block text-sm font-semibold text-zinc-200">
                Current password
              </label>
              <input
                id="delete-account-password"
                name="current-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={isWorking}
                className="w-full rounded-2xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none transition focus:border-white/40"
              />
              <button
                type="submit"
                disabled={!password || isWorking}
                className="inline-flex min-h-12 items-center justify-center rounded-full bg-rose-600 px-5 py-3 font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isWorking ? 'Verifying and deleting…' : 'Verify password and delete'}
              </button>
            </form>
          ) : null}
          {canUseGoogle || !canUsePassword ? (
            <div className="mt-4">
              <p className="text-sm leading-6 text-zinc-400">
                {canUsePassword
                  ? 'Or sign in again with Google, then confirm the deletion here.'
                  : 'Sign in again with Google, then confirm the deletion here.'}
              </p>
              <SignInAgainLink>Sign in again to continue</SignInAgainLink>
            </div>
          ) : null}
        </div>
      ) : (
        <form onSubmit={(event) => void handleDelete(event)} className="mt-6 space-y-3">
          <label htmlFor="delete-account-confirmation" className="block text-sm font-semibold text-zinc-200">
            Type DELETE to confirm
          </label>
          <input
            id="delete-account-confirmation"
            name="delete-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={isWorking}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="DELETE"
            className="w-full rounded-2xl border border-white/15 bg-black/40 px-4 py-3 text-white outline-none transition placeholder:text-zinc-600 focus:border-white/40"
          />
          <button
            type="submit"
            disabled={!isConfirmed || isWorking}
            className="inline-flex min-h-12 items-center justify-center rounded-full bg-rose-600 px-5 py-3 font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isWorking ? 'Deleting account…' : 'Permanently delete account'}
          </button>
        </form>
      )}
    </section>
  );
}
