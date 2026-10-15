'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useReducer, useSyncExternalStore } from 'react';

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

export default function AppShellAccountFallback() {
  const pathname = usePathname();
  const search = useSyncExternalStore(subscribeToHistory, readSearch, readServerSearch);
  // The router changes the query with history.pushState, which no event
  // reports, and the header does not re-render for a new query alone: reaching
  // for the link renders it again with the address bar's query. (useSearchParams
  // would need a Suspense boundary around the header on every static page.)
  const [, rereadSearch] = useReducer((count: number) => count + 1, 0);

  return (
    <Link
      href={`/login?returnUrl=${encodeURIComponent(signInReturnPath(pathname, search))}`}
      prefetch={false}
      onPointerEnter={rereadSearch}
      onPointerDown={rereadSearch}
      onFocus={rereadSearch}
      className="ui-focus-ring inline-flex min-h-12 items-center justify-center rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
    >
      Sign in
    </Link>
  );
}
