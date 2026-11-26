import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  AGENT_OAUTH_SCOPE,
  AgentOAuthError,
  buildAuthorizationResponseUrl,
  checkAuthorizeRequest,
  readClientCredentials,
  readTokenGrantRequest,
  singleParameter,
  surfaceOfResource,
  type AgentOAuthClient,
  type ClientCredentials,
} from '@/lib/agent-oauth-request';
import {
  bindAgentOAuthAuthorization,
  consumeAgentOAuthCode,
  decideAgentOAuthAuthorization,
  findAgentOAuthAuthorization,
  findAgentOAuthClient,
  insertAgentOAuthAuthorization,
  issueAgentOAuthGrant,
  listLiveAgentOAuthGrants,
  purgeExpiredAgentOAuthRows,
  revokeAgentOAuthGrants,
  revokeAgentOAuthToken,
  rotateAgentOAuthRefreshToken,
} from '@/lib/agent-oauth-store';
import {
  AGENT_ACCESS_TOKEN_PREFIX,
  AGENT_ACCESS_TOKEN_TTL_SECONDS,
  AGENT_AUTHORIZATION_CODE_PREFIX,
  AGENT_AUTHORIZATION_CODE_TTL_SECONDS,
  AGENT_AUTHORIZATION_ID_PREFIX,
  AGENT_AUTHORIZATION_REQUEST_TTL_SECONDS,
  AGENT_CONSENT_TOKEN_PREFIX,
  AGENT_REFRESH_REUSE_GRACE_SECONDS,
  AGENT_REFRESH_TOKEN_PREFIX,
  AGENT_REFRESH_TOKEN_TTL_SECONDS,
  constantTimeEqual,
  hashAgentSecret,
  isAgentSecret,
  mintAgentSecret,
  verifierMatchesChallenge,
} from '@/lib/agent-oauth-tokens';
import { logBackendInfo, logBackendWarning } from '@/lib/backend-logger';
import type { McpSurface } from '@/lib/mcp-surfaces';
import {
  agentAccessForSurface,
  buildConsentPath,
  describeRedirectTarget,
  httpUrlOrNull,
  type ConsentDecision,
  type ConsentDetails,
} from '@/lib/oauth-consent-service';

/**
 * The app's own authorization server for the MCP routes
 * (`docs/plans/agent-token-broker-plan-2026-11-26.md`): what happens between an agent asking to
 * act as a creator and the agent holding an opaque token that this app alone can read.
 *
 * 1. `/oauth/authorize` checks the request and stores it (`startAgentAuthorization`).
 * 2. The consent page is rendered for the signed-in account, which binds the request to that
 *    account and mints the one-time consent token the answer must carry (`loadAgentConsent`).
 * 3. The account's answer issues an authorization code, or a refusal (`decideAgentConsent`).
 * 4. `/oauth/token` exchanges the code, once and against its PKCE verifier, for an access token
 *    and a refresh token, and later rotates the refresh token (`exchangeAgentToken`).
 *
 * Nothing here logs or returns a secret it did not just mint for the caller, and nothing is
 * stored but hashes. Every log line names the client, the account and the grant, never a value.
 */

export type AgentOAuthServiceOptions = {
  admin: SupabaseClient;
  /** The site's origin: the issuer, and the base of the two resources a grant may be for. */
  siteOrigin: string;
  now?: () => Date;
};

function nowOf(options: Pick<AgentOAuthServiceOptions, 'now'>): Date {
  return options.now?.() ?? new Date();
}

function plusSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// /oauth/authorize

export type StartedAuthorization =
  /** The request is stored: the browser goes to the consent page with its id. */
  | { kind: 'consent'; location: string }
  /** The request is refused and the client is told, at its registered redirect URI. */
  | { kind: 'redirect'; location: string }
  /** Nothing can be sent to the client: the person is shown why. */
  | { kind: 'page'; description: string };

export async function startAgentAuthorization(
  params: URLSearchParams,
  options: AgentOAuthServiceOptions,
): Promise<StartedAuthorization> {
  const check = await checkAuthorizeRequest(params, {
    siteOrigin: options.siteOrigin,
    findClient: (clientId) => findAgentOAuthClient(options.admin, clientId),
  });
  if (!check.ok) {
    if (check.kind === 'page') return { kind: 'page', description: check.description };
    return {
      kind: 'redirect',
      location: buildAuthorizationResponseUrl(check.redirectUri, { error: check.error, description: check.description }, check.state),
    };
  }
  const id = mintAgentSecret(AGENT_AUTHORIZATION_ID_PREFIX);
  await insertAgentOAuthAuthorization(options.admin, {
    id,
    clientId: check.request.clientId,
    redirectUri: check.request.redirectUri,
    surface: check.request.surface,
    scope: check.request.scope,
    state: check.request.state,
    codeChallenge: check.request.codeChallenge,
    expiresAt: plusSeconds(nowOf(options), AGENT_AUTHORIZATION_REQUEST_TTL_SECONDS),
  });
  logBackendInfo('agent_oauth_authorization_started', { clientId: check.request.clientId, surface: check.request.surface });
  return { kind: 'consent', location: buildConsentPath(id) };
}

