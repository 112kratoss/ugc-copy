'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, LogOut, Menu, Sparkles, X } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';

import { getAuthAvatarUrl, getCreatorDisplayName, getUserInitials } from '@/lib/profile';
import { supabase } from '@/lib/supabase';

const COMMUNITY_LINKS = [
  { href: '/showcase', label: 'Community' },
  { href: '/marketplace', label: 'Unlocks' },
  { href: '/blog', label: 'Blog' },
];

const AUTH_COMMUNITY_LINKS = [...COMMUNITY_LINKS, { href: '/post/new', label: 'Share Post' }];
const PUBLIC_LINKS = [...COMMUNITY_LINKS, { href: '/pricing', label: 'Pricing' }];

const ACCOUNT_LINKS = [
  { href: '/profile', label: 'Profile', description: 'Manage your creator identity' },
  { href: '/creations', label: 'My Studio', description: 'Manage creations, posts, and unlocks' },
  { href: '/marketplace/sell', label: 'Seller Dashboard', description: 'Track unlocks, links, and sales' },
  { href: '/pricing', label: 'Credits & Pricing', description: 'Top up or manage credits' },
];

interface NavbarProfileState {
  credits: number | null;
  avatarUrl: string | null;
  displayName: string | null;
  username: string | null;
}

function AccountAvatar({
  imageUrl,
  name,
  size = 'md',
}: {
  imageUrl: string | null;
  name: string;
  size?: 'md' | 'lg';
}) {
  const sizeClass = size === 'lg' ? 'h-11 w-11 text-sm' : 'h-9 w-9 text-xs';

  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={`${name} avatar`}
        className={`${sizeClass} rounded-full border border-white/10 object-cover`}
      />
    );
  }

  return (
    <div
      className={`${sizeClass} flex items-center justify-center rounded-full border border-white/10 bg-white/5 font-semibold text-zinc-100`}
      aria-hidden="true"
    >
      {getUserInitials(name)}
    </div>
  );
}

