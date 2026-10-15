'use client';

import type { Session, User } from '@supabase/supabase-js';
import { ChevronDown, Gift, History, Loader2, LogOut, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { isSessionRefusal } from '@/lib/auth-error-copy';
import {
  getAuthAvatarUrl,
  getCreatorDisplayName,
  getUserInitials,
} from '@/lib/profile';
import { supabase } from '@/lib/supabase';
import { removeSupabaseAuthCookies } from '@/lib/supabase-auth-cookie';

import AppShellAccountFallback from './AppShellAccountFallback';
import { OptimizedPreviewImage } from './OptimizedPreviewImage';
import { publishAppShellAuthentication } from './app-shell-auth-state';

type ProfileSummary = {
  display_name: string | null;
  avatar_url: string | null;
  credits: number | null;
};

/** Sign-out waits this long at most for the creators' storage to clear. */
const SIGN_OUT_CLEAR_WAIT_MS = 3000;
/** A session check Supabase could not answer is asked once more after this. */
const SESSION_RECHECK_DELAY_MS = 2000;
/** Coming back to the tab re-reads the balance at most this often. */
const CREDITS_RECHECK_INTERVAL_MS = 30_000;

/**
 * The creators keep this account's staged files and text drafts in the
 * browser; the next person to sign in here must not open them. Loaded on
 * demand so the storage library stays out of the account menu's chunk, and
 * bounded so storage that never answers cannot hold the sign-out.
 */
export async function clearCreatorDataForSignOut(userId: string) {
  const clearing = import('@/lib/persisted-media')
    .then(({ clearPersistedCreatorData }) => clearPersistedCreatorData(userId))
    .catch(() => {
      // The keys are per account, so whatever is left stays out of the next
      // account's reach; signing out goes ahead.
    });
  let timer: number | undefined;
  await Promise.race([
    clearing,
    new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, SIGN_OUT_CLEAR_WAIT_MS);
    }),
  ]);
  window.clearTimeout(timer);
}

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

  return (
    <span
      aria-hidden="true"
      className={`${className} relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[rgba(255,122,89,0.35)] bg-[var(--ui-primary-soft)] font-extrabold text-[var(--ui-primary-strong)]`}
    >
      {initials}
      {avatarUrl ? (
        <OptimizedPreviewImage
          previewSrc={avatarUrl}
          fallbackSrc={avatarUrl}
          fallbackToUnoptimized
          alt=""
          sizes={size === 'sm' ? '32px' : '36px'}
          className="object-cover"
        />
      ) : null}
    </span>
  );
}

