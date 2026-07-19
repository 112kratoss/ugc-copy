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

const mobileCorsHeaders = {
  'Access-Control-Allow-Headers': mobileCorsAllowedHeaders,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': mobileCorsExposedHeaders,
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
  ...createMobileCompatibilityResponseHeaders(),
};

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

function applyMobileCorsHeaders(response: NextResponse) {
  for (const [key, value] of Object.entries(mobileCorsHeaders)) {
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
        ...(isMobilePath ? mobileCorsHeaders : createMobileCompatibilityResponseHeaders()),
        'Cache-Control': 'private, no-store',
      },
    });
  }

  if (!isMobilePath && !isIdentifiedMobileClient(request.headers)) {
    return NextResponse.next();
  }

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      headers: mobileCorsHeaders,
      status: 204,
    });
  }

  return isMobilePath
    ? applyMobileCorsHeaders(NextResponse.next())
    : applyMobileCompatibilityHeaders(NextResponse.next());
}

export const config = {
  matcher: ['/', '/api/:path*'],
};
