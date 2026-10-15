'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';

import { isSessionRefusal } from '@/lib/auth-error-copy';
import {
    getClientE2EAuthState,
} from '@/lib/e2e-auth';
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
    isLoading: boolean;
    updateCredits: (nextCredits: number | null, options?: CreditUpdateOptions) => void;
    refreshSessionState: () => Promise<void>;
}

const anonymousAuthContext: AuthContextValue = {
    session: null,
    user: null,
    credits: null,
    marketplaceSpendableCredits: null,
    isLoading: false,
    updateCredits: () => undefined,
    refreshSessionState: async () => undefined,
};

interface CreditBalance {
    credits: number | null;
    marketplaceSpendableCredits: number | null;
}

const UNKNOWN_BALANCE: CreditBalance = { credits: null, marketplaceSpendableCredits: null };

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
 * carried one. Otherwise only the total is known: a spend comes off the
 * spendable part too (generations spend promotional credits first, so this can
 * only understate it until the next profile read), and a rise is not counted
 * as spendable until the server says so, because a welcome or referral grant
 * is promotional.
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
    const spent = Math.max(0, previous.credits - credits);
    return { credits, marketplaceSpendableCredits: Math.max(0, previous.marketplaceSpendableCredits - spent) };
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

export function AuthProvider({
    children,
    initialSession = null,
    initialCredits = null,
    initialMarketplaceSpendableCredits = null,
    hasResolvedInitialState = false,
}: {
    children: React.ReactNode;
    initialSession?: Session | null;
    initialCredits?: number | null;
    initialMarketplaceSpendableCredits?: number | null;
    hasResolvedInitialState?: boolean;
}) {
    const [clientE2EAuth] = useState(() => getClientE2EAuthState());
    const hasAuthCookieHint = useSupabaseAuthCookieHint();
    const hasHydratedAuthCookieHint = useHasHydratedSupabaseAuthCookieHint();
    const [session, setSession] = useState<Session | null>(initialSession ?? clientE2EAuth?.session ?? null);
    const [balance, setBalance] = useState<CreditBalance>(() => ({
        credits: initialCredits ?? clientE2EAuth?.credits ?? null,
        // The E2E identity holds no promotional credits.
        marketplaceSpendableCredits: initialMarketplaceSpendableCredits ?? clientE2EAuth?.credits ?? null,
    }));
    const [isLoading, setIsLoading] = useState(!hasResolvedInitialState && !clientE2EAuth);
    const witnessedAuthCookieRef = useRef(hasAuthCookieHint);
    const authEpochRef = useRef(0);
    const tokenEpochRef = useRef(0);

    useEffect(() => {
        if (clientE2EAuth) {
            return;
        }

        let isActive = true;
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
            setSession(null);
            setBalance(UNKNOWN_BALANCE);
            setIsLoading(false);
        };

        const syncSessionState = async (
            candidateSession: Session | null,
            expectedAuthEpoch: number,
            expectedTokenEpoch: number,
            isRecheck = false,
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
                const { data, error } = await supabase.auth.getUser(candidateSession.access_token);
                verifiedUser = data.user;
                verificationFailed = Boolean(error);
                verificationError = error;
            } catch (error) {
                verificationFailed = true;
                verificationError = error;
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
                        void syncSessionState(candidateSession, expectedAuthEpoch, expectedTokenEpoch, true);
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

            const { data: profile } = await supabase
                .from('profiles')
                .select('credits, promotional_credits')
                .eq('id', verifiedUser.id)
                .single();

            if (
                !isActive
                || sequence !== authSequence
                || expectedAuthEpoch !== authEpochRef.current
            ) {
                return;
            }

            setBalance(balanceFromProfile(profile));
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

            const timeoutId = window.setTimeout(() => {
                deferredAuthSyncIds.delete(timeoutId);
                void syncSessionState(candidateSession, expectedAuthEpoch, expectedTokenEpoch);
            }, 0);
            deferredAuthSyncIds.add(timeoutId);
        };

        const subscribeToAuthChanges = async () => {
            const supabase = await getBrowserSupabase();
            if (!isActive || unsubscribeAuthState) {
                return;
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
                await syncSessionState(
                    currentSession,
                    expectedAuthEpoch,
                    tokenEpochRef.current,
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
            setSession(null);
            setBalance(UNKNOWN_BALANCE);
            setIsLoading(false);
            return;
        }

        const { data: { user: verifiedUser }, error: verificationError } =
            await supabase.auth.getUser(nextSession.access_token);
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
            setSession(null);
            setBalance(UNKNOWN_BALANCE);
            setIsLoading(false);
            return;
        }

        if (expectedTokenEpoch === tokenEpochRef.current) {
            setSession({ ...nextSession, user: verifiedUser });
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('credits, promotional_credits')
            .eq('id', verifiedUser.id)
            .single();

        if (expectedAuthEpoch !== authEpochRef.current) {
            return;
        }

        setBalance(balanceFromProfile(profile));
        setIsLoading(false);
    };

    const updateCredits = (nextCredits: number | null, options?: CreditUpdateOptions) => {
        setBalance((current) => balanceAfterTotal(current, nextCredits, options));

        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('credits_updated', {
                detail: { credits: nextCredits, marketplaceSpendableCredits: options?.marketplaceSpendableCredits },
            }));
        }
    };

    const resolvedIsLoading = !hasResolvedInitialState
        && !clientE2EAuth
        && !hasAuthCookieHint
        ? false
        : isLoading;

    return (
        <AuthContext.Provider
            value={{
                session,
                user: session?.user ?? null,
                credits: balance.credits,
                marketplaceSpendableCredits: balance.marketplaceSpendableCredits,
                isLoading: resolvedIsLoading,
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
