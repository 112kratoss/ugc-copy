'use client';

import type { Session } from '@supabase/supabase-js';
import { ChevronDown, Gift, LogOut, Sparkles } from 'lucide-react';
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
import { publishAppShellAuthentication } from './app-shell-auth-state';

type ProfileSummary = {
  display_name: string | null;
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
    displayName: profile?.display_name ?? null,
    email: session?.user?.email ?? null,
  });
  const initials = getUserInitials(label);
  const className = size === 'sm' ? 'h-8 w-8 text-xs' : 'h-9 w-9 text-sm';

  if (avatarUrl) {
    return (
      <span
        aria-hidden="true"
        className={`${className} rounded-full border border-[var(--ui-border-default)] bg-cover bg-center`}
        style={{ backgroundImage: `url(${avatarUrl})` }}
      />
    );
  }

  return (
    <span
      className={`${className} inline-flex items-center justify-center rounded-full border border-[rgba(255,122,89,0.35)] bg-[var(--ui-primary-soft)] font-extrabold text-[var(--ui-primary-strong)]`}
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
  const credits = profile?.credits;
  const displayName = getCreatorDisplayName({
    displayName: profile?.display_name ?? null,
    email: session?.user?.email ?? null,
  });

  useEffect(() => {
    let mounted = true;

    async function loadProfile(nextSession: Session | null) {
      publishAppShellAuthentication(Boolean(nextSession?.user?.id));
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
        .select('display_name, avatar_url, credits')
        .eq('id', nextSession.user.id)
        .maybeSingle();

      if (mounted) {
        setProfile({
          display_name: data?.display_name ?? null,
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
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setAccountOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
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
              ...(current ?? { display_name: null, avatar_url: null }),
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
    publishAppShellAuthentication(false);
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
        className="ui-focus-ring hidden min-h-12 items-center gap-2 rounded-full border border-amber-300/20 bg-amber-400/10 px-3 text-sm font-bold text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-400/15 sm:inline-flex"
      >
        <Sparkles className="h-4 w-4" />
        <span>{typeof credits === 'number' ? `${credits} credits` : 'Credits'}</span>
      </Link>

      <div className="relative" ref={accountMenuRef}>
        <button
          type="button"
          className="ui-focus-ring flex min-h-12 items-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] p-1 pr-2 transition hover:bg-[var(--ui-surface-3)]"
          onClick={() => setAccountOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={accountOpen}
          aria-label={`Open account menu for ${displayName}`}
        >
          <AccountAvatar session={session} profile={profile} />
          <ChevronDown className="hidden h-4 w-4 text-zinc-500 sm:block" />
        </button>

        {accountOpen ? (
          <div
            role="menu"
            aria-label="Account"
            className="absolute right-0 top-14 z-50 w-64 overflow-hidden rounded-3xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-2 shadow-2xl shadow-black/40"
          >
            <div className="flex items-center gap-3 border-b border-white/10 px-2 pb-3 pt-1">
              <AccountAvatar session={session} profile={profile} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{displayName}</p>
                <p className="truncate text-xs text-zinc-500">{session.user.email}</p>
              </div>
            </div>
            <Link
              href="/invite"
              role="menuitem"
              onClick={() => setAccountOpen(false)}
              className="ui-focus-ring mt-2 flex min-h-12 items-center justify-between rounded-2xl px-3 py-2 text-sm font-bold text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
            >
              <span className="flex items-center gap-2">
                <Gift className="h-4 w-4 text-amber-300" aria-hidden />
                Invite &amp; Earn
              </span>
              <span className="text-xs text-amber-200/75">Earn credits</span>
            </Link>
            <Link
              href="/profile"
              role="menuitem"
              onClick={() => setAccountOpen(false)}
              className="ui-focus-ring mt-1 flex min-h-11 items-center justify-between rounded-2xl px-3 py-2 text-sm font-bold text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
            >
              Profile
              <span className="text-xs text-[var(--ui-text-faint)]">
                {typeof credits === 'number' ? `${credits} credits` : 'View account'}
              </span>
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={handleSignOut}
              className="ui-focus-ring mt-1 flex min-h-11 w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm font-bold text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
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
