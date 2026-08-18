import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { decryptCreatorPayoutDetails } from '@/lib/creator-payout-details-crypto';
import { formatTokenSubunitsAsUsd } from '@/lib/creator-payouts';

export interface OpenCreatorPayoutRequest {
  id: string;
  userId: string;
  username: string | null;
  displayName: string | null;
  amountTokenSubunits: number;
  amountUsd: string;
  payoutMethod: string;
  payoutDetails: string;
  requestedAt: string;
  /** Lifetime earnings give the operator context for an unusual request. */
  lifetimeEarnedTokenSubunits: number;
}

type PayoutQueueRow = {
  id: string;
  user_id: string;
  amount_token_subunits: number;
  payout_method: string;
  payout_details: string;
  requested_at: string;
};

/**
 * The operator queue. Deliberately unpaginated for now: with a $100 floor and a
 * single operator, an open queue long enough to need paging is itself the
 * signal that this rail needs automating.
 */
export async function listOpenCreatorPayoutRequests(
  adminSupabase: SupabaseClient,
): Promise<OpenCreatorPayoutRequest[]> {
  const { data, error } = await adminSupabase
    .from('creator_payout_requests')
    .select('id, user_id, amount_token_subunits, payout_method, payout_details, requested_at')
    .eq('status', 'requested')
    .order('requested_at', { ascending: true })
    .limit(200);

  if (error) {
    logBackendError('creator_payout_queue_load_failed', { error: error });
    throw error;
  }

  const rows = (data ?? []) as PayoutQueueRow[];
  if (rows.length === 0) {
    return [];
  }

  const userIds = Array.from(new Set(rows.map((row) => row.user_id)));
  const [profilesResult, walletsResult] = await Promise.all([
    adminSupabase.from('profiles').select('id, username, display_name').in('id', userIds),
    adminSupabase
      .from('creator_resource_wallets')
      .select('user_id, lifetime_earned_token_subunits')
      .in('user_id', userIds),
  ]);

  const profiles = new Map(
    ((profilesResult.data ?? []) as Array<{ id: string; username: string | null; display_name: string | null }>)
      .map((profile) => [profile.id, profile]),
  );
  const wallets = new Map(
    ((walletsResult.data ?? []) as Array<{ user_id: string; lifetime_earned_token_subunits: number | null }>)
      .map((wallet) => [wallet.user_id, wallet.lifetime_earned_token_subunits ?? 0]),
  );

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    username: profiles.get(row.user_id)?.username ?? null,
    displayName: profiles.get(row.user_id)?.display_name ?? null,
    amountTokenSubunits: row.amount_token_subunits,
    amountUsd: formatTokenSubunitsAsUsd(row.amount_token_subunits),
    payoutMethod: row.payout_method,
    payoutDetails: readPayoutDetails(row),
    requestedAt: row.requested_at,
    lifetimeEarnedTokenSubunits: wallets.get(row.user_id) ?? 0,
  }));
}

/**
 * Details are stored AES-256-GCM encrypted (legacy rows are plaintext and pass
 * through). A row that fails to decrypt keeps the queue rendering — one broken
 * or re-keyed row must not take the whole operator view down with it.
 */
function readPayoutDetails(row: PayoutQueueRow): string {
  const decrypted = decryptCreatorPayoutDetails(row.payout_details);
  if (decrypted.ok) {
    return decrypted.plaintext;
  }

  logBackendError('creator_payout_details_decrypt_failed', {
    requestId: row.id,
    reason: decrypted.reason,
  });
  return '[payout details unavailable: '
    + (decrypted.reason === 'key_unconfigured'
      ? 'CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY is not configured'
      : 'stored ciphertext failed to decrypt')
    + ']';
}

export type ResolveCreatorPayoutResult =
  | { ok: true; status: 'paid' | 'rejected'; amountTokenSubunits: number }
  | {
      ok: false;
      error: string;
      code: 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'REASON_REQUIRED' | 'INVALID_ACTION';
    };

export async function resolveCreatorPayoutRequest({
  adminSupabase,
  requestId,
  reviewerUserId,
  action,
  resolutionNote,
  externalReference,
}: {
  adminSupabase: SupabaseClient;
  requestId: string;
  reviewerUserId: string;
  action: 'mark_paid' | 'reject';
  resolutionNote?: string | null;
  externalReference?: string | null;
}): Promise<ResolveCreatorPayoutResult> {
  const { data, error } = await adminSupabase.rpc('resolve_creator_payout_request', {
    p_request_id: requestId,
    p_reviewer_id: reviewerUserId,
    p_action: action,
    p_resolution_note: resolutionNote ?? null,
    p_external_reference: externalReference ?? null,
  });

  if (error) {
    logBackendError('creator_payout_resolution_failed', { error: error });
    throw error;
  }

  const result = (data ?? {}) as { status?: string; amount_token_subunits?: number };

  switch (result.status) {
    case 'paid':
    case 'rejected':
      return {
        ok: true,
        status: result.status,
        amountTokenSubunits: Number(result.amount_token_subunits ?? 0),
      };
    case 'not_found':
      return { ok: false, code: 'NOT_FOUND', error: 'That payout request no longer exists.' };
    case 'already_resolved':
      return { ok: false, code: 'ALREADY_RESOLVED', error: 'That payout request was already settled.' };
    case 'reason_required':
      return { ok: false, code: 'REASON_REQUIRED', error: 'A rejection needs a reason the creator can read.' };
    default:
      return { ok: false, code: 'INVALID_ACTION', error: 'Unsupported payout action.' };
  }
}
