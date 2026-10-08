import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import { notifyReferralReward } from '@/lib/mobile-notifications';
import { deliverReferralRewardNotifications, hasPendingReferralRewardNotifications, type ReferralNotificationDeliverySummary } from '@/lib/referral-reward-notifications';
import {
  getReferralRewardNotifications,
  settleReferralPurchaseRewards,
} from '@/lib/referral-reward-service';

export const REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT = 100;
const SETTLEMENT_CONCURRENCY = 10;

type UnsettledReferralPurchaseRow = {
  transaction_id: string;
};

export type ReferralRewardReconciliationFailure = {
  transactionId: string;
  error: string;
};

export type ReferralRewardReconciliationSummary = {
  processed: number;
  settled: number;
  failed: number;
  failures: ReferralRewardReconciliationFailure[];
  notificationDelivery: ReferralNotificationDeliverySummary;
};

export class ReferralRewardReconciliationError extends Error {
  constructor(readonly summary: ReferralRewardReconciliationSummary) {
    super('Referral reconciliation has retryable failures');
    this.name = 'ReferralRewardReconciliationError';
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT) {
    throw new Error(
      `Referral reward reconciliation limit must be between 1 and ${REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT}`,
    );
  }
  return limit;
}

function normalizeTransactionIds(data: unknown): string[] {
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) {
    throw new Error('Unsettled referral purchase RPC returned an invalid result');
  }

  const transactionIds: string[] = [];
  const seen = new Set<string>();

  for (const candidate of data) {
    const transactionId = candidate && typeof candidate === 'object'
      ? (candidate as Partial<UnsettledReferralPurchaseRow>).transaction_id
      : undefined;

    if (typeof transactionId !== 'string' || transactionId.trim().length === 0) {
      throw new Error('Unsettled referral purchase RPC returned an invalid transaction id');
    }

    if (!seen.has(transactionId)) {
      seen.add(transactionId);
      transactionIds.push(transactionId);
    }
  }

  return transactionIds;
}

export async function listUnsettledReferralPurchaseTransactionIds(
  adminSupabase: SupabaseClient,
  options: { limit?: number } = {},
): Promise<string[]> {
  const limit = validateLimit(options.limit ?? REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT);
  const { data, error } = await adminSupabase.rpc(
    'list_unsettled_referral_purchase_transactions',
    { p_limit: limit },
  );

  if (error) throw error;
  return normalizeTransactionIds(data).slice(0, limit);
}

export async function hasUnsettledReferralPurchaseTransactions(
  adminSupabase: SupabaseClient,
): Promise<boolean> {
  const transactionIds = await listUnsettledReferralPurchaseTransactionIds(adminSupabase, {
    limit: 1,
  });
  return transactionIds.length > 0 || await hasPendingReferralRewardNotifications(adminSupabase);
}

export async function reconcileReferralPurchaseRewards(
  adminSupabase: SupabaseClient,
  options: { limit?: number } = {},
): Promise<ReferralRewardReconciliationSummary> {
  const transactionIds = await listUnsettledReferralPurchaseTransactionIds(adminSupabase, options);
  const failures: ReferralRewardReconciliationFailure[] = [];
  let settled = 0;

  for (let index = 0; index < transactionIds.length; index += SETTLEMENT_CONCURRENCY) {
    const batch = transactionIds.slice(index, index + SETTLEMENT_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (transactionId) => {
      let settlement;
      try {
        settlement = await settleReferralPurchaseRewards(adminSupabase, transactionId);
      } catch (error) {
        // The database rechecks whether settlement committed before deferring.
        // Notification-only failures already have their own durable retry queue.
        const { error: deferError } = await adminSupabase.rpc('defer_referral_purchase_reconciliation', {
          p_transaction_id: transactionId,
        });
        if (deferError) {
          throw new Error(`${errorMessage(error)}; retry deferral failed: ${errorMessage(deferError)}`);
        }
        throw error;
      }
      const rewards = getReferralRewardNotifications(settlement);

      await Promise.all(rewards.map((reward) => notifyReferralReward(adminSupabase, {
        userId: reward.userId,
        credits: reward.credits,
        rewardId: reward.rewardId,
        eventKey: reward.eventKey,
      })));

      return rewards.length > 0;
    }));

    results.forEach((result, resultIndex) => {
      if (result.status === 'fulfilled') {
        if (result.value) settled += 1;
        return;
      }

      const transactionId = batch[resultIndex];
      const failure = {
        transactionId,
        error: errorMessage(result.reason).slice(0, 500),
      };
      failures.push(failure);
      logBackendError('referral_reward_reconciliation_item_failed', {
        transactionId,
        error: failure.error,
      });
    });
  }

  const notificationDelivery = await deliverReferralRewardNotifications(adminSupabase);
  const summary = {
    processed: transactionIds.length,
    settled,
    failed: failures.length,
    failures,
    notificationDelivery,
  };
  if (summary.failed > 0 || notificationDelivery.failed > 0) {
    throw new ReferralRewardReconciliationError(summary);
  }
  return summary;
}
