'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogOut, Menu, Sparkles, X } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

const PUBLIC_LINKS = [
  { href: '/showcase', label: 'Showcase' },
  { href: '/blog', label: 'Blog' },
  { href: '/pricing', label: 'Pricing' },
];

const PRIVATE_LINKS = [
  { href: '/create', label: 'Create Hub' },
  { href: '/creations', label: 'My Creations' },
  { href: '/profile', label: 'Profile' },
];

export default function NavbarClient() {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

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
    };

    void syncSessionState();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      void syncSessionState(nextSession);
    });

    const handleCreditsUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ credits?: number | null }>;
      if (customEvent.detail && 'credits' in customEvent.detail) {
        setCredits(customEvent.detail.credits ?? null);
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
  }, []);

  const isActivePath = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/');
    router.refresh();
  };

  const user = session?.user ?? null;
  const visibleLinks = user
    ? [...PUBLIC_LINKS, ...PRIVATE_LINKS]
    : PUBLIC_LINKS;

  return (
    <>
      <div className="hidden sm:flex items-center gap-6">
        <nav className="flex items-center gap-6">
          {visibleLinks.map((link) => {
            const isActive = isActivePath(link.href);

            return (
              <Link
                key={link.href}
                href={link.href}
                prefetch={link.href === '/create-workflow' || link.href === '/create-video' ? false : undefined}
                className={`relative py-1 text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-white'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {link.label}
                <span
                  className={`absolute inset-x-0 -bottom-1 h-0.5 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 transition-opacity ${
                    isActive ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-4">
          {user ? (
            <>
              {credits !== null ? (
                <Link
                  href="/pricing"
                  className="group relative rounded-full bg-gradient-to-r from-purple-500/40 to-pink-500/40 p-[1px] transition-all hover:from-purple-500 hover:to-pink-500"
                >
                  <span className="flex items-center gap-2 rounded-full bg-zinc-950/90 px-4 py-1.5 text-sm font-medium text-zinc-100 transition-colors group-hover:bg-zinc-950/70">
                    <Sparkles className="h-4 w-4 text-purple-400" />
                    {credits} Credits
                  </span>
                </Link>
              ) : null}

              <button
                type="button"
                onClick={handleLogout}
                className="rounded-full p-2.5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
                title="Log out"
              >
                <LogOut className="h-5 w-5" />
              </button>
            </>
          ) : (
            <Link
              href="/login?returnUrl=/create"
              className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.02] hover:bg-zinc-200"
            >
              Start Creating
            </Link>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 sm:hidden">
        {user && credits !== null ? (
          <Link
            href="/pricing"
            className="rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-sm font-medium text-purple-100"
          >
            {credits}
          </Link>
        ) : null}

        <button
          type="button"
          onClick={() => setIsMobileMenuOpen((current) => !current)}
          className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          title="Toggle menu"
        >
          {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {isMobileMenuOpen ? (
        <div className="absolute left-0 top-full z-40 w-full border-t border-white/10 bg-black/95 shadow-2xl sm:hidden">
          <div className="flex flex-col gap-4 px-6 py-4">
            {visibleLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                prefetch={link.href === '/create-workflow' || link.href === '/create-video' ? false : undefined}
                onClick={() => setIsMobileMenuOpen(false)}
                className={`text-sm font-medium ${
                  isActivePath(link.href) ? 'text-white' : 'text-zinc-300 hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
            {user ? (
              <button
                type="button"
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  void handleLogout();
                }}
                className="text-left text-sm font-medium text-zinc-300 hover:text-white"
              >
                Log Out
              </button>
            ) : (
              <Link
                href="/login?returnUrl=/create"
                onClick={() => setIsMobileMenuOpen(false)}
                className="text-sm font-medium text-zinc-300 hover:text-white"
              >
                Start Creating
              </Link>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
