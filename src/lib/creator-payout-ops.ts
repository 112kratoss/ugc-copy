import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { runPagedQuery } from '@/lib/admin-paged-query';
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

export interface ResolvedCreatorPayoutRequest {
  id: string;
  userId: string;
  username: string | null;
  displayName: string | null;
  amountTokenSubunits: number;
  amountUsd: string;
  payoutMethod: string;
  status: 'paid' | 'rejected';
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** Bank reference / UTR for a paid request, or the reason for a rejection. */
  resolutionNote: string | null;
  externalReference: string | null;
}

const RESOLVED_PAYOUT_STATUSES = ['paid', 'rejected'];

/**
 * The settled half of the queue.
 *
 * Once an operator marked a request paid or rejected it left the console
 * entirely, so there was no way to answer "did we already pay this creator?"
 * without a database session — and a creator disputing a payment is exactly
 * when that question gets asked.
 *
 * `payout_details` is deliberately not decrypted here. The open queue reveals
 * the destination because the operator needs it to send the money; once the
 * request is settled that need is gone, and re-rendering a bank handle on a
 * long scrollable history is exposure with no operational purpose.
 */
export async function listResolvedCreatorPayoutRequests(
  adminSupabase: SupabaseClient,
  options: { limit?: number; offset?: number } = {},
): Promise<{ requests: ResolvedCreatorPayoutRequest[]; total: number; offset: number }> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

  const page = await runPagedQuery<Record<string, unknown>>(
    (from, to) => adminSupabase
      .from('creator_payout_requests')
      .select(
        'id, user_id, amount_token_subunits, payout_method, status, requested_at, resolved_at, resolved_by, resolution_note, external_reference',
        { count: 'exact' },
      )
      .in('status', RESOLVED_PAYOUT_STATUSES)
      .order('resolved_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(from, to),
    { offset: Math.max(options.offset ?? 0, 0), pageSize: limit },
  ).catch((error) => {
    logBackendError('creator_payout_history_load_failed', { error });
    throw error;
  });

  const rows = page.rows;
  if (rows.length === 0) {
    return { requests: [], total: page.total, offset: page.offset };
  }

  const userIds = Array.from(new Set(rows.map((row) => String(row.user_id))));
  const profilesResult = await adminSupabase
    .from('profiles')
    .select('id, username, display_name')
    .in('id', userIds);

  const profiles = new Map(
    ((profilesResult.data ?? []) as Array<{ id: string; username: string | null; display_name: string | null }>)
      .map((profile) => [profile.id, profile]),
  );

  return {
    requests: rows.map((row) => {
      const userId = String(row.user_id);
      const amountTokenSubunits = Number(row.amount_token_subunits ?? 0);
      return {
        id: String(row.id),
        userId,
        username: profiles.get(userId)?.username ?? null,
        displayName: profiles.get(userId)?.display_name ?? null,
        amountTokenSubunits,
        amountUsd: formatTokenSubunitsAsUsd(amountTokenSubunits),
        payoutMethod: String(row.payout_method ?? ''),
        status: row.status === 'paid' ? 'paid' as const : 'rejected' as const,
        requestedAt: String(row.requested_at ?? ''),
        resolvedAt: (row.resolved_at as string | null) ?? null,
        resolvedBy: (row.resolved_by as string | null) ?? null,
        resolutionNote: (row.resolution_note as string | null) ?? null,
        externalReference: (row.external_reference as string | null) ?? null,
      };
    }),
    total: page.total,
    offset: page.offset,
  };
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
