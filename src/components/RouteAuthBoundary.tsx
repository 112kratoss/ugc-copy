import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

import {
  E2E_AUTH_COOKIE_NAME,
  hasE2EAuthCookie,
  isE2EAuthBypassEnabled,
} from '@/lib/e2e-auth';
import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';
import { getServerAuthState } from '@/lib/supabase-server';

import { AuthProvider } from './AuthProvider';

export async function RequireAuth({
  children,
  returnTo,
}: {
  children: React.ReactNode;
  returnTo: string;
}) {
  const auth = await getServerAuthState();

  if (!auth.session?.user) {
    redirect(`/login?returnUrl=${encodeURIComponent(returnTo)}`);
  }

  return (
    <AuthProvider
      initialSession={auth.session}
      initialCredits={auth.credits}
      initialMarketplaceSpendableCredits={auth.marketplaceSpendableCredits ?? null}
      initialSaverNoticeSeen={auth.saverNoticeSeen ?? null}
      hasResolvedInitialState
    >
      {children}
    </AuthProvider>
  );
}

export function OptionalAuth({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthProvider>{children}</AuthProvider>;
}

/**
 * Whether the request carries a sign-in cookie (or the E2E one): the cheap
 * signal that it may have a session. Without one it has none, and the page is
 * drawn for a signed-out visitor without asking the auth server.
 */
export async function requestHasAuthHint(): Promise<boolean> {
  const cookieStore = await cookies();
  const hasAuthHint = hasSupabaseAuthCookie(
    cookieStore.getAll().map(({ name }) => `${name}=1`).join(';')
  );
  const hasE2EHint = isE2EAuthBypassEnabled()
    && hasE2EAuthCookie(cookieStore.get(E2E_AUTH_COOKIE_NAME)?.value);
  return hasAuthHint || hasE2EHint;
}

export async function RequestHintedOptionalAuth({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await requestHasAuthHint())) {
    return children;
  }

  const auth = await getServerAuthState();
  // A resolved provider never reads the profile again, so the recipe
  // surfaces' spendable balance has to start from the server's figure.
  return (
    <AuthProvider
      initialSession={auth.session}
      initialCredits={auth.credits}
      initialMarketplaceSpendableCredits={auth.marketplaceSpendableCredits ?? null}
      initialSaverNoticeSeen={auth.saverNoticeSeen ?? null}
      hasResolvedInitialState
    >
      {children}
    </AuthProvider>
  );
}
