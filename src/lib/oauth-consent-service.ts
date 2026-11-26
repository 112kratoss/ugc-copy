import type { User } from '@supabase/supabase-js';

import { PROMPT_ENHANCEMENT_COST_CREDITS } from '../../ugc-mobile/lib/model-catalog/protocol';

/**
 * The consent page's decisions (`/oauth/consent`).
 *
 * The app's own authorization server (`/oauth/authorize`, `agent-oauth-server-service.ts`) sends
 * the person's browser here with an `authorization_id` when an agent (Claude, ChatGPT, Codex,
 * Cursor) asks to act as them. The page decides who may answer: never a guest, whose refusal
 * comes before the request is read.
 *
 * The token an approval issues carries no permissions finer than its one scope (`mcp`, never
 * shown here as a permission), so the page shows the fixed list of what an agent may do on the
 * server the grant is for, and the server authorizes per tool as the signed-in creator.
 */

export const OAUTH_CONSENT_PATH = '/oauth/consent';

/**
 * What an agent may do once connected, in the page's words. The one charge with no price step, prompt enhancement, is named with its fixed cost (the catalog's
 * constant, which the tool's own description also states).
 */
export const AGENT_ACCESS = [
  {
    title: 'Create images and videos with your credits',
    detail: `Each run spends your balance as it does on the site. The agent sees the price first and is never charged more than it confirmed, except prompt enhancement, a fixed ${PROMPT_ENHANCEMENT_COST_CREDITS} credit${PROMPT_ENHANCEMENT_COST_CREDITS === 1 ? '' : 's'} a call.`,
  },
  {
    title: 'Publish posts as you',
    detail: 'Your creations, pictures and videos the agent brings from elsewhere, and text posts, with prompts or guides attached free or at a price you approve, on your profile, in Explore and in the Marketplace, under your name, with the rules every post follows.',
  },
  {
    title: 'Read your creations',
    detail: 'Your library, with its prompts, settings and links. Nothing of anyone else\'s.',
  },
] as const;

/**
 * What a grant for the posting server may do (`mcp-surfaces.ts`): each of the posting server's
 * tools, said in a person's words, and what it is given no tool for. The full server refuses its
 * token (`agent-oauth-admission.ts`), and the token is nothing at Supabase, so the last line holds.
 */
export const POSTING_AGENT_ACCESS = [
  {
    title: 'Publish posts as you',
    detail: 'Pictures and videos the agent brings from elsewhere, your finished creations, and text posts, with prompts or guides attached free or at a price you approve, on your profile, in Explore and in the Marketplace, under your name, with the rules every post follows.',
  },
  {
    title: 'Change and delete your posts',
    detail: 'Make a post public or private, or delete one of your posts, when you ask.',
  },
  {
    title: 'Read your creations and posts',
    detail: 'Your library, with its prompts and links, and your posts in any state. Of other accounts, only posts that are public.',
  },
  {
    title: 'No tool that spends credits',
    detail: 'It is given no way to create media, enhance a prompt or use your balance.',
  },
] as const;

export type AgentAccessItem = { readonly title: string; readonly detail: string };

/**
 * The access list for a grant, which is for one server
 * (`agent-oauth-request.ts`): the posting list when the grant is for the posting server, whoever
 * the client is, so the page lists what that grant can reach and nothing wider.
 */
export function agentAccessForSurface(surface: 'full' | 'posts'): ReadonlyArray<AgentAccessItem> {
  return surface === 'posts' ? POSTING_AGENT_ACCESS : AGENT_ACCESS;
}

/**
 * The shape the page takes an `authorization_id` in: URL-safe characters, bounded. Looser than
 * the app's own (`mbar_` and 43 characters, `isAgentAuthorizationId`) on purpose, so a link of
 * another shape, such as one Supabase's OAuth server issued before 2026-11-26, is told the request
 * cannot be answered rather than that the link is incomplete.
 */
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
  /** What this grant may do, as the page lists it (`agentAccessForSurface`). */
  access: ReadonlyArray<AgentAccessItem>;
};

export const CONSENT_UNAVAILABLE_MESSAGE =
  'This connection request has expired or was already answered. Go back to the app that asked and connect again.';
export const CONSENT_DECISION_FAILED_MESSAGE =
  'Your answer did not reach Magicbooklet. Try again, or go back to the app that asked and connect again.';

export function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The URL the server says to send the browser to, and only when it is an http(s) one: a stored
 * redirect URI is https or loopback http (the tables' own check), and the page must not be led
 * into another scheme whatever an answer says.
 */
function redirectUrlOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  return httpUrlOrNull((value as { redirect_url?: unknown }).redirect_url);
}

export type ConsentDecision = 'approve' | 'deny';

/** Where the consent page sends the account's answer to a request of the app's own server. */
export const AGENT_CONSENT_API_PATH = '/api/oauth/consent';

/** The body of that answer: the request, the answer, and the token the page was rendered with. */
export type AgentConsentAnswer = {
  authorizationId: string;
  decision: ConsentDecision;
  consentToken: string;
};

type AnswerFetch = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

/**
 * Sends the answer to the app's own authorization server with the web session's token, and
 * returns where the browser goes next: the client's redirect URI with a code, or with
 * `access_denied`. Same-origin by its relative path; the session token in the header is what
 * makes it this account's answer, and no cookie is involved.
 */
export async function sendAgentConsentAnswer(
  answer: AgentConsentAnswer,
  options: { accessToken: string | null | undefined; fetch?: AnswerFetch },
): Promise<{ ok: true; redirectUrl: string } | { ok: false; message: string }> {
  if (!options.accessToken) return { ok: false, message: CONSENT_DECISION_FAILED_MESSAGE };
  const send: AnswerFetch = options.fetch ?? ((input, init) => fetch(input, init));
  try {
    const response = await send(AGENT_CONSENT_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.accessToken}` },
      body: JSON.stringify(answer),
      credentials: 'omit',
      cache: 'no-store',
    });
    const body: unknown = await response.json().catch(() => null);
    const redirectUrl = response.ok ? redirectUrlOf(body) : null;
    if (redirectUrl) return { ok: true, redirectUrl };
    const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : null;
    return { ok: false, message: code === 'CONSENT_UNAVAILABLE' ? CONSENT_UNAVAILABLE_MESSAGE : CONSENT_DECISION_FAILED_MESSAGE };
  } catch {
    return { ok: false, message: CONSENT_DECISION_FAILED_MESSAGE };
  }
}
