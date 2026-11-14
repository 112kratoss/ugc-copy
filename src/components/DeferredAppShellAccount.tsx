'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';

import AppShellAccountFallback from './AppShellAccountFallback';
import AppShellAccountPending from './AppShellAccountPending';
import { publishAppShellAuthentication } from './app-shell-auth-state';
import type { AppNavClickHandler } from './app-shell-nav';
import {
  useHasHydratedSupabaseAuthCookieHint,
  useSupabaseAuthCookieHint,
} from './useSupabaseAuthCookieHint';

const AppShellAccount = dynamic(() => import('./AppShellAccount'), {
  ssr: false,
  // Only a browser with a session cookie loads the account: it waits in the signed-in shape.
  loading: () => <AppShellAccountPending />,
});

/**
 * `pathname` is the shell's own (see AppShellClient), for the Sign in link the
 * server draws: the account itself loads in the browser only. The account menu
 * takes it with the shell's `onNavigate` for its Profile row.
 */
export default function DeferredAppShellAccount({
  pathname,
  onNavigate,
}: {
  pathname?: string;
  onNavigate?: AppNavClickHandler;
}) {
  const shouldLoadAccount = useSupabaseAuthCookieHint();
  const hasHydratedCookieHint = useHasHydratedSupabaseAuthCookieHint();

  useEffect(() => {
    if (hasHydratedCookieHint && !shouldLoadAccount) {
      publishAppShellAuthentication(false);
    }
  }, [hasHydratedCookieHint, shouldLoadAccount]);

  if (!hasHydratedCookieHint) {
    // The server's HTML, and the browser's first render that adopts it. No cookie can be read on
    // a page drawn ahead of time, so both shapes are drawn and the root element's mark, set from
    // this browser's cookie before the page draws, shows one (app-shell-account-restore.ts). A
    // signed-in refresh drew "Sign in" here, then the account, and the bar moved (2026-11-14).
    // Once mounted the slot draws one shape with no mark, so a sign-out later in the visit draws
    // "Sign in" whatever the root element says. The cost, accepted: a cookie with no live session
    // behind it (signed out everywhere, a refresh token gone) draws the signed-in shape until the
    // account's check refuses it, then "Sign in", one move where every live session's refresh
    // made three (review of #811).
    return (
      <>
        <AppShellAccountFallback pathname={pathname} className="app-shell-when-signed-out" />
        <AppShellAccountPending className="app-shell-when-signed-in" />
      </>
    );
  }

  return shouldLoadAccount ? (
    <AppShellAccount pathname={pathname} onNavigate={onNavigate} />
  ) : (
    <AppShellAccountFallback pathname={pathname} />
  );
}
