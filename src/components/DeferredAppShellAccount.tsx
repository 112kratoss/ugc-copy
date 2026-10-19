'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';

import AppShellAccountFallback from './AppShellAccountFallback';
import { publishAppShellAuthentication } from './app-shell-auth-state';
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
 * server draws: the account itself loads in the browser only.
 */
export default function DeferredAppShellAccount({ pathname }: { pathname?: string }) {
  const shouldLoadAccount = useSupabaseAuthCookieHint();
  const hasHydratedCookieHint = useHasHydratedSupabaseAuthCookieHint();

  useEffect(() => {
    if (hasHydratedCookieHint && !shouldLoadAccount) {
      publishAppShellAuthentication(false);
    }
  }, [hasHydratedCookieHint, shouldLoadAccount]);

  return shouldLoadAccount ? <AppShellAccount /> : <AppShellAccountFallback pathname={pathname} />;
}