// ---------------------------------------------------------------------------------------------
// The consent page

/** Whether an `authorization_id` is one this server issued (a GoTrue id never has the prefix). */
export function isAgentAuthorizationId(value: unknown): value is string {
  return isAgentSecret(value, AGENT_AUTHORIZATION_ID_PREFIX);
}

export type LoadedAgentConsent = {
  details: ConsentDetails;
  /** Minted for this render and this account; its hash is on the request, its value only in the page. */
  consentToken: string;
};

/**
 * The request as the consent page shows it to a signed-in account, or null when there is nothing
 * to answer (unknown, expired, answered, shown to another account, or its client since disabled).
 * Rendering binds the request to the account and replaces any earlier consent token, so only the
 * page rendered last, for this account, can answer.
 */
export async function loadAgentConsent(
  input: { authorizationId: string; userId: string },
  options: Pick<AgentOAuthServiceOptions, 'admin' | 'now'>,
): Promise<LoadedAgentConsent | null> {
  if (!isAgentAuthorizationId(input.authorizationId)) return null;
  const consentToken = mintAgentSecret(AGENT_CONSENT_TOKEN_PREFIX);
  const authorization = await bindAgentOAuthAuthorization(options.admin, {
    id: input.authorizationId,
    userId: input.userId,
    consentTokenHash: hashAgentSecret(consentToken),
    now: nowOf(options).toISOString(),
  });
  if (!authorization) return null;
  const client = await findAgentOAuthClient(options.admin, authorization.clientId);
  if (!client || client.disabledAt) return null;
  return {
    consentToken,
    details: {
      authorizationId: authorization.id,
      clientName: client.clientName,
      clientUri: httpUrlOrNull(client.clientUri),
      redirectUri: authorization.redirectUri,
      redirect: describeRedirectTarget(authorization.redirectUri),
      access: agentAccessForSurface(authorization.surface),
    },
  };
}

/**
 * The account's answer. It counts only from the account the page was rendered for, with the
 * consent token that render minted, while the request is still pending. An approval issues the
 * authorization code and sends it to the client's registered redirect URI; a refusal sends
 * `access_denied` there. Null when the answer does not count: nothing changes.
 */
export async function decideAgentConsent(
  input: { authorizationId: string; userId: string; consentToken: string; decision: ConsentDecision },
  options: Pick<AgentOAuthServiceOptions, 'admin' | 'now'>,
): Promise<{ redirectUrl: string } | null> {
  if (!isAgentAuthorizationId(input.authorizationId) || !isAgentSecret(input.consentToken, AGENT_CONSENT_TOKEN_PREFIX)) {
    return null;
  }
  const now = nowOf(options);
  const authorization = await findAgentOAuthAuthorization(options.admin, input.authorizationId);
  const consentTokenHash = hashAgentSecret(input.consentToken);
  if (
    !authorization
    || authorization.status !== 'pending'
    || authorization.userId !== input.userId
    || !authorization.consentTokenHash
    || !constantTimeEqual(consentTokenHash, authorization.consentTokenHash)
    || Date.parse(authorization.expiresAt) <= now.getTime()
  ) {
    return null;
  }

  if (input.decision === 'deny') {
    const denied = await decideAgentOAuthAuthorization(options.admin, {
      id: authorization.id,
      userId: input.userId,
      consentTokenHash,
      now: now.toISOString(),
      decision: { status: 'denied' },
    });
    if (!denied) return null;
    logBackendInfo('agent_oauth_consent_denied', { clientId: authorization.clientId, userId: input.userId });
    return {
      redirectUrl: buildAuthorizationResponseUrl(
        authorization.redirectUri,
        { error: 'access_denied', description: 'The account declined the connection.' },
        authorization.state,
      ),
    };
  }

  const client = await findAgentOAuthClient(options.admin, authorization.clientId);
  if (!client || client.disabledAt) return null;
  const code = mintAgentSecret(AGENT_AUTHORIZATION_CODE_PREFIX);
  const approved = await decideAgentOAuthAuthorization(options.admin, {
    id: authorization.id,
    userId: input.userId,
    consentTokenHash,
    now: now.toISOString(),
    decision: {
      status: 'approved',
      codeHash: hashAgentSecret(code),
      codeExpiresAt: plusSeconds(now, AGENT_AUTHORIZATION_CODE_TTL_SECONDS),
    },
  });
  if (!approved) return null;
  logBackendInfo('agent_oauth_consent_approved', {
    clientId: authorization.clientId,
    userId: input.userId,
    surface: authorization.surface,
  });
  return { redirectUrl: buildAuthorizationResponseUrl(authorization.redirectUri, { code }, authorization.state) };
}

