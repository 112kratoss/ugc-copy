'use client';

import type { Session, User } from '@supabase/supabase-js';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';

import AppleLogo from '@/components/AppleLogo';
import {
  buildAppleWebAuthorizationUrl,
  forgetAppleWebAuthorizationStart,
  getAppleWebAuthorization,
  judgeAppleWebAuthorizationAnswer,
  readAppleWebAuthorizationAnswer,
  readAppleWebAuthorizationStart,
  rememberAppleWebAuthorizationStart,
  type AppleWebAuthorizationAnswer,
  type AppleWebAuthorizationRefusal,
  type AppleWebAuthorizationStart,
} from '@/lib/apple-web-reauthentication';
import { describeAuthError } from '@/lib/auth-error-copy';
import { forgetBrowserSignOut, markBrowserSignOut } from '@/lib/browser-sign-out';
import { siteConfig } from '@/lib/seo';
import { removeSupabaseAuthCookies } from '@/lib/supabase-auth-cookie';

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
/** Neither the answer nor Supabase could say whether it started; the app says the same. */
const UNCONFIRMED_DELETION_COPY = 'We could not confirm the deletion. Check the connection and try again.';
/** The request never left: the client or the session could not be loaded. */
const NOT_SENT_COPY = 'Your account was not deleted. Check the connection and try again.';
/** Supabase still accepts the session the request carried, so nothing started. */
const STILL_ACTIVE_COPY = 'The deletion did not go through. Your account is still active.';
/** Supabase's words for a session, or an account, that no longer exists. */
const ENDED_SESSION_CODES = new Set(['session_not_found', 'user_not_found']);
/** What the page says when Apple's answer brings no code to use. */
const APPLE_REFUSAL_COPY: Record<AppleWebAuthorizationRefusal, string> = {
  elsewhere: 'That Apple confirmation was not started on this page, so nothing was deleted. Continue with Apple here to delete this account.',
  cancelled: 'You cancelled Continue with Apple. Your account was not deleted.',
  'not-confirmed': 'Apple did not confirm it is you. Your account was not deleted.',
};
const APPLE_NOT_STARTED_COPY = 'Continue with Apple could not start in this browser. Try another browser, or request deletion by email below.';
const APPLE_MISMATCH_COPY = 'You continued with a different Apple ID. Continue with the Apple ID this account uses.';

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
  /** `message`: why Apple's code was refused, when one was sent. */
  | { kind: 'apple'; message: string | null }
  | { kind: 'refused'; message: string }
  /** Neither the answer nor Supabase could say whether the deletion started. */
  | { kind: 'unconfirmed' };

/** An answer that cannot say whether the deletion started: Supabase is asked. */
type DeletionAnswer = DeletionOutcome | { kind: 'ambiguous' };

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
async function readDeletionOutcome(response: Response): Promise<DeletionAnswer> {
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
    if (!code || !APPLE_REAUTH_CODES.has(code)) return { kind: 'reauthenticate' };
    return { kind: 'apple', message: code === 'APPLE_REAUTH_FAILED' ? message : null };
  }
  // Apple confirmed someone else, so the right Apple ID is asked for. The
  // server's sentence names the brand its own way.
  if (response.status === 403 && code === 'ACCOUNT_REAUTH_MISMATCH') {
    return { kind: 'apple', message: APPLE_MISMATCH_COPY };
  }
  // The route's own 500 says whether the account was touched.
  if (response.status === 500 && body) {
    return body.deletionScheduled === false ? { kind: 'refused', message } : { kind: 'scheduled' };
  }
  // A 401 also follows a deletion that already ended every session, and a 5xx
  // without the route's JSON came from the platform, before the route ran or
  // after: neither says whether the account was touched.
  if (response.status === 401 || (response.status >= 500 && !body)) return { kind: 'ambiguous' };
  return { kind: 'refused', message };
}

function isEndedSession(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  // auth-js reports Supabase's session_not_found as AuthSessionMissingError.
  return name === 'AuthSessionMissingError' || (typeof code === 'string' && ENDED_SESSION_CODES.has(code));
}

/**
 * Asks Supabase about the session the deletion request carried, when the
 * answer could not say whether the deletion started (audit 04-3). A deletion
 * ends every session of the account as soon as it starts, so a session that
 * is gone means it started, and a live one means it did not. Anything else,
 * the probe failing included, proves nothing. The app asks the same question.
 */
