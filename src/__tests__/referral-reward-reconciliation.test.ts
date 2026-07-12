import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rewardState = vi.hoisted(() => ({
  settle: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/lib/referral-reward-service', () => ({
  getReferralRewardNotifications: (settlement: { rewards: Array<{ credits: number }> }) => (
    settlement.rewards.filter((reward) => reward.credits > 0)
  ),
  settleReferralPurchaseRewards: (...args: unknown[]) => rewardState.settle(...args),
}));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyReferralReward: (...args: unknown[]) => rewardState.notify(...args),
}));

import {
  hasUnsettledReferralPurchaseTransactions,
  listUnsettledReferralPurchaseTransactionIds,
  reconcileReferralPurchaseRewards,
  REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT,
} from '@/lib/referral-reward-reconciliation';

function createClient(result: { data: unknown; error: Error | null }) {
  const rpc = vi.fn(async () => result);
  return {
    client: { rpc } as unknown as SupabaseClient,
    rpc,
  };
}

describe('referral reward reconciliation', () => {
  beforeEach(() => {
    rewardState.settle.mockReset();
    rewardState.settle.mockResolvedValue({ status: 'already_settled', rewards: [] });
    rewardState.notify.mockReset();
    rewardState.notify.mockResolvedValue({ created: true });
  });

  it('checks for work with a one-row service-role RPC query', async () => {
    const db = createClient({
      data: [{ transaction_id: 'transaction-1' }],
      error: null,
    });

    await expect(hasUnsettledReferralPurchaseTransactions(db.client)).resolves.toBe(true);
    expect(db.rpc).toHaveBeenCalledWith('list_unsettled_referral_purchase_transactions', {
      p_limit: 1,
    });
  });

  it('reports no work when the unsettled purchase query is empty', async () => {
    const db = createClient({ data: [], error: null });

    await expect(hasUnsettledReferralPurchaseTransactions(db.client)).resolves.toBe(false);
  });

  it('settles a bounded batch and isolates individual transaction failures', async () => {
    const db = createClient({
      data: [
        { transaction_id: 'transaction-1' },
        { transaction_id: 'transaction-2' },
        { transaction_id: 'transaction-3' },
      ],
      error: null,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rewardState.settle.mockImplementation(async (_client, transactionId: string) => {
      if (transactionId === 'transaction-2') throw new Error('temporary notification failure');
      if (transactionId === 'transaction-1') {
        return {
          status: 'settled',
          rewards: [{
            eventKey: 'ledger-grant-1',
            rewardId: 'reward-1',
            userId: 'user-1',
            credits: 5,
            activeCredits: 5,
            kind: 'inviter_purchase',
            status: 'granted',
            notificationType: 'referral_reward_earned',
          }],
        };
      }
      return { status: 'already_settled', rewards: [] };
    });

    await expect(reconcileReferralPurchaseRewards(db.client)).resolves.toEqual({
      processed: 3,
      settled: 1,
      failed: 1,
      failures: [{
        transactionId: 'transaction-2',
        error: 'temporary notification failure',
      }],
    });
    expect(db.rpc).toHaveBeenCalledWith('list_unsettled_referral_purchase_transactions', {
      p_limit: REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT,
    });
    expect(rewardState.settle).toHaveBeenCalledTimes(3);
    expect(rewardState.settle).toHaveBeenCalledWith(db.client, 'transaction-1');
    expect(rewardState.settle).toHaveBeenCalledWith(db.client, 'transaction-3');
    expect(rewardState.notify).toHaveBeenCalledWith(db.client, {
      userId: 'user-1',
      credits: 5,
      rewardId: 'reward-1',
      eventKey: 'ledger-grant-1',
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(
      'referral_reward_reconciliation_item_failed',
    ));
  });

  it('deduplicates rows and never processes beyond the requested limit', async () => {
    const db = createClient({
      data: [
        { transaction_id: 'transaction-1' },
        { transaction_id: 'transaction-1' },
        { transaction_id: 'transaction-2' },
      ],
      error: null,
    });
    rewardState.settle.mockResolvedValue({
      status: 'settled',
      rewards: [{
        eventKey: 'ledger-grant-1',
        rewardId: 'reward-1',
        userId: 'user-1',
        credits: 5,
        activeCredits: 5,
        kind: 'inviter_purchase',
        status: 'granted',
        notificationType: 'referral_reward_earned',
      }],
    });

    await expect(reconcileReferralPurchaseRewards(db.client, { limit: 1 })).resolves.toMatchObject({
      processed: 1,
      settled: 1,
      failed: 0,
    });
    expect(rewardState.settle).toHaveBeenCalledTimes(1);
    expect(rewardState.settle).toHaveBeenCalledWith(db.client, 'transaction-1');
  });

  it('fails the batch on catastrophic list-query and payload errors', async () => {
    const queryFailure = createClient({ data: null, error: new Error('database unavailable') });
    await expect(reconcileReferralPurchaseRewards(queryFailure.client)).rejects.toThrow(
      'database unavailable',
    );
    expect(rewardState.settle).not.toHaveBeenCalled();

    const invalidPayload = createClient({ data: [{ transaction_id: null }], error: null });
    await expect(reconcileReferralPurchaseRewards(invalidPayload.client)).rejects.toThrow(
      'invalid transaction id',
    );
    expect(rewardState.settle).not.toHaveBeenCalled();
  });

  it('rejects unsafe batch limits before querying the database', async () => {
    const db = createClient({ data: [], error: null });

    await expect(listUnsettledReferralPurchaseTransactionIds(db.client, { limit: 0 })).rejects.toThrow(
      'limit must be between 1 and 100',
    );
    await expect(listUnsettledReferralPurchaseTransactionIds(db.client, { limit: 101 })).rejects.toThrow(
      'limit must be between 1 and 100',
    );
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
