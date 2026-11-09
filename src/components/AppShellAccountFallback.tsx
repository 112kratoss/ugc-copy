'use client';

import { Crown } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useReducer, useSyncExternalStore } from 'react';

import { WELCOME_CREDITS_SHOWN } from '@/lib/onboarding';
import { useWelcomePromise } from '@/lib/welcome-promise';

/**
 * Where the header's "Sign in" brings the visitor back to: the page they were
 * on, with its query, so signing in from a post, a creator or Pricing does not
 * land on Home. The sign-in pages themselves return to Home.
 */
export function signInReturnPath(pathname: string | null, search: string): string {
  if (!pathname?.startsWith('/') || pathname.startsWith('//')) return '/';
  const isAuthPage = pathname === '/login'
    || pathname.startsWith('/login/')
    || pathname === '/auth'
    || pathname.startsWith('/auth/');
  if (isAuthPage) return '/';
  const query = search.replace(/^\?/, '');
  return query ? `${pathname}?${query}` : pathname;
}

function subscribeToHistory(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}
const readSearch = () => window.location.search;
// A statically rendered page has no query on the server; the browser fills it in.
const readServerSearch = () => '';

export default function AppShellAccountFallback({ pathname: shellPathname }: { pathname?: string }) {
  const routePathname = usePathname();
  // The shell's pathname when it passes one. It is the neutral '' wherever the
  // header must match HTML drawn for another address (the not-found page at
  // every address, `/` before mounting), and '' returns Home, as the server
  // wrote it: React never patches an attribute that hydrates differently.
  const pathname = shellPathname ?? routePathname;
  const search = useSyncExternalStore(subscribeToHistory, readSearch, readServerSearch);
  // The router changes the query with history.pushState, which no event
  // reports, and the header does not re-render for a new query alone: reaching
  // for the link renders it again with the address bar's query. (useSearchParams
  // would need a Suspense boundary around the header on every static page.)
  const [, rereadSearch] = useReducer((count: number) => count + 1, 0);
  // Just "Sign in" once an account has signed in on this browser (owner, 2026-11-09).
  const welcomePromise = useWelcomePromise();

  // In place of a balance a visitor does not have: the welcome credits, and the page that gets
  // them, as the app's Home says it (owner, 2026-11-08; `home-dashboard.tsx`). The words are
  // read as one name, "Sign in for 25 free credits", which the dot does not say. The promise is
  // `.welcome-promise-only`: hidden from the first paint where it was spent (`welcome-promise.ts`).
  return (
    <Link
      href={`/login?returnUrl=${encodeURIComponent(signInReturnPath(pathname, search))}`}
      prefetch={false}
      onPointerEnter={rereadSearch}
      onPointerDown={rereadSearch}
      onFocus={rereadSearch}
      aria-label={welcomePromise ? `Sign in for ${WELCOME_CREDITS_SHOWN} free credits` : 'Sign in'}
      className="ui-focus-ring inline-flex min-h-12 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-surface-3)] active:scale-[0.985]"
    >
      <Crown aria-hidden className="app-shell-sign-in-crown h-4 w-4 shrink-0 text-[var(--ui-accent-commerce)]" fill="currentColor" fillOpacity={0.2} />
      <span>Sign in</span>
      {welcomePromise ? (
        <span className="welcome-promise-only inline-flex items-center gap-1.5">
          <span aria-hidden className="text-[var(--ui-text-faint)]">·</span>
          <span className="font-extrabold text-[var(--ui-primary)]">
            {WELCOME_CREDITS_SHOWN}
            {/* A narrow phone's bar keeps "25 free" (`.app-shell-sign-in-credits` in globals.css). */}
            {' free'}
            <span className="app-shell-sign-in-credits"> credits</span>
          </span>
        </span>
      ) : null}
    </Link>
  );
}
