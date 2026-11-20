'use client';

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Session, User } from '@supabase/supabase-js';

import { isSessionRefusal } from '@/lib/auth-error-copy';
import { checkSessionUser, forgetAccountReads, readOwnProfile } from '@/lib/browser-account-reads';
import {
    accessTokenSessionId,
    browserSignOutSnapshot,
    subscribeToBrowserSignOuts,
    wasSessionSignedOutInBrowser,
    wasSessionSignedOutInThisTab,
} from '@/lib/browser-sign-out';
import type { SaverNoticeRecord } from '@/components/saver-notice';
import {
    getClientE2EAuthState,
} from '@/lib/e2e-auth';
import {
    forgetInviteShareCode,
    holdStoredInviteShareCode,
    primeInviteShareCode,
} from '@/lib/invite-share-code';
import { clearStoredInviteHandoff } from '@/lib/invite-handoff';
import {
    useHasHydratedSupabaseAuthCookieHint,
    useSupabaseAuthCookieHint,
} from '@/components/useSupabaseAuthCookieHint';

type BrowserSupabaseClient = typeof import('@/lib/supabase')['supabase'];

/** A session check Supabase could not answer is asked once more after this. */
const SESSION_RECHECK_DELAY_MS = 2000;

type IdleWindow = Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    cancelIdleCallback?: (handle: number) => void;
};

export interface CreditUpdateOptions {
    /**
     * How much of the new total can buy a recipe, as the server counted it
     * (the credit unlock answers it). Left out, it follows the total.
     */
    marketplaceSpendableCredits?: number | null;
}

interface AuthContextValue {
    session: Session | null;
    user: User | null;
    credits: number | null;
    /**
     * The part of `credits` a recipe can be bought with: the total less the
     * welcome and referral (promotional) credits, which the credit unlock will
     * not spend. Null when unknown.
     */
    marketplaceSpendableCredits: number | null;
    /**
     * Whether the signed-in account has been told, on record, that creators can
     * see who saved its posts: as the page was drawn, or as the profile was
     * last read since (a sign-in, a balance refresh). A new object for each
     * read. Null while neither has been read for the account signed in.
     */
    saverNoticeRecord: SaverNoticeRecord | null;
    /**
     * Whether a sign-out made in this browser, in this tab or another one (`markBrowserSignOut`),
     * ended the session this tab held last. False while a session is held, and after one that
     * lapsed or was refused: Supabase reports all of them as the same sign-out.
     */
    signedOut: boolean;
    /** Whether that sign-out was made in this tab, which goes on to the login page of its own accord. */
    signedOutHere: boolean;
    isLoading: boolean;
    /**
     * When this provider, with no session from the server, began checking the browser's session
     * cookie with Supabase (`performance.now()`): once supabase-js has loaded, as it asks for the
     * session, a token refresh and `getUser` included. Null before then, and where no such check is
     * made (a session the server read, the E2E session, no cookie, no provider). A part of the page
     * waiting on the check times it from here (`useViewerSessionCheck`): loading supabase-js before
     * it is not the check's, and on a slow phone it is most of the wait.
     */
    sessionCheckStartedAt: number | null;
    updateCredits: (nextCredits: number | null, options?: CreditUpdateOptions) => void;
    refreshSessionState: () => Promise<void>;
}

/**
 * A new balance, told to everything on the page that draws one: the header
 * (`AppShellAccount`, which takes the figure at once and reads it again) and
 * every provider (each takes it into its own balance). They listen on the
 * window because the shell sits above every route's provider.
 */
function announceCredits(nextCredits: number | null, options?: CreditUpdateOptions) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('credits_updated', {
        detail: { credits: nextCredits, marketplaceSpendableCredits: options?.marketplaceSpendableCredits },
    }));
}

const anonymousAuthContext: AuthContextValue = {
    session: null,
    user: null,
    credits: null,
    marketplaceSpendableCredits: null,
    saverNoticeRecord: null,
    signedOut: false,
    signedOutHere: false,
    isLoading: false,
    sessionCheckStartedAt: null,
    // Outside a provider (the root layout's own components, a page drawn
    // without one) a balance still has to reach the header: a no-op here left
    // it at 0 after the welcome claim, made on a page with no provider, until
    // a full reload (2026-11-05).
    updateCredits: announceCredits,
    refreshSessionState: async () => undefined,
};

interface CreditBalance {
    credits: number | null;
    marketplaceSpendableCredits: number | null;
}

