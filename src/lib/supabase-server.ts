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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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

  // Reads the cookie only — no network. The `user` it carries is decoded from
  // storage the client controls, so it is not trustworthy until the token it
  // came from has been verified below.
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError || !session) {
    return unauthenticatedServerState();
  }

  // F8: verification without the GoTrue round trip.
  //
  // This project signs JWTs with asymmetric keys (ES256, JWKS published at
  // /auth/v1/.well-known/jwks.json), so `getClaims()` verifies the signature
  // locally through WebCrypto against a JWKS it caches, rather than asking the
  // auth server on every authenticated render. If the project were ever moved
  // back to a symmetric secret, `getClaims()` falls back to a server call by
  // itself — the same round trip this replaces, so the degradation is safe
  // rather than a silent loss of verification.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;

  if (claimsError || !claims) {
    return unauthenticatedServerState();
  }

  const claimedUserId = typeof claims.sub === 'string' ? claims.sub : null;
  if (!claimedUserId) {
    return unauthenticatedServerState();
  }

  // Built from the verified token alone, field by field, rather than by
  // spreading the cookie's user object.
  //
  // The previous implementation never read `session.user` at all, because
  // `getUser()` returned an independently verified user and the cookie copy was
  // pure risk with no upside. That invariant is kept here: everything below
  // comes from claims the signature covers, so a cookie pairing a genuine token
  // with a hand-written user object naming someone else cannot influence any
  // field. `created_at` is the one thing the JWT does not carry, and it is left
  // empty rather than guessed — no caller reads it, and an empty string is
  // visibly absent where a fabricated timestamp would look authoritative.
  const user: User = {
    id: claimedUserId,
    aud: typeof claims.aud === 'string' ? claims.aud : 'authenticated',
    role: typeof claims.role === 'string' ? claims.role : undefined,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    phone: typeof claims.phone === 'string' ? claims.phone : undefined,
    is_anonymous: claims.is_anonymous === true,
    app_metadata: isRecord(claims.app_metadata) ? claims.app_metadata : {},
    user_metadata: isRecord(claims.user_metadata) ? claims.user_metadata : {},
    created_at: '',
  };

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
