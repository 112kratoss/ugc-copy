import { NextRequest, NextResponse } from 'next/server';
import { createClient, isAuthRetryableFetchError, type User } from '@supabase/supabase-js';
import { routeIdentityPolicyForPathname } from '@/lib/route-identity-policy';
import {
  IDENTITY_ADMISSION_HEADER,
  IDENTITY_PROXY_TIMING_HEADER,
  signIdentityAdmission,
} from '@/lib/identity-admission-assertion';

type ProxyIdentityClaims = Record<string, unknown>;

type ProxyIdentityClient = {
  auth: {
    getClaims: (jwt: string) => Promise<{
      data: { claims: ProxyIdentityClaims } | null;
      error: unknown;
    }>;
  };
  rpc: (name: string) => Promise<{ data: unknown; error: unknown }>;
};

export type ProxyIdentityDependencies = {
  createUserClient?: (authorization: string) => ProxyIdentityClient;
  signIdentityAdmission?: typeof signIdentityAdmission;
};

type ProxyIdentityAdmission = {
  assertion: string | null;
  durationMs: number;
  verifyMs: number;
  lifecycleMs: number;
  rejection: NextResponse | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function createProxyIdentityClient(authorization: string): ProxyIdentityClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: { headers: { Authorization: authorization } },
    },
  ) as unknown as ProxyIdentityClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bearerToken(authorization: string): string | null {
  const match = authorization.match(/^Bearer\s+(\S+)$/iu);
  return match?.[1] ?? null;
}

