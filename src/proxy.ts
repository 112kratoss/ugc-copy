import { NextRequest, NextResponse } from 'next/server';

const mobileCorsPathPrefixes = [
  '/api/generate',
  '/api/generate-image',
  '/api/generate-video',
  '/api/generations',
  '/api/marketplace/resources',
  '/api/mobile/commerce',
  '/api/posts',
  '/api/profile',
  '/api/showcase/feed',
  '/api/showcase/posts',
  '/api/showcase/publish',
  '/api/showcase/remix',
  '/api/showcase/save',
  '/api/showcase/share',
];

const mobileCorsHeaders = {
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
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

export function proxy(request: NextRequest) {
  if (isRootAuthCodeRedirect(request)) {
    const callbackUrl = request.nextUrl.clone();
    callbackUrl.pathname = '/auth/callback';
    return NextResponse.redirect(callbackUrl);
  }

  if (!isMobileCorsPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      headers: mobileCorsHeaders,
      status: 204,
    });
  }

  return applyMobileCorsHeaders(NextResponse.next());
}

export const config = {
  matcher: ['/', '/api/:path*'],
};
