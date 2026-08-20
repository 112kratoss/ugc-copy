import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { resolveAdminConfig, resolveAdminIdentity, type AdminIdentity } from '@/lib/admin-identity';
import {
  ADMIN_SESSION_COOKIE,
  deriveAdminCredentialVersion,
  verifyAdminSessionToken,
} from '@/lib/admin-session-token';
import { isAdminSessionActive } from '@/lib/admin-session-store';
import { createServiceClient } from '@/lib/server-helpers';

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
  | { authenticated: false; reason: 'unconfigured' | 'unauthenticated' | 'unavailable' };

type AdminAuthOptions = {
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  /** Test seam; production always uses the service-role client. */
  sessionClient?: SupabaseClient;
};

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
  sessionClient?: SupabaseClient,
): Promise<AdminAuthResult> {
  const config = resolveAdminConfig(environment);
  if (!config.configured || !config.sessionSecret || !config.passwordHash) {
    return { authenticated: false, reason: 'unconfigured' };
  }

  const verification = await verifyAdminSessionToken(token, {
    secret: config.sessionSecret,
    now,
  });
  if (!verification.valid) {
    return { authenticated: false, reason: 'unauthenticated' };
  }

  const currentCredentialVersion = await deriveAdminCredentialVersion({
    secret: config.sessionSecret,
    passwordHash: config.passwordHash,
  });
  if (verification.payload.cv !== currentCredentialVersion) {
    return { authenticated: false, reason: 'unauthenticated' };
  }

  let active: boolean;
  try {
    active = await isAdminSessionActive(sessionClient ?? createServiceClient(), {
      sessionId: verification.payload.sid,
      subject: verification.payload.sub,
      credentialVersion: currentCredentialVersion,
      now,
    });
  } catch {
    // The database row is authoritative. Treating an unavailable lookup as an
    // active session would turn a dependency outage into an auth bypass.
    return { authenticated: false, reason: 'unavailable' };
  }
  if (!active) {
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
  options: AdminAuthOptions = {},
): Promise<AdminAuthResult> {
  return authenticateToken(
    readCookieFromRequest(request, ADMIN_SESSION_COOKIE),
    options.environment ?? process.env,
    options.now ?? new Date(),
    options.sessionClient,
  );
}

/** For Server Components, which read the cookie store directly. */
export async function authenticateAdminPage(
  options: AdminAuthOptions = {},
): Promise<AdminAuthResult> {
  const cookieStore = await cookies();
  return authenticateToken(
    cookieStore.get(ADMIN_SESSION_COOKIE)?.value ?? null,
    options.environment ?? process.env,
    options.now ?? new Date(),
    options.sessionClient,
  );
}

/**
 * Throws when called outside an authenticated admin context. Admin pages call
 * this after the layout has already redirected, so reaching the throw means a
 * routing bug rather than an expected unauthenticated visit.
 */
export async function requireAdminIdentity(
  options: AdminAuthOptions = {},
): Promise<AdminIdentity> {
  const result = await authenticateAdminPage(options);
  if (!result.authenticated) {
    throw new Error(`Admin identity is unavailable (${result.reason}).`);
  }
  return result.identity;
}
