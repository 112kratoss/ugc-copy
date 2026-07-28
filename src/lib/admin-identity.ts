import { parseAdminPasswordHash } from '@/lib/admin-password';
import { resolveAdminSessionSecret } from '@/lib/admin-session-token';

/**
 * Single choke point for "who is the admin".
 *
 * Today this resolves one master operator from the environment. When per-person
 * admin accounts arrive, only this module and its callers' `AdminIdentity`
 * consumers change — moderation, credit grants, and audit writes already read
 * the reviewer id from here rather than from a hand-typed CLI flag.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 5 * 60;
const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;

export type AdminIdentity = {
  subject: string;
  username: string;
  /**
   * A real `auth.users.id`. `moderation_reports.reviewed_by` and
   * `post_reports.reviewed_by` are foreign keys into `auth.users`, so admin
   * actions cannot be attributed to a synthetic id.
   */
  reviewerUserId: string;
};

export type AdminConfig = {
  configured: boolean;
  issues: string[];
  username: string | null;
  passwordHash: string | null;
  sessionSecret: string | null;
  reviewerUserId: string | null;
  sessionTtlSeconds: number;
};

function resolveSessionTtlSeconds(environment: NodeJS.ProcessEnv): number {
  const raw = environment.ADMIN_SESSION_TTL_SECONDS?.trim();
  if (!raw) return DEFAULT_SESSION_TTL_SECONDS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_SESSION_TTL_SECONDS || parsed > MAX_SESSION_TTL_SECONDS) {
    return DEFAULT_SESSION_TTL_SECONDS;
  }
  return parsed;
}

export function resolveAdminConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AdminConfig {
  const issues: string[] = [];

  const username = environment.ADMIN_USERNAME?.trim() || null;
  if (!username) {
    issues.push('ADMIN_USERNAME is not set.');
  }

  const passwordHash = environment.ADMIN_PASSWORD_HASH?.trim() || null;
  if (!passwordHash) {
    issues.push('ADMIN_PASSWORD_HASH is not set.');
  } else if (!parseAdminPasswordHash(passwordHash)) {
    issues.push('ADMIN_PASSWORD_HASH is not a valid scrypt hash. Regenerate it with `npm run admin:credentials`.');
  }

  const sessionSecret = resolveAdminSessionSecret(environment);
  if (!sessionSecret) {
    issues.push('ADMIN_SESSION_SECRET is missing or shorter than 32 characters.');
  }

  const reviewerUserId = environment.ADMIN_REVIEWER_USER_ID?.trim() || null;
  if (!reviewerUserId) {
    issues.push('ADMIN_REVIEWER_USER_ID is not set.');
  } else if (!UUID_PATTERN.test(reviewerUserId)) {
    issues.push('ADMIN_REVIEWER_USER_ID must be the UUID of a real Supabase auth user.');
  }

  return {
    configured: issues.length === 0,
    issues,
    username,
    passwordHash,
    sessionSecret,
    reviewerUserId: reviewerUserId && UUID_PATTERN.test(reviewerUserId) ? reviewerUserId : null,
    sessionTtlSeconds: resolveSessionTtlSeconds(environment),
  };
}

export function resolveAdminIdentity(
  subject: string,
  environment: NodeJS.ProcessEnv = process.env,
): AdminIdentity | null {
  const config = resolveAdminConfig(environment);
  if (!config.configured || !config.username || !config.reviewerUserId) {
    return null;
  }

  return {
    subject,
    username: config.username,
    reviewerUserId: config.reviewerUserId,
  };
}
