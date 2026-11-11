'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Check, Eye, EyeOff, Info, Loader2, X } from 'lucide-react';
import clsx from 'clsx';

import BrandWordmark from '@/components/BrandWordmark';
import SignInAgreement from '@/components/SignInAgreement';
import { describeAuthError } from '@/lib/auth-error-copy';
import { buildAuthContinuePath, isCreatorSignUpReturn } from '@/lib/auth-onboarding';
import { displayFont } from '@/lib/display-font';
import { startProviderSignIn, type SignInProvider } from '@/lib/provider-sign-in';
import { siteConfig } from '@/lib/seo';
import {
    creatorReturnNote,
    hasSameSiteHistory,
    signInEmailHref,
    signInHalfAt,
    signInHalfPath,
    type SignInHalf,
} from '@/lib/sign-in-page';
import { supabase } from '@/lib/supabase';
import { useFieldValueBeforeHydration } from '@/lib/use-field-value-before-hydration';
import { useWelcomePromise } from '@/lib/welcome-promise';
import { settlePendingSharedInviteVisit } from '@/lib/invite-share-landing';

import InviteCodeEntry from './InviteCodeEntry';
import { SIGN_IN_PILL, SIGN_IN_PILLS, SignInProviderButtons, type SignInInFlight } from './sign-in-parts';

const SUPPORT_MAILTO = `mailto:${siteConfig.supportEmail}`;

/**
 * Marks the email form's own entry in the tab's history, pushed over the choices: Back, X and
 * Escape step back to them. Kept in the entry's state, so a reload of the form still has the
 * choices under it.
 */
const EMAIL_ENTRY = 'magicbookletSignInEmail';

function onEmailEntry() {
    const state = window.history.state as Record<string, unknown> | null;
    return state?.[EMAIL_ENTRY] === true;
}

export interface LoginClientProps {
    /** The half the page opens on: the email form for `?email=1` and `?recovery=1`. */
    initialHalf: SignInHalf;
    /** `?recovery=1`: an expired reset link, or an older app's "Forgot password?". */
    recoveryRequested: boolean;
    redirectTo: string;
    /** Whether the address named a return (`returnUrl`, `next`, `redirect`): a page sent the visitor here. */
    returnRequested?: boolean;
    /** What a new account is given, while the welcome program is on; null when it is off or unread. */
    welcomeCredits: number | null;
    /** The moving wall, drawn on the server (`SignInWall`); left out in unit tests. */
    wall?: ReactNode;
    /** Whether this browser already keeps an invite (its visit cookie), for the invite-code line. */
    inviteHeld?: boolean;
}

/**
 * The web's one sign-in page, the app's (`ugc-mobile/components/sign-in-wall.tsx`, #731) on the
 * web's dark design: a wall of creations drifting behind "Start filling your Magic Booklet", then
 * Apple and Google, which make an account or sign into one. Every "Sign in" on the web opens it,
 * and the creators' Generate does too, which used to open a sheet of its own (owner, 2026-11-09).
 *
 * New accounts are made with Apple or Google only: in production the before-user-created hook
 * refuses every email sign-up, and with no mail sender nothing can deliver a reset or
 * confirmation link (docs/production-deployment-runbook.md, "Identity Policy: OAuth Only"). So
 * email is a way back into an account made with it, not a third button: "Made an account with
 * email? Sign in" turns this page into the email form in place, over the same moving wall, which
 * darkens behind the fields. X, Escape and the browser's Back turn it back. There are no Sign in
 * and Sign up tabs.
 */