async function probeDeletion(accessToken: string): Promise<DeletionOutcome> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (!error && data.user) return { kind: 'refused', message: STILL_ACTIVE_COPY };
    if (isEndedSession(error)) return { kind: 'scheduled' };
  } catch {
    // Nothing is known.
  }
  return { kind: 'unconfirmed' };
}

/** `appleAuthorizationCode`: the one-time code Apple's answer brought this page, for an account with an Apple identity. */
async function sendDeletion(accessToken: string, appleAuthorizationCode: string | null): Promise<DeletionOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/account', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(appleAuthorizationCode
        ? { confirmation: 'DELETE', appleAuthorizationCode, appleAuthorizationClient: 'web' }
        : { confirmation: 'DELETE' }),
    });
  } catch {
    // The connection failed: the request may or may not have arrived.
    return probeDeletion(accessToken);
  }
  const answer = await readDeletionOutcome(response);
  return answer.kind === 'ambiguous' ? probeDeletion(accessToken) : answer;
}

/**
 * The deletion, told to the browser's other tabs first. It ends every session
 * of the account as it starts, before it answers, so a tab can hear of the end
 * (from its own check of the session, or this page's probe) before this page
 * signs out: marked first, they read it as a sign-out, not a lapse, and an open
 * creator page there clears (`markBrowserSignOut`). `alsoEnding`: a session
 * this page held before a fresh sign-in, which a tab may still hold. An answer
 * that leaves the session as it was takes the marks back; one that cannot say
 * keeps them, since the account may be on its way out.
 * `appleAuthorizationCode`: the code Apple's answer brought this page.
 */
async function requestDeletion(
  accessToken: string,
  { alsoEnding = null, appleAuthorizationCode = null }: {
    alsoEnding?: string | null;
    appleAuthorizationCode?: string | null;
  } = {},
): Promise<DeletionOutcome> {
  markBrowserSignOut(accessToken, alsoEnding);
  let outcome: DeletionOutcome | null = null;
  try {
    outcome = await sendDeletion(accessToken, appleAuthorizationCode);
    return outcome;
  } finally {
    if (!outcome || outcome.kind === 'refused' || outcome.kind === 'reauthenticate' || outcome.kind === 'apple') {
      forgetBrowserSignOut(accessToken, alsoEnding);
    }
  }
}

/**
 * Ends this browser's session; the server has already ended the account's
 * others. When the logout call fails, auth-js keeps the session and the
 * sign-in page sends it straight back here, so its cookies go anyway.
 * `deliberate`: the account leaves this browser (its deletion), which the
 * other tabs read as a sign-out (`markBrowserSignOut`), so an open creator page
 * there clears. The sign-in-again link signs out only so the same person can
 * sign straight back in: the other tabs read that as a lapse, and a creator
 * page there keeps its form for their return.
 */
async function signOutHere({ deliberate }: { deliberate: boolean }) {
  let signedOut = false;
  try {
    const supabase = await getSupabase();
    if (deliberate) {
      const { data } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
      markBrowserSignOut(data.session?.access_token);
    }
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    signedOut = !error;
  } catch {
    // Ended below, as for a returned error.
  }
  if (!signedOut) removeSupabaseAuthCookies();
}

/**
 * The account's drafts and staged files in this browser go with it, as they
 * do when the account menu signs out (audit 04-7). The menu's own clean-up,
 * loaded when needed like the client.
 */
async function clearCreatorDataHere(userId: string) {
  try {
    const { clearCreatorDataForSignOut } = await import('@/components/AppShellAccount');
    await clearCreatorDataForSignOut(userId);
  } catch {
    // The keys are per account: whatever is left stays out of the next account's reach.
  }
}

/**
 * Apple's answer in this page's address and the start it answers, read once as
 * the page opens; the tab's storage only when there is an answer.
 */
