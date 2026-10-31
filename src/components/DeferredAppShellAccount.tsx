'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';

import AppShellAccountFallback from './AppShellAccountFallback';
import { publishAppShellAuthentication } from './app-shell-auth-state';
import type { AppNavClickHandler } from './app-shell-nav';
import {
  useHasHydratedSupabaseAuthCookieHint,
  useSupabaseAuthCookieHint,
} from './useSupabaseAuthCookieHint';

const AppShellAccount = dynamic(() => import('./AppShellAccount'), {
  ssr: false,
  loading: () => <AppShellAccountFallback />,
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

  return shouldLoadAccount ? (
    <AppShellAccount pathname={pathname} onNavigate={onNavigate} />
  ) : (
    <AppShellAccountFallback pathname={pathname} />
  );
}