export default function AppShellAccount() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const creditIdentityRef = useRef<{ userId: string } | null>(null);
  const credits = profile?.credits;
  const signedInUserId = session?.user?.id ?? null;
  const displayName = getCreatorDisplayName({
    displayName: profile?.display_name ?? null,
    email: session?.user?.email ?? null,
  });

  useEffect(() => {
    let mounted = true;
    let authSequence = 0;
    let acceptedAccessToken: string | null = null;
    let acceptedUserId: string | null = null;
    const pendingAccessTokens = new Set<string>();
    const queuedUserUpdates = new Map<string, Session>();
    const deferredAuthSyncIds = new Set<number>();

    function clearAccountState() {
      authSequence += 1;
      creditIdentityRef.current = null;
      acceptedAccessToken = null;
      acceptedUserId = null;
      pendingAccessTokens.clear();
      queuedUserUpdates.clear();
      deferredAuthSyncIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      deferredAuthSyncIds.clear();
      publishAppShellAuthentication(false);
      if (mounted) {
        setSession(null);
        setProfile(null);
      }
    }

    async function loadProfile(nextSession: Session | null, isRecheck = false) {
      const sequence = ++authSequence;
      if (!nextSession?.user?.id) {
        clearAccountState();
        return;
      }

      let verifiedUser: User | null = null;
      let verificationFailed = false;
      let verificationError: unknown = null;
      try {
        const { data, error } = await supabase.auth.getUser(nextSession.access_token);
        verifiedUser = data.user;
        verificationFailed = Boolean(error);
        verificationError = error;
      } catch (error) {
        verificationFailed = true;
        verificationError = error;
      } finally {
        pendingAccessTokens.delete(nextSession.access_token);
        const queuedUserUpdate = queuedUserUpdates.get(nextSession.access_token);
        if (queuedUserUpdate) {
          queuedUserUpdates.delete(nextSession.access_token);
          const timeoutId = window.setTimeout(() => {
            deferredAuthSyncIds.delete(timeoutId);
            if (mounted) {
              handleAuthChange('USER_UPDATED', queuedUserUpdate);
            }
          }, 0);
          deferredAuthSyncIds.add(timeoutId);
        }
      }

      if (!mounted || sequence !== authSequence) {
        return;
      }

      if (verificationFailed && !isSessionRefusal(verificationError)) {
        // Supabase Auth could not answer (offline, a 5xx, a rate limit), which
        // says nothing about the session: the header keeps it, without the
        // profile until a check succeeds, and asks once more.
        if (acceptedUserId !== nextSession.user.id) {
          acceptedAccessToken = null;
          acceptedUserId = null;
          setProfile(null);
        }
        publishAppShellAuthentication(true);
        setSession(nextSession);
        if (!isRecheck) {
          const timeoutId = window.setTimeout(() => {
            deferredAuthSyncIds.delete(timeoutId);
            // A newer auth event checks the current session itself.
            if (mounted && sequence === authSequence) {
              void loadProfile(nextSession, true);
            }
          }, SESSION_RECHECK_DELAY_MS);
          deferredAuthSyncIds.add(timeoutId);
        }
        return;
      }

      if (verificationFailed || !verifiedUser || verifiedUser.id !== nextSession.user.id) {
        clearAccountState();
        return;
      }

      const verifiedSession = { ...nextSession, user: verifiedUser };
      creditIdentityRef.current = { userId: verifiedUser.id };
      acceptedAccessToken = nextSession.access_token;
      acceptedUserId = verifiedUser.id;
      publishAppShellAuthentication(true);
      if (mounted) {
        setSession(verifiedSession);
      }

      const { data } = await supabase
        .from('profiles')
        .select('display_name, avatar_url, credits')
        .eq('id', verifiedUser.id)
        .maybeSingle();

      if (mounted && sequence === authSequence) {
        setProfile({
          display_name: data?.display_name ?? null,
          avatar_url: data?.avatar_url ?? null,
          credits: typeof data?.credits === 'number' ? data.credits : null,
        });
      }
    }

    function handleAuthChange(event: string, nextSession: Session | null) {
      if (!nextSession?.user?.id) {
        clearAccountState();
        return;
      }

      const accessToken = nextSession?.access_token ?? null;
      if (event === 'TOKEN_REFRESHED' && acceptedUserId === nextSession.user.id) {
        acceptedAccessToken = accessToken;
        setSession(nextSession);
        publishAppShellAuthentication(true);
        return;
      }

      if (accessToken) {
        if (pendingAccessTokens.has(accessToken)) {
          if (event === 'USER_UPDATED') {
            queuedUserUpdates.set(accessToken, nextSession);
          }
          return;
        }
        if (event !== 'USER_UPDATED' && accessToken === acceptedAccessToken) {
          return;
        }
        pendingAccessTokens.add(accessToken);
      }

      // Invalidate credit responses before deferred verification or effect cleanup.
      creditIdentityRef.current = null;
      const timeoutId = window.setTimeout(() => {
        deferredAuthSyncIds.delete(timeoutId);
        void loadProfile(nextSession);
      }, 0);
      deferredAuthSyncIds.add(timeoutId);
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      handleAuthChange(event, nextSession);
    });

    return () => {
      mounted = false;
      creditIdentityRef.current = null;
      deferredAuthSyncIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
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
    let isActive = true;

    function refreshCredits() {
      const userId = session?.user?.id;
      const identity = creditIdentityRef.current;
      if (!userId || identity?.userId !== userId) return;

      supabase
        .from('profiles')
        .select('credits')
        .eq('id', userId)
        .maybeSingle()
        .then(({ data }) => {
          if (isActive && creditIdentityRef.current === identity && typeof data?.credits === 'number') {
            // React may apply this updater after a newer account state is queued.
            setProfile((current) => creditIdentityRef.current === identity ? {
              ...(current ?? { display_name: null, avatar_url: null }),
              credits: data.credits,
            } : current);
          }
        });
    }

    window.addEventListener('credits_updated', refreshCredits);
    return () => {
      isActive = false;
      window.removeEventListener('credits_updated', refreshCredits);
    };
  }, [session?.user?.id]);

  useEffect(() => {
    if (!signedInUserId) return;
    // The balance can change while the tab is hidden: a purchase settled in
    // the app or by Razorpay's webhook after the checkout reloaded, a referral
    // reward. The header is on every page of a signed-in visitor, so coming
    // back asks every reader of the balance to read it again.
    let lastRecheckAt = Date.now();
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastRecheckAt < CREDITS_RECHECK_INTERVAL_MS) return;
      lastRecheckAt = now;
      window.dispatchEvent(new Event('credits_updated'));
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [signedInUserId]);

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    const userId = session?.user?.id;
    if (userId) {
      await clearCreatorDataForSignOut(userId);
    }
    // This browser only. The default (global) also ends the account's session
    // on the person's phone, which then has every request refused. The logout
    // call gives up after 10 s (src/lib/supabase.ts).
    const { error } = await supabase.auth.signOut({ scope: 'local' })
      .catch((thrown: unknown) => ({ error: thrown }));
    if (error) {
      // auth-js keeps the session when the logout call fails, and /login sends
      // a browser holding one straight back: on a shared computer the person
      // would walk away signed in.
      removeSupabaseAuthCookies();
    }
    creditIdentityRef.current = null;
    publishAppShellAuthentication(false);
    setSession(null);
    setProfile(null);
    setAccountOpen(false);
    setIsSigningOut(false);
    router.push('/login');
  };

  if (!session) {
    return <AppShellAccountFallback />;
  }

  return (
    <>
      <Link
        href="/pricing"
        prefetch={false}
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
              prefetch={false}
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
              prefetch={false}
              role="menuitem"
              onClick={() => setAccountOpen(false)}
              className="ui-focus-ring mt-1 flex min-h-11 items-center justify-between rounded-2xl px-3 py-2 text-sm font-bold text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
            >
              Profile
              <span className="text-xs text-[var(--ui-text-faint)]">
                {typeof credits === 'number' ? `${credits} credits` : 'View account'}
              </span>
            </Link>
            {/* Under the balance: where every credit in it came from and went. */}
            <Link
              href="/credits"
              prefetch={false}
              role="menuitem"
              onClick={() => setAccountOpen(false)}
              className="ui-focus-ring mt-1 flex min-h-11 items-center gap-2 rounded-2xl px-3 py-2 text-sm font-bold text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
            >
              <History className="h-4 w-4" aria-hidden />
              Credit history
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleSignOut()}
              disabled={isSigningOut}
              aria-busy={isSigningOut || undefined}
              className="ui-focus-ring mt-1 flex min-h-11 w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm font-bold text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)] disabled:cursor-wait disabled:opacity-70"
            >
              {isSigningOut ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              {isSigningOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