export default function LoginClient({
    initialHalf,
    recoveryRequested,
    redirectTo,
    returnRequested = false,
    welcomeCredits,
    wall,
    inviteHeld = false,
}: LoginClientProps) {
    const router = useRouter();
    const [half, setHalf] = useState<SignInHalf>(initialHalf);
    // The recovery notice belongs to the visit's first sight of the form; turning back to the
    // choices drops it, with its `recovery=1`.
    const [recoveryShown, setRecoveryShown] = useState(recoveryRequested && initialHalf === 'email');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // One sign-in at a time, from either half: while one is under way nothing else starts, and
    // the page is neither turned nor left, so a sign-in lands on the page that started it.
    const [inFlight, setInFlight] = useState<SignInInFlight>(null);
    const inFlightRef = useRef<SignInInFlight>(null);
    const emailRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);
    const emailTitleRef = useRef<HTMLHeadingElement>(null);
    const emailLinkRef = useRef<HTMLAnchorElement>(null);
    // What the fields hold before this script runs, typed or filled in by the browser, is
    // taken in as the page mounts. Else the sign-in sends empty values, and its render writes
    // them over the fields.
    useFieldValueBeforeHydration(emailRef, { drawn: email, onValue: setEmail });
    useFieldValueBeforeHydration(passwordRef, { drawn: password, onValue: setPassword });
    const onEmail = half === 'email';
    const returnNote = creatorReturnNote(redirectTo);
    // The welcome credits, unless an account has signed in on this browser (owner, 2026-11-09).
    const welcomePromise = useWelcomePromise();
    const promisesCredits = welcomeCredits !== null && welcomePromise;

    const startSignIn = (method: Exclude<SignInInFlight, null>) => {
        if (inFlightRef.current) return false;
        inFlightRef.current = method;
        setInFlight(method);
        setError(null);
        return true;
    };
    const endSignIn = () => {
        inFlightRef.current = null;
        setInFlight(null);
    };

    useEffect(() => {
        let isActive = true;

        supabase.auth.getSession().then(({ data }) => {
            if (!isActive || !data.session) {
                return;
            }

            // The flag tells /auth/continue this visit is no new sign-in, so
            // it is not counted as auth_succeeded.
            router.replace(`${buildAuthContinuePath(redirectTo)}&signedIn=1`);
            router.refresh();
        });

        return () => {
            isActive = false;
        };
    }, [redirectTo, router]);

    // A page the browser restores after leaving for Google or Apple (Back from its
    // sign-in page) comes back as it was left, every button waiting; it is usable again.
    useEffect(() => {
        const onPageShow = (event: PageTransitionEvent) => {
            if (event.persisted) endSignIn();
        };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
    }, []);

    // A visit that opens on the form (`?email=1`, `?recovery=1`) gets the choices under it, so
    // Back turns the page back to them, as the app's Back does, before it leaves.
    // Set after the first commit: on a full load this effect runs before the router's own, which
    // patches the history API to keep its state on every entry. Called earlier, the entries lose
    // that state, and Forward onto the form reloads the whole page (review of #744). The router's
    // state is carried over as well, so neither entry depends on the patch.
    useEffect(() => {
        if (initialHalf !== 'email' || onEmailEntry()) return undefined;
        const timer = window.setTimeout(() => {
            if (onEmailEntry()) return;
            const here = window.location.href;
            const state = window.history.state as Record<string, unknown> | null;
            window.history.replaceState(state, '', signInHalfPath(here, 'choose'));
            window.history.pushState({ ...state, [EMAIL_ENTRY]: true }, '', signInHalfPath(here, 'email'));
        }, 0);
        return () => window.clearTimeout(timer);
    }, [initialHalf]);

    // Back and Forward between the two halves: the address says which one shows.
    useEffect(() => {
        const onPopState = () => {
            const next = signInHalfAt(window.location.href);
            if (next === 'choose') setRecoveryShown(false);
            setHalf(next);
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, []);

    const turnToEmail = (event: React.MouseEvent<HTMLAnchorElement>) => {
        // A click that asks for a new tab or window is the browser's: the form opens there.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (inFlightRef.current) return;
        setError(null);
        // Drawn before focus moves: the form is inert until it shows.
        flushSync(() => setHalf('email'));
        window.history.pushState({ [EMAIL_ENTRY]: true }, '', signInHalfPath(window.location.href, 'email'));
        // A mouse goes straight to the field; a touch lands on the title, so the keyboard does not
        // rise over the page as it turns.
        if (window.matchMedia?.('(pointer: fine)').matches) emailRef.current?.focus({ preventScroll: true });
        else emailTitleRef.current?.focus({ preventScroll: true });
    };

    const backToChoices = useCallback(() => {
        if (inFlightRef.current) return;
        setError(null);
        setRecoveryShown(false);
        flushSync(() => setHalf('choose'));
        // Over the choices' own entry, step back to it, so Forward opens the form again;
        // otherwise turn this entry into the choices'.
        if (onEmailEntry()) window.history.back();
        else window.history.replaceState(null, '', signInHalfPath(window.location.href, 'choose'));
        emailLinkRef.current?.focus({ preventScroll: true });
    }, []);

    useEffect(() => {
        if (!onEmail) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
            backToChoices();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [backToChoices, onEmail]);

    // Close goes back where the visitor came from on this site, else Home. A link to Home
    // before the page's script runs; a click that asks for a new tab stays the browser's.
    // - A creator's hand-over returns to the creator's own return address, which leaves out the
    //   link's settings: a plain Back reopens the link, whose prompt and model would win over the
    //   draft the visitor edited and was told stays (review of #744).
    // - A page that sent the visitor here (its return in the address) is stepped back to.
    // - Otherwise Home, drawn fresh: after a sign-out (no return), a step back would redraw the
    //   last page of the account that just left.
    const close = (event: React.MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (inFlightRef.current) return;
        if (isCreatorSignUpReturn(redirectTo)) router.replace(redirectTo);
        else if (returnRequested && hasSameSiteHistory()) router.back();
        else router.replace(returnRequested ? redirectTo : '/');
    };

    const continueWith = async (provider: SignInProvider) => {
        if (!startSignIn(provider)) return;
        // A shared link's invite this tab could not record must be recorded before the account is.
        await settlePendingSharedInviteVisit();
        const failure = await startProviderSignIn(provider, redirectTo);
        // Once it has started, the page is leaving for the provider, and stays held.
        if (failure) {
            setError(failure);
            endSignIn();
        }
    };

    const handleSignIn = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!startSignIn('email')) return;

        try {
            await settlePendingSharedInviteVisit();
            const { error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });
            if (error) throw error;
            router.replace(buildAuthContinuePath(redirectTo));
            router.refresh();
        } catch (err: unknown) {
            setError(describeAuthError(err, 'Could not sign in. Try again.'));
            endSignIn();
        }
    };

    // One alert, on the half that shows: a sign-in that failed there. Solid grounds, never a
    // backdrop blur: the wall moves under them, and a blur would be drawn again every frame.
    const errorAlert = error ? (
        <div id="auth-error" role="alert" aria-live="assertive" className="flex items-start gap-3 rounded-2xl border border-red-400/30 bg-[#2a0f12]/90 p-3 text-left text-sm leading-6 text-red-200">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <p>{error}</p>
        </div>
    ) : null;

    // On a dark chip of its own: it sits over the lighter middle of the wall.
    const returnLine = (align: 'centre' | 'start') => (returnNote ? (
        <p className={clsx('flex max-w-[360px] items-start gap-2 rounded-2xl bg-black/60 px-3.5 py-2.5 text-left text-sm leading-5 text-white/80', align === 'centre' ? 'mx-auto' : 'self-start')}>
            <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ui-accent-workflow)]" />
            <span>{returnNote}</span>
        </p>
    ) : null);

    return (
        <div className="relative isolate h-[100dvh] overflow-hidden bg-black text-white">
            {wall}
            <div aria-hidden className="sign-in-shade" />
            <div aria-hidden className="sign-in-scrim" data-shown={onEmail ? '' : undefined} />

            {/* The first half: it rises and fades away as the form comes in. */}
            <section
                aria-labelledby="sign-in-title"
                inert={onEmail}
                data-away={onEmail ? '' : undefined}
                className="sign-in-half sign-in-choices"
            >
                <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col px-5 pb-[max(env(safe-area-inset-bottom),16px)] pt-[max(env(safe-area-inset-top),8px)] md:max-w-[560px] md:justify-center md:py-12">
                    <Link
                        href="/"
                        prefetch={false}
                        onClick={close}
                        aria-label="Close"
                        aria-disabled={inFlight !== null || undefined}
                        className="ui-focus-ring -ml-2.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition hover:bg-white/10 md:fixed md:left-5 md:top-5 md:ml-0"
                    >
                        <X aria-hidden className="h-6 w-6" />
                    </Link>

                    {/* The headline runs on into the wordmark (owner, 2026-11-08: like "Start working
                        in", with the name below it), and is read as the one line it is. */}
                    <h1
                        id="sign-in-title"
                        className={clsx(displayFont.className, 'mt-5 font-extrabold text-[52px] leading-[56px] tracking-[-0.023em] text-white md:mt-0 md:text-center md:text-[64px] md:leading-[68px]')}
                    >
                        <span className="block md:inline">Start</span>{' '}
                        <span className="block md:inline">filling your</span>{' '}
                        <BrandWordmark className="mt-2 text-[38px] leading-[44px] tracking-[-0.02em] md:mt-3 md:flex md:justify-center md:text-[52px] md:leading-[60px]" />
                    </h1>

                    <div className="min-h-6 flex-1 md:h-12 md:flex-none" />

                    <div className="flex flex-col gap-3.5 text-center">
                        {/* Both lines while the promise may stand: the root's mark picks one from the
                            first paint (`.welcome-promise-only`, `welcome-promise.ts`). The second,
                            #738's words, is right for a returning person and a new one alike. */}
                        {promisesCredits ? (
                            <p className="welcome-promise-only text-base leading-6 text-white">
                                Join free and get <strong className="font-bold">{welcomeCredits} credits</strong> to start
                            </p>
                        ) : null}
                        <p className={clsx('text-base leading-6 text-white', promisesCredits && 'welcome-promise-spent-only')}>
                            Sign in or join free to start creating.
                        </p>
                        {returnLine('centre')}
                        {!onEmail ? errorAlert : null}
                        <SignInProviderButtons inFlight={inFlight} onContinue={(provider) => void continueWith(provider)} describedBy="sign-in-agreement" />
                        {/* Before the account is made, as a claim needs: a typed code is this
                            browser's invite from the moment it is saved. */}
                        <InviteCodeEntry disabled={inFlight !== null} inviteHeld={inviteHeld} />
                        {/* Email makes no new accounts, so it is a way back into one, not a third
                            button. A link, so before the page's script runs it opens the form as a page. */}
                        <Link
                            ref={emailLinkRef}
                            href={signInEmailHref(redirectTo)}
                            prefetch={false}
                            onClick={turnToEmail}
                            aria-disabled={inFlight !== null || undefined}
                            className={clsx('ui-focus-ring mx-auto inline-flex min-h-11 items-center justify-center rounded-full px-3 text-[15px] leading-5 text-white/70 transition hover:text-white', inFlight !== null && 'pointer-events-none opacity-50')}
                        >
                            <span>Made an account with email? <strong className="font-bold text-white">Sign in</strong></span>
                        </Link>
                        <SignInAgreement id="sign-in-agreement" className="text-center text-xs leading-5 text-white/65" />
                    </div>
                </div>
            </section>

            {/* The email half: it rises into place as the first half leaves. */}
            <section
                aria-labelledby="sign-in-email-title"
                inert={!onEmail}
                data-away={onEmail ? undefined : ''}
                className="sign-in-half sign-in-email"
            >
                <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col px-5 pb-[max(env(safe-area-inset-bottom),16px)] pt-[max(env(safe-area-inset-top),8px)] md:max-w-[460px] md:justify-center md:py-12">
                    <button
                        type="button"
                        onClick={backToChoices}
                        disabled={inFlight !== null}
                        aria-label="Back to all sign-in options"
                        className="ui-focus-ring -ml-2.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition hover:bg-white/10 disabled:opacity-50 md:fixed md:left-5 md:top-5 md:ml-0"
                    >
                        <X aria-hidden className="h-6 w-6" />
                    </button>

                    <div className="mt-4 md:mt-0">
                        <BrandWordmark className="text-[22px] leading-7" />
                        <h1
                            id="sign-in-email-title"
                            ref={emailTitleRef}
                            tabIndex={-1}
                            className={clsx(displayFont.className, 'mt-5 font-extrabold text-[32px] leading-[38px] tracking-[-0.02em] text-white outline-none md:text-[36px] md:leading-[42px]')}
                        >
                            Sign in with email
                        </h1>
                        {returnNote ? <div className="mt-3 flex">{returnLine('start')}</div> : null}
                    </div>

                    {/* `?recovery=1` asked for a reset link, which no mail sender can deliver:
                        say so, and name the two ways back in instead. */}
                    {recoveryShown ? (
                        <div role="status" className="mt-6 flex items-start gap-3 rounded-2xl border border-white/15 bg-black/60 p-3 text-sm leading-6 text-white/80">
                            <Info className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ui-primary)]" aria-hidden />
                            <p>
                                Password reset emails aren’t available. Signed up with Google or Apple? Continue with it below. Otherwise, email{' '}
                                <a href={SUPPORT_MAILTO} className="font-bold text-white underline underline-offset-2 hover:text-[var(--ui-primary)]">{siteConfig.supportEmail}</a>
                                {' '}and we’ll help you sign in.
                            </p>
                        </div>
                    ) : null}

                    {/* A post, not the default GET: until the page's script has run, Enter
                        submits the form the browser's own way, and a GET wrote the
                        password into the address. The page renders on every
                        request (page.tsx), so the server answers with it. */}
                    <form method="post" onSubmit={handleSignIn} className="mt-7 flex flex-col gap-3.5">
                        <SignInField label="Email" htmlFor="login-email">
                            <input
                                id="login-email"
                                ref={emailRef}
                                name="email"
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                required
                                autoComplete="username"
                                autoCapitalize="none"
                                spellCheck={false}
                                placeholder="you@example.com"
                                className="sign-in-field-input"
                            />
                            {email.length > 0 ? (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setEmail('');
                                        emailRef.current?.focus();
                                    }}
                                    aria-label="Clear email"
                                    className="ui-focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/55 transition hover:text-white"
                                >
                                    <X aria-hidden className="h-[18px] w-[18px]" />
                                </button>
                            ) : null}
                        </SignInField>

                        <SignInField label="Password" htmlFor="login-password">
                            <input
                                id="login-password"
                                ref={passwordRef}
                                name="password"
                                type={showPassword ? 'text' : 'password'}
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                required
                                autoComplete="current-password"
                                placeholder="Your password"
                                className="sign-in-field-input"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword((current) => !current)}
                                aria-label={showPassword ? 'Hide password' : 'Show password'}
                                className="ui-focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition hover:text-white"
                            >
                                {/* Two glyphs, not one glyph in two colours. */}
                                {showPassword
                                    ? <EyeOff aria-hidden className="h-[18px] w-[18px] text-[var(--ui-primary)]" />
                                    : <Eye aria-hidden className="h-[18px] w-[18px] text-white/55" />}
                            </button>
                        </SignInField>

                        {/* In place of "Forgot password?": no reset link can be sent, and a
                            locked-out password account is recovered by hand (the runbook's
                            "Legacy email/password accounts"). */}
                        <p className="text-right text-sm leading-6 text-white/60">
                            Trouble signing in? Email{' '}
                            <a href={SUPPORT_MAILTO} className="font-semibold text-[var(--ui-primary)] underline-offset-2 hover:underline">{siteConfig.supportEmail}</a>
                        </p>

                        {onEmail ? errorAlert : null}

                        <div className={clsx(SIGN_IN_PILLS, 'mt-1 gap-3')}>
                            {/* Coral, the page's one action, apart from Apple and Google below, which
                                stay white on dark. On solid black, so a faded button reads as dimmed
                                rather than as the wall showing through it. */}
                            <div className="rounded-full bg-black">
                                <button
                                    type="submit"
                                    disabled={inFlight !== null}
                                    className={clsx(SIGN_IN_PILL, 'ui-focus-ring bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)] disabled:cursor-not-allowed', inFlight !== null && inFlight !== 'email' && 'opacity-50')}
                                >
                                    {inFlight === 'email' ? <Loader2 aria-hidden className="h-5 w-5 animate-spin" /> : null}
                                    {inFlight === 'email' ? 'Signing in…' : 'Sign in'}
                                </button>
                            </div>
                            <div className="my-0.5 flex items-center gap-3" aria-hidden>
                                <span className="h-px flex-1 bg-white/20" />
                                <span className="text-[13px] font-semibold text-white/60">or</span>
                                <span className="h-px flex-1 bg-white/20" />
                            </div>
                        </div>
                    </form>

                    {/* For an account made with Apple or Google, which the wrong-password copy points at. */}
                    <div className="mt-3">
                        <SignInProviderButtons inFlight={inFlight} onContinue={(provider) => void continueWith(provider)} describedBy="sign-in-agreement-email" />
                    </div>

                    <div className="min-h-6 flex-1 md:h-8 md:flex-none" />
                    <SignInAgreement id="sign-in-agreement-email" className="text-center text-xs leading-5 text-white/65" />
                </div>
            </section>
        </div>
    );
}

/** A labelled pill field, as the app's form draws them (owner, 2026-11-08: "round as the button"). */
function SignInField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={htmlFor} className="pl-[22px] text-[13px] font-bold uppercase leading-[18px] tracking-[0.05em] text-white/70">
                {label}
            </label>
            <div className="flex min-h-[52px] items-center gap-1 rounded-full border border-white/20 bg-[#0b0b0d]/90 pl-[22px] pr-1.5 transition focus-within:border-[var(--ui-focus)]">
                {children}
            </div>
        </div>
    );
}
