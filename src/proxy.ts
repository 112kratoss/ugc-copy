import { NextRequest, NextResponse } from 'next/server';
import { createClient, isAuthRetryableFetchError, type User } from '@supabase/supabase-js';

import {
  ADMIN_SESSION_COOKIE,
  resolveAdminSessionSecret,
  verifyAdminSessionToken,
} from '@/lib/admin-session-token';
import {
  MOBILE_CLIENT_COMPATIBILITY_POLICY,
  createMobileCompatibilityResponseHeaders,
  evaluateMobileClientCompatibility,
  isIdentifiedMobileClient,
} from '@/lib/mobile-client-compatibility';
import {
  E2E_AUTH_COOKIE_NAME,
  hasE2EAuthCookie,
  isE2EAuthBypassEnabled,
} from '@/lib/e2e-auth';
import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';
import { routeIdentityPolicyForPathname } from '@/lib/route-identity-policy';
import {
  IDENTITY_ADMISSION_HEADER,
  IDENTITY_PROXY_TIMING_HEADER,
  signIdentityAdmission,
} from '@/lib/identity-admission-assertion';
import mobileApiOperationsV1 from '../contracts/mobile-api-operations-v1.json';

/**
 * Admin paths reachable without a session: the login screen itself and the
 * endpoint that mints the session. Everything else under /admin and
 * /api/admin is gated here *and* re-checked inside each route, because
 * middleware is a convenience layer rather than the security boundary.
 */
const ADMIN_PUBLIC_PATHS = new Set(['/admin/login', '/api/admin/session']);

export function isAdminPath(pathname: string) {
  return pathname === '/admin'
    || pathname.startsWith('/admin/')
    || pathname === '/api/admin'
    || pathname.startsWith('/api/admin/');
}

export function isPublicAdminPath(pathname: string) {
  return ADMIN_PUBLIC_PATHS.has(pathname);
}

async function guardAdminRequest(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  const verification = await verifyAdminSessionToken(
    request.cookies.get(ADMIN_SESSION_COOKIE)?.value,
    { secret: resolveAdminSessionSecret(), now: new Date() },
  );

  if (verification.valid) {
    const response = NextResponse.next();
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return response;
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, {
      status: 401,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/admin/login';
  loginUrl.search = '';
  // Only same-site paths are echoed back, so the redirect cannot be used as an
  // open redirect to an attacker-controlled origin.
  if (pathname !== '/admin') {
    loginUrl.searchParams.set('next', pathname);
  }
  return NextResponse.redirect(loginUrl);
}

const mobileCorsRouteTemplates = [
  ...Object.values(mobileApiOperationsV1.operations),
  ...mobileApiOperationsV1.fallbackRoutes,
].map((route) => route.path);

const mobileCorsAllowedHeaders = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
  'If-None-Match',
  'X-Request-Id',
  'X-Magicbooklet-Client',
  'X-Magicbooklet-App-Version',
  'X-Magicbooklet-Api-Version',
  'X-Magicbooklet-Catalog-Schema-Version',
  'X-Magicbooklet-Installation-Id',
].join(', ');

const mobileCorsExposedHeaders = [
  'X-Request-Id',
  'X-Magicbooklet-Api-Version',
  'X-Magicbooklet-Min-Api-Version',
  'X-Magicbooklet-Min-App-Version',
  'X-Magicbooklet-Catalog-Schema-Version',
  'ETag',
].join(', ');

function getConfiguredSiteOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

function isLocalDevelopmentOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * Native mobile clients send no Origin header, so they never need
 * Access-Control-Allow-Origin. Browsers only get the header back when the
 * request comes from the site's own origin (or localhost during development);
 * any other origin receives no CORS grant at all.
 */
function resolveAllowedCorsOrigin(request: NextRequest): string | null {
  const origin = request.headers.get('origin')?.trim();
  if (!origin) return null;

  if (origin === getConfiguredSiteOrigin()) return origin;
  if (process.env.NODE_ENV !== 'production' && isLocalDevelopmentOrigin(origin)) return origin;

  return null;
}

function buildMobileCorsHeaders(request: NextRequest): Record<string, string> {
  const allowedOrigin = resolveAllowedCorsOrigin(request);

  return {
    'Access-Control-Allow-Headers': mobileCorsAllowedHeaders,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
    'Access-Control-Expose-Headers': mobileCorsExposedHeaders,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
    ...createMobileCompatibilityResponseHeaders(),
  };
}

export function isRootAuthCodeRedirect(request: NextRequest) {
  return request.nextUrl.pathname === '/' && request.nextUrl.searchParams.has('code');
}

function hasSignedInHomeHint(request: NextRequest): boolean {
  if (hasSupabaseAuthCookie(request.headers.get('cookie') ?? '')) {
    return true;
  }

  return isE2EAuthBypassEnabled()
    && hasE2EAuthCookie(request.cookies.get(E2E_AUTH_COOKIE_NAME)?.value);
}

/**
 * Splits `/` between the statically prerendered marketing page (cookie-less
 * traffic, SEO bots) and the signed-in dashboard served from `/home`.
 *
 * Cookie presence is only a routing hint, never authentication: the rewritten
 * page re-verifies with getServerAuthState() and renders the marketing
 * experience itself when the session turns out to be invalid — a redirect
 * back to `/` would loop through this same rewrite.
 *
 * `/home` is an internal rewrite target only; direct hits bounce to `/` so it
 * never becomes a second public URL for the same content.
 */
export function resolveRootHomeRouting(request: NextRequest): NextResponse | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }

  const { pathname } = request.nextUrl;

  if (pathname === '/home') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  if (pathname !== '/' || !hasSignedInHomeHint(request)) {
    return null;
  }

  const url = request.nextUrl.clone();
  url.pathname = '/home';
  const response = NextResponse.rewrite(url);
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export function isMobileCorsPath(pathname: string) {
  const pathnameParts = pathname.split('/').filter(Boolean);
  return mobileCorsRouteTemplates.some((template) => {
    const templateParts = template.split('/').filter(Boolean);
    return templateParts.length === pathnameParts.length
      && templateParts.every((part, index) => part.startsWith(':') || part === pathnameParts[index]);
  });
}

