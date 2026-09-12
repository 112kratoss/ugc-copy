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

export async function RequestHintedOptionalAuth({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const hasAuthHint = hasSupabaseAuthCookie(
    cookieStore.getAll().map(({ name }) => `${name}=1`).join(';')
  );
  const hasE2EHint = isE2EAuthBypassEnabled()
    && hasE2EAuthCookie(cookieStore.get(E2E_AUTH_COOKIE_NAME)?.value);

  if (!hasAuthHint && !hasE2EHint) {
    return children;
  }

  const auth = await getServerAuthState();
  return (
    <AuthProvider
      initialSession={auth.session}
      initialCredits={auth.credits}
      hasResolvedInitialState
    >
      {children}
    </AuthProvider>
  );
}
