'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

interface AuthContextValue {
    session: Session | null;
    user: User | null;
    credits: number | null;
    isLoading: boolean;
    refreshSessionState: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [session, setSession] = useState<Session | null>(null);
    const [credits, setCredits] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(true);

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

        void syncSessionState();

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
            void syncSessionState(nextSession);
        });

        const handleCreditsUpdated = () => {
            void syncSessionState();
        };

        window.addEventListener('credits_updated', handleCreditsUpdated);

        return () => {
            isActive = false;
            subscription.unsubscribe();
            window.removeEventListener('credits_updated', handleCreditsUpdated);
        };
    }, []);

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

    return (
        <AuthContext.Provider
            value={{
                session,
                user: session?.user ?? null,
                credits,
                isLoading,
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