function applyMobileCorsHeaders(request: NextRequest, response: NextResponse) {
  for (const [key, value] of Object.entries(buildMobileCorsHeaders(request))) {
    response.headers.set(key, value);
  }
  return response;
}

function applyMobileCompatibilityHeaders(response: NextResponse) {
  for (const [key, value] of Object.entries(createMobileCompatibilityResponseHeaders())) {
    response.headers.set(key, value);
  }
  return response;
}

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

type ProxyIdentityDependencies = {
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
 * Central admission for every policy-listed authenticated API route.
 *
 * The proxy uses only the caller's JWT and anon key, and one network round
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
async function evaluateUserFacingRouteIdentity(
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

function createAdmittedNextResponse(
  request: NextRequest,
  admission: ProxyIdentityAdmission,
): NextResponse {
  const requestHeaders = new Headers(request.headers);
  // Never let a caller supply an internal assertion or timing value. Only this
  // proxy may add them to the request forwarded to a route.
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
        `proxy-identity;dur=${admission.durationMs.toFixed(2)}`,
        `proxy-verify;dur=${admission.verifyMs.toFixed(2)}`,
        `proxy-lifecycle;dur=${admission.lifecycleMs.toFixed(2)}`,
      ].join(', '),
    );
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export async function proxy(
  request: NextRequest,
  identityDependencies: ProxyIdentityDependencies = {},
): Promise<NextResponse> {
  // Admin traffic is resolved before the mobile compatibility gate: the admin
  // console is a browser-only surface and must never be version-gated or
  // CORS-exposed alongside the mobile API.
  const { pathname } = request.nextUrl;
  if (isAdminPath(pathname)) {
    return isPublicAdminPath(pathname)
      ? NextResponse.next()
      : guardAdminRequest(request);
  }

  if (isRootAuthCodeRedirect(request)) {
    const callbackUrl = request.nextUrl.clone();
    callbackUrl.pathname = '/auth/callback';
    return NextResponse.redirect(callbackUrl);
  }

  const isMobilePath = isMobileCorsPath(request.nextUrl.pathname);
  const compatibility = evaluateMobileClientCompatibility(request.headers);
  const isCompatibilityPolicyRequest = request.nextUrl.pathname === '/api/app-version';
  if (!isCompatibilityPolicyRequest && !compatibility.allowed) {
    return NextResponse.json({
      code: compatibility.code,
      error: compatibility.message,
      compatibility: MOBILE_CLIENT_COMPATIBILITY_POLICY,
    }, {
      status: compatibility.status,
      headers: {
        ...(isMobilePath ? buildMobileCorsHeaders(request) : createMobileCompatibilityResponseHeaders()),
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const homeRouting = resolveRootHomeRouting(request);
  if (homeRouting) {
    return homeRouting;
  }

  if (request.method === 'OPTIONS') {
    return isMobilePath || isIdentifiedMobileClient(request.headers)
      ? new NextResponse(null, {
        headers: buildMobileCorsHeaders(request),
        status: 204,
      })
      : NextResponse.next();
  }

  // Identity lifecycle admission applies to ordinary web requests as well as
  // identified mobile traffic. Keep it ahead of the mobile-only early return
  // so a stale merged/deleting JWT cannot reach a route adapter on the web.
  const identityAdmission = await evaluateUserFacingRouteIdentity(
    request,
    identityDependencies,
  );
  if (identityAdmission.rejection) {
    return isMobilePath
      ? applyMobileCorsHeaders(request, identityAdmission.rejection)
      : applyMobileCompatibilityHeaders(identityAdmission.rejection);
  }

  const admittedResponse = createAdmittedNextResponse(
    request,
    identityAdmission,
  );

  if (!isMobilePath && !isIdentifiedMobileClient(request.headers)) {
    return admittedResponse;
  }

  return isMobilePath
    ? applyMobileCorsHeaders(request, admittedResponse)
    : applyMobileCompatibilityHeaders(admittedResponse);
}

export const config = {
  // `/admin` is listed separately from `/admin/:path*` so the bare index route
  // is gated too, regardless of how the matcher expands optional segments.
  matcher: ['/', '/home', '/api/:path*', '/admin', '/admin/:path*'],
};
