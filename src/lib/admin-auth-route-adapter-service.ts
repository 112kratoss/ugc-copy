import 'server-only';

import { NextResponse } from 'next/server';

import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { resolveAdminConfig } from '@/lib/admin-identity';
import { verifyAdminPassword } from '@/lib/admin-password';
import {
  ADMIN_MASTER_SUBJECT,
  ADMIN_SESSION_COOKIE,
  createAdminSessionToken,
} from '@/lib/admin-session-token';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  ADMIN_LOGIN_RATE_LIMIT,
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getClientNetworkKey } from '@/lib/client-network-key';
import { createServiceClient } from '@/lib/server-helpers';

type LoginBody = {
  username?: unknown;
  password?: unknown;
};

/**
 * Every failure path returns this one message. Distinguishing "no such user"
 * from "wrong password" would confirm the admin username to an attacker, and
 * the operator already knows which field they mistyped.
 */
const GENERIC_LOGIN_FAILURE = 'Incorrect username or password.';

function buildSessionCookieOptions(maxAgeSeconds: number) {
  return {
    name: ADMIN_SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    // `lax` rather than `strict` so following an /admin link from an external
    // tab still arrives authenticated; the admin surface performs no
    // cross-site state change on GET.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

async function parseLoginBody(request: Request): Promise<{ username: string; password: string } | null> {
  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return null;
  }

  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password || username.length > 256 || password.length > 1024) {
    return null;
  }

  return { username, password };
}

function constantTimeStringEquals(left: string, right: string): boolean {
  // Compares every character regardless of mismatch position so username
  // length and prefix are not leaked through response timing.
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function postAdminSessionResponse(request: Request): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const requestId = getApiRequestId(request);
  const config = resolveAdminConfig();

  if (!config.configured) {
    logBackendRouteError(JSON.stringify({
      level: 'error',
      msg: 'admin_login_unconfigured',
      requestId,
      issues: config.issues,
    }));
    return NextResponse.json(
      { error: 'Admin access is not configured on this deployment.' },
      { status: 503, headers },
    );
  }

  try {
    await enforceBackendRateLimit(createServiceClient(), {
      ...ADMIN_LOGIN_RATE_LIMIT,
      key: getClientNetworkKey(request.headers),
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }
    throw error;
  }

  const credentials = await parseLoginBody(request);
  if (!credentials) {
    return NextResponse.json({ error: GENERIC_LOGIN_FAILURE }, { status: 401, headers });
  }

  const usernameMatches = constantTimeStringEquals(credentials.username, config.username ?? '');
  const passwordMatches = await verifyAdminPassword(credentials.password, config.passwordHash);

  if (!usernameMatches || !passwordMatches) {
    logBackendRouteError(JSON.stringify({
      level: 'warn',
      msg: 'admin_login_rejected',
      requestId,
    }));
    return NextResponse.json({ error: GENERIC_LOGIN_FAILURE }, { status: 401, headers });
  }

  const token = await createAdminSessionToken({
    secret: config.sessionSecret as string,
    subject: ADMIN_MASTER_SUBJECT,
    issuedAt: new Date(),
    ttlSeconds: config.sessionTtlSeconds,
  });

  const response = NextResponse.json(
    { ok: true, expiresInSeconds: config.sessionTtlSeconds },
    { status: 200, headers },
  );
  response.cookies.set({
    ...buildSessionCookieOptions(config.sessionTtlSeconds),
    value: token,
  });
  return response;
}

export function deleteAdminSessionResponse(request: Request): NextResponse {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const response = NextResponse.json({ ok: true }, { status: 200, headers });
  response.cookies.set({ ...buildSessionCookieOptions(0), value: '' });
  return response;
}

export function createAdminSessionRouteHandlers() {
  return {
    POST(request: Request) {
      return postAdminSessionResponse(request);
    },
    DELETE(request: Request) {
      return Promise.resolve(deleteAdminSessionResponse(request));
    },
  };
}
