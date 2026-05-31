'use client';

import type { Session } from '@supabase/supabase-js';
import { ChevronDown, LogOut, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import {
  getAuthAvatarUrl,
  getCreatorDisplayName,
  getUserInitials,
} from '@/lib/profile';
import { supabase } from '@/lib/supabase';

import AppShellAccountFallback from './AppShellAccountFallback';

type ProfileSummary = {
  name: string | null;
  avatar_url: string | null;
  credits: number | null;
};

type AccountAvatarProps = {
  session: Session | null;
  profile: ProfileSummary | null;
  size?: 'sm' | 'md';
};

function AccountAvatar({ session, profile, size = 'md' }: AccountAvatarProps) {
  const avatarUrl = getAuthAvatarUrl(session?.user?.user_metadata) ?? profile?.avatar_url;
  const label = getCreatorDisplayName({
    name: profile?.name ?? null,
    email: session?.user?.email ?? null,
  });
  const initials = getUserInitials(label);
  const className = size === 'sm' ? 'h-8 w-8 text-xs' : 'h-9 w-9 text-sm';

  if (avatarUrl) {
    return (
      <span
        aria-hidden="true"
        className={`${className} rounded-full border border-white/10 bg-cover bg-center`}
        style={{ backgroundImage: `url(${avatarUrl})` }}
      />
    );
  }

  return (
    <span
      className={`${className} inline-flex items-center justify-center rounded-full border border-white/10 bg-white text-black font-semibold`}
    >
      {initials}
    </span>
  );
}

export default function AppShellAccount() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const credits = profile?.credits ?? 0;
  const displayName = getCreatorDisplayName({
    name: profile?.name ?? null,
    email: session?.user?.email ?? null,
  });

  useEffect(() => {
    let mounted = true;

    async function loadProfile(nextSession: Session | null) {
      if (!nextSession?.user?.id) {
        if (mounted) {
          setSession(null);
          setProfile(null);
        }
        return;
      }

      if (mounted) {
        setSession(nextSession);
      }

      const { data } = await supabase
        .from('profiles')
        .select('name, avatar_url, credits')
        .eq('id', nextSession.user.id)
        .maybeSingle();

      if (mounted) {
        setProfile({
          name: data?.name ?? null,
          avatar_url: data?.avatar_url ?? null,
          credits: typeof data?.credits === 'number' ? data.credits : null,
        });
      }
    }

    supabase.auth.getSession().then(({ data }) => {
      void loadProfile(data.session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      void loadProfile(nextSession);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  useEffect(() => {
    function refreshCredits() {
      const userId = session?.user?.id;
      if (!userId) return;

      supabase
        .from('profiles')
        .select('credits')
        .eq('id', userId)
        .maybeSingle()
        .then(({ data }) => {
          if (typeof data?.credits === 'number') {
            setProfile((current) => ({
              ...(current ?? { name: null, avatar_url: null }),
              credits: data.credits,
            }));
          }
        });
    }

    window.addEventListener('credits_updated', refreshCredits);
    return () => window.removeEventListener('credits_updated', refreshCredits);
  }, [session?.user?.id]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setAccountOpen(false);
    router.push('/login');
  };

  if (!session) {
    return <AppShellAccountFallback />;
  }

  return (
    <>
      <Link
        href="/pricing"
        className="hidden items-center gap-2 rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-sm font-semibold text-violet-100 shadow-lg shadow-violet-500/10 transition hover:bg-violet-500/15 sm:inline-flex"
      >
        <Sparkles className="h-4 w-4" />
        <span>{credits} Credits</span>
      </Link>

      <div className="relative" ref={accountMenuRef}>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] p-1 pr-2 transition hover:bg-white/[0.08]"
          onClick={() => setAccountOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={accountOpen}
        >
          <AccountAvatar session={session} profile={profile} />
          <ChevronDown className="hidden h-4 w-4 text-zinc-500 sm:block" />
        </button>

        {accountOpen ? (
          <div
            role="menu"
            className="absolute right-0 top-12 z-50 w-64 overflow-hidden rounded-2xl border border-white/10 bg-[#101013] p-2 shadow-2xl shadow-black/40"
          >
            <div className="flex items-center gap-3 border-b border-white/10 px-2 pb-3 pt-1">
              <AccountAvatar session={session} profile={profile} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{displayName}</p>
                <p className="truncate text-xs text-zinc-500">{session.user.email}</p>
              </div>
            </div>
            <Link
              href="/profile"
              onClick={() => setAccountOpen(false)}
              className="mt-2 flex items-center justify-between rounded-xl px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-white/[0.05] hover:text-white"
            >
              Profile
              <span className="text-xs text-zinc-500">{credits} credits</span>
            </Link>
            <button
              type="button"
              onClick={handleSignOut}
              className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-zinc-300 hover:bg-white/[0.05] hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