const UNKNOWN_BALANCE: CreditBalance = { credits: null, marketplaceSpendableCredits: null };

/** A profile row's record of its account being told that creators can see who saved. */
function saverNoticeRecordFromProfile(
    userId: string,
    profile: { saver_notice_seen_at?: string | null } | null,
): SaverNoticeRecord | null {
    return profile ? { userId, seen: typeof profile.saver_notice_seen_at === 'string' } : null;
}

/** A profile row's balance, split by the rule the profile API and the unlock RPC apply. */
function balanceFromProfile(
    profile: { credits?: number | null; promotional_credits?: number | null } | null,
): CreditBalance {
    const credits = profile?.credits ?? null;
    return {
        credits,
        marketplaceSpendableCredits: credits === null
            ? null
            : Math.max(0, credits - Math.max(0, profile?.promotional_credits ?? 0)),
    };
}

/**
 * The balance after a change. The server's own split stands when the answer
 * carried one. Otherwise only the total is known: a spend leaves the spendable
 * part alone until the total falls below it (a generation or an enhancement
 * draws the promotional credits first, and a recipe unlock answers with its own
 * split, so taking a spend off the spendable part understated it and blocked
 * real purchases until the next profile read), and a rise is not counted as
 * spendable until the server says so, because a welcome or referral grant is
 * promotional.
 */
function balanceAfterTotal(
    previous: CreditBalance,
    credits: number | null,
    options?: CreditUpdateOptions,
): CreditBalance {
    if (options?.marketplaceSpendableCredits !== undefined) {
        return { credits, marketplaceSpendableCredits: options.marketplaceSpendableCredits };
    }
    if (credits === null || previous.credits === null || previous.marketplaceSpendableCredits === null) {
        return { credits, marketplaceSpendableCredits: null };
    }
    return { credits, marketplaceSpendableCredits: Math.max(0, Math.min(previous.marketplaceSpendableCredits, credits)) };
}

// Public routes intentionally omit the provider when the request has no auth
// cookie hint. Consumers still receive a complete, signed-out context while
// authenticated requests mount AuthProvider with server-verified state.
const AuthContext = createContext<AuthContextValue>(anonymousAuthContext);

async function getBrowserSupabase(): Promise<BrowserSupabaseClient> {
    const { supabase } = await import('@/lib/supabase');
    return supabase;
}

function scheduleIdle(callback: () => void, timeout = 1500) {
    if (typeof window === 'undefined') {
        return undefined;
    }

    const idleWindow = window as IdleWindow;

    if (typeof idleWindow.requestIdleCallback === 'function') {
        const idleId = idleWindow.requestIdleCallback(callback, { timeout });
        return () => idleWindow.cancelIdleCallback?.(idleId);
    }

    const timeoutId = idleWindow.setTimeout(callback, Math.min(timeout, 900));
    return () => idleWindow.clearTimeout(timeoutId);
}

function subscribeToNothing() {
    return () => {};
}

// One object per page load, so useSyncExternalStore sees a stable snapshot.
let clientE2EAuthSnapshot: ReturnType<typeof getClientE2EAuthState> = null;
function readClientE2EAuth() {
    clientE2EAuthSnapshot ??= getClientE2EAuthState();
    return clientE2EAuthSnapshot;
}

