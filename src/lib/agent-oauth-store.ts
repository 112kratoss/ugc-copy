import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AgentOAuthAuthMethod, AgentOAuthClient } from '@/lib/agent-oauth-request';
import type { McpSurface } from '@/lib/mcp-surfaces';

/**
 * The authorization server's rows (migration `20261126121704_agent_oauth_server.sql`), read and
 * written under the service role: the four tables grant nothing to any other role. Everything
 * here takes and returns hashes; a secret's value never reaches this module.
 *
 * A read that fails throws: the endpoints answer that as unavailable, never as "no such client"
 * or "no such token", so an outage cannot look like a refusal a client would act on.
 */

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function surfaceOf(value: unknown): McpSurface {
  return value === 'posts' ? 'posts' : 'full';
}

function authMethodOf(value: unknown): AgentOAuthAuthMethod {
  return value === 'client_secret_post' || value === 'client_secret_basic' ? value : 'none';
}

const CLIENT_COLUMNS = 'client_id, client_name, client_uri, redirect_uris, token_endpoint_auth_method, client_secret_hash, surface, disabled_at';

function toClient(row: Row): AgentOAuthClient {
  return {
    clientId: String(row.client_id),
    clientName: text(row.client_name) ?? String(row.client_id),
    clientUri: text(row.client_uri),
    redirectUris: Array.isArray(row.redirect_uris) ? row.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [],
    tokenEndpointAuthMethod: authMethodOf(row.token_endpoint_auth_method),
    clientSecretHash: text(row.client_secret_hash),
    surface: surfaceOf(row.surface),
    disabledAt: text(row.disabled_at),
  };
}

export async function findAgentOAuthClient(admin: SupabaseClient, clientId: string): Promise<AgentOAuthClient | null> {
  const { data, error } = await admin
    .from('agent_oauth_clients')
    .select(CLIENT_COLUMNS)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return isRecord(data) ? toClient(data) : null;
}

export async function listAgentOAuthClients(admin: SupabaseClient): Promise<AgentOAuthClient[]> {
  const { data, error } = await admin
    .from('agent_oauth_clients')
    .select(CLIENT_COLUMNS)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).filter(isRecord).map(toClient);
}

export type NewAgentOAuthClient = {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: AgentOAuthAuthMethod;
  clientSecretHash: string | null;
  surface: McpSurface;
};

export async function insertAgentOAuthClient(admin: SupabaseClient, client: NewAgentOAuthClient): Promise<void> {
  const { error } = await admin.from('agent_oauth_clients').insert({
    client_id: client.clientId,
    client_name: client.clientName,
    client_uri: client.clientUri,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    client_secret_hash: client.clientSecretHash,
    surface: client.surface,
  });
  if (error) throw error;
}

/** Changes one client; false when no client has that id. */
export async function updateAgentOAuthClient(
  admin: SupabaseClient,
  clientId: string,
  change: { disabledAt?: string | null; clientSecretHash?: string; redirectUris?: string[] },
): Promise<boolean> {
  const patch: Row = {};
  if (change.disabledAt !== undefined) patch.disabled_at = change.disabledAt;
  if (change.clientSecretHash !== undefined) patch.client_secret_hash = change.clientSecretHash;
  if (change.redirectUris !== undefined) patch.redirect_uris = change.redirectUris;
  const { data, error } = await admin
    .from('agent_oauth_clients')
    .update(patch)
    .eq('client_id', clientId)
    .select('client_id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export type AgentOAuthAuthorization = {
  id: string;
  clientId: string;
  redirectUri: string;
  surface: McpSurface;
  state: string | null;
  userId: string | null;
  consentTokenHash: string | null;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  expiresAt: string;
};

const AUTHORIZATION_COLUMNS = 'id, client_id, redirect_uri, surface, state, user_id, consent_token_hash, status, expires_at';

function toAuthorization(row: Row): AgentOAuthAuthorization {
  const status = row.status;
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    surface: surfaceOf(row.surface),
    state: typeof row.state === 'string' ? row.state : null,
    userId: text(row.user_id),
    consentTokenHash: text(row.consent_token_hash),
    status: status === 'approved' || status === 'denied' || status === 'consumed' ? status : 'pending',
    expiresAt: String(row.expires_at),
  };
}

export async function insertAgentOAuthAuthorization(
  admin: SupabaseClient,
  request: {
    id: string;
    clientId: string;
    redirectUri: string;
    surface: McpSurface;
    scope: string | null;
    state: string | null;
    codeChallenge: string;
    expiresAt: string;
  },
): Promise<void> {
  const { error } = await admin.from('agent_oauth_authorizations').insert({
    id: request.id,
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    surface: request.surface,
    scope: request.scope,
    state: request.state,
    code_challenge: request.codeChallenge,
    expires_at: request.expiresAt,
  });
  if (error) throw error;
}

