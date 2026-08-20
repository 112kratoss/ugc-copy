import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { resolveAdminConfig } from '@/lib/admin-identity';
import { verifyAdminPassword } from '@/lib/admin-password';
import {
  ADMIN_MASTER_SUBJECT,
  ADMIN_SESSION_COOKIE,
  createAdminSessionId,
  createAdminSessionToken,
  deriveAdminCredentialVersion,
  resolveAdminSessionSecret,
  verifyAdminSessionToken,
} from '@/lib/admin-session-token';
import { insertAdminSession, revokeAdminSession } from '@/lib/admin-session-store';
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

type AdminSessionRouteDependencies = {
  createServiceClient?: () => SupabaseClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  verifyAdminPassword?: typeof verifyAdminPassword;
  createSessionId?: typeof createAdminSessionId;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
};

function resolveDependencies(dependencies: AdminSessionRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    verifyAdminPassword: dependencies?.verifyAdminPassword ?? verifyAdminPassword,
    createSessionId: dependencies?.createSessionId ?? createAdminSessionId,
    environment: dependencies?.environment ?? process.env,
    now: dependencies?.now ?? (() => new Date()),
  };
}

/**
 * Every failure path returns this one message. Distinguishing "no such user"
 * from "wrong password" would confirm the admin username to an attacker, and
 * the operator already knows which field they mistyped.
 */
const GENERIC_LOGIN_FAILURE = 'Incorrect username or password.';

function buildSessionCookieOptions(maxAgeSeconds: number, environment: NodeJS.ProcessEnv) {
  return {
    name: ADMIN_SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    // `lax` rather than `strict` so following an /admin link from an external
    // tab still arrives authenticated; the admin surface performs no
    // cross-site state change on GET.
    secure: environment.NODE_ENV === 'production',
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

export async function postAdminSessionResponse(
  request: Request,
  dependencies?: AdminSessionRouteDependencies,
): Promise<NextResponse> {
  const resolved = resolveDependencies(dependencies);
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const requestId = getApiRequestId(request);
  const config = resolveAdminConfig(resolved.environment);

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
    await resolved.enforceBackendRateLimit(resolved.createServiceClient(), {
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
  const passwordMatches = await resolved.verifyAdminPassword(credentials.password, config.passwordHash);

  if (!usernameMatches || !passwordMatches) {
    logBackendRouteError(JSON.stringify({
      level: 'warn',
      msg: 'admin_login_rejected',
      requestId,
    }));
    return NextResponse.json({ error: GENERIC_LOGIN_FAILURE }, { status: 401, headers });
  }

  const issuedAt = resolved.now();
  const sessionId = resolved.createSessionId();
  const credentialVersion = await deriveAdminCredentialVersion({
    secret: config.sessionSecret as string,
    passwordHash: config.passwordHash as string,
  });
  const token = await createAdminSessionToken({
    secret: config.sessionSecret as string,
    subject: ADMIN_MASTER_SUBJECT,
    sessionId,
    credentialVersion,
    issuedAt,
    ttlSeconds: config.sessionTtlSeconds,
  });

  try {
    await insertAdminSession(resolved.createServiceClient(), {
      sessionId,
      subject: ADMIN_MASTER_SUBJECT,
      credentialVersion,
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + config.sessionTtlSeconds * 1000),
    });
  } catch (error) {
    logBackendRouteError(JSON.stringify({
      level: 'error',
      msg: 'admin_session_create_failed',
      requestId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return NextResponse.json(
      { error: 'Admin session storage is unavailable.' },
      { status: 503, headers },
    );
  }

  const response = NextResponse.json(
    { ok: true, expiresInSeconds: config.sessionTtlSeconds },
    { status: 200, headers },
  );
  response.cookies.set({
    ...buildSessionCookieOptions(config.sessionTtlSeconds, resolved.environment),
    value: token,
  });
  return response;
}

export async function deleteAdminSessionResponse(
  request: Request,
  dependencies?: AdminSessionRouteDependencies,
): Promise<NextResponse> {
  const resolved = resolveDependencies(dependencies);
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const requestId = getApiRequestId(request);
  const verification = await verifyAdminSessionToken(
    readCookieFromRequest(request, ADMIN_SESSION_COOKIE),
    {
      secret: resolveAdminSessionSecret(resolved.environment),
      now: resolved.now(),
    },
  );

  if (verification.valid) {
    try {
      await revokeAdminSession(
        resolved.createServiceClient(),
        verification.payload.sid,
        resolved.now(),
      );
    } catch (error) {
      // Do not clear a still-authoritative cookie when revocation could not be
      // confirmed. The operator can retry once the database recovers.
      logBackendRouteError(JSON.stringify({
        level: 'error',
        msg: 'admin_session_revoke_failed',
        requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return NextResponse.json(
        { error: 'Sign out could not be completed.' },
        { status: 503, headers },
      );
    }
  }

  const response = NextResponse.json({ ok: true }, { status: 200, headers });
  response.cookies.set({ ...buildSessionCookieOptions(0, resolved.environment), value: '' });
  return response;
}

function readCookieFromRequest(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) continue;
    if (part.slice(0, separatorIndex).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separatorIndex + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function createAdminSessionRouteHandlers(dependencies?: AdminSessionRouteDependencies) {
  return {
    POST(request: Request) {
      return postAdminSessionResponse(request, dependencies);
    },
    DELETE(request: Request) {
      return deleteAdminSessionResponse(request, dependencies);
    },
  };
}