export function AuthProvider({
    children,
    initialSession = null,
    initialCredits = null,
    initialMarketplaceSpendableCredits = null,
    initialSaverNoticeSeen = null,
    hasResolvedInitialState = false,
}: {
    children: React.ReactNode;
    initialSession?: Session | null;
    initialCredits?: number | null;
    initialMarketplaceSpendableCredits?: number | null;
    initialSaverNoticeSeen?: boolean | null;
    hasResolvedInitialState?: boolean;
}) {
    // The E2E bypass session is read after hydration, never in it: the server drew this page with
    // `initialSession` alone (a cached page has none), so the hydration render must too, or React
    // throws the server's HTML away. The server snapshot is null; the browser's is the bypass.
    const clientE2EAuth = useSyncExternalStore(subscribeToNothing, readClientE2EAuth, () => null);
    const hasAuthCookieHint = useSupabaseAuthCookieHint();
    const hasHydratedAuthCookieHint = useHasHydratedSupabaseAuthCookieHint();
    // Whether this provider was drawn with the document's own HTML (a full load: its first render is
    // the hydration's) or made in the browser (a client navigation, Back and Forward included). See
    // `askedSince` in the effect below.
    const [cameWithDocument] = useState(!hasHydratedAuthCookieHint);
    const [session, setSession] = useState<Session | null>(initialSession ?? clientE2EAuth?.session ?? null);
    const [balance, setBalance] = useState<CreditBalance>(() => ({
        credits: initialCredits ?? clientE2EAuth?.credits ?? null,
        // The E2E identity holds no promotional credits.
        marketplaceSpendableCredits: initialMarketplaceSpendableCredits ?? clientE2EAuth?.credits ?? null,
    }));
    const [isLoading, setIsLoading] = useState(!hasResolvedInitialState);
    // The bypass applied to the state above, once, in the render that first sees it (after
    // hydration), as a session the server drew does and the real check never touches.
    const [appliedE2EAuth, setAppliedE2EAuth] = useState<typeof clientE2EAuth>(null);
    if (clientE2EAuth && appliedE2EAuth !== clientE2EAuth) {
        setAppliedE2EAuth(clientE2EAuth);
        setSession((current) => current ?? clientE2EAuth.session);
        setBalance((current) => ({
            credits: current.credits ?? clientE2EAuth.credits,
            marketplaceSpendableCredits: current.marketplaceSpendableCredits ?? clientE2EAuth.credits,
        }));
        setIsLoading(false);
    }
    const [sessionCheckStartedAt, setSessionCheckStartedAt] = useState<number | null>(null);
    // The record the page was drawn with, kept as one object for as long as
    // the page is open, and the latest one read in the browser since.
    const [pageSaverNoticeRecord] = useState<SaverNoticeRecord | null>(() => (
        initialSaverNoticeSeen !== null && initialSession?.user?.id
            ? { userId: initialSession.user.id, seen: initialSaverNoticeSeen }
            : null
    ));
    const [readSaverNoticeRecord, setReadSaverNoticeRecord] = useState<SaverNoticeRecord | null>(null);
    // The session this tab held last, by its id (no token outlives the session here), which its
    // ending is read against (`signedOut`), and the browser's sign-out marks, followed as other
    // tabs write them: a mark that lands after this tab's session has ended still counts.
    const sessionId = session ? accessTokenSessionId(session.access_token) : null;
    const [heldSessionId, setHeldSessionId] = useState(sessionId);
    if (sessionId && sessionId !== heldSessionId) setHeldSessionId(sessionId);
    const signOutMarks = useSyncExternalStore(subscribeToBrowserSignOuts, browserSignOutSnapshot, () => null);
    const witnessedAuthCookieRef = useRef(hasAuthCookieHint);
    const authEpochRef = useRef(0);
    const tokenEpochRef = useRef(0);

    useEffect(() => {
        // Read here, not from the render's snapshot: the effect of the hydration render runs
        // before the snapshot has switched to the bypass.
        if (readClientE2EAuth()) {
            return;
        }

        let isActive = true;
        // The checks and reads this page takes from the ones the page shares
        // (`browser-account-reads.ts`): a page that came with the document began with it, and takes
        // any asked for since, the top bar's included, which can go out before the page's part of
        // the HTML has hydrated; a page made by a client navigation takes only what was asked for
        // since it began, so it checks the session and reads the balance as each new page always did.
        const askedSince = cameWithDocument ? undefined : performance.now();
        let unsubscribeAuthState: (() => void) | null = null;
        let cancelDeferredSubscription: (() => void) | undefined;
        let authSequence = 0;
        let acceptedAccessToken = hasResolvedInitialState ? initialSession?.access_token ?? null : null;
        let acceptedUserId = hasResolvedInitialState ? initialSession?.user?.id ?? null : null;
        const pendingAccessTokens = new Set<string>();
        const queuedUserUpdates = new Map<string, Session>();
        const deferredAuthSyncIds = new Set<number>();

        const clearAuthState = () => {
            authEpochRef.current += 1;
            tokenEpochRef.current += 1;
            authSequence += 1;
            acceptedAccessToken = null;
            acceptedUserId = null;
            pendingAccessTokens.clear();
            queuedUserUpdates.clear();
            deferredAuthSyncIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
            deferredAuthSyncIds.clear();
            // Nothing checked or read for the session that ended answers anyone after it.
            forgetAccountReads();
            setSession(null);
            setBalance(UNKNOWN_BALANCE);
            setReadSaverNoticeRecord(null);
            setIsLoading(false);
        };

        /**
         * Checks `candidateSession` with Supabase Auth and reads the account's balance. Both are the
         * page's shared ones (`browser-account-reads.ts`): the top bar and the comment composer ask
         * for the same, once. `fresh` asks Supabase again whatever is held: a re-read of the balance,
         * a user Supabase says changed.
         */
        const syncSessionState = async (
            candidateSession: Session | null,
            expectedAuthEpoch: number,
            expectedTokenEpoch: number,
            { isRecheck = false, fresh = false }: { isRecheck?: boolean; fresh?: boolean } = {},
        ) => {
            const sequence = ++authSequence;
            const supabase = await getBrowserSupabase();

            if (
                !isActive
                || sequence !== authSequence
                || expectedAuthEpoch !== authEpochRef.current
            ) {
                return;
            }

            if (!candidateSession?.user?.id) {
                clearAuthState();
                return;
            }

            let verifiedUser: User | null = null;
            let verificationFailed = false;
            let verificationError: unknown = null;
            try {
                // Supabase Auth's own answer about this token, whoever on the page asked first.
                const check = await checkSessionUser(supabase, candidateSession.access_token, { fresh, askedSince });
                verifiedUser = check.user;
                verificationFailed = check.failed;
                verificationError = check.error;
            } finally {
                pendingAccessTokens.delete(candidateSession.access_token);
                const queuedUserUpdate = queuedUserUpdates.get(candidateSession.access_token);
                if (queuedUserUpdate) {
                    queuedUserUpdates.delete(candidateSession.access_token);
                    const timeoutId = window.setTimeout(() => {
                        deferredAuthSyncIds.delete(timeoutId);
                        if (isActive) {
                            handleAuthChange('USER_UPDATED', queuedUserUpdate);
                        }
                    }, 0);
                    deferredAuthSyncIds.add(timeoutId);
                }
            }

            if (
                !isActive
                || sequence !== authSequence
                || expectedAuthEpoch !== authEpochRef.current
            ) {
                return;
            }

            if (verificationFailed && !isSessionRefusal(verificationError)) {
                // Supabase Auth could not answer (offline, a 5xx, a rate limit),
                // which says nothing about the session (audit 01-10): it stays,
                // unverified, and is checked once more. Only a refusal ends it.
                if (acceptedUserId !== candidateSession.user.id) {
                    acceptedAccessToken = null;
                    acceptedUserId = null;
                    setBalance(UNKNOWN_BALANCE);
                }
                if (expectedTokenEpoch === tokenEpochRef.current) {
                    setSession(candidateSession);
                }
                if (isRecheck) {
                    setIsLoading(false);
                    return;
                }
                const timeoutId = window.setTimeout(() => {
                    deferredAuthSyncIds.delete(timeoutId);
                    // A newer auth event or re-read checks the current session itself.
                    if (isActive && expectedAuthEpoch === authEpochRef.current) {
                        void syncSessionState(candidateSession, expectedAuthEpoch, expectedTokenEpoch, { isRecheck: true, fresh });
                    }
                }, SESSION_RECHECK_DELAY_MS);
                deferredAuthSyncIds.add(timeoutId);
                return;
            }

            if (verificationFailed || !verifiedUser || verifiedUser.id !== candidateSession.user.id) {
                clearAuthState();
                return;
            }

            const resolvedSession = { ...candidateSession, user: verifiedUser };
            acceptedAccessToken = candidateSession.access_token;
            acceptedUserId = verifiedUser.id;
            if (expectedTokenEpoch === tokenEpochRef.current) {
                setSession(resolvedSession);
            } else {
                setSession((currentSession) => (
                    currentSession?.user.id === verifiedUser.id
                        ? { ...currentSession, user: verifiedUser }
                        : currentSession
                ));
            }

            const { row: profile } = await readOwnProfile(supabase, verifiedUser.id, { fresh, askedSince });

            if (
                !isActive
                || sequence !== authSequence
                || expectedAuthEpoch !== authEpochRef.current
            ) {
                return;
            }

            setBalance(balanceFromProfile(profile));
            const saverNoticeRecord = saverNoticeRecordFromProfile(verifiedUser.id, profile);
            if (saverNoticeRecord) setReadSaverNoticeRecord(saverNoticeRecord);
            setIsLoading(false);
        };

        const handleAuthChange = (event: string, candidateSession: Session | null) => {
            if (!candidateSession?.user?.id) {
                clearAuthState();
                return;
            }

            const accessToken = candidateSession?.access_token ?? null;
            if (event === 'TOKEN_REFRESHED' && acceptedUserId === candidateSession.user.id) {
                tokenEpochRef.current += 1;
                acceptedAccessToken = accessToken;
                setSession(candidateSession);
                return;
            }

            if (accessToken) {
                if (pendingAccessTokens.has(accessToken)) {
                    if (event === 'USER_UPDATED') {
                        queuedUserUpdates.set(accessToken, candidateSession);
                    }
                    return;
                }
                if (event !== 'USER_UPDATED' && accessToken === acceptedAccessToken) {
                    return;
                }
                pendingAccessTokens.add(accessToken);
            }

            const expectedAuthEpoch = ++authEpochRef.current;
            const expectedTokenEpoch = ++tokenEpochRef.current;
            // Supabase says the user changed: a check from before the change would name the old one.
            const fresh = event === 'USER_UPDATED';

            const timeoutId = window.setTimeout(() => {
                deferredAuthSyncIds.delete(timeoutId);
                void syncSessionState(candidateSession, expectedAuthEpoch, expectedTokenEpoch, { fresh });
            }, 0);
            deferredAuthSyncIds.add(timeoutId);
        };

        const subscribeToAuthChanges = async () => {
            const supabase = await getBrowserSupabase();
            if (!isActive || unsubscribeAuthState) {
                return;
            }

            // The check of a cookie the server did not read starts here, the first time only.
            if (!hasResolvedInitialState) {
                setSessionCheckStartedAt((startedAt) => startedAt ?? performance.now());
            }
            const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
                handleAuthChange(event, nextSession);
            });
            unsubscribeAuthState = () => subscription.unsubscribe();
        };

        const hadAuthCookieHint = witnessedAuthCookieRef.current;
        if (hasAuthCookieHint) {
            witnessedAuthCookieRef.current = true;
        }
        const didLoseAuthCookie = hasHydratedAuthCookieHint
            && !hasAuthCookieHint
            && hadAuthCookieHint;

        if (didLoseAuthCookie) {
            witnessedAuthCookieRef.current = false;
            clearAuthState();
        } else if (hasResolvedInitialState) {
            cancelDeferredSubscription = scheduleIdle(() => {
                void subscribeToAuthChanges();
            });
        } else if (hasAuthCookieHint) {
            void subscribeToAuthChanges();
        }

        const handleCreditsUpdated = (event: Event) => {
            const customEvent = event as CustomEvent<{
                credits?: number | null;
                marketplaceSpendableCredits?: number | null;
            }>;
            if (customEvent.detail && 'credits' in customEvent.detail) {
                const { credits: nextCredits, marketplaceSpendableCredits } = customEvent.detail;
                setBalance((current) => balanceAfterTotal(current, nextCredits ?? null, { marketplaceSpendableCredits }));
                setIsLoading(false);
                return;
            }

            void getBrowserSupabase().then(async (supabase) => {
                const expectedAuthEpoch = ++authEpochRef.current;
                const { data: { session: currentSession } } = await supabase.auth.getSession();
                if (expectedAuthEpoch !== authEpochRef.current) {
                    return;
                }
                // Asked anew, as a re-read of the balance always was.
                await syncSessionState(
                    currentSession,
                    expectedAuthEpoch,
                    tokenEpochRef.current,
                    { fresh: true },
                );
            });
        };

        window.addEventListener('credits_updated', handleCreditsUpdated);

        return () => {
            isActive = false;
            authEpochRef.current += 1;
            tokenEpochRef.current += 1;
            cancelDeferredSubscription?.();
            unsubscribeAuthState?.();
            deferredAuthSyncIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
            window.removeEventListener('credits_updated', handleCreditsUpdated);
        };
    }, [
        cameWithDocument,
        clientE2EAuth,
        hasAuthCookieHint,
        hasHydratedAuthCookieHint,
        hasResolvedInitialState,
        initialSession,
    ]);

    const refreshSessionState = async () => {
        const expectedAuthEpoch = ++authEpochRef.current;
        const expectedTokenEpoch = tokenEpochRef.current;
        setIsLoading(true);
        const supabase = await getBrowserSupabase();
        if (expectedAuthEpoch !== authEpochRef.current) {
            return;
        }
        const { data: { session: nextSession } } = await supabase.auth.getSession();
        if (expectedAuthEpoch !== authEpochRef.current) {
            return;
        }
        if (!nextSession?.user?.id) {
            forgetAccountReads();
            setSession(null);
            setBalance(UNKNOWN_BALANCE);
            setIsLoading(false);
            return;
        }

        // Asked anew: the page wants Supabase Auth's answer now, not one it already had. Whatever
        // else asks meanwhile is given this one.
        const check = await checkSessionUser(supabase, nextSession.access_token, { fresh: true });
        // A check that threw ends this re-check as it always did (the caller's reload, say).
        if (check.threw) throw check.error;
        const verifiedUser = check.user;
        const verificationError = check.failed ? check.error : null;
        if (expectedAuthEpoch !== authEpochRef.current) {
            return;
        }
        if (verificationError && !isSessionRefusal(verificationError)) {
            // Supabase Auth could not answer: the session stays, unverified,
            // and the next auth event or balance re-read checks it again.
            if (expectedTokenEpoch === tokenEpochRef.current) {
                setSession(nextSession);
            }
            setIsLoading(false);
            return;
        }
        if (verificationError || !verifiedUser || verifiedUser.id !== nextSession.user.id) {
            forgetAccountReads();
            setSession(null);
            setBalance(UNKNOWN_BALANCE);
            setIsLoading(false);
            return;
        }

        if (expectedTokenEpoch === tokenEpochRef.current) {
            setSession({ ...nextSession, user: verifiedUser });
        }

        const { row: profile } = await readOwnProfile(supabase, verifiedUser.id, { fresh: true });

        if (expectedAuthEpoch !== authEpochRef.current) {
            return;
        }

        setBalance(balanceFromProfile(profile));
        const saverNoticeRecord = saverNoticeRecordFromProfile(verifiedUser.id, profile);
        if (saverNoticeRecord) setReadSaverNoticeRecord(saverNoticeRecord);
        setIsLoading(false);
    };

    const updateCredits = (nextCredits: number | null, options?: CreditUpdateOptions) => {
        setBalance((current) => balanceAfterTotal(current, nextCredits, options));
        announceCredits(nextCredits, options);
    };

    // The account's invite code, for the links it shares (`invite-share-code.ts`). What this
    // browser stored is held as soon as the account is known; the server is asked in idle time,
    // at most once a week. A guest has no invite and a visitor has no account: their shares
    // carry none, and the code is let go when the account signs out.
    const inviteUserId = !clientE2EAuth && session?.user && !session.user.is_anonymous
        ? session.user.id
        : null;
    const inviteAccessToken = inviteUserId ? session?.access_token ?? null : null;
    // An account holds no invite to carry on to the app: the one this tab kept for the page's
    // offer (`invite-handoff.ts`) goes as soon as any page sees the account, so a later
    // sign-out in the tab does not bring the offer back for an invite already used.
    useEffect(() => {
        if (inviteUserId) clearStoredInviteHandoff();
    }, [inviteUserId]);
    useEffect(() => {
        if (!inviteUserId || !inviteAccessToken) {
            // Only once the session is known: an optional-auth page mounts this provider with no
            // session while it asks, and letting go then left a share made in that second bare
            // (review of 2026-11-10). A share checks the session cookie itself in the meantime.
            if (!isLoading) forgetInviteShareCode();
            return undefined;
        }
        holdStoredInviteShareCode(inviteUserId);
        return scheduleIdle(() => {
            void primeInviteShareCode({ userId: inviteUserId, accessToken: inviteAccessToken });
        }, 4000);
    }, [inviteAccessToken, inviteUserId, isLoading]);

    const resolvedIsLoading = !hasResolvedInitialState
        && !clientE2EAuth
        && !hasAuthCookieHint
        ? false
        : isLoading;
    const signedOut = !session && wasSessionSignedOutInBrowser(heldSessionId, signOutMarks);

    return (
        <AuthContext.Provider
            value={{
                session,
                user: session?.user ?? null,
                credits: balance.credits,
                marketplaceSpendableCredits: balance.marketplaceSpendableCredits,
                // Only ever the account signed in now's, the latest read first.
                saverNoticeRecord: [readSaverNoticeRecord, pageSaverNoticeRecord]
                    .find((record) => record !== null && record.userId === session?.user?.id) ?? null,
                signedOut,
                signedOutHere: signedOut && wasSessionSignedOutInThisTab(heldSessionId),
                isLoading: resolvedIsLoading,
                sessionCheckStartedAt,
                updateCredits,
                refreshSessionState,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    return useContext(AuthContext);
}
