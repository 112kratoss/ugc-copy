import 'server-only';

import { cache } from 'react';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import {
  E2E_AUTH_COOKIE_NAME,
  E2E_AUTH_CREDITS,
  createE2ESession,
  hasE2EAuthCookie,
  isE2EAuthBypassEnabled,
} from '@/lib/e2e-auth';
import { createServiceClient } from '@/lib/server-helpers';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

async function createServerSupabaseClient(cookieStore?: CookieStore) {
  const resolvedCookieStore = cookieStore ?? await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return resolvedCookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              resolvedCookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot always set auth cookies.
          }
        },
      },
    }
  );
}

export interface ServerAuthState {
  session: Session | null;
  credits: number | null;
}

function getE2EAuthState(cookieStore: CookieStore): ServerAuthState | null {
  if (!isE2EAuthBypassEnabled()) {
    return null;
  }

  const e2eCookie = cookieStore.get(E2E_AUTH_COOKIE_NAME);
  if (!hasE2EAuthCookie(e2eCookie?.value)) {
    return null;
  }

  return {
    session: createE2ESession(),
    credits: E2E_AUTH_CREDITS,
  };
}

export const getServerAuthState = cache(async (): Promise<ServerAuthState> => {
  const cookieStore = await cookies();
  const e2eAuthState = getE2EAuthState(cookieStore);
  if (e2eAuthState) {
    return e2eAuthState;
  }

  const supabase = await createServerSupabaseClient(cookieStore);
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    return {
      session: null,
      credits: null,
    };
  }

  const adminSupabase = createServiceClient();
  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('credits')
    .eq('id', session.user.id)
    .maybeSingle();

  return {
    session,
    credits: profile?.credits ?? null,
  };
});
