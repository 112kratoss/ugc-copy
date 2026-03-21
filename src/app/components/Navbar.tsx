'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { LogOut, Sparkles, Menu, X } from 'lucide-react';
import { useAuth } from '@/app/components/AuthProvider';
import { useState } from 'react';
import { motion } from 'framer-motion';

export default function Navbar() {
    const router = useRouter();
    const pathname = usePathname();
    const { user, credits } = useAuth();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    const isActivePath = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

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

                <div className="flex items-center gap-3 sm:gap-6">
                    {/* Desktop Navigation */}
                    <nav className="hidden sm:flex items-center gap-6">
                        {[
                            { href: '/showcase', label: 'Showcase' },
                            { href: '/blog', label: 'Blog' },
                            { href: '/pricing', label: 'Pricing' },
                        ].map((link) => {
                            const isActive = isActivePath(link.href);
                            return (
                                <Link key={link.href} href={link.href} className={`relative text-sm font-medium transition-all hover:scale-105 py-1 ${isActive ? 'text-white' : 'text-zinc-400 hover:text-white'}`}>
                                    {link.label}
                                    {isActive && (
                                        <motion.div layoutId="navbar-active" className="absolute -bottom-1 left-0 right-0 h-0.5 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full shadow-[0_0_10px_rgba(168,85,247,0.5)]" />
                                    )}
                                </Link>
                            );
                        })}

                        {user && (
                            <>
                                {[
                                    { href: '/create', label: 'Create Hub' },
                                    { href: '/creations', label: 'My Creations' },
                                ].map((link) => {
                                    const isActive = isActivePath(link.href);
                                    return (
                                        <Link key={link.href} href={link.href} className={`relative text-sm font-medium transition-all hover:scale-105 py-1 ${isActive ? 'text-white' : 'text-zinc-400 hover:text-white'}`}>
                                            {link.label}
                                            {isActive && (
                                                <motion.div layoutId="navbar-active" className="absolute -bottom-1 left-0 right-0 h-0.5 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full shadow-[0_0_10px_rgba(168,85,247,0.5)]" />
                                            )}
                                        </Link>
                                    );
                                })}
                            </>
                        )}
                    </nav>

                    {/* Always visible items (Credits, Logout/Login, Hamburger) */}
                    <div className="flex items-center gap-3 sm:gap-5">
                        {user ? (
                            <>
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
                            </>
                        ) : (
                            <Link
                                href="/login"
                                className="relative group bg-white text-black px-5 py-2 rounded-full text-sm font-medium overflow-hidden transition-transform hover:scale-105"
                            >
                                <span className="relative z-10 font-semibold tracking-wide">Log In</span>
                                <div className="absolute inset-0 bg-gradient-to-r from-zinc-200 to-white opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                            </Link>
                        )}

                        {/* Mobile Menu Toggle */}
                        <button
                            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                            className="sm:hidden p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-all"
                            title="Toggle menu"
                        >
                            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
                        </button>
                    </div>
                </div>
            </div>
            {/* Mobile Navigation Menu */}
            {isMobileMenuOpen && (
                <div className="sm:hidden border-t border-white/10 bg-black/95 backdrop-blur-xl absolute top-full w-full left-0 z-40 shadow-2xl">
                    <div className="flex flex-col px-6 py-4 gap-4">
                        <Link href="/showcase" onClick={() => setIsMobileMenuOpen(false)} className="text-zinc-300 hover:text-white text-sm font-medium">
                            Showcase
                        </Link>
                        <Link href="/blog" onClick={() => setIsMobileMenuOpen(false)} className="text-zinc-300 hover:text-white text-sm font-medium">
                            Blog
                        </Link>
                        <Link href="/pricing" onClick={() => setIsMobileMenuOpen(false)} className="text-zinc-300 hover:text-white text-sm font-medium">
                            Pricing
                        </Link>
                        {user && (
                            <>
                                <Link href="/create" onClick={() => setIsMobileMenuOpen(false)} className="text-zinc-300 hover:text-white text-sm font-medium">
                                    Create Hub
                                </Link>
                                <Link href="/creations" onClick={() => setIsMobileMenuOpen(false)} className="text-zinc-300 hover:text-white text-sm font-medium">
                                    My Creations
                                </Link>
                            </>
                        )}
                    </div>
                </div>
            )}
        </header>
    );
}
