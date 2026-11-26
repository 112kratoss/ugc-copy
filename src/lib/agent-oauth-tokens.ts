import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { APP_AGENT_ACCESS_TOKEN_PREFIX } from './agent-token';

/**
 * The secrets of the app's own authorization server (`docs/archive/agent-token-broker-plan-2026-11-26.md`):
 * how each is made, how it is stored, how two are compared, and how long each lasts.
 *
 * Every secret is 256 random bits behind a prefix that says what it is. Only its hash is stored,
 * base64url(SHA-256(value)): the values carry their full entropy, so a plain fast hash is the
 * right one (a slow password hash guards a guessable secret, which these are not), and it is the
 * form Supabase Auth keeps a client secret in, so the clients copied from it at the cutover kept
 * their secrets.
 */

export const AGENT_ACCESS_TOKEN_PREFIX = APP_AGENT_ACCESS_TOKEN_PREFIX;
export const AGENT_REFRESH_TOKEN_PREFIX = 'mbrt_';
export const AGENT_AUTHORIZATION_CODE_PREFIX = 'mbac_';
/** The `authorization_id` the consent page carries: a handle for the request, not a credential. */
export const AGENT_AUTHORIZATION_ID_PREFIX = 'mbar_';
/** The one-time token the consent page is rendered with, for the account it was rendered for. */
export const AGENT_CONSENT_TOKEN_PREFIX = 'mbct_';
export const AGENT_CLIENT_SECRET_PREFIX = 'mbcs_';

/** An access token's life: the hour a Supabase session's token had. */
export const AGENT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A refresh token's life from its issue; each use replaces it, so this is how long a grant may sit unused. */
export const AGENT_REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
/** From approval to the token endpoint: the client's redirect and one request. */
export const AGENT_AUTHORIZATION_CODE_TTL_SECONDS = 2 * 60;
/** From `/oauth/authorize` to the answer on the consent page, a sign-in in between included. */
export const AGENT_AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
/**
 * How long after its first use a refresh token may be used again without ending the grant: two
 * processes sharing one stored token (two Claude Code sessions) refresh at the same moment
 * honestly. Past it, a second use means the token was copied, and the grant is revoked.
 */
export const AGENT_REFRESH_REUSE_GRACE_SECONDS = 10;

const SECRET_BODY = '[A-Za-z0-9_-]{43}';

export function mintAgentSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** Whether a value has the shape `mintAgentSecret(prefix)` produces; nothing else is ever looked up. */
export function isAgentSecret(value: unknown, prefix: string): value is string {
  return typeof value === 'string'
    && value.startsWith(prefix)
    && new RegExp(`^${SECRET_BODY}$`, 'u').test(value.slice(prefix.length));
}

/** base64url(SHA-256(value)): 43 characters, the only form a secret is stored in. */
export function hashAgentSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/**
 * Whether two strings are equal, in time that does not depend on where they differ. Both are
 * hashed first so the comparison is over equal lengths whatever was sent.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** RFC 7636: 43 to 128 unreserved characters. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_CHALLENGE_PATTERN = new RegExp(`^${SECRET_BODY}$`, 'u');

export function isCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && CODE_VERIFIER_PATTERN.test(value);
}

/** An S256 challenge: base64url of a SHA-256 digest, 43 characters, no padding. */
export function isCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && CODE_CHALLENGE_PATTERN.test(value);
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Whether a verifier answers the challenge the authorization request carried (S256 only). */
export function verifierMatchesChallenge(verifier: string, challenge: string): boolean {
  return isCodeVerifier(verifier) && constantTimeEqual(codeChallengeS256(verifier), challenge);
}
