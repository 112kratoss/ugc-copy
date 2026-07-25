import { NextRequest, NextResponse } from 'next/server';

import {
  MOBILE_CLIENT_COMPATIBILITY_POLICY,
  createMobileCompatibilityResponseHeaders,
  evaluateMobileClientCompatibility,
  isIdentifiedMobileClient,
} from '@/lib/mobile-client-compatibility';
import mobileApiOperationsV1 from '../contracts/mobile-api-operations-v1.json';

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

export function proxy(request: NextRequest) {
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
  matcher: ['/', '/api/:path*'],
};