function readAppleReturnHere(): { answer: AppleWebAuthorizationAnswer; start: AppleWebAuthorizationStart | null } | null {
  if (typeof window === 'undefined') return null;
  const answer = readAppleWebAuthorizationAnswer(window.location.hash);
  return answer ? { answer, start: readAppleWebAuthorizationStart() } : null;
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
    await signOutHere({ deliberate: false });
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

/**
 * An account with an Apple identity confirms its deletion with Apple: the
 * deletion revokes Apple's authorization with a one-time code from Apple
 * (`apple-account-deletion-service.ts`). Here Continue with Apple leaves for
 * Apple's page and comes back with the code (`apple-web-reauthentication.ts`),
 * for any such account: one made in the app, one made here, or one Supabase
 * linked an Apple sign-in to by its email.
 */
function AppleDeletionStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5">
      <h3 className="text-lg font-semibold text-white">Confirm with Apple</h3>
      <p className="mt-2 leading-7 text-zinc-300">
        {`This account uses Sign in with Apple. Continue with Apple to confirm it is you, and Apple brings you back here to finish. ${siteConfig.name} is disconnected from your Apple ID as the account is deleted.`}
      </p>
      {/* Apple's white style, the one its guidelines give a dark background. */}
      <button
        type="button"
        onClick={onContinue}
        className="mt-4 inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-white px-5 py-3 font-semibold text-black transition hover:bg-zinc-200"
      >
        <AppleLogo className="h-5 w-5" />
        Continue with Apple
      </button>
      <p className="mt-4 text-sm leading-6 text-zinc-400">No longer use that Apple ID? Request deletion by email below.</p>
    </div>
  );
}

/**
 * Continue with Apple on another origin of the site (the www host, a preview):
 * Apple returns only to the registered address, so the deletion goes on there,
 * after a sign-in, since a session stays on its own host.
 */
function AppleElsewhereNotice({ returnUrl }: { returnUrl: string }) {
  const host = new URL(returnUrl).host;
  return (
    <div role="status" className="mt-6 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-5">
      <h3 className="text-lg font-semibold text-white">{`Continue on ${host}`}</h3>
      <p className="mt-2 leading-7 text-zinc-300">
        {`This account uses Sign in with Apple, and Apple confirms it is you only on ${host}. Open this page there, sign in, and continue with Apple to delete the account.`}
      </p>
      <a
        href={returnUrl}
        className="mt-4 inline-flex min-h-12 items-center justify-center rounded-full bg-white px-5 py-3 font-semibold text-black transition hover:bg-zinc-200"
      >
        {`Open ${host}`}
      </a>
    </div>
  );
}

/**
 * Where the website has no Services ID, an account with an Apple identity is
 * deleted in the iPhone app, whose native sheet gives the code, or by the
 * email request.
 */
