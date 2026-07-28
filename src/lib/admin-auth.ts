import 'server-only';

import { cookies } from 'next/headers';

import { resolveAdminConfig, resolveAdminIdentity, type AdminIdentity } from '@/lib/admin-identity';
import {
  ADMIN_SESSION_COOKIE,
  verifyAdminSessionToken,
} from '@/lib/admin-session-token';

/**
 * Server-side admin gate for route handlers and Server Components.
 *
 * `src/proxy.ts` already rejects unauthenticated `/admin` and `/api/admin`
 * traffic at the edge, but middleware is a convenience layer, not the security
 * boundary: every admin route re-verifies here so a matcher mistake cannot
 * expose data.
 */

export type AdminAuthResult =
  | { authenticated: true; identity: AdminIdentity }
  | { authenticated: false; reason: 'unconfigured' | 'unauthenticated' };

function readCookieFromRequest(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) continue;
    if (part.slice(0, separatorIndex).trim() === name) {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    }
  }
  return null;
}

async function authenticateToken(
  token: string | null,
  environment: NodeJS.ProcessEnv,
  now: Date,
): Promise<AdminAuthResult> {
  const config = resolveAdminConfig(environment);
  if (!config.configured) {
    return { authenticated: false, reason: 'unconfigured' };
  }

  const verification = await verifyAdminSessionToken(token, {
    secret: config.sessionSecret,
    now,
  });
  if (!verification.valid) {
    return { authenticated: false, reason: 'unauthenticated' };
  }

  const identity = resolveAdminIdentity(verification.payload.sub, environment);
  if (!identity) {
    return { authenticated: false, reason: 'unconfigured' };
  }

  return { authenticated: true, identity };
}

/** For API route handlers, which read the cookie off the incoming `Request`. */
export async function authenticateAdminRequest(
  request: Request,
  options: { environment?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<AdminAuthResult> {
  return authenticateToken(
    readCookieFromRequest(request, ADMIN_SESSION_COOKIE),
    options.environment ?? process.env,
    options.now ?? new Date(),
  );
}

/** For Server Components, which read the cookie store directly. */
export async function authenticateAdminPage(
  options: { environment?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<AdminAuthResult> {
  const cookieStore = await cookies();
  return authenticateToken(
    cookieStore.get(ADMIN_SESSION_COOKIE)?.value ?? null,
    options.environment ?? process.env,
    options.now ?? new Date(),
  );
}

/**
 * Throws when called outside an authenticated admin context. Admin pages call
 * this after the layout has already redirected, so reaching the throw means a
 * routing bug rather than an expected unauthenticated visit.
 */
export async function requireAdminIdentity(
  options: { environment?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<AdminIdentity> {
  const result = await authenticateAdminPage(options);
  if (!result.authenticated) {
    throw new Error(`Admin identity is unavailable (${result.reason}).`);
  }
  return result.identity;
}
