'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';

import {
    getClientE2EAuthState,
} from '@/lib/e2e-auth';

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

const AuthContext = createContext<AuthContextValue | null>(null);

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
    const [session, setSession] = useState<Session | null>(initialSession ?? clientE2EAuth?.session ?? null);
    const [credits, setCredits] = useState<number | null>(initialCredits ?? clientE2EAuth?.credits ?? null);
    const [isLoading, setIsLoading] = useState(!hasResolvedInitialState && !clientE2EAuth);

    useEffect(() => {
        if (clientE2EAuth) {
            return;
        }

        let isActive = true;
        let unsubscribeAuthState: (() => void) | null = null;
        let cancelDeferredSubscription: (() => void) | undefined;

        const syncSessionState = async (nextSession?: Session | null) => {
            const supabase = await getBrowserSupabase();
            const resolvedSession =
                nextSession !== undefined
                    ? nextSession
                    : (await supabase.auth.getSession()).data.session;

            if (!isActive) {
                return;
            }

            setSession(resolvedSession ?? null);

            if (!resolvedSession?.user) {
                setCredits(null);
                setIsLoading(false);
                return;
            }

            const { data: profile } = await supabase
                .from('profiles')
                .select('credits')
                .eq('id', resolvedSession.user.id)
                .single();

            if (!isActive) {
                return;
            }

            setCredits(profile?.credits ?? null);
            setIsLoading(false);
        };

        if (!hasResolvedInitialState) {
            void syncSessionState();
        }

        const subscribeToAuthChanges = async () => {
            const supabase = await getBrowserSupabase();
            if (!isActive || unsubscribeAuthState) {
                return;
            }

            const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
                void syncSessionState(nextSession);
            });
            unsubscribeAuthState = () => subscription.unsubscribe();
        };

        if (hasResolvedInitialState) {
            cancelDeferredSubscription = scheduleIdle(() => {
                void subscribeToAuthChanges();
            });
        } else {
            void subscribeToAuthChanges();
        }

        const handleCreditsUpdated = (event: Event) => {
            const customEvent = event as CustomEvent<{ credits?: number | null }>;
            if (customEvent.detail && 'credits' in customEvent.detail) {
                setCredits(customEvent.detail.credits ?? null);
                setIsLoading(false);
                return;
            }

            void syncSessionState();
        };

        window.addEventListener('credits_updated', handleCreditsUpdated);

        return () => {
            isActive = false;
            cancelDeferredSubscription?.();
            unsubscribeAuthState?.();
            window.removeEventListener('credits_updated', handleCreditsUpdated);
        };
    }, [clientE2EAuth, hasResolvedInitialState]);

    const refreshSessionState = async () => {
        setIsLoading(true);
        const supabase = await getBrowserSupabase();
        const { data: { session: nextSession } } = await supabase.auth.getSession();
        setSession(nextSession ?? null);

        if (!nextSession?.user) {
            setCredits(null);
            setIsLoading(false);
            return;
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('credits')
            .eq('id', nextSession.user.id)
            .single();

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

    return (
        <AuthContext.Provider
            value={{
                session,
                user: session?.user ?? null,
                credits,
                isLoading,
                updateCredits,
                refreshSessionState,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);

    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }

    return context;
}