// ---------------------------------------------------------------------------------------------
// /oauth/token and /oauth/revoke

/** RFC 6749 section 5.1. */
export type AgentTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

const INVALID_CLIENT = () => new AgentOAuthError('invalid_client', 'The client is unknown or its credentials are wrong.', 401);
const INVALID_GRANT = (description: string) => new AgentOAuthError('invalid_grant', description);

/**
 * The client a request is from. A public client is named by its id alone and must send no
 * secret; a confidential one must send the secret it was registered with, in the body or a Basic
 * header, and its hash is compared in constant time. Every failure answers the same thing.
 */
export async function authenticateAgentOAuthClient(admin: SupabaseClient, credentials: ClientCredentials): Promise<AgentOAuthClient> {
  const client = await findAgentOAuthClient(admin, credentials.clientId);
  if (!client || client.disabledAt) throw INVALID_CLIENT();
  if (client.tokenEndpointAuthMethod === 'none') {
    if (credentials.clientSecret !== null) throw INVALID_CLIENT();
    return client;
  }
  if (
    credentials.clientSecret === null
    || !client.clientSecretHash
    || !constantTimeEqual(hashAgentSecret(credentials.clientSecret), client.clientSecretHash)
  ) {
    throw INVALID_CLIENT();
  }
  return client;
}

function tokenResponse(accessToken: string, refreshToken: string): AgentTokenResponse {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: AGENT_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: AGENT_OAUTH_SCOPE,
  };
}

/**
 * The token endpoint: a code for the first token pair, or a refresh token for the next pair.
 * Throws `AgentOAuthError` for every refusal, in RFC 6749's words.
 */
export async function exchangeAgentToken(
  input: { form: URLSearchParams; authorizationHeader: string | null },
  options: AgentOAuthServiceOptions,
): Promise<AgentTokenResponse> {
  const { admin } = options;
  const client = await authenticateAgentOAuthClient(admin, readClientCredentials(input.form, input.authorizationHeader));
  const grant = readTokenGrantRequest(input.form);
  const accessToken = mintAgentSecret(AGENT_ACCESS_TOKEN_PREFIX);
  const refreshToken = mintAgentSecret(AGENT_REFRESH_TOKEN_PREFIX);

  if (grant.grantType === 'refresh_token') {
    if (!isAgentSecret(grant.refreshToken, AGENT_REFRESH_TOKEN_PREFIX)) throw INVALID_GRANT('The refresh token is not valid.');
    const rotated = await rotateAgentOAuthRefreshToken(admin, {
      refreshHash: hashAgentSecret(grant.refreshToken),
      clientId: client.clientId,
      accessHash: hashAgentSecret(accessToken),
      newRefreshHash: hashAgentSecret(refreshToken),
      accessTtlSeconds: AGENT_ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: AGENT_REFRESH_TOKEN_TTL_SECONDS,
      reuseGraceSeconds: AGENT_REFRESH_REUSE_GRACE_SECONDS,
    });
    if (rotated.outcome === 'reuse_detected') {
      // A rotated token came back after the grace: it was copied, and the grant is gone.
      logBackendWarning('agent_oauth_refresh_reuse_detected', {
        clientId: client.clientId,
        userId: rotated.userId,
        grantId: rotated.grantId,
      });
      throw INVALID_GRANT('The refresh token is not valid. Connect again.');
    }
    if (rotated.outcome !== 'rotated') throw INVALID_GRANT('The refresh token is not valid.');
    logBackendInfo('agent_oauth_token_issued', {
      grant: 'refresh_token',
      clientId: rotated.clientId,
      userId: rotated.userId,
      grantId: rotated.grantId,
    });
    return tokenResponse(accessToken, refreshToken);
  }

  if (!isAgentSecret(grant.code, AGENT_AUTHORIZATION_CODE_PREFIX)) throw INVALID_GRANT('The authorization code is not valid.');
  // Single use, whatever follows: a code presented with the wrong verifier is spent.
  const consumed = await consumeAgentOAuthCode(admin, hashAgentSecret(grant.code));
  if (consumed.outcome === 'replayed') {
    logBackendWarning('agent_oauth_code_replayed', { clientId: client.clientId });
    throw INVALID_GRANT('The authorization code is not valid.');
  }
  if (consumed.outcome !== 'consumed') throw INVALID_GRANT('The authorization code is not valid.');
  if (consumed.clientId !== client.clientId) throw INVALID_GRANT('The authorization code is not valid.');
  if (grant.redirectUri !== null && grant.redirectUri !== consumed.redirectUri) {
    throw INVALID_GRANT('redirect_uri does not match the authorization request.');
  }
  if (!verifierMatchesChallenge(grant.codeVerifier, consumed.codeChallenge)) {
    throw INVALID_GRANT('code_verifier does not match the authorization request.');
  }
  if (grant.resource !== null && surfaceOfResource(grant.resource, options.siteOrigin) !== consumed.surface) {
    throw new AgentOAuthError('invalid_target', 'resource does not match the authorization request.');
  }
  const issued = await issueAgentOAuthGrant(admin, {
    authorizationId: consumed.authorizationId,
    accessHash: hashAgentSecret(accessToken),
    refreshHash: hashAgentSecret(refreshToken),
    accessTtlSeconds: AGENT_ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: AGENT_REFRESH_TOKEN_TTL_SECONDS,
  });
  if (!issued) throw INVALID_GRANT('The authorization code is not valid.');
  logBackendInfo('agent_oauth_token_issued', {
    grant: 'authorization_code',
    clientId: issued.clientId,
    userId: issued.userId,
    grantId: issued.grantId,
    surface: issued.surface,
  });
  // A new connection is rare enough to carry the housekeeping; its failure is not the client's.
  await purgeExpiredAgentOAuthRows(admin).catch((error: unknown) => {
    logBackendWarning('agent_oauth_purge_failed', { error });
  });
  return tokenResponse(accessToken, refreshToken);
}

