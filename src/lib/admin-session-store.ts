import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

export type AdminSessionRecord = {
  sessionId: string;
  subject: string;
  credentialVersion: string;
  createdAt: Date;
  expiresAt: Date;
};

type StoredAdminSession = {
  session_id?: unknown;
  subject?: unknown;
  credential_version?: unknown;
  expires_at?: unknown;
  revoked_at?: unknown;
};

/**
 * Stores the server-authoritative half of an admin login. The backing table is
 * intentionally inaccessible to anon/authenticated Data API roles.
 */
export async function insertAdminSession(
  client: SupabaseClient,
  session: AdminSessionRecord,
): Promise<void> {
  const { error } = await client.from('admin_sessions').insert({
    session_id: session.sessionId,
    subject: session.subject,
    credential_version: session.credentialVersion,
    created_at: session.createdAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
  });

  if (error) {
    throw new Error(`Failed to persist admin session: ${error.message}`);
  }
}

/**
 * Re-validates all mutable/authoritative session state for every admin request.
 * An unavailable database is represented by a thrown error so callers cannot
 * accidentally confuse it with an active session.
 */
export async function isAdminSessionActive(
  client: SupabaseClient,
  expected: {
    sessionId: string;
    subject: string;
    credentialVersion: string;
    now: Date;
  },
): Promise<boolean> {
  const { data, error } = await client
    .from('admin_sessions')
    .select('session_id, subject, credential_version, expires_at, revoked_at')
    .eq('session_id', expected.sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load admin session: ${error.message}`);
  }
  if (!data) return false;

  const row = data as StoredAdminSession;
  if (
    row.session_id !== expected.sessionId
    || row.subject !== expected.subject
    || row.credential_version !== expected.credentialVersion
    || row.revoked_at !== null
    || typeof row.expires_at !== 'string'
  ) {
    return false;
  }

  const expiresAt = Date.parse(row.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > expected.now.getTime();
}

/** Marks a session unusable before its browser cookie is cleared. */
export async function revokeAdminSession(
  client: SupabaseClient,
  sessionId: string,
  revokedAt: Date,
): Promise<void> {
  const { error } = await client
    .from('admin_sessions')
    .update({ revoked_at: revokedAt.toISOString() })
    .eq('session_id', sessionId)
    .is('revoked_at', null);

  if (error) {
    throw new Error(`Failed to revoke admin session: ${error.message}`);
  }
}