/**
 * Shows a pending request to an account: binds it to that account, if it is bound to none or to
 * this one already, and stores the hash of the consent token the page is rendered with. Null when
 * the request does not exist, has been answered, has expired, or was shown to another account.
 */
export async function bindAgentOAuthAuthorization(
  admin: SupabaseClient,
  input: { id: string; userId: string; consentTokenHash: string; now: string },
): Promise<AgentOAuthAuthorization | null> {
  const { data, error } = await admin
    .from('agent_oauth_authorizations')
    .update({ user_id: input.userId, consent_token_hash: input.consentTokenHash })
    .eq('id', input.id)
    .eq('status', 'pending')
    .gt('expires_at', input.now)
    .or(`user_id.is.null,user_id.eq.${input.userId}`)
    .select(AUTHORIZATION_COLUMNS);
  if (error) throw error;
  const row = Array.isArray(data) ? data.find(isRecord) : null;
  return row ? toAuthorization(row) : null;
}

export async function findAgentOAuthAuthorization(admin: SupabaseClient, id: string): Promise<AgentOAuthAuthorization | null> {
  const { data, error } = await admin
    .from('agent_oauth_authorizations')
    .select(AUTHORIZATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return isRecord(data) ? toAuthorization(data) : null;
}

/**
 * Records the bound account's answer, once: the row must still be pending, unexpired, this
 * account's, and carry the consent token the answer came with. False when another answer got
 * there first or any of those no longer holds.
 */
export async function decideAgentOAuthAuthorization(
  admin: SupabaseClient,
  input: {
    id: string;
    userId: string;
    consentTokenHash: string;
    now: string;
    decision: { status: 'approved'; codeHash: string; codeExpiresAt: string } | { status: 'denied' };
  },
): Promise<boolean> {
  const patch: Row = { status: input.decision.status, decided_at: input.now, consent_token_hash: null };
  if (input.decision.status === 'approved') {
    patch.code_hash = input.decision.codeHash;
    patch.code_expires_at = input.decision.codeExpiresAt;
  }
  const { data, error } = await admin
    .from('agent_oauth_authorizations')
    .update(patch)
    .eq('id', input.id)
    .eq('status', 'pending')
    .eq('user_id', input.userId)
    .eq('consent_token_hash', input.consentTokenHash)
    .gt('expires_at', input.now)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export type ConsumedCode =
  | { outcome: 'consumed'; authorizationId: string; clientId: string; redirectUri: string; codeChallenge: string; surface: McpSurface; userId: string }
  | { outcome: 'invalid' }
  | { outcome: 'replayed' };

export async function consumeAgentOAuthCode(admin: SupabaseClient, codeHash: string): Promise<ConsumedCode> {
  const { data, error } = await admin.rpc('agent_oauth_consume_code', { p_code_hash: codeHash });
  if (error) throw error;
  if (!isRecord(data)) throw new Error('agent_oauth_consume_code answered nothing');
  if (data.outcome === 'replayed') return { outcome: 'replayed' };
  if (data.outcome !== 'consumed') return { outcome: 'invalid' };
  return {
    outcome: 'consumed',
    authorizationId: String(data.authorization_id),
    clientId: String(data.client_id),
    redirectUri: String(data.redirect_uri),
    codeChallenge: String(data.code_challenge),
    surface: surfaceOf(data.surface),
    userId: String(data.user_id),
  };
}

export type IssuedGrant = { grantId: string; userId: string; clientId: string; surface: McpSurface };

function toIssuedGrant(data: Row): IssuedGrant {
  return {
    grantId: String(data.grant_id),
    userId: String(data.user_id),
    clientId: String(data.client_id),
    surface: surfaceOf(data.surface),
  };
}

/** The grant and its first token pair for a code consumed a moment ago; null when there is none to issue. */
export async function issueAgentOAuthGrant(
  admin: SupabaseClient,
  input: { authorizationId: string; accessHash: string; refreshHash: string; accessTtlSeconds: number; refreshTtlSeconds: number },
): Promise<IssuedGrant | null> {
  const { data, error } = await admin.rpc('agent_oauth_issue_grant', {
    p_authorization_id: input.authorizationId,
    p_access_hash: input.accessHash,
    p_refresh_hash: input.refreshHash,
    p_access_ttl_seconds: input.accessTtlSeconds,
    p_refresh_ttl_seconds: input.refreshTtlSeconds,
  });
  if (error) throw error;
  if (!isRecord(data)) throw new Error('agent_oauth_issue_grant answered nothing');
  return data.outcome === 'issued' ? toIssuedGrant(data) : null;
}

export type RotatedRefreshToken =
  | ({ outcome: 'rotated' } & IssuedGrant)
  | { outcome: 'invalid' }
  | { outcome: 'reuse_detected'; grantId: string; userId: string };

export async function rotateAgentOAuthRefreshToken(
  admin: SupabaseClient,
  input: {
    refreshHash: string;
    clientId: string;
    accessHash: string;
    newRefreshHash: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    reuseGraceSeconds: number;
  },
): Promise<RotatedRefreshToken> {
  const { data, error } = await admin.rpc('agent_oauth_rotate_refresh_token', {
    p_refresh_hash: input.refreshHash,
    p_client_id: input.clientId,
    p_access_hash: input.accessHash,
    p_new_refresh_hash: input.newRefreshHash,
    p_access_ttl_seconds: input.accessTtlSeconds,
    p_refresh_ttl_seconds: input.refreshTtlSeconds,
    p_reuse_grace_seconds: input.reuseGraceSeconds,
  });
  if (error) throw error;
  if (!isRecord(data)) throw new Error('agent_oauth_rotate_refresh_token answered nothing');
  if (data.outcome === 'rotated') return { outcome: 'rotated', ...toIssuedGrant(data) };
  if (data.outcome === 'reuse_detected') {
    return { outcome: 'reuse_detected', grantId: String(data.grant_id), userId: String(data.user_id) };
  }
  return { outcome: 'invalid' };
}

export type AgentTokenAdmissionRow = {
  grantId: string;
  userId: string;
  clientId: string;
  surface: McpSurface;
  /** `profiles.identity_state`, as stored; null for an account with no profile row. */
  state: string | null;
  createdAt: string | null;
  email: string | null;
  isAnonymous: boolean;
  banned: boolean;
};

/** What the database says of an access token's hash; null when it admits nobody. */
export async function readAgentTokenAdmission(admin: SupabaseClient, tokenHash: string): Promise<AgentTokenAdmissionRow | null> {
  const { data, error } = await admin.rpc('agent_oauth_token_admission', { p_token_hash: tokenHash });
  if (error) throw error;
  if (data === null || data === undefined) return null;
  if (!isRecord(data)) throw new Error('agent_oauth_token_admission answered an unexpected shape');
  return {
    grantId: String(data.grant_id),
    userId: String(data.user_id),
    clientId: String(data.client_id),
    surface: surfaceOf(data.surface),
    state: text(data.state),
    createdAt: text(data.created_at),
    email: text(data.email),
    isAnonymous: data.is_anonymous === true,
    banned: data.banned === true,
  };
}

/** Ends every live grant an account gave a client; the number ended. */
export async function revokeAgentOAuthGrants(
  admin: SupabaseClient,
  input: { userId: string; clientId: string; reason: 'user' | 'operator' },
): Promise<number> {
  const { data, error } = await admin.rpc('agent_oauth_revoke_grants', {
    p_user_id: input.userId,
    p_client_id: input.clientId,
    p_reason: input.reason,
  });
  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}

/** RFC 7009: ends the grant a client's own token belongs to; false for any other token. */
export async function revokeAgentOAuthToken(admin: SupabaseClient, input: { tokenHash: string; clientId: string }): Promise<boolean> {
  const { data, error } = await admin.rpc('agent_oauth_revoke_token', {
    p_token_hash: input.tokenHash,
    p_client_id: input.clientId,
  });
  if (error) throw error;
  return data === true;
}

export type AgentOAuthGrantRow = {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  surface: McpSurface;
  createdAt: string;
};

/** An account's live grants, newest first, each with its client's name and site. */
export async function listLiveAgentOAuthGrants(admin: SupabaseClient, userId: string): Promise<AgentOAuthGrantRow[]> {
  const { data, error } = await admin
    .from('agent_oauth_grants')
    .select('client_id, surface, created_at, client:agent_oauth_clients(client_name, client_uri)')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).filter(isRecord).map((row) => {
    const client = Array.isArray(row.client) ? row.client.find(isRecord) : isRecord(row.client) ? row.client : null;
    return {
      clientId: String(row.client_id),
      clientName: text(client?.client_name) ?? String(row.client_id),
      clientUri: text(client?.client_uri),
      surface: surfaceOf(row.surface),
      createdAt: String(row.created_at),
    };
  });
}

export async function purgeExpiredAgentOAuthRows(admin: SupabaseClient): Promise<void> {
  const { error } = await admin.rpc('agent_oauth_purge_expired');
  if (error) throw error;
}
