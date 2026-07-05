import 'server-only';

import { cache } from 'react';
import { createServerClient } from '@supabase/ssr';
import type { Session, User } from '@supabase/supabase-js';
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

function unauthenticatedServerState(): ServerAuthState {
  return {
    session: null,
    credits: null,
  };
}

function createVerifiedSession(session: Session, user: User): Session {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: session.token_type,
    provider_token: session.provider_token,
    provider_refresh_token: session.provider_refresh_token,
    user,
  };
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
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return unauthenticatedServerState();
  }

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError || !session) {
    return unauthenticatedServerState();
  }

  const adminSupabase = createServiceClient();
  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('credits')
    .eq('id', user.id)
    .maybeSingle();

  return {
    session: createVerifiedSession(session, user),
    credits: profile?.credits ?? null,
  };
});