/**
 * RFC 7009: a client ends the grant one of its own tokens belongs to, access or refresh. A token
 * that is unknown, expired or another client's changes nothing and is answered the same way.
 */
export async function revokeAgentToken(
  input: { form: URLSearchParams; authorizationHeader: string | null },
  options: Pick<AgentOAuthServiceOptions, 'admin'>,
): Promise<void> {
  const client = await authenticateAgentOAuthClient(options.admin, readClientCredentials(input.form, input.authorizationHeader));
  const token = singleParameter(input.form, 'token');
  if (!token) throw new AgentOAuthError('invalid_request', 'token is required.');
  if (!isAgentSecret(token, AGENT_ACCESS_TOKEN_PREFIX) && !isAgentSecret(token, AGENT_REFRESH_TOKEN_PREFIX)) return;
  const revoked = await revokeAgentOAuthToken(options.admin, { tokenHash: hashAgentSecret(token), clientId: client.clientId });
  if (revoked) logBackendInfo('agent_oauth_grant_revoked', { clientId: client.clientId, by: 'client' });
}

// ---------------------------------------------------------------------------------------------
// Connected apps

export type AgentGrantSummary = {
  clientId: string;
  name: string;
  uri: string | null;
  grantedAt: string;
  /** The widest server any of the account's live grants to this client reaches. */
  surface: McpSurface;
};

/** An account's connected apps: one entry per client, its earliest live approval, newest first. */
export async function listAgentGrants(admin: SupabaseClient, userId: string): Promise<AgentGrantSummary[]> {
  const byClient = new Map<string, AgentGrantSummary>();
  for (const grant of await listLiveAgentOAuthGrants(admin, userId)) {
    const earlier = byClient.get(grant.clientId);
    if (!earlier) {
      byClient.set(grant.clientId, {
        clientId: grant.clientId,
        name: grant.clientName,
        uri: httpUrlOrNull(grant.clientUri),
        grantedAt: grant.createdAt,
        surface: grant.surface,
      });
      continue;
    }
    byClient.set(grant.clientId, {
      ...earlier,
      grantedAt: grant.createdAt < earlier.grantedAt ? grant.createdAt : earlier.grantedAt,
      surface: earlier.surface === 'full' || grant.surface === 'full' ? 'full' : 'posts',
    });
  }
  return [...byClient.values()].sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
}

/** Disconnect: every live grant the account gave the client ends, with its tokens, at once. */
export async function disconnectAgentClient(admin: SupabaseClient, input: { userId: string; clientId: string }): Promise<number> {
  const revoked = await revokeAgentOAuthGrants(admin, { ...input, reason: 'user' });
  if (revoked > 0) logBackendInfo('agent_oauth_grant_revoked', { clientId: input.clientId, userId: input.userId, by: 'user', grants: revoked });
  return revoked;
}
