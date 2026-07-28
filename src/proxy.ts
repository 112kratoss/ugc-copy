import { NextRequest, NextResponse } from 'next/server';

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

export function proxy(request: NextRequest): NextResponse | Promise<NextResponse> {
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

  if (!isMobilePath && !isIdentifiedMobileClient(request.headers)) {
    return NextResponse.next();
  }

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      headers: buildMobileCorsHeaders(request),
      status: 204,
    });
  }

  return isMobilePath
    ? applyMobileCorsHeaders(request, NextResponse.next())
    : applyMobileCompatibilityHeaders(NextResponse.next());
}

export const config = {
  // `/admin` is listed separately from `/admin/:path*` so the bare index route
  // is gated too, regardless of how the matcher expands optional segments.
  matcher: ['/', '/api/:path*', '/admin', '/admin/:path*'],
};
