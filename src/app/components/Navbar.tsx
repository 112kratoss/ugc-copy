'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { LogOut, Sparkles } from 'lucide-react';
import { User } from '@supabase/supabase-js';

export default function Navbar() {
    const router = useRouter();
    const [user, setUser] = useState<User | null>(null);
    const [credits, setCredits] = useState<number | null>(null);

    useEffect(() => {
        const fetchUserAndCredits = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                setUser(session.user);

                // Fetch credits from profiles table
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('credits')
                    .eq('id', session.user.id)
                    .single();

                if (profile) {
                    setCredits(profile.credits);
                }
            } else {
                setUser(null);
                setCredits(null);
            }
        };

        fetchUserAndCredits();

        // Listen for auth changes (login/logout)
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            if (session?.user) {
                fetchUserAndCredits();
            } else {
                setUser(null);
                setCredits(null);
            }
        });

        return () => subscription.unsubscribe();
    }, []);

    const handleLogout = async () => {
        await supabase.auth.signOut();
        router.push('/');
        router.refresh();
    };

    return (
        <header className="w-full px-6 py-4 flex justify-between items-center max-w-7xl mx-auto border-b border-zinc-800/50 bg-black/50 backdrop-blur-md sticky top-0 z-50 text-white">
            <Link href="/" className="text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-500 text-transparent bg-clip-text">
                UGC Creator
            </Link>

            <nav className="flex items-center gap-6">
                <Link href="/pricing" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors hidden sm:block">
                    Pricing
                </Link>

                {user ? (
                    <div className="flex items-center gap-4">
                        <Link href="/create" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors hidden sm:block">
                            Create Video
                        </Link>

                        {credits !== null && (
                            <Link href="/pricing" className="bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-full flex items-center gap-2 text-sm font-medium hover:bg-zinc-800 transition-colors">
                                <Sparkles className="w-4 h-4 text-purple-400" />
                                <span className="hidden sm:inline">{credits} Credits</span>
                                <span className="sm:hidden">{credits}</span>
                            </Link>
                        )}

                        <button
                            onClick={handleLogout}
                            className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-full transition-colors"
                            title="Log out"
                        >
                            <LogOut className="w-5 h-5" />
                        </button>
                    </div>
                ) : (
                    <Link href="/login" className="bg-white text-black px-4 py-2 rounded-full text-sm font-medium hover:bg-zinc-200 transition-colors">
                        Log In
                    </Link>
                )}
            </nav>
        </header>
    );
}
