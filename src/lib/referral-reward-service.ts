import 'server-only';

export type ReferralRewardKind = 'inviter_purchase' | 'invitee_first_purchase';
export type ReferralRewardStatus = 'granted' | 'partially_reversed' | 'reversed';
export type ReferralRewardNotificationType =
  | 'referral_reward_earned'
  | 'referral_reward_reversed';

export type ReferralRewardNotification = {
  eventKey: string;
  rewardId: string;
  userId: string;
  credits: number;
  activeCredits: number;
  kind: ReferralRewardKind;
  status: ReferralRewardStatus;
  notificationType: ReferralRewardNotificationType;
};

export type ReferralRewardSettlement = {
  status: string;
  rewards: ReferralRewardNotification[];
};

type ReferralRewardRpcResult = {
  data: unknown;
  error: { message?: string } | Error | null;
};

export type ReferralRewardRpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<ReferralRewardRpcResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isRewardKind(value: unknown): value is ReferralRewardKind {
  return value === 'inviter_purchase' || value === 'invitee_first_purchase';
}

function isRewardStatus(value: unknown): value is ReferralRewardStatus {
  return value === 'granted' || value === 'partially_reversed' || value === 'reversed';
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Referral reward response contained an invalid ${field}`);
  }
  return parsed;
}

function parseReward(
  value: unknown,
  notificationType: ReferralRewardNotificationType,
): ReferralRewardNotification {
  if (!isRecord(value)
      || typeof value.id !== 'string'
      || typeof value.user_id !== 'string'
      || typeof value.event_key !== 'string'
      || !isRewardKind(value.kind)
      || !isRewardStatus(value.status)) {
    throw new Error('Referral reward response contained an invalid reward');
  }

  return {
    eventKey: value.event_key,
    rewardId: value.id,
    userId: value.user_id,
    credits: parseNonNegativeInteger(value.credits, 'credits'),
    activeCredits: parseNonNegativeInteger(value.active_credits, 'active credits'),
    kind: value.kind,
    status: value.status,
    notificationType,
  };
}

function parseSettlement(
  value: unknown,
  notificationType: ReferralRewardNotificationType,
): ReferralRewardSettlement {
  if (!isRecord(value) || typeof value.status !== 'string' || !Array.isArray(value.rewards)) {
    throw new Error('Referral reward RPC returned an invalid response');
  }

  return {
    status: value.status,
    rewards: value.rewards.map((reward) => parseReward(reward, notificationType)),
  };
}

async function callRewardRpc(
  adminSupabase: ReferralRewardRpcClient,
  rpcName: string,
  args: Record<string, unknown>,
  notificationType: ReferralRewardNotificationType,
): Promise<ReferralRewardSettlement> {
  const { data, error } = await adminSupabase.rpc(rpcName, args);
  if (error) {
    throw error instanceof Error
      ? error
      : new Error(error.message || `${rpcName} failed`);
  }

  return parseSettlement(data, notificationType);
}

export function getReferralRewardNotifications(
  settlement: ReferralRewardSettlement,
): ReferralRewardNotification[] {
  return settlement.rewards.filter((reward) => reward.credits > 0);
}

export async function settleReferralPurchaseRewards(
  adminSupabase: ReferralRewardRpcClient,
  transactionId: string,
): Promise<ReferralRewardSettlement> {
  return callRewardRpc(
    adminSupabase,
    'settle_referral_purchase_rewards',
    { p_transaction_id: transactionId },
    'referral_reward_earned',
  );
}

export async function reverseReferralPurchaseRewards(
  adminSupabase: ReferralRewardRpcClient,
  transactionId: string,
  reason: string,
): Promise<ReferralRewardSettlement> {
  return callRewardRpc(
    adminSupabase,
    'reverse_referral_purchase_rewards',
    { p_transaction_id: transactionId, p_reason: reason },
    'referral_reward_reversed',
  );
}

export async function restoreReferralPurchaseRewards(
  adminSupabase: ReferralRewardRpcClient,
  transactionId: string,
): Promise<ReferralRewardSettlement> {
  return callRewardRpc(
    adminSupabase,
    'restore_referral_purchase_rewards',
    { p_transaction_id: transactionId },
    'referral_reward_earned',
  );
}

export async function reconcileReferralPurchaseRewardAdjustment(
  adminSupabase: ReferralRewardRpcClient,
  input: {
    transactionId: string;
    action: 'reverse' | 'restore';
    purchaseCredits: number;
    adjustmentKey: string;
    reason?: string | null;
  },
): Promise<ReferralRewardSettlement> {
  return callRewardRpc(
    adminSupabase,
    'reconcile_referral_purchase_reward_adjustment',
    {
      p_transaction_id: input.transactionId,
      p_action: input.action,
      p_purchase_credits: input.purchaseCredits,
      p_adjustment_key: input.adjustmentKey,
      p_reason: input.reason ?? null,
    },
    input.action === 'reverse' ? 'referral_reward_reversed' : 'referral_reward_earned',
  );
}

export async function reconcileRazorpayCreditPurchaseAdjustment(
  adminSupabase: ReferralRewardRpcClient,
  input: {
    transactionId: string;
    providerEventId: string;
    cumulativeReversedSubunits: number;
    action: 'reverse' | 'restore';
    reason: string;
  },
): Promise<ReferralRewardSettlement> {
  return callRewardRpc(
    adminSupabase,
    'reconcile_razorpay_credit_purchase_adjustment',
    {
      p_transaction_id: input.transactionId,
      p_provider_event_id: input.providerEventId,
      p_cumulative_reversed_subunits: input.cumulativeReversedSubunits,
      p_action: input.action,
      p_reason: input.reason,
    },
    input.action === 'reverse' ? 'referral_reward_reversed' : 'referral_reward_earned',
  );
}

export async function reconcileMobileCreditPurchaseAdjustment(
  adminSupabase: ReferralRewardRpcClient,
  input: {
    externalOrderId: string;
    userId: string;
    productId: string;
    providerEventId: string;
    providerEventTimestampMs: number;
    action: 'refund' | 'restore';
  },
): Promise<ReferralRewardSettlement> {
  return callRewardRpc(
    adminSupabase,
    'reconcile_mobile_credit_purchase_adjustment',
    {
      p_external_order_id: input.externalOrderId,
      p_user_id: input.userId,
      p_product_id: input.productId,
      p_event_id: input.providerEventId,
      p_event_timestamp_ms: input.providerEventTimestampMs,
      p_action: input.action,
    },
    input.action === 'refund' ? 'referral_reward_reversed' : 'referral_reward_earned',
  );
}
