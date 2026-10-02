import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';

const mocks = vi.hoisted(() => ({
  notifyReferralReward: vi.fn(),
  settleReferralPurchaseRewards: vi.fn(),
}));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyReferralReward: (...args: unknown[]) => mocks.notifyReferralReward(...args),
}));

vi.mock('@/lib/referral-reward-service', () => ({
  getReferralRewardNotifications: (settlement: { rewards: Array<{ credits: number }> }) => (
    settlement.rewards.filter((reward) => reward.credits > 0)
  ),
  settleReferralPurchaseRewards: (...args: unknown[]) => mocks.settleReferralPurchaseRewards(...args),
}));

import { settleCreditPurchaseReferralRewards } from '@/lib/credit-referral-integration';

describe('credit purchase referral settlement boundary', () => {
  beforeEach(() => {
    mocks.notifyReferralReward.mockReset();
    mocks.notifyReferralReward.mockResolvedValue(null);
    mocks.settleReferralPurchaseRewards.mockReset();
  });

  it('notifies each ledger event and returns the purchaser welcome bonus', async () => {
    mocks.settleReferralPurchaseRewards.mockResolvedValue({
      status: 'settled',
      rewards: [
        {
          eventKey: 'grant:inviter',
          rewardId: 'reward-inviter',
          userId: 'inviter-1',
          credits: 5,
          activeCredits: 5,
          kind: 'inviter_purchase',
          status: 'granted',
          notificationType: 'referral_reward_earned',
        },
        {
          eventKey: 'grant:invitee',
          rewardId: 'reward-invitee',
          userId: 'buyer-1',
          credits: 5,
          activeCredits: 5,
          kind: 'invitee_first_purchase',
          status: 'granted',
          notificationType: 'referral_reward_earned',
        },
      ],
    });

    await expect(settleCreditPurchaseReferralRewards({
      adminSupabase: {} as never,
      purchaserUserId: 'buyer-1',
      transactionId: 'transaction-1',
      source: 'razorpay_verify',
    })).resolves.toEqual({
      status: 'settled',
      purchaserBonusCredits: 5,
      rewarded: true,
    });
    expect(mocks.notifyReferralReward).toHaveBeenCalledTimes(2);
    expect(mocks.notifyReferralReward).toHaveBeenCalledWith({}, expect.objectContaining({
      eventKey: 'grant:invitee',
      rewardId: 'reward-invitee',
      userId: 'buyer-1',
    }));
  });

  it('defers a failed referral grant without failing the verified purchase', async () => {
    mocks.settleReferralPurchaseRewards.mockRejectedValue(new Error('database unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(settleCreditPurchaseReferralRewards({
      adminSupabase: {} as never,
      purchaserUserId: 'buyer-1',
      transactionId: 'transaction-1',
      source: 'mobile_purchase',
    })).resolves.toBeNull();

    expect(mocks.notifyReferralReward).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('credit_purchase_referral_settlement_deferred'));
    errorSpy.mockRestore();
  });
});

