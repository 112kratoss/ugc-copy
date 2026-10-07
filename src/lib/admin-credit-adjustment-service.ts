import 'server-only';

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { planAdminCreditAdjustmentDeltas } from '@/lib/admin-credit-adjustment-policy';

/**
 * Operator-initiated credit adjustments.
 *
 * The database side (`apply_admin_credit_adjustment`) is deliberately dumb: it
 * applies whatever deltas it is given, atomically, with an audit row and an
 * idempotency key. All *policy* — which balance a grant lands in, and how large
 * an adjustment one operator may make unattended — lives here in TypeScript
 * where it is unit-testable and easy to revise.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type AdminCreditAdjustmentIntent =
  /** Goodwill after a bad experience — a failed generation, a support apology. */
  | 'goodwill'
  /** Returning value the user actually paid for but did not receive. */
  | 'refund'
  /** Removing credits granted in error or obtained abusively. */
  | 'clawback';

export type AdminCreditAdjustmentRequest = {
  userId: string;
  intent: AdminCreditAdjustmentIntent;
  /** Always a positive magnitude. `clawback` turns it negative via the policy. */
  amount: number;
  reason: string;
};

export type AdminCreditAdjustmentPlan = {
  creditsDelta: number;
  promotionalCreditsDelta: number;
};

export type AdminCreditAdjustmentResult = {
  status: 'applied' | 'already_applied' | 'not_found' | 'invalid';
  adjustmentId: string | null;
  credits: number | null;
  promotionalCredits: number | null;
  error: string | null;
};

/**
 * The maximum magnitude a single adjustment may move, in credits. Anything
 * larger has to be split into multiple audited actions, so an accidental extra
 * zero cannot quietly mint a fortune.
 */
export const ADMIN_CREDIT_ADJUSTMENT_MAX = 10_000;

/**
 * Maps an operator's intent onto the two balances Magicbooklet carries.
 *
 *   - `credits`               total spendable value. Refund reconciliation
 *                             (`reconcile_credit_purchase_adjustment`) subtracts
 *                             from this column and is allowed to drive it
 *                             negative, so it behaves like a money liability.
 *   - `promotional_credits`   the promotional subset of that total. Welcome and
 *                             referral bonuses increase both columns. Spend
 *                             paths reserve promotional value first, and
 *                             spending clamps it with `greatest(x, 0)`.
 *
 * The policy:
 *
 *   goodwill  → total and promotional equally, preserving purchased value.
 *   refund    → total only, restoring purchased value without adding promotion.
 *   clawback  → total and promotional equally, reversing a promotional grant.
 *               Reversing a real payment is deliberately NOT done here — that
 *               belongs to `reconcile_credit_purchase_adjustment`, which also
 *               reconciles the provider-side transaction. Letting an operator
 *               reverse a payment through this route would desynchronise its
 *               provider-side transaction record.
 *
 * Kept pure — no balance lookup — so there is no read-then-write race with the
 * RPC, which locks the profile row itself. Clawing back more than the user
 * holds is allowed to go negative, matching the DECISION in
 * 20260725231000_credit_integrity_constraints.sql.
 */
export function planAdminCreditAdjustment(
  request: AdminCreditAdjustmentRequest,
): AdminCreditAdjustmentPlan {
  return planAdminCreditAdjustmentDeltas(request.intent, request.amount);
}

export function validateAdminCreditAdjustment(
  request: AdminCreditAdjustmentRequest,
): string | null {
  if (!UUID_PATTERN.test(request.userId)) {
    return 'User id must be a UUID.';
  }
  if (!Number.isInteger(request.amount) || request.amount <= 0) {
    return 'Amount must be a positive whole number of credits.';
  }
  if (request.amount > ADMIN_CREDIT_ADJUSTMENT_MAX) {
    return `Amount must be ${ADMIN_CREDIT_ADJUSTMENT_MAX.toLocaleString()} credits or fewer per adjustment.`;
  }
  const reason = request.reason.trim();
  if (reason.length < 3 || reason.length > 1000) {
    return 'Reason must be between 3 and 1000 characters.';
  }
  return null;
}

export async function applyAdminCreditAdjustment(
  client: SupabaseClient,
  options: AdminCreditAdjustmentRequest & {
    reviewerId: string;
    /** Supplied by the caller so a retried submit cannot double-credit. */
    idempotencyKey?: string;
  },
): Promise<AdminCreditAdjustmentResult> {
  const validationError = validateAdminCreditAdjustment(options);
  if (validationError) {
    return {
      status: 'invalid',
      adjustmentId: null,
      credits: null,
      promotionalCredits: null,
      error: validationError,
    };
  }

  const plan = planAdminCreditAdjustment(options);

  const { data, error } = await client.rpc('apply_admin_credit_adjustment', {
    p_user_id: options.userId,
    p_reviewer_id: options.reviewerId,
    p_credits_delta: plan.creditsDelta,
    p_promotional_credits_delta: plan.promotionalCreditsDelta,
    p_reason: options.reason.trim(),
    p_idempotency_key: options.idempotencyKey ?? randomUUID(),
  });

  if (error) throw error;

  const result = (data ?? {}) as Record<string, unknown>;
  const status = String(result.status ?? '');

  return {
    status: status === 'applied' || status === 'already_applied' || status === 'not_found'
      ? status
      : 'invalid',
    adjustmentId: typeof result.adjustment_id === 'string' ? result.adjustment_id : null,
    credits: typeof result.credits === 'number' ? result.credits : null,
    promotionalCredits: typeof result.promotional_credits === 'number'
      ? result.promotional_credits
      : null,
    error: typeof result.error === 'string' ? result.error : null,
  };
}

export async function listAdminCreditAdjustments(
  client: SupabaseClient,
  userId: string,
  limit = 20,
): Promise<Array<{
  id: string;
  creditsDelta: number;
  promotionalCreditsDelta: number;
  reason: string;
  reviewerId: string;
  createdAt: string;
}>> {
  const { data, error } = await client
    .from('admin_credit_adjustments')
    .select('id, credits_delta, promotional_credits_delta, reason, reviewer_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    creditsDelta: Number(row.credits_delta ?? 0),
    promotionalCreditsDelta: Number(row.promotional_credits_delta ?? 0),
    reason: String(row.reason ?? ''),
    reviewerId: String(row.reviewer_id ?? ''),
    createdAt: String(row.created_at ?? ''),
  }));
}
