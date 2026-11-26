import 'server-only';

import type { SupabaseClient, User } from '@supabase/supabase-js';

import { readAgentTokenAdmission } from '@/lib/agent-oauth-store';
import { hashAgentSecret } from '@/lib/agent-oauth-tokens';
import { isAppAgentAccessToken } from '@/lib/agent-token';
import { isPostingOnlyClientId } from '@/lib/mcp-client-directory';
import type { McpSurface } from '@/lib/mcp-surfaces';

/**
 * Admission of the app's own agent access token at the MCP routes
 * (`docs/archive/agent-token-broker-plan-2026-11-26.md`, "MCP admission").
 *
 * The token is an opaque string: there is no signature to check and nothing to decode. It is
 * hashed and looked up, in one round trip that also answers everything the proxy's evaluator
 * asks of a JWT's subject (`route-identity-admission.ts`), and the answers are given in the same
 * order and the same words:
 *
 * - no row (unknown or expired token, revoked grant, disabled client, account gone): 401;
 * - the account is being deleted: 409 `ACCOUNT_DELETING`, asked before anything else;
 * - banned: 401;
 * - a state that is neither `active` nor `merged`: 503, as for a profile that cannot be read;
 * - merged into another account: 409 `SESSION_MERGED`;
 * - a guest: 403 `REGISTRATION_REQUIRED` (a guest cannot be granted one, so this is a backstop).
 *
 * A grant for the posting server is refused at the full one (403 `AGENT_SURFACE_NOT_ALLOWED`); a
 * grant for the full server is taken at either, the posting tools being a subset of it.
 */

export type AgentTokenRefusal = {
  ok: false;
  status: 401 | 403 | 409 | 503;
  code: string;
  error: string;
};

export type AgentTokenAdmitted = {
  ok: true;
  userId: string;
  clientId: string;
  grantId: string;
  /** The server the grant is for. */
  grantSurface: McpSurface;
  /** The account, built field by field from the database's answer, as admission builds a JWT's. */
  user: User;
};

export type AgentTokenAdmission = AgentTokenAdmitted | AgentTokenRefusal;

const UNAUTHORIZED: AgentTokenRefusal = { ok: false, status: 401, code: 'UNAUTHORIZED', error: 'Unauthorized' };
const UNAVAILABLE: AgentTokenRefusal = {
  ok: false,
  status: 503,
  code: 'IDENTITY_CHECK_UNAVAILABLE',
  error: 'Identity verification is temporarily unavailable. Please try again.',
};

export async function admitAgentAccessToken(
  token: string,
  options: { admin: SupabaseClient; surface: McpSurface },
): Promise<AgentTokenAdmission> {
  // Shape first: nothing that is not one of this server's tokens is ever hashed or looked up.
  if (!isAppAgentAccessToken(token)) return UNAUTHORIZED;
  let row: Awaited<ReturnType<typeof readAgentTokenAdmission>>;
  try {
    row = await readAgentTokenAdmission(options.admin, hashAgentSecret(token));
  } catch {
    return UNAVAILABLE;
  }
  if (!row) return UNAUTHORIZED;
  if (row.state === 'deleting') {
    return { ok: false, status: 409, code: 'ACCOUNT_DELETING', error: 'This account is being permanently deleted.' };
  }
  if (row.banned) return UNAUTHORIZED;
  if (row.state !== 'active' && row.state !== 'merged') return UNAVAILABLE;
  if (row.state === 'merged') {
    return {
      ok: false,
      status: 409,
      code: 'SESSION_MERGED',
      error: 'This guest session has been linked to an account. Sign in to continue.',
    };
  }
  if (row.isAnonymous) {
    return { ok: false, status: 403, code: 'REGISTRATION_REQUIRED', error: 'Create an account to use this feature.' };
  }
  // The grant says which server it is for; the code's own posting-only list is asked as well, so
  // a grant that should never have been `full` is still held to posting.
  if (options.surface === 'full' && (row.surface !== 'full' || isPostingOnlyClientId(row.clientId))) {
    return {
      ok: false,
      status: 403,
      code: 'AGENT_SURFACE_NOT_ALLOWED',
      error: 'This app was connected for posting only. It can use the Magicbooklet posting server, not this one.',
    };
  }
  const user: User = {
    id: row.userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: row.email ?? undefined,
    is_anonymous: false,
    app_metadata: {},
    user_metadata: {},
    created_at: row.createdAt ?? '',
  };
  return { ok: true, userId: row.userId, clientId: row.clientId, grantId: row.grantId, grantSurface: row.surface, user };
}
