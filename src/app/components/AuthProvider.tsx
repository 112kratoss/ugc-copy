'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';

import {
    getClientE2EAuthState,
} from '@/lib/e2e-auth';
import {
    useHasHydratedSupabaseAuthCookieHint,
    useSupabaseAuthCookieHint,
} from '@/app/components/useSupabaseAuthCookieHint';

type BrowserSupabaseClient = typeof import('@/lib/supabase')['supabase'];

type IdleWindow = Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    cancelIdleCallback?: (handle: number) => void;
};

interface AuthContextValue {
    session: Session | null;
    user: User | null;
    credits: number | null;
    isLoading: boolean;
    updateCredits: (nextCredits: number | null) => void;
    refreshSessionState: () => Promise<void>;
}

const anonymousAuthContext: AuthContextValue = {
    session: null,
    user: null,
    credits: null,
    isLoading: false,
    updateCredits: () => undefined,
    refreshSessionState: async () => undefined,
};

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
    hasResolvedInitialState = false,
}: {
    children: React.ReactNode;
    initialSession?: Session | null;
    initialCredits?: number | null;
    hasResolvedInitialState?: boolean;
}) {
    const [clientE2EAuth] = useState(() => getClientE2EAuthState());
    const hasAuthCookieHint = useSupabaseAuthCookieHint();
    const hasHydratedAuthCookieHint = useHasHydratedSupabaseAuthCookieHint();
    const [session, setSession] = useState<Session | null>(initialSession ?? clientE2EAuth?.session ?? null);
    const [credits, setCredits] = useState<number | null>(initialCredits ?? clientE2EAuth?.credits ?? null);
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
            setCredits(null);
            setIsLoading(false);
        };

        const syncSessionState = async (
            candidateSession: Session | null,
            expectedAuthEpoch: number,
            expectedTokenEpoch: number,
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
            try {
                const { data, error } = await supabase.auth.getUser(candidateSession.access_token);
                verifiedUser = data.user;
                verificationFailed = Boolean(error);
            } catch {
                verificationFailed = true;
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
                .select('credits')
                .eq('id', verifiedUser.id)
                .single();

            if (
                !isActive
                || sequence !== authSequence
                || expectedAuthEpoch !== authEpochRef.current
            ) {
                return;
            }

            setCredits(profile?.credits ?? null);
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
            const customEvent = event as CustomEvent<{ credits?: number | null }>;
            if (customEvent.detail && 'credits' in customEvent.detail) {
                setCredits(customEvent.detail.credits ?? null);
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
            setCredits(null);
            setIsLoading(false);
            return;
        }

        const { data: { user: verifiedUser }, error: verificationError } =
            await supabase.auth.getUser(nextSession.access_token);
        if (expectedAuthEpoch !== authEpochRef.current) {
            return;
        }
        if (verificationError || !verifiedUser || verifiedUser.id !== nextSession.user.id) {
            setSession(null);
            setCredits(null);
            setIsLoading(false);
            return;
        }

        if (expectedTokenEpoch === tokenEpochRef.current) {
            setSession({ ...nextSession, user: verifiedUser });
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('credits')
            .eq('id', verifiedUser.id)
            .single();

        if (expectedAuthEpoch !== authEpochRef.current) {
            return;
        }

        setCredits(profile?.credits ?? null);
        setIsLoading(false);
    };

    const updateCredits = (nextCredits: number | null) => {
        setCredits(nextCredits);

        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('credits_updated', {
                detail: { credits: nextCredits },
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
                credits,
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
