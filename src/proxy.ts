import { NextRequest, NextResponse } from 'next/server';

import {
  MOBILE_CLIENT_COMPATIBILITY_POLICY,
  createMobileCompatibilityResponseHeaders,
  evaluateMobileClientCompatibility,
  isIdentifiedMobileClient,
} from '@/lib/mobile-client-compatibility';

const mobileCorsPathPrefixes = [
  '/api/generate',
  '/api/generate-image',
  '/api/generate-video',
  '/api/app-version',
  '/api/credits',
  '/api/enhance-prompt',
  '/api/generation-models',
  '/api/generations',
  '/api/marketplace/resources',
  '/api/mobile/commerce',
  '/api/mobile/notifications',
  '/api/onboarding',
  '/api/posts',
  '/api/profile',
  '/api/referrals',
  '/api/showcase/feed',
  '/api/showcase/posts',
  '/api/showcase/publish',
  '/api/showcase/remix',
  '/api/showcase/save',
  '/api/showcase/saved-media',
  '/api/showcase/share',
  '/api/source-tools',
  '/api/uploads/media',
];

const mobileCorsAllowedHeaders = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
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
  return mobileCorsPathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
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
