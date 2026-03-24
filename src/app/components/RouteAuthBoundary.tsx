import { redirect } from 'next/navigation';

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

export async function OptionalAuth({
  children,
}: {
  children: React.ReactNode;
}) {
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
