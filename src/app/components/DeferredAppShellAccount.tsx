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

export default function DeferredAppShellAccount() {
  const shouldLoadAccount = useSupabaseAuthCookieHint();
  const hasHydratedCookieHint = useHasHydratedSupabaseAuthCookieHint();

  useEffect(() => {
    if (hasHydratedCookieHint && !shouldLoadAccount) {
      publishAppShellAuthentication(false);
    }
  }, [hasHydratedCookieHint, shouldLoadAccount]);

  return shouldLoadAccount ? <AppShellAccount /> : <AppShellAccountFallback />;
}