function AppleAccountNotice() {
  return (
    <div role="status" className="mt-6 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-5">
      <h3 className="text-lg font-semibold text-white">Delete this account in the app</h3>
      <p className="mt-2 leading-7 text-zinc-300">
        {`This account uses Sign in with Apple, so it is deleted in the ${siteConfig.name} app on an iPhone, where Apple confirms it is you and ${siteConfig.name} is disconnected from your Apple ID. Tap the menu (☰) at the top left of Home, then choose Settings and Delete account. No iPhone? Request deletion by email below.`}
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
  const [appleReturn] = useState(readAppleReturnHere);
  // Set once the server sends the person back to Apple: the code is no use then.
  const [isAppleCodeSpent, setIsAppleCodeSpent] = useState(false);
  const user = session?.user ?? null;
  const userId = user?.id ?? null;
  const earnings: Earnings = earningsRead && earningsRead.userId === userId
    ? earningsRead.earnings
    : { status: 'loading' };
  const isConfirmed = confirmation.trim().toUpperCase() === 'DELETE';
  const appleJudgement = judgeAppleWebAuthorizationAnswer(appleReturn?.answer ?? null, appleReturn?.start ?? null, userId);
  // Kept through answers that leave the form up (one that could not say, a
  // refusal before Apple was asked), so a retry sends it again.
  const appleCode = appleJudgement && 'code' in appleJudgement && !isAppleCodeSpent ? appleJudgement.code : null;

  // The answer leaves the address at once, so neither a reload nor the history
  // brings the code back, and the start it answered is used up. The first
  // replace keeps Next's history state, since this runs before Next's router
  // has patched history (a child's effects run first). The later one, through
  // that patch, gives the router the clean address too: with Next's own state
  // it skips the router, which would write the code back at its next commit.
  useEffect(() => {
    if (!appleReturn) return;
    const here = () => `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(window.history.state, '', here());
    forgetAppleWebAuthorizationStart();
    const routerSync = window.setTimeout(() => window.history.replaceState(null, '', here()), 0);
    return () => window.clearTimeout(routerSync);
  }, [appleReturn]);

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
        if (userId) await clearCreatorDataHere(userId);
        await signOutHere({ deliberate: true });
        return;
      case 'reauthenticate':
        setStage({ kind: 'reauthenticate' });
        return;
      case 'apple':
        setStage({ kind: 'apple' });
        setIsAppleCodeSpent(true);
        if (outcome.message) setError(`Your account was not deleted. ${outcome.message}`);
        return;
      case 'refused':
        setError(`Your account was not deleted. ${outcome.message}`);
        return;
      case 'unconfirmed':
        // Still signed in here, so the form stays and a retry settles it.
        setError(UNCONFIRMED_DELETION_COPY);
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
      await applyOutcome(await requestDeletion(token, { appleAuthorizationCode: appleCode }));
    } catch {
      // requestDeletion settles every answer, a lost one included, so this is
      // a failure before the request left.
      setError(NOT_SENT_COPY);
    } finally {
      setIsWorking(false);
    }
  };

  // Apple's answer comes back in a new load of this page, so this tab keeps
  // the start for it.
  const handleContinueWithApple = (apple: { clientId: string; returnUrl: string }, accountId: string) => {
    const state = crypto.randomUUID();
    if (!rememberAppleWebAuthorizationStart({ state, userId: accountId })) {
      setError(APPLE_NOT_STARTED_COPY);
      return;
    }
    window.location.assign(buildAppleWebAuthorizationUrl({ clientId: apple.clientId, returnUrl: apple.returnUrl, state }));
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
      // A tab that has not taken the new session yet still holds the one this page had.
      const outcome = await requestDeletion(data.session.access_token, { alsoEnding: session?.access_token ?? null });
      if (outcome.kind === 'reauthenticate') {
        // Left as it was, the card would look as if nothing had happened.
        setError('Your account was not deleted. The new sign-in was not accepted yet; try again in a moment.');
        return;
      }
      await applyOutcome(outcome);
    } catch {
      setError(NOT_SENT_COPY);
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
  const appleWeb = isAppleLinked ? getAppleWebAuthorization(window.location.origin) : null;
  const canUsePassword = Boolean(user.email) && (providers.has('email') || providers.size === 0);
  const canUseGoogle = providers.has('google');
  // Said only before anything is sent: a later answer has its own words.
  const appleRefusal = stage.kind === 'confirm' && appleWeb?.returnsHere && appleJudgement && 'refusal' in appleJudgement
    ? APPLE_REFUSAL_COPY[appleJudgement.refusal]
    : null;
  const shownError = error ?? appleRefusal;

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

      {shownError ? (
        <p role="alert" className="mt-6 rounded-2xl border border-rose-300/30 bg-rose-400/10 px-4 py-3 text-sm leading-6 text-rose-100">
          {shownError}
        </p>
      ) : null}

      {stage.kind === 'session-ended' ? (
        <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5">
          <p className="leading-7 text-zinc-300">Your session has ended. Sign in again, then confirm the deletion here.</p>
          <SignInAgainLink>Sign in again to continue</SignInAgainLink>
        </div>
      ) : isAppleLinked && !appleWeb ? (
        <AppleAccountNotice />
      ) : appleWeb && !appleWeb.returnsHere ? (
        <AppleElsewhereNotice returnUrl={appleWeb.returnUrl} />
      ) : appleWeb && !appleCode ? (
        <AppleDeletionStep onContinue={() => handleContinueWithApple(appleWeb, user.id)} />
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
                {!canUseGoogle
                  ? 'Sign in again, then confirm the deletion here.'
                  : canUsePassword
                    ? 'Or sign in again with Google, then confirm the deletion here.'
                    : 'Sign in again with Google, then confirm the deletion here.'}
              </p>
              <SignInAgainLink>Sign in again to continue</SignInAgainLink>
            </div>
          ) : null}
        </div>
      ) : (
        <form onSubmit={(event) => void handleDelete(event)} className="mt-6 space-y-3">
          {appleCode ? (
            <p role="status" className="leading-7 text-zinc-300">
              Apple confirmed it is you. Type DELETE to finish deleting the account.
            </p>
          ) : null}
          <label htmlFor="delete-account-confirmation" className="block text-sm font-semibold text-zinc-200">
            Type DELETE to confirm
          </label>
          <input
            id="delete-account-confirmation"
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
