import 'server-only';

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Operator suspensions and reinstatements.
 *
 * Enforcement lives in GoTrue (`auth.users.banned_until`), applied atomically
 * with its audit row by `apply_admin_user_sanction`. This module holds the
 * policy around it: which durations an operator may pick, and the invariant
 * that a reinstatement never carries one.
 *
 * A sanction governs account ACCESS only — it does not touch the user's posts.
 * See the migration for why the two are kept as separate audited decisions.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type AdminUserSanctionAction = 'suspend' | 'reinstate';

/**
 * Fixed choices rather than a free-text number: an operator typing hours into a
 * box is one fat finger away from a 10,000-hour "24-hour" suspension, and the
 * difference is invisible in the audit log afterwards.
 */
export const ADMIN_SANCTION_DURATIONS = [
  { hours: 24, label: '24 hours' },
  { hours: 24 * 7, label: '7 days' },
  { hours: 24 * 30, label: '30 days' },
  { hours: null, label: 'Indefinite' },
] as const;

export const ADMIN_SANCTION_DURATION_HOURS: ReadonlyArray<number | null> =
  ADMIN_SANCTION_DURATIONS.map((option) => option.hours);

export type AdminUserSanction = {
  id: string;
  userId: string;
  reviewerId: string;
  action: AdminUserSanctionAction;
  reason: string;
  suspendedUntil: string | null;
  createdAt: string;
};

export type AdminUserAccountState = {
  isSuspended: boolean;
  bannedUntil: string | null;
};

export type AdminUserSanctionResult = {
  status: 'applied' | 'already_applied' | 'not_found' | 'invalid';
  sanctionId: string | null;
  action: AdminUserSanctionAction | null;
  suspendedUntil: string | null;
  error: string | null;
};

export function isValidSanctionDuration(hours: number | null | undefined): boolean {
  if (hours === null || hours === undefined) return true;
  return ADMIN_SANCTION_DURATION_HOURS.includes(hours);
}

export async function applyAdminUserSanction(
  client: SupabaseClient,
  options: {
    userId: string;
    reviewerId: string;
    action: AdminUserSanctionAction;
    reason: string;
    /** Ignored for a reinstatement; null means indefinite. */
    durationHours?: number | null;
    idempotencyKey?: string;
  },
): Promise<AdminUserSanctionResult> {
  if (!UUID_PATTERN.test(options.userId)) {
    return invalid('User id must be a UUID.');
  }
  if (!UUID_PATTERN.test(options.reviewerId)) {
    return invalid('Reviewer id must be a UUID.');
  }

  const reason = options.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 1000) {
    return invalid('A reason of 3 to 1000 characters is required.');
  }

  // A reinstatement has no duration to validate, and passing one through would
  // let a caller write an expiry onto a row the schema requires to be null.
  const durationHours = options.action === 'suspend' ? options.durationHours ?? null : null;
  if (!isValidSanctionDuration(durationHours)) {
    return invalid('Unsupported suspension duration.');
  }

  const { data, error } = await client.rpc('apply_admin_user_sanction', {
    p_user_id: options.userId,
    p_reviewer_id: options.reviewerId,
    p_action: options.action,
    p_reason: reason,
    p_duration_hours: durationHours,
    p_idempotency_key: options.idempotencyKey?.trim() || randomUUID(),
  });
  if (error) throw error;

  const result = (data ?? {}) as Record<string, unknown>;
  const status = result.status;

  if (status !== 'applied' && status !== 'already_applied' && status !== 'not_found' && status !== 'invalid') {
    throw new Error('Sanction resolver returned an invalid response.');
  }

  return {
    status,
    sanctionId: typeof result.sanction_id === 'string' ? result.sanction_id : null,
    action: result.action === 'suspend' || result.action === 'reinstate' ? result.action : null,
    suspendedUntil: typeof result.suspended_until === 'string' ? result.suspended_until : null,
    error: typeof result.error === 'string' ? result.error : null,
  };
}

function invalid(message: string): AdminUserSanctionResult {
  return { status: 'invalid', sanctionId: null, action: null, suspendedUntil: null, error: message };
}

export async function listAdminUserSanctions(
  client: SupabaseClient,
  userId: string,
  options: { limit?: number } = {},
): Promise<AdminUserSanction[]> {
  const { data, error } = await client
    .from('admin_user_sanctions')
    .select('id, user_id, reviewer_id, action, reason, suspended_until, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 25);
  if (error) throw error;

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    reviewerId: String(row.reviewer_id),
    action: row.action === 'reinstate' ? 'reinstate' : 'suspend',
    reason: String(row.reason ?? ''),
    suspendedUntil: (row.suspended_until as string | null) ?? null,
    createdAt: String(row.created_at ?? ''),
  }));
}

/**
 * Live access state for a set of accounts, read from GoTrue rather than from
 * the audit log — see the view's comment for why those can disagree.
 */
export async function getAdminUserAccountStates(
  client: SupabaseClient,
  userIds: string[],
): Promise<Map<string, AdminUserAccountState>> {
  const uniqueIds = [...new Set(userIds)].filter((id) => UUID_PATTERN.test(id));
  if (uniqueIds.length === 0) return new Map();

  const { data, error } = await client
    .from('admin_user_account_state')
    .select('user_id, banned_until, is_suspended')
    .in('user_id', uniqueIds);
  if (error) throw error;

  return new Map(((data ?? []) as Array<Record<string, unknown>>).map((row) => [
    String(row.user_id),
    {
      isSuspended: row.is_suspended === true,
      bannedUntil: (row.banned_until as string | null) ?? null,
    },
  ]));
}

export async function getAdminUserAccountState(
  client: SupabaseClient,
  userId: string,
): Promise<AdminUserAccountState> {
  const states = await getAdminUserAccountStates(client, [userId]);
  return states.get(userId) ?? { isSuspended: false, bannedUntil: null };
}
