'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { LogOut, Sparkles } from 'lucide-react';
import { useAuth } from '@/app/components/AuthProvider';

export default function Navbar() {
    const router = useRouter();
    const { user, credits } = useAuth();

    const handleLogout = async () => {
        await supabase.auth.signOut();
        router.push('/');
        router.refresh();
    };

    return (
        <header className="w-full sticky top-0 z-50 transition-all duration-300 border-b border-white/5 bg-black/60 backdrop-blur-xl supports-[backdrop-filter]:bg-black/40 text-white">
            <div className="max-w-7xl mx-auto px-6 h-16 flex justify-between items-center">
                <div className="flex items-center gap-2">
                    <Link href="/" className="text-xl font-bold tracking-tight bg-gradient-to-br from-white via-purple-100 to-pink-200 text-transparent bg-clip-text drop-shadow-sm hover:opacity-90 transition-opacity">
                        UGC copy
                    </Link>
                </div>

                <nav className="flex items-center gap-6">
                    <Link href="/showcase" className="text-sm font-medium text-zinc-400 hover:text-white transition-all hover:scale-105 hidden sm:block">
                        Showcase
                    </Link>
                    <Link href="/blog" className="text-sm font-medium text-zinc-400 hover:text-white transition-all hover:scale-105 hidden sm:block">
                        Blog
                    </Link>
                    <Link href="/pricing" className="text-sm font-medium text-zinc-400 hover:text-white transition-all hover:scale-105 hidden sm:block">
                        Pricing
                    </Link>

                    {user ? (
                        <div className="flex items-center gap-3 sm:gap-5">
                            <Link href="/create" className="text-sm font-medium text-zinc-400 hover:text-white transition-all hover:scale-105 hidden sm:block">
                                Create Hub
                            </Link>
                            <Link href="/creations" className="text-sm font-medium text-zinc-400 hover:text-white transition-all hover:scale-105 hidden sm:block">
                                My Creations
                            </Link>

                            {credits !== null && (
                                <Link
                                    href="/pricing"
                                    className="group relative rounded-full p-[1px] bg-gradient-to-r from-purple-500/40 to-pink-500/40 hover:from-purple-500 hover:to-pink-500 transition-all duration-500 hover:shadow-[0_0_15px_-3px_rgba(168,85,247,0.4)]"
                                >
                                    <span className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 rounded-full bg-zinc-950/90 backdrop-blur-md group-hover:bg-zinc-950/70 transition-all duration-500 text-sm font-medium">
                                        <Sparkles className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-purple-400 group-hover:text-purple-300 transition-colors" />
                                        <span className="bg-gradient-to-r from-purple-100 to-pink-100 text-transparent bg-clip-text">
                                            {credits} <span className="hidden sm:inline">Credits</span>
                                        </span>
                                    </span>
                                </Link>
                            )}

                            <button
                                onClick={handleLogout}
                                className="p-2 sm:p-2.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded-full transition-all duration-300 hover:rotate-6 hover:scale-110"
                                title="Log out"
                            >
                                <LogOut className="w-4 h-4 sm:w-5 sm:h-5" />
                            </button>
                        </div>
                    ) : (
                        <Link
                            href="/login"
                            className="relative group bg-white text-black px-5 py-2 rounded-full text-sm font-medium overflow-hidden transition-transform hover:scale-105"
                        >
                            <span className="relative z-10 font-semibold tracking-wide">Log In</span>
                            <div className="absolute inset-0 bg-gradient-to-r from-zinc-200 to-white opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                        </Link>
                    )}
                </nav>
            </div>
        </header>
    );
}