export default function NavbarClient() {
  const router = useRouter();
  const pathname = usePathname();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<NavbarProfileState | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);

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
        setProfile(null);
        return;
      }

      const { data: profileRecord } = await supabase
        .from('profiles')
        .select('credits, avatar_url, display_name, username')
        .eq('id', resolvedSession.user.id)
        .maybeSingle();

      if (!isActive) {
        return;
      }

      setProfile({
        credits: profileRecord?.credits ?? null,
        avatarUrl: profileRecord?.avatar_url ?? null,
        displayName: profileRecord?.display_name ?? null,
        username: profileRecord?.username ?? null,
      });
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
        setProfile((current) =>
          current
            ? { ...current, credits: customEvent.detail.credits ?? null }
            : current
        );
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

  useEffect(() => {
    const closeMenus = () => {
      setIsAccountMenuOpen(false);
      setIsMobileMenuOpen(false);
    };

    closeMenus();
  }, [pathname]);

  useEffect(() => {
    if (!isAccountMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsAccountMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAccountMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAccountMenuOpen]);

  const isActivePath = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const handleLogout = async () => {
    setIsAccountMenuOpen(false);
    setIsMobileMenuOpen(false);
    await supabase.auth.signOut();
    router.push('/');
    router.refresh();
  };

  const user = session?.user ?? null;
  const credits = profile?.credits ?? null;
  const visibleLinks = user ? AUTH_COMMUNITY_LINKS : PUBLIC_LINKS;
  const mobileLinks = visibleLinks;
  const isCreatePath =
    pathname === '/create' || pathname.startsWith('/create-') || pathname.startsWith('/create/');

  const authMetadata = (user?.user_metadata ?? null) as Record<string, unknown> | null;
  const authMetadataName =
    typeof authMetadata?.full_name === 'string'
      ? authMetadata.full_name
      : typeof authMetadata?.name === 'string'
        ? authMetadata.name
        : null;
  const accountName = useMemo(
    () =>
      getCreatorDisplayName({
        displayName: profile?.displayName ?? authMetadataName,
        username: profile?.username,
        email: user?.email ?? null,
      }),
    [authMetadataName, profile?.displayName, profile?.username, user?.email]
  );

  const accountAvatarUrl = useMemo(
    () => profile?.avatarUrl ?? getAuthAvatarUrl(authMetadata),
    [authMetadata, profile?.avatarUrl]
  );

  const accountSecondaryLabel = profile?.username
    ? `@${profile.username}`
    : user?.email ?? 'Creator account';

  return (
    <>
      <div className="hidden items-center gap-5 sm:flex">
        <nav className="flex items-center gap-5">
          {visibleLinks.map((link) => {
            const isActive = isActivePath(link.href);

            return (
              <Link
                key={link.href}
                href={link.href}
                prefetch={link.href === '/create-workflow' || link.href === '/create-video' ? false : undefined}
                className={`relative py-1 text-sm font-medium transition-colors ${
                  isActive ? 'text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {link.label}
                <span
                  className={`absolute inset-x-0 -bottom-1 h-0.5 rounded-full bg-[var(--ui-primary)] transition-opacity ${
                    isActive ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              </Link>
            );
          })}
        </nav>

        <div className="h-5 w-px bg-white/[0.08]" />

        <div className="flex items-center gap-3">
          {user ? (
            <>
              <Link
                href="/create"
                className={`ui-focus-ring rounded-full border px-4 py-2 text-sm font-extrabold transition-all ${
                  isCreatePath
                    ? 'border-transparent bg-[var(--ui-primary-strong)] text-[var(--ui-primary-on)]'
                    : 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]'
                }`}
              >
                Create
              </Link>

              {credits !== null ? (
                <Link
                  href="/pricing"
                  className="ui-focus-ring group relative rounded-full border border-amber-300/25 bg-amber-400/10 transition-colors hover:border-amber-300/40 hover:bg-amber-400/15"
                >
                  <span className="flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-bold text-amber-100">
                    <Sparkles className="h-4 w-4 text-amber-300" />
                    {credits} Credits
                  </span>
                </Link>
              ) : null}

              <div ref={menuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsAccountMenuOpen((current) => !current)}
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-1.5 text-sm text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                  aria-haspopup="menu"
                  aria-expanded={isAccountMenuOpen}
                  title="Open account menu"
                >
                  <AccountAvatar imageUrl={accountAvatarUrl} name={accountName} />
                  <ChevronDown
                    className={`mr-1 h-4 w-4 text-zinc-400 transition-transform ${
                      isAccountMenuOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {isAccountMenuOpen ? (
                  <div className="absolute right-0 top-[calc(100%+0.75rem)] z-50 w-72 overflow-hidden rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(22,22,28,0.98),rgba(10,10,14,0.98))] p-2 shadow-[0_32px_80px_-40px_rgba(0,0,0,0.95)] backdrop-blur-xl">
                    <div className="flex items-center gap-3 rounded-[18px] border border-white/6 bg-white/[0.03] p-3">
                      <AccountAvatar imageUrl={accountAvatarUrl} name={accountName} size="lg" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-white">
                          {accountName}
                        </div>
                        <div className="truncate text-xs text-zinc-400">
                          {accountSecondaryLabel}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2 space-y-1">
                      {ACCOUNT_LINKS.map((link) => (
                        <Link
                          key={link.href}
                          href={link.href}
                          onClick={() => setIsAccountMenuOpen(false)}
                          className="block rounded-[18px] px-3 py-3 transition hover:bg-white/[0.04]"
                        >
                          <div className="text-sm font-medium text-white">{link.label}</div>
                          <div className="mt-0.5 text-xs text-zinc-400">{link.description}</div>
                        </Link>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="mt-2 flex w-full items-center gap-2 rounded-[18px] px-3 py-3 text-left text-sm font-medium text-zinc-300 transition hover:bg-white/[0.04] hover:text-white"
                    >
                      <LogOut className="h-4 w-4" />
                      Log out
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <Link
              href="/login?returnUrl=/create"
              className="ui-focus-ring rounded-full bg-[var(--ui-primary)] px-5 py-2 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
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
            className="ui-focus-ring rounded-full border border-amber-300/25 bg-amber-400/10 px-3 py-1.5 text-sm font-bold text-amber-100"
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
          <div className="flex flex-col gap-5 px-6 py-5">
            {user ? (
              <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-center gap-3">
                  <AccountAvatar imageUrl={accountAvatarUrl} name={accountName} size="lg" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{accountName}</div>
                    <div className="truncate text-xs text-zinc-400">{accountSecondaryLabel}</div>
                  </div>
                </div>

                <div className="mt-4 space-y-1">
                  {ACCOUNT_LINKS.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      prefetch={link.href === '/create-video' ? false : undefined}
                      onClick={() => setIsMobileMenuOpen(false)}
                      className="block rounded-[16px] px-3 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.05] hover:text-white"
                    >
                      {link.label}
                    </Link>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      void handleLogout();
                    }}
                    className="flex w-full items-center gap-2 rounded-[16px] px-3 py-2.5 text-left text-sm font-medium text-zinc-200 transition hover:bg-white/[0.05] hover:text-white"
                  >
                    <LogOut className="h-4 w-4" />
                    Log out
                  </button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-4">
              <Link
                href={user ? '/create' : '/login?returnUrl=/create'}
                onClick={() => setIsMobileMenuOpen(false)}
                className="ui-focus-ring rounded-2xl bg-[var(--ui-primary)] px-4 py-3 text-center text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
              >
                {user ? 'Create' : 'Start Creating'}
              </Link>

              <div className="h-px w-full bg-white/[0.08]" />

              {mobileLinks.map((link) => (
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
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
