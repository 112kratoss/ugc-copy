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
import { getMarketplaceSpendableCredits } from '@/lib/profile';
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
  /**
   * The part of `credits` a recipe can be bought with: welcome and referral
   * credits count in the total, and the credit unlock will not spend them.
   * The provider starts from it because a server-rendered page never reads
   * the profile again. Null or absent when unknown.
   */
  marketplaceSpendableCredits?: number | null;
  /** The profile's display name, when the row was read with the session. */
  displayName?: string | null;
  /**
   * The profile's handle, absent when the row was not read. With the display
   * name it says whether a public post can go out under them, so the post
   * composer asks for the two before publishing without a read of its own.
   */
  username?: string | null;
  /**
   * Whether the account has been told, on record, that creators can see who
   * saved its posts (`profiles.saver_notice_seen_at`): the web's saver notice
   * starts from it, so a page load never asks for it on its own. Absent when
   * the row was not read.
   */
  saverNoticeSeen?: boolean;
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
    // The E2E identity holds no welcome or referral credits.
    marketplaceSpendableCredits: E2E_AUTH_CREDITS,
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
    .select('credits, promotional_credits, display_name, saver_notice_seen_at, username')
    .eq('id', user.id)
    .maybeSingle();
  const credits: number | null = profile?.credits ?? null;

  return {
    session: createVerifiedSession(session, user),
    credits,
    marketplaceSpendableCredits: getMarketplaceSpendableCredits(credits, profile?.promotional_credits),
    displayName: typeof profile?.display_name === 'string' ? profile.display_name : null,
    ...(profile ? { saverNoticeSeen: typeof profile.saver_notice_seen_at === 'string' } : {}),
    ...(profile ? { username: typeof profile.username === 'string' ? profile.username : null } : {}),
  };
});

/**
 * The handle and name the post composer judges public-publish readiness by,
 * or null when the profile row was not read with the session (then the
 * composer reads it itself).
 */
export function getServerPublicIdentity(
  auth: ServerAuthState,
): { username: string | null; displayName: string | null } | null {
  return auth.username === undefined ? null : { username: auth.username, displayName: auth.displayName ?? null };
}
