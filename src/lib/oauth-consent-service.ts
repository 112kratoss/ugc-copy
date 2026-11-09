import type { OAuthAuthorizationDetails, OAuthRedirect, User } from '@supabase/supabase-js';

/**
 * The consent page's decisions (`/oauth/consent`, Supabase Auth's `authorization_url_path`).
 *
 * Supabase's OAuth server sends the person's browser here with an `authorization_id` when an
 * agent (Claude, ChatGPT, Codex, Cursor) asks to act as them. The page decides who may answer
 * and what it shows; GoTrue decides nothing about the account: it would let a guest session read
 * and approve an authorization (the phase 0 spike, `docs/research/mcp-oauth-spike-2026-11-09.md`,
 * check 8), so the guest refusal is this page's, and it comes before any call with the session.
 *
 * The token an approval issues carries no permissions of its own (`scope` is `openid email`
 * class, never shown here as permissions), so the page shows the fixed list of what an agent
 * may do, and the server authorizes per tool as the signed-in creator.
 */

export const OAUTH_CONSENT_PATH = '/oauth/consent';

/** What an agent may do once connected, in the page's words. The token carries no scopes. */
export const AGENT_ACCESS = [
  {
    title: 'Create images and videos with your credits',
    detail: 'Each run spends your balance as it does on the site. The agent sees the price first and is never charged more than it confirmed.',
  },
  {
    title: 'Publish posts as you',
    detail: 'On your profile and in Explore, under your name, with the rules every post follows.',
  },
  {
    title: 'Read your creations',
    detail: 'Your library, with its prompts, settings and links. Nothing of anyone else\'s.',
  },
] as const;

/** The id GoTrue issues: URL-safe characters, 32 on the stacks seen; bounded either way. */
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function normalizeAuthorizationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return AUTHORIZATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function buildConsentPath(authorizationId: string): string {
  return `${OAUTH_CONSENT_PATH}?authorization_id=${encodeURIComponent(authorizationId)}`;
}

/**
 * Where a signed-out visitor signs in and comes back: the login page reads `next` through
 * `getSafeAuthNextPath`, which keeps the query.
 */
export function buildConsentSignInHref(authorizationId: string): string {
  return `/login?next=${encodeURIComponent(buildConsentPath(authorizationId))}`;
}

export type ConsentGate =
  | { kind: 'missing' }
  | { kind: 'sign_in'; href: string }
  | { kind: 'guest'; href: string }
  | { kind: 'account'; authorizationId: string; email: string | null };

/**
 * Who may answer this request: nobody without an `authorization_id`; a signed-out visitor
 * after signing in; never a guest (an account is what the agent acts as); the account itself.
 */
export function gateConsentRequest({
  authorizationId,
  user,
}: {
  authorizationId: unknown;
  user: Pick<User, 'is_anonymous' | 'email'> | null | undefined;
}): ConsentGate {
  const id = normalizeAuthorizationId(authorizationId);
  if (!id) return { kind: 'missing' };
  const href = buildConsentSignInHref(id);
  if (!user) return { kind: 'sign_in', href };
  if (user.is_anonymous === true) return { kind: 'guest', href };
  return { kind: 'account', authorizationId: id, email: user.email?.trim() || null };
}

export type RedirectTarget = {
  /** The host the client is sent back to, port included when it has one. */
  host: string;
  /** A loopback address: any program on the person's computer can listen there. */
  loopback: boolean;
};

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The redirect URI's host, which the MCP spec asks a consent screen to show, and whether it is local. */
export function describeRedirectTarget(redirectUri: string): RedirectTarget | null {
  try {
    const url = new URL(redirectUri);
    if (!url.host) return null;
    const hostname = url.hostname.toLowerCase();
    const loopback = LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
    return { host: url.host, loopback };
  } catch {
    return null;
  }
}

export type ConsentDetails = {
  authorizationId: string;
  clientName: string;
  /** The client's own site, shown and linked when it is an http(s) URL. */
  clientUri: string | null;
  redirectUri: string;
  redirect: RedirectTarget | null;
};

export type ConsentView =
  | { kind: 'redirect'; redirectUrl: string }
  | { kind: 'consent'; details: ConsentDetails };

type ClientResult<T> = { data: T | null; error: { message: string } | null };

/** The slice of `supabase.auth.oauth` the page uses, so a test can hand it a fake. */
export type OAuthConsentClient = {
  getAuthorizationDetails(authorizationId: string): Promise<ClientResult<OAuthAuthorizationDetails | OAuthRedirect>>;
  approveAuthorization(authorizationId: string, options: { skipBrowserRedirect: true }): Promise<ClientResult<OAuthRedirect>>;
  denyAuthorization(authorizationId: string, options: { skipBrowserRedirect: true }): Promise<ClientResult<OAuthRedirect>>;
};

export const CONSENT_UNAVAILABLE_MESSAGE =
  'This connection request has expired or was already answered. Go back to the app that asked and connect again.';
export const CONSENT_DECISION_FAILED_MESSAGE =
  'Your answer did not reach Magicbooklet. Try again, or go back to the app that asked and connect again.';

function redirectUrlOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const redirectUrl = (value as { redirect_url?: unknown }).redirect_url;
  return typeof redirectUrl === 'string' && redirectUrl.trim() ? redirectUrl : null;
}

function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * What the page shows for an authorization: the client's redirect when the account has already
 * consented to this client (GoTrue answers an `OAuthRedirect`, and the page follows it without a
 * click), or the details to decide on.
 */
export async function loadConsentView(
  client: OAuthConsentClient,
  authorizationId: string,
): Promise<{ ok: true; view: ConsentView } | { ok: false; message: string }> {
  const { data, error } = await client.getAuthorizationDetails(authorizationId);
  if (error || !data) return { ok: false, message: CONSENT_UNAVAILABLE_MESSAGE };
  const redirectUrl = redirectUrlOf(data);
  if (redirectUrl) return { ok: true, view: { kind: 'redirect', redirectUrl } };
  const details = data as OAuthAuthorizationDetails;
  if (typeof details.redirect_uri !== 'string' || !details.client) {
    return { ok: false, message: CONSENT_UNAVAILABLE_MESSAGE };
  }
  const clientName = typeof details.client.name === 'string' && details.client.name.trim()
    ? details.client.name.trim()
    : 'An app';
  return {
    ok: true,
    view: {
      kind: 'consent',
      details: {
        authorizationId,
        clientName,
        clientUri: httpUrlOrNull(details.client.uri),
        redirectUri: details.redirect_uri,
        redirect: describeRedirectTarget(details.redirect_uri),
      },
    },
  };
}

export type ConsentDecision = 'approve' | 'deny';

/**
 * The account's answer, sent to GoTrue without its own browser redirect so the page can follow
 * the returned `redirect_url` itself (a denial's carries `error=access_denied`).
 */
export async function decideConsent(
  client: OAuthConsentClient,
  authorizationId: string,
  decision: ConsentDecision,
): Promise<{ ok: true; redirectUrl: string } | { ok: false; message: string }> {
  const { data, error } = decision === 'approve'
    ? await client.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
    : await client.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
  const redirectUrl = error ? null : redirectUrlOf(data);
  return redirectUrl
    ? { ok: true, redirectUrl }
    : { ok: false, message: CONSENT_DECISION_FAILED_MESSAGE };
}