describe('credit purchase referral notifications', () => {
  // The real notifier runs here against held notification history. A referred
  // buyer's first purchase earns two rewards, and each person is told of theirs.
  const referredSettlement = {
    status: 'settled',
    rewards: [
      {
        eventKey: 'grant:inviter',
        rewardId: 'reward-inviter',
        userId: 'inviter-1',
        credits: 5,
        activeCredits: 5,
        kind: 'inviter_purchase',
        status: 'granted',
        notificationType: 'referral_reward_earned',
      },
      {
        eventKey: 'grant:invitee',
        rewardId: 'reward-invitee',
        userId: 'buyer-1',
        credits: 5,
        activeCredits: 5,
        kind: 'invitee_first_purchase',
        status: 'granted',
        notificationType: 'referral_reward_earned',
      },
    ],
  };
  const rewardKeys = [
    'referral-reward:reward-inviter:grant:inviter',
    'referral-reward:reward-invitee:grant:invitee',
  ];
  const rewardNotifications = [
    expect.objectContaining({ user_id: 'inviter-1', type: 'referral_reward_earned', dedupe_key: rewardKeys[0] }),
    expect.objectContaining({ user_id: 'buyer-1', type: 'referral_reward_earned', dedupe_key: rewardKeys[1] }),
  ];
  // What the buyer's answer is built from. It comes from the settlement, not
  // from the notifications, so it must be the same whenever they are sent.
  const settled = { status: 'settled', purchaserBonusCredits: 5, rewarded: true };

  function settle(history: MobileNotificationHistory, runAfterResponse?: (task: () => Promise<unknown>) => void) {
    return settleCreditPurchaseReferralRewards({
      adminSupabase: withMobileNotificationHistory({} as SupabaseClient, history),
      purchaserUserId: 'buyer-1',
      transactionId: 'transaction-1',
      source: 'razorpay_verify',
      runAfterResponse,
    });
  }

  beforeEach(async () => {
    const { notifyReferralReward } = await vi.importActual<typeof import('@/lib/mobile-notifications')>(
      '@/lib/mobile-notifications',
    );
    mocks.notifyReferralReward.mockReset();
    mocks.notifyReferralReward.mockImplementation(notifyReferralReward);
    mocks.settleReferralPurchaseRewards.mockReset();
    mocks.settleReferralPurchaseRewards.mockResolvedValue(referredSettlement);
  });

  it('settles a referred purchase before its rewards are announced when the caller can run work after the response', async () => {
    const history = createMobileNotificationHistory();
    history.hold();
    const deferred: Array<() => Promise<unknown>> = [];

    const settlement = settle(history, (task) => { deferred.push(task); });

    // A notification that has not finished no longer holds the buyer's answer
    // back, and the bonus that answer reports is the one it always was.
    expect(await hasAnswered(settlement)).toBe(true);
    await expect(settlement).resolves.toEqual(settled);
    expect(history.started).toEqual([]);
    expect(deferred).toHaveLength(1);

    history.release();
    await deferred[0]();
    expect(history.sent).toEqual(rewardNotifications);
  });

  it('announces the rewards before settling when the caller has nowhere to run them afterwards', async () => {
    const history = createMobileNotificationHistory();
    history.hold();

    const settlement = settle(history);

    expect(await hasAnswered(settlement)).toBe(false);
    expect(history.started).toEqual(rewardKeys);

    history.release();
    await expect(settlement).resolves.toEqual(settled);
    expect(history.sent).toEqual(rewardNotifications);
  });

  it('defers nothing for a purchase that earned no reward', async () => {
    mocks.settleReferralPurchaseRewards.mockResolvedValue({ status: 'not_referred', rewards: [] });
    const history = createMobileNotificationHistory();
    const runAfterResponse = vi.fn();

    await expect(settle(history, runAfterResponse)).resolves.toEqual({
      status: 'not_referred',
      purchaserBonusCredits: 0,
      rewarded: false,
    });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('defers nothing when the referral grant itself fails', async () => {
    mocks.settleReferralPurchaseRewards.mockRejectedValue(new Error('database unavailable'));
    const history = createMobileNotificationHistory();
    const runAfterResponse = vi.fn();
    const restoreLogSink = setBackendLogSink(() => {});

    try {
      await expect(settle(history, runAfterResponse)).resolves.toBeNull();
    } finally {
      restoreLogSink();
    }

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('announces the rewards in front of the answer rather than drop the bonus when the task cannot be queued', async () => {
    const history = createMobileNotificationHistory();
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      // The purchase is settled and the bonus granted. A scheduler that will
      // not take the task must not turn that into an answer without the bonus.
      await expect(settle(history, () => {
        throw new Error('`after` was called outside a request scope.');
      })).resolves.toEqual(settled);
    } finally {
      restoreLogSink();
    }

    expect(history.sent).toEqual(rewardNotifications);
    expect(logged).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'mobile_notification_deferral_failed',
        errorMessage: '`after` was called outside a request scope.',
      }),
    ]);
  });
});
