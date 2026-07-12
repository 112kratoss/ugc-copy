import { beforeEach, describe, expect, it, vi } from 'vitest';

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