function identityRejection(status: 401 | 403 | 409 | 503, code: string, error: string) {
  return NextResponse.json({ error, code }, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

function unauthorizedRejection() {
  return identityRejection(401, 'UNAUTHORIZED', 'Unauthorized');
}

function identityUnavailableRejection() {
  return identityRejection(
    503,
    'IDENTITY_CHECK_UNAVAILABLE',
    'Identity verification is temporarily unavailable. Please try again.',
  );
}

/**
 * Shared admission for policy-listed authenticated API routes.
 *
 * Admission uses only the caller's JWT and anon key, and one network round
 * trip. The token's signature and expiry are verified locally: the project
 * signs JWTs with an asymmetric key (ES256), so `getClaims()` checks the
 * signature through WebCrypto against a JWKS cached per instance, and only
 * falls back to a GoTrue call if the project were ever moved back to a
 * symmetric secret. Everything GoTrue's `/user` round trip used to establish
 * beyond the signature — that the account still exists, that the token's
 * session was not revoked, that the account is not banned — is answered by the
 * zero-argument `current_identity_admission()` RPC together with the durable
 * lifecycle state and `created_at`, the one field a JWT does not carry. The RPC
 * can inspect only auth.uid() and its own claims, so this stays an
 * authoritative lifecycle check without putting the service-role credential at
 * the edge.
 *
 * Successful admission is passed to the route in a short-lived HMAC assertion
 * bound to this exact bearer token, method and path. Route adapters verify that
 * assertion and fall back to their own Auth/lifecycle checks when it is absent
 * or invalid.
 */
export async function evaluateUserFacingRouteIdentity(
  request: NextRequest,
  dependencies: ProxyIdentityDependencies = {},
): Promise<ProxyIdentityAdmission> {
  const startedAt = performance.now();
  let verifyMs = 0;
  let lifecycleMs = 0;
  const result = (
    rejection: NextResponse | null,
    assertion: string | null = null,
  ): ProxyIdentityAdmission => ({
    assertion,
    durationMs: performance.now() - startedAt,
    verifyMs,
    lifecycleMs,
    rejection,
  });
  const policy = routeIdentityPolicyForPathname(request.nextUrl.pathname);
  if (!policy || policy === 'service') return result(null);

  // Public routes stay public when no token is supplied. If a caller does send
  // a bearer token, however, it must still be a live identity: otherwise an
  // optional-auth endpoint can turn a spent guest token into a service-role
  // mutation or signing capability.
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) return result(null);
  const token = bearerToken(authorization);
  if (!token) return result(unauthorizedRejection());

  try {
    const client = (dependencies.createUserClient ?? createProxyIdentityClient)(authorization);

    const verifyStartedAt = performance.now();
    const { data: verified, error: verifyError } = await client.auth.getClaims(token);
    verifyMs = performance.now() - verifyStartedAt;
    if (verifyError || !verified?.claims) {
      // A signing-key fetch that failed on the network is an outage on our
      // side, not a bad token; a signature, expiry or parse failure is.
      return result(isAuthRetryableFetchError(verifyError)
        ? identityUnavailableRejection()
        : unauthorizedRejection());
    }
    const { claims } = verified;
    const userId = typeof claims.sub === 'string' && UUID_PATTERN.test(claims.sub)
      ? claims.sub
      : null;
    if (!userId || claims.role !== 'authenticated') {
      return result(unauthorizedRejection());
    }

    const lifecycleStartedAt = performance.now();
    const { data: admission, error: admissionError } = await client.rpc('current_identity_admission');
    lifecycleMs = performance.now() - lifecycleStartedAt;
    if (admissionError) return result(identityUnavailableRejection());
    // NULL means the account no longer exists (or is soft-deleted): a still
    // valid token for a deleted user is refused, as GoTrue would have.
    if (admission === null) return result(unauthorizedRejection());
    if (!isRecord(admission)) return result(identityUnavailableRejection());
    if (admission.session_valid !== true || admission.banned === true) {
      return result(unauthorizedRejection());
    }

    const state = admission.state;
    if (state !== 'active' && state !== 'merged' && state !== 'deleting') {
      return result(identityUnavailableRejection());
    }

    if (state === 'merged') {
      return result(identityRejection(
        409,
        'SESSION_MERGED',
        'This guest session has been linked to an account. Sign in to continue.',
      ));
    }

    if (state === 'deleting') {
      return result(identityRejection(
        409,
        'ACCOUNT_DELETING',
        'This account is being permanently deleted.',
      ));
    }

    const isAnonymous = claims.is_anonymous === true;
    if (policy === 'registered' && isAnonymous) {
      return result(identityRejection(
        403,
        'REGISTRATION_REQUIRED',
        'Create an account to use this feature.',
      ));
    }

    // Built field by field from the verified claims plus the RPC's created_at,
    // the same way the server render path rebuilds its user (F8): nothing here
    // comes from a caller-controlled object.
    const user: User = {
      id: userId,
      aud: typeof claims.aud === 'string' ? claims.aud : 'authenticated',
      role: 'authenticated',
      email: typeof claims.email === 'string' ? claims.email : undefined,
      phone: typeof claims.phone === 'string' ? claims.phone : undefined,
      is_anonymous: isAnonymous,
      app_metadata: isRecord(claims.app_metadata) ? claims.app_metadata : {},
      user_metadata: isRecord(claims.user_metadata) ? claims.user_metadata : {},
      created_at: typeof admission.created_at === 'string' ? admission.created_at : '',
    };

    let assertion: string | null = null;
    try {
      assertion = await (dependencies.signIdentityAdmission ?? signIdentityAdmission)({
        authorization,
        method: request.method,
        pathname: request.nextUrl.pathname,
        state: 'active',
        user,
      });
    } catch {
      assertion = null;
    }
    if (!assertion) {
      // Safe rolling/configuration fallback: the route receives no trusted
      // assertion and therefore repeats its existing Auth/lifecycle boundary.
      // Production health still degrades while the signing key is absent.
      return result(null);
    }
    return result(null, assertion);
  } catch {
    return result(identityUnavailableRejection());
  }
}

export async function guardUserFacingRouteIdentity(
  request: NextRequest,
  dependencies: ProxyIdentityDependencies = {},
): Promise<NextResponse | null> {
  return (await evaluateUserFacingRouteIdentity(request, dependencies)).rejection;
}

export function createAdmittedIdentityHeaders(
  request: NextRequest,
  admission: ProxyIdentityAdmission,
  timingPrefix: 'proxy' | 'route' = 'proxy',
): Headers {
  const requestHeaders = new Headers(request.headers);
  // Never let a caller supply an internal assertion or timing value. Only fresh
  // admission may add them to the request forwarded to a route.
  requestHeaders.delete(IDENTITY_ADMISSION_HEADER);
  requestHeaders.delete(IDENTITY_PROXY_TIMING_HEADER);
  if (admission.assertion) {
    requestHeaders.set(IDENTITY_ADMISSION_HEADER, admission.assertion);
  }
  const performanceMonitorMode = request.headers.get('x-performance-monitor');
  const timingEnabled = process.env.SCALING_CERTIFICATION_TIMINGS === '1'
    || Boolean(request.headers.get('Authorization'))
      && (performanceMonitorMode === 'warmup' || performanceMonitorMode === 'load');
  if (timingEnabled) {
    // The total plus its two network-facing phases, so the production monitor
    // can tell a slow signing-key fetch from a slow lifecycle lookup.
    requestHeaders.set(
      IDENTITY_PROXY_TIMING_HEADER,
      [
        `${timingPrefix}-identity;dur=${admission.durationMs.toFixed(2)}`,
        `${timingPrefix}-verify;dur=${admission.verifyMs.toFixed(2)}`,
        `${timingPrefix}-lifecycle;dur=${admission.lifecycleMs.toFixed(2)}`,
      ].join(', '),
    );
  }
  return requestHeaders;
}

