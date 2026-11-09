'use client';

import dynamic from 'next/dynamic';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { isWelcomePopupOfferedAt, readWelcomeReturn, type WelcomeReturn } from '@/lib/welcome-credits-popup';

import { readAppShellAuthentication, subscribeToAppShellAuthentication } from './app-shell-auth-state';

const WelcomeCreditsGate = dynamic(() => import('./WelcomeCreditsGate'), { ssr: false, loading: () => null });

/**
 * The welcome-credits popup's place in the root layout, beside the
 * generation notifications: drawn on every page, so it costs a visitor
 * nothing. It reads the flags a return from sign-up put on the address
 * (`welcome=1`, with the invite's outcome), remembers the page, and takes them
 * off the address; and it loads the gate, which asks the server, only once the
 * shell has a signed-in account on a page that offers the popup. Once loaded
 * the gate stays, so a popup in the middle of its claim outlives a Back.
 *
 * It reads the query, so the root layout draws it inside a Suspense boundary:
 * a page drawn ahead of time draws nothing here and keeps being drawn ahead.
 */
export default function DeferredWelcomeCreditsPopup() {
  const pathname = usePathname() ?? '';
  const query = useSearchParams()?.toString() ?? '';
  const flags = readWelcomeReturn(pathname, query);
  const [authenticated, setAuthenticated] = useState(() => readAppShellAuthentication() === true);
  const [returned, setReturned] = useState<WelcomeReturn | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Remembered as it is read: the flags are gone from the address a moment later.
  if (flags && (returned?.pathname !== pathname || returned.referral !== flags.referral)) {
    setReturned({ pathname, referral: flags.referral });
  }

  useEffect(() => subscribeToAppShellAuthentication(setAuthenticated), []);

  const strippedSearch = flags?.search ?? null;
  useEffect(() => {
    if (strippedSearch === null) return;
    // Through Next's own history handling (a null state), so the router keeps the address too.
    window.history.replaceState(null, '', `${pathname}${strippedSearch}${window.location.hash}`);
  }, [pathname, strippedSearch]);

  const returnedHere = returned?.pathname === pathname ? returned : null;
  const offeredHere = authenticated && isWelcomePopupOfferedAt(pathname, returnedHere?.pathname ?? null);
  if (offeredHere && !loaded) setLoaded(true);

  return loaded ? <WelcomeCreditsGate offeredHere={offeredHere} returned={returnedHere} page={pathname} /> : null;
}
