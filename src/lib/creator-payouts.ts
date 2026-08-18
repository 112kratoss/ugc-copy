import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { encryptCreatorPayoutDetails } from '@/lib/creator-payout-details-crypto';
import { POST_RESOURCE_TOKEN_SUBUNITS, POST_RESOURCE_TOKENS_PER_USD } from '@/lib/post-resource-commerce';

/** $100, expressed in the token subunits the wallet is denominated in. */
export const CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS =
  100 * POST_RESOURCE_TOKENS_PER_USD * POST_RESOURCE_TOKEN_SUBUNITS;

export const CREATOR_PAYOUT_METHODS = ['upi', 'bank_transfer', 'paypal'] as const;
export type CreatorPayoutMethod = (typeof CREATOR_PAYOUT_METHODS)[number];

export function isCreatorPayoutMethod(value: unknown): value is CreatorPayoutMethod {
  return typeof value === 'string' && (CREATOR_PAYOUT_METHODS as readonly string[]).includes(value);
}

export function tokenSubunitsToUsdCents(subunits: number): number {
  return Math.floor(subunits / POST_RESOURCE_TOKEN_SUBUNITS);
}

export function formatTokenSubunitsAsUsd(subunits: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(tokenSubunitsToUsdCents(subunits) / 100);
}

export interface CreatorPayoutRequestSummary {
  id: string;
  amountTokenSubunits: number;
  amountUsd: string;
  status: 'requested' | 'paid' | 'rejected';
  payoutMethod: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  externalReference: string | null;
}

export interface CreatorPayoutState {
  availableTokenSubunits: number;
  heldTokenSubunits: number;
  lifetimeEarnedTokenSubunits: number;
  lifetimePaidOutTokenSubunits: number;
  availableUsd: string;
  minimumTokenSubunits: number;
  minimumUsd: string;
  /** False until the balance clears $100 and nothing is already in flight. */
  canRequest: boolean;
  pendingRequest: CreatorPayoutRequestSummary | null;
  history: CreatorPayoutRequestSummary[];
}

type WalletRow = {
  available_token_subunits: number | null;
  held_token_subunits: number | null;
  lifetime_earned_token_subunits: number | null;
  lifetime_paid_out_token_subunits: number | null;
};

type PayoutRequestRow = {
  id: string;
  amount_token_subunits: number;
  status: 'requested' | 'paid' | 'rejected';
  payout_method: string;
  requested_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  external_reference: string | null;
};

function toSummary(row: PayoutRequestRow): CreatorPayoutRequestSummary {
  return {
    id: row.id,
    amountTokenSubunits: row.amount_token_subunits,
    amountUsd: formatTokenSubunitsAsUsd(row.amount_token_subunits),
    status: row.status,
    payoutMethod: row.payout_method,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
    externalReference: row.external_reference,
  };
}

export async function getCreatorPayoutState({
  adminSupabase,
  userId,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
}): Promise<CreatorPayoutState> {
  const [walletResult, requestsResult] = await Promise.all([
    adminSupabase
      .from('creator_resource_wallets')
      .select('available_token_subunits, held_token_subunits, lifetime_earned_token_subunits, lifetime_paid_out_token_subunits')
      .eq('user_id', userId)
      .maybeSingle(),
    adminSupabase
      .from('creator_payout_requests')
      .select('id, amount_token_subunits, status, payout_method, requested_at, resolved_at, resolution_note, external_reference')
      .eq('user_id', userId)
      .order('requested_at', { ascending: false })
      .limit(20),
  ]);

  if (walletResult.error) {
    logBackendError('creator_payout_wallet_load_failed', { error: walletResult.error });
    throw walletResult.error;
  }

  if (requestsResult.error) {
    logBackendError('creator_payout_requests_load_failed', { error: requestsResult.error });
    throw requestsResult.error;
  }

  const wallet = (walletResult.data as WalletRow | null) ?? null;
  const rows = (requestsResult.data ?? []) as PayoutRequestRow[];
  const available = wallet?.available_token_subunits ?? 0;
  const pendingRow = rows.find((row) => row.status === 'requested') ?? null;

  return {
    availableTokenSubunits: available,
    heldTokenSubunits: wallet?.held_token_subunits ?? 0,
    lifetimeEarnedTokenSubunits: wallet?.lifetime_earned_token_subunits ?? 0,
    lifetimePaidOutTokenSubunits: wallet?.lifetime_paid_out_token_subunits ?? 0,
    availableUsd: formatTokenSubunitsAsUsd(available),
    minimumTokenSubunits: CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS,
    minimumUsd: formatTokenSubunitsAsUsd(CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS),
    canRequest: !pendingRow && available >= CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS,
    pendingRequest: pendingRow ? toSummary(pendingRow) : null,
    history: rows.map(toSummary),
  };
}

export type RequestCreatorPayoutResult =
  | { ok: true; requestId: string; amountTokenSubunits: number }
  | {
      ok: false;
      status: 400 | 409;
      error: string;
      code: 'BELOW_MINIMUM' | 'ALREADY_PENDING' | 'INVALID_METHOD' | 'INVALID_DETAILS';
    };

/**
 * Withdraws the whole available balance. Partial withdrawals would need a
 * second amount-validation path for no product benefit -- the balance either
 * clears the floor or it does not.
 */
export async function requestCreatorPayout({
  adminSupabase,
  userId,
  payoutMethod,
  payoutDetails,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  payoutMethod: string;
  payoutDetails: string;
}): Promise<RequestCreatorPayoutResult> {
  // The plaintext bound lives here now: the database CHECK and the RPC only
  // see ciphertext, whose length says nothing about what the creator typed.
  const trimmedDetails = payoutDetails.trim();
  if (trimmedDetails.length < 3 || trimmedDetails.length > 500) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_DETAILS',
      error: 'Add the account details we should send the payout to.',
    };
  }

  const { data, error } = await adminSupabase.rpc('request_creator_payout', {
    p_user_id: userId,
    p_payout_method: payoutMethod,
    p_payout_details: encryptCreatorPayoutDetails(trimmedDetails),
  });

  if (error) {
    logBackendError('creator_payout_request_failed', { error: error });
    throw error;
  }

  const result = (data ?? {}) as {
    status?: string;
    request_id?: string;
    amount_token_subunits?: number;
    minimum_token_subunits?: number;
  };

  switch (result.status) {
    case 'requested':
      return {
        ok: true,
        requestId: String(result.request_id),
        amountTokenSubunits: Number(result.amount_token_subunits ?? 0),
      };
    case 'already_pending':
      return {
        ok: false,
        status: 409,
        code: 'ALREADY_PENDING',
        error: 'You already have a payout in progress. It has to be settled before you can request another.',
      };
    case 'invalid_method':
      return {
        ok: false,
        status: 400,
        code: 'INVALID_METHOD',
        error: 'Choose how you want to be paid.',
      };
    case 'invalid_details':
      return {
        ok: false,
        status: 400,
        code: 'INVALID_DETAILS',
        error: 'Add the account details we should send the payout to.',
      };
    default:
      return {
        ok: false,
        status: 400,
        code: 'BELOW_MINIMUM',
        error: `Payouts start at ${formatTokenSubunitsAsUsd(CREATOR_PAYOUT_MINIMUM_TOKEN_SUBUNITS)}. Keep selling and the balance will get there.`,
      };
  }
}
