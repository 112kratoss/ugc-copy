import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendDeferrableNotification, type RunAfterResponse } from '@/lib/deferrable-notification';
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
  runAfterResponse,
}: {
  adminSupabase: SupabaseClient;
  purchaserUserId: string;
  transactionId: string;
  source: 'razorpay_verify' | 'razorpay_webhook' | 'mobile_purchase';
  /**
   * Runs a task once the caller has answered its request. The checkout's
   * verify route and the app's purchase sync and restore pass one: a buyer is
   * waiting on them with the payment already taken. The webhooks pass none,
   * so there the rewards are announced before this returns.
   */
  runAfterResponse?: RunAfterResponse;
}) {
  try {
    const settlement = await settleReferralPurchaseRewards(adminSupabase, transactionId);
    // What the caller is told comes from the settlement. Announcing the
    // rewards changes none of it, so that part can go out behind the answer.
    const rewards = getReferralRewardNotifications(settlement);
    if (rewards.length > 0) {
      await sendDeferrableNotification(
        runAfterResponse,
        () => notifyReferralRewardSettlement(adminSupabase, settlement),
      );
    }
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
    logBackendError('credit_purchase_referral_settlement_deferred', {
    source,
      transactionId,
      error: errorMessage(error),
  });
    return null;
  }
}
