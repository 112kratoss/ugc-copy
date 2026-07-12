import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { notifyReferralReward } from '@/lib/mobile-notifications';
import {
  getReferralRewardNotifications,
  settleReferralPurchaseRewards,
  type ReferralRewardSettlement,
} from '@/lib/referral-reward-service';

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export async function notifyReferralRewardSettlement(
  adminSupabase: SupabaseClient,
  settlement: ReferralRewardSettlement,
) {
  const rewards = getReferralRewardNotifications(settlement);
  await Promise.all(rewards.map((reward) => notifyReferralReward(adminSupabase, {
    userId: reward.userId,
    credits: reward.credits,
    rewardId: reward.rewardId,
    reversed: reward.notificationType === 'referral_reward_reversed',
    eventKey: reward.eventKey,
  })));
  return rewards;
}

/**
 * Referral rewards are downstream of the verified credit purchase. This
 * boundary intentionally logs and returns a repairable failure instead of
 * turning an already-paid top-up into a checkout error.
 */
export async function settleCreditPurchaseReferralRewards({
  adminSupabase,
  purchaserUserId,
  transactionId,
  source,
}: {
  adminSupabase: SupabaseClient;
  purchaserUserId: string;
  transactionId: string;
  source: 'razorpay_verify' | 'razorpay_webhook' | 'mobile_purchase';
}) {
  try {
    const settlement = await settleReferralPurchaseRewards(adminSupabase, transactionId);
    const rewards = await notifyReferralRewardSettlement(adminSupabase, settlement);
    return {
      status: settlement.status,
      purchaserBonusCredits: rewards
        .filter((reward) => (
          reward.userId === purchaserUserId
          && reward.kind === 'invitee_first_purchase'
          && reward.notificationType === 'referral_reward_earned'
        ))
        .reduce((total, reward) => total + reward.credits, 0),
      rewarded: rewards.length > 0,
    };
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'credit_purchase_referral_settlement_deferred',
      source,
      transactionId,
      error: errorMessage(error),
    }));
    return null;
  }
}
