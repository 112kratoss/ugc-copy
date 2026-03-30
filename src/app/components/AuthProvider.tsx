'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';

import {
    getClientE2EAuthState,
} from '@/lib/e2e-auth';
import { supabase } from '@/lib/supabase';

interface AuthContextValue {
    session: Session | null;
    user: User | null;
    credits: number | null;
    isLoading: boolean;
    updateCredits: (nextCredits: number | null) => void;
    refreshSessionState: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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
    const clientE2EAuth = getClientE2EAuthState();
    const [session, setSession] = useState<Session | null>(initialSession ?? clientE2EAuth?.session ?? null);
    const [credits, setCredits] = useState<number | null>(initialCredits ?? clientE2EAuth?.credits ?? null);
    const [isLoading, setIsLoading] = useState(!hasResolvedInitialState && !clientE2EAuth);

    useEffect(() => {
        let isActive = true;

        const syncSessionState = async (nextSession?: Session | null) => {
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

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
            void syncSessionState(nextSession);
        });

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
            subscription.unsubscribe();
            window.removeEventListener('credits_updated', handleCreditsUpdated);
        };
    }, [hasResolvedInitialState]);

    const refreshSessionState = async () => {
        setIsLoading(true);
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
