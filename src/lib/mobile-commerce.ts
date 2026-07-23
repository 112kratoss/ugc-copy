import type { SupabaseClient } from '@supabase/supabase-js';

import {
  notifyReferralRewardSettlement,
  settleCreditPurchaseReferralRewards,
} from '@/lib/credit-referral-integration';
import {
  notifyMarketplaceUnlockCompleted,
  notifyMobileCreditPurchase,
  notifyMobilePurchasesRestored,
  notifyPostResourceUnlockCompleted,
} from '@/lib/mobile-notifications';
import { invalidateMarketplaceResourceListCache as defaultInvalidateMarketplaceResourceListCache } from '@/lib/marketplace-resource-list-cache';
import {
  EXTERNAL_API_REQUEST_TIMEOUT_MS,
  fetchWithProviderTimeout,
  isExternalServiceTimeoutError,
} from '@/lib/provider-fetch';
import { PRICING_PLAN_MAP, type PricingPlan } from '@/lib/pricing';
import type {
  ReferralRewardNotification,
  ReferralRewardSettlement,
} from '@/lib/referral-reward-service';

export type MobilePurchaseProvider = 'app_store' | 'play_store' | 'revenuecat' | 'sandbox';

export type MobilePurchaseEntitlementType =
  | 'credits'
  | 'marketplace_unlock'
  | 'post_resource_unlock';

type MobilePurchaseEntitlement =
  | { type: 'credits'; productId: string; credits: number }
  | { type: 'marketplace_unlock'; productId: string; assetId: string }
  | { type: 'post_resource_unlock'; productId: string; postId: string };

export interface NormalizedMobileCommercePayload {
  provider: MobilePurchaseProvider;
  productId: string;
  transactionId: string | null;
  receiptToken: string | null;
  purchaseIntentId: string | null;
}

export interface MobilePurchaseAuthority {
  entitlementType: MobilePurchaseEntitlementType;
  productId: string;
  purchaseIntentId: string | null;
  resourceId: string | null;
  amountSubunits: number;
  currency: string;
  credits: number | null;
}

export interface MobileCommerceSyncResult {
  success: true;
  entitlement: MobilePurchaseEntitlement['type'];
  credits?: number | null;
  alreadyProcessed?: boolean;
  assetId?: string;
  postId?: string;
  message?: string;
  referralBonusCredits?: number;
}

export class MobileCommerceError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = 'MobileCommerceError';
  }
}

const MOBILE_CREDIT_PRODUCTS = {
  'magicbooklet.credits.starter': 'starter',
  'magicbooklet.credits.creator': 'creator',
  'magicbooklet.credits.pro': 'pro',
} as const;

type MobileCreditProductId = keyof typeof MOBILE_CREDIT_PRODUCTS;

interface RevenueCatPurchase {
  id?: string | number | null;
  store?: string | null;
  store_transaction_id?: string | number | null;
  purchase_date?: string | null;
  refunded_at?: string | null;
}

interface RevenueCatSubscriber {
  non_subscriptions?: Record<string, RevenueCatPurchase[] | undefined> | null;
}

interface RevenueCatResponse {
  subscriber?: RevenueCatSubscriber | null;
  value?: {
    subscriber?: RevenueCatSubscriber | null;
  } | null;
}

interface RestorableMobileCreditPurchase {
  productId: string;
  provider: Exclude<MobilePurchaseProvider, 'sandbox'>;
  transactionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeProvider(value: unknown): MobilePurchaseProvider | null {
  if (value === 'app_store' || value === 'play_store' || value === 'revenuecat' || value === 'sandbox') {
    return value;
  }

  return null;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeMobileCommercePayload(body: unknown): NormalizedMobileCommercePayload {
  if (!isRecord(body)) {
    throw new MobileCommerceError('Invalid mobile purchase payload.');
  }

  const provider = normalizeProvider(body.provider);
  const productId = normalizeOptionalString(body.productId);
  if (!provider || !productId) {
    throw new MobileCommerceError('Missing mobile purchase provider or product ID.');
  }

  const purchaseIntentId = normalizeOptionalString(body.purchaseIntentId)
    ?? normalizeOptionalString(body.purchase_intent_id);
  if (!resolveMobileCreditProduct(productId) && !purchaseIntentId) {
    throw new MobileCommerceError('A server-issued purchase intent is required for this product.');
  }

  return {
    provider,
    productId,
    transactionId: normalizeOptionalString(body.transactionId),
    receiptToken:
      normalizeOptionalString(body.receiptToken)
      ?? normalizeOptionalString(body.receipt)
      ?? normalizeOptionalString(body.fetchToken),
    purchaseIntentId,
  };
}

export function resolveMobileCreditProduct(productId: string): PricingPlan | null {
  const planId = MOBILE_CREDIT_PRODUCTS[productId as MobileCreditProductId];
  return planId ? PRICING_PLAN_MAP[planId] : null;
}

function providerStoreMatches(provider: MobilePurchaseProvider, store: string | null | undefined) {
  if (provider === 'revenuecat' || provider === 'sandbox') {
    return true;
  }

  return store === provider;
}

function isProviderTimeoutError(error: unknown) {
  if (isExternalServiceTimeoutError(error)) {
    return true;
  }

  if (!isRecord(error)) {
    return false;
  }

  return error.name === 'TimeoutError' || error.name === 'AbortError';
}

function latestPurchase(purchases: RevenueCatPurchase[]) {
  return [...purchases].sort((first, second) => {
    const firstTime = Date.parse(first.purchase_date ?? '') || 0;
    const secondTime = Date.parse(second.purchase_date ?? '') || 0;
    return secondTime - firstTime;
  })[0] ?? null;
}

function findRevenueCatPurchase(
  response: RevenueCatResponse,
  productId: string,
  provider: MobilePurchaseProvider,
  transactionId?: string | null
): RevenueCatPurchase | null {
  const subscriber = response.subscriber ?? response.value?.subscriber ?? null;
  const productPurchases = subscriber?.non_subscriptions?.[productId] ?? [];
  const validPurchases = productPurchases.filter((purchase) => {
    if (purchase.refunded_at) {
      return false;
    }

    if (!providerStoreMatches(provider, purchase.store)) {
      return false;
    }

    if (!transactionId) {
      return true;
    }

    return String(purchase.id ?? '') === transactionId || String(purchase.store_transaction_id ?? '') === transactionId;
  });

  return latestPurchase(validPurchases);
}

async function fetchRevenueCatSubscriber({
  userId,
  fetcher = fetch,
  revenueCatApiKey = process.env.REVENUECAT_SECRET_API_KEY ?? process.env.REVENUECAT_REST_API_KEY,
}: {
  userId: string;
  fetcher?: typeof fetch;
  revenueCatApiKey?: string;
}): Promise<RevenueCatResponse> {
  if (!revenueCatApiKey) {
    throw new MobileCommerceError('Mobile receipt verification is not configured.', 500);
  }

  let response: Response;
  try {
    response = await fetchWithProviderTimeout(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${revenueCatApiKey}`,
          'Content-Type': 'application/json',
        },
      },
      EXTERNAL_API_REQUEST_TIMEOUT_MS,
      fetcher,
      'RevenueCat'
    );
  } catch (error) {
    if (isProviderTimeoutError(error)) {
      throw new MobileCommerceError('Mobile purchase verification timed out.', 504);
    }

    throw error;
  }

  if (!response.ok) {
    throw new MobileCommerceError('Unable to verify mobile purchase.', 502);
  }

  return response.json() as Promise<RevenueCatResponse>;
}

function revenueCatStoreProvider(store: string | null | undefined): RestorableMobileCreditPurchase['provider'] {
  return store === 'app_store' || store === 'play_store' ? store : 'revenuecat';
}

function revenueCatPurchaseTransactionId(productId: string, purchase: RevenueCatPurchase) {
  const explicitId = String(purchase.store_transaction_id ?? purchase.id ?? '').trim();
  if (explicitId) {
    return explicitId;
  }

  const purchaseDate = String(purchase.purchase_date ?? '').trim();
  return purchaseDate ? `${productId}_${purchaseDate}` : null;
}

function listRestorableMobileCreditPurchases(response: RevenueCatResponse): RestorableMobileCreditPurchase[] {
  const subscriber = response.subscriber ?? response.value?.subscriber ?? null;
  const nonSubscriptions = subscriber?.non_subscriptions ?? {};
  const purchases: RestorableMobileCreditPurchase[] = [];

  for (const [productId, productPurchases] of Object.entries(nonSubscriptions)) {
    if (!resolveMobileCreditProduct(productId)) {
      continue;
    }

    for (const purchase of productPurchases ?? []) {
      if (purchase.refunded_at) {
        continue;
      }

      const transactionId = revenueCatPurchaseTransactionId(productId, purchase);
      if (!transactionId) {
        continue;
      }

      purchases.push({
        productId,
        provider: revenueCatStoreProvider(purchase.store),
        transactionId,
      });
    }
  }

  return purchases;
}

export function buildMobileExternalOrderId(provider: MobilePurchaseProvider, transactionId: string) {
  const safeTransactionId = transactionId.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 160);
  return `mobile_${provider}_${safeTransactionId}`;
}

export async function verifyMobilePurchase({
  userId,
  productId,
  provider,
  transactionId,
  fetcher = fetch,
  revenueCatApiKey = process.env.REVENUECAT_SECRET_API_KEY ?? process.env.REVENUECAT_REST_API_KEY,
  nodeEnv = process.env.NODE_ENV,
}: {
  userId: string;
  productId: string;
  provider: MobilePurchaseProvider;
  transactionId?: string | null;
  receiptToken?: string | null;
  fetcher?: typeof fetch;
  revenueCatApiKey?: string;
  nodeEnv?: string;
}) {
  if (provider === 'sandbox') {
    if (nodeEnv === 'production') {
      throw new MobileCommerceError('Sandbox mobile purchases are disabled in production.', 400);
    }

    return {
      provider,
      transactionId: transactionId ?? `sandbox_${productId}`,
      raw: null,
    };
  }

  const body = await fetchRevenueCatSubscriber({ userId, fetcher, revenueCatApiKey });
  const purchase = findRevenueCatPurchase(body, productId, provider, transactionId);
  if (!purchase) {
    throw new MobileCommerceError('Mobile purchase receipt is invalid or not owned by this user.', 400);
  }

  const verifiedTransactionId = revenueCatPurchaseTransactionId(productId, purchase) ?? normalizeOptionalString(transactionId);
  if (!verifiedTransactionId) {
    throw new MobileCommerceError('Mobile purchase receipt is invalid or not owned by this user.', 400);
  }

  return {
    provider: purchase.store === 'app_store' || purchase.store === 'play_store' ? purchase.store : provider,
    transactionId: verifiedTransactionId,
    raw: purchase,
  };
}

async function getProfileCredits(adminSupabase: SupabaseClient, userId: string) {
  const { data, error } = await adminSupabase
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new MobileCommerceError('Failed to load credit balance.', 500);
  }

  return typeof data?.credits === 'number' ? data.credits : null;
}

function requiredSafeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function parseEntitlementType(value: unknown): MobilePurchaseEntitlementType | null {
  if (value === 'credits' || value === 'marketplace_unlock' || value === 'post_resource_unlock') {
    return value;
  }
  return null;
}

export async function resolveMobilePurchaseAuthority({
  adminSupabase,
  userId,
  productId,
  purchaseIntentId,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  productId: string;
  purchaseIntentId?: string | null;
}): Promise<MobilePurchaseAuthority> {
  const creditPlan = resolveMobileCreditProduct(productId);
  if (creditPlan) {
    return {
      entitlementType: 'credits',
      productId,
      purchaseIntentId: null,
      resourceId: null,
      amountSubunits: creditPlan.priceInr * 100,
      currency: 'INR',
      credits: creditPlan.credits,
    };
  }

  if (!purchaseIntentId) {
    throw new MobileCommerceError('A server-issued purchase intent is required for this product.');
  }

  const { data, error } = await adminSupabase
    .from('mobile_purchase_intents')
    .select('id, user_id, product_id, entitlement_type, resource_id, amount_subunits, currency, credits, status, expires_at')
    .eq('id', purchaseIntentId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new MobileCommerceError('Failed to load the mobile purchase intent.', 500);
  }
  if (!isRecord(data)) {
    throw new MobileCommerceError('Mobile purchase intent not found.', 404);
  }

  const entitlementType = parseEntitlementType(data.entitlement_type);
  const intentProductId = normalizeOptionalString(data.product_id);
  const resourceId = normalizeOptionalString(data.resource_id);
  const amountSubunits = requiredSafeInteger(data.amount_subunits);
  const currency = normalizeOptionalString(data.currency);
  const status = normalizeOptionalString(data.status);
  const expiresAt = normalizeOptionalString(data.expires_at);

  if (
    !entitlementType
    || entitlementType === 'credits'
    || !intentProductId
    || !resourceId
    || !amountSubunits
    || amountSubunits <= 0
    || !currency
  ) {
    throw new MobileCommerceError('Mobile purchase intent is invalid.', 409);
  }
  if (intentProductId !== productId) {
    throw new MobileCommerceError('Purchase product does not match the server-issued intent.', 409);
  }
  if (status === 'expired' || (status === 'pending' && expiresAt && Date.parse(expiresAt) <= Date.now())) {
    throw new MobileCommerceError('Mobile purchase intent has expired.', 409);
  }
  if (status !== 'pending' && status !== 'consumed' && status !== 'revoked') {
    throw new MobileCommerceError('Mobile purchase intent is not active.', 409);
  }

  return {
    entitlementType,
    productId: intentProductId,
    purchaseIntentId,
    resourceId,
    amountSubunits,
    currency,
    credits: requiredSafeInteger(data.credits),
  };
}

export async function createMobilePurchaseIntent({
  adminSupabase,
  userId,
  entitlementType,
  resourceId,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  entitlementType: Exclude<MobilePurchaseEntitlementType, 'credits'>;
  resourceId: string;
}) {
  if (entitlementType === 'post_resource_unlock') {
    throw new MobileCommerceError(
      'Post resources are credit-only on mobile. Use the credit unlock option.',
      400,
    );
  }

  const { data, error } = await adminSupabase.rpc('create_mobile_purchase_intent', {
    p_user_id: userId,
    p_entitlement_type: entitlementType,
    p_resource_id: resourceId,
  });

  if (error || !isRecord(data) || data.status !== 'created') {
    const status = isRecord(data) ? normalizeOptionalString(data.status) : null;
    if (status === 'not_found') {
      throw new MobileCommerceError('Purchase resource not found.', 404);
    }
    if (status === 'owned_by_user' || status === 'already_owned') {
      throw new MobileCommerceError('You already own this resource.', 400);
    }
    if (status === 'not_paid') {
      throw new MobileCommerceError('This resource does not require a mobile purchase.', 400);
    }
    if (status === 'product_not_configured') {
      throw new MobileCommerceError('No mobile store product is configured for this resource.', 409);
    }
    throw new MobileCommerceError('Failed to create the mobile purchase intent.', 500);
  }

  const purchaseIntentId = normalizeOptionalString(data.purchase_intent_id);
  const productId = normalizeOptionalString(data.product_id);
  const amountSubunits = requiredSafeInteger(data.amount_subunits);
  const currency = normalizeOptionalString(data.currency);
  const expiresAt = normalizeOptionalString(data.expires_at);
  if (!purchaseIntentId || !productId || !amountSubunits || !currency || !expiresAt) {
    throw new MobileCommerceError('Failed to create the mobile purchase intent.', 500);
  }

  return {
    purchaseIntentId,
    productId,
    amountSubunits,
    currency,
    expiresAt,
  };
}

function throwMobileSettlementError(status: string | null, entitlementType: MobilePurchaseEntitlementType): never {
  if (status === 'intent_not_found' || status === 'resource_not_found' || status === 'not_found') {
    throw new MobileCommerceError('Mobile purchase resource not found.', 404);
  }
  if (status === 'owned_by_user') {
    throw new MobileCommerceError('You cannot purchase your own resource.', 400);
  }
  if (status === 'not_paid') {
    throw new MobileCommerceError('This resource does not require a mobile purchase.', 400);
  }
  if (status === 'already_owned') {
    throw new MobileCommerceError('You already own this resource; the store transaction was not consumed.', 409);
  }
  if (status === 'intent_expired') {
    throw new MobileCommerceError('Mobile purchase intent has expired.', 409);
  }
  if (
    status === 'intent_mismatch'
    || status === 'intent_consumed'
    || status === 'intent_revoked'
    || status === 'transaction_conflict'
    || status === 'product_mismatch'
    || status === 'price_mismatch'
  ) {
    throw new MobileCommerceError('Mobile purchase does not match the server-issued intent.', 409);
  }
  if (status === 'revoked') {
    throw new MobileCommerceError('This mobile store transaction has been revoked.', 409);
  }
  if (status === 'product_not_found') {
    throw new MobileCommerceError('Unknown mobile store product.', 400);
  }

  const label = entitlementType === 'credits'
    ? 'credit purchase'
    : entitlementType === 'marketplace_unlock'
      ? 'marketplace purchase'
      : 'post resource purchase';
  throw new MobileCommerceError(`Failed to complete mobile ${label}.`, 500);
}

export async function completeMobilePurchase({
  adminSupabase,
  userId,
  authority,
  provider,
  transactionId,
  invalidateMarketplaceResourceListCache = defaultInvalidateMarketplaceResourceListCache,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  authority: MobilePurchaseAuthority;
  provider: MobilePurchaseProvider;
  transactionId: string;
  invalidateMarketplaceResourceListCache?: () => void;
}): Promise<MobileCommerceSyncResult> {
  const externalOrderId = buildMobileExternalOrderId(provider, transactionId);
  const { data, error } = await adminSupabase.rpc('complete_mobile_purchase', {
    p_user_id: userId,
    p_purchase_intent_id: authority.purchaseIntentId,
    p_product_id: authority.productId,
    p_provider: provider,
    p_store_transaction_id: transactionId,
    p_external_order_id: externalOrderId,
    p_payment_id: `mobile_${provider}_${transactionId}`,
  });

  if (error || !isRecord(data)) {
    throw new MobileCommerceError('Failed to atomically record the mobile purchase.', 500);
  }

  const status = normalizeOptionalString(data.status);
  if (status !== 'completed' && status !== 'already_processed') {
    throwMobileSettlementError(status, authority.entitlementType);
  }

  const settledType = parseEntitlementType(data.entitlement_type);
  const settledProductId = normalizeOptionalString(data.product_id);
  const settledResourceId = normalizeOptionalString(data.resource_id);
  const settledAmount = requiredSafeInteger(data.amount_subunits);
  const settledCurrency = normalizeOptionalString(data.currency);

  if (
    settledType !== authority.entitlementType
    || settledProductId !== authority.productId
    || settledResourceId !== authority.resourceId
    || settledAmount !== authority.amountSubunits
    || settledCurrency !== authority.currency
  ) {
    throw new MobileCommerceError('Mobile purchase settlement identity mismatch.', 409);
  }

  const alreadyProcessed = status === 'already_processed';
  if (authority.entitlementType === 'credits') {
    const creditTransactionId = normalizeOptionalString(data.source_record_id);
    if (!creditTransactionId) {
      throw new MobileCommerceError('Failed to record mobile credit purchase.', 500);
    }
    const referral = await settleCreditPurchaseReferralRewards({
      adminSupabase,
      purchaserUserId: userId,
      transactionId: creditTransactionId,
      source: 'mobile_purchase',
    });
    const credits = requiredSafeInteger(data.remaining_credits) ?? await getProfileCredits(adminSupabase, userId);
    if (!alreadyProcessed) {
      await notifyMobileCreditPurchase(adminSupabase, {
        userId,
        credits,
        transactionId: creditTransactionId,
      });
    }
    return {
      success: true,
      entitlement: 'credits',
      credits,
      alreadyProcessed,
      ...(referral?.purchaserBonusCredits
        ? { referralBonusCredits: referral.purchaserBonusCredits }
        : {}),
    };
  }

  if (!settledResourceId) {
    throw new MobileCommerceError('Mobile purchase settlement resource is missing.', 500);
  }

  if (authority.entitlementType === 'marketplace_unlock') {
    const sellerUserId = normalizeOptionalString(data.seller_user_id);
    if (!alreadyProcessed) {
      if (!sellerUserId) throw new MobileCommerceError('Failed to unlock marketplace purchase.', 500);
      await notifyMarketplaceUnlockCompleted(adminSupabase, {
        buyerUserId: userId,
        sellerUserId,
        assetId: settledResourceId,
        alreadyProcessed: false,
      });
    }
    return {
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: settledResourceId,
      alreadyProcessed,
    };
  }

  const ownerUserId = normalizeOptionalString(data.owner_user_id);
  const bundleId = normalizeOptionalString(data.bundle_id);
  if (!alreadyProcessed) {
    if (!ownerUserId || !bundleId) throw new MobileCommerceError('Failed to unlock post resources.', 500);
    invalidateMarketplaceResourceListCache();
    await notifyPostResourceUnlockCompleted(adminSupabase, {
      buyerUserId: userId,
      ownerUserId,
      postId: settledResourceId,
      bundleId,
      alreadyProcessed: false,
    });
  }
  return {
    success: true,
    entitlement: 'post_resource_unlock',
    postId: settledResourceId,
    alreadyProcessed,
  };
}

function parseMobileAdjustmentRewards(
  value: unknown,
  action: 'refund' | 'restore',
): ReferralRewardNotification[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || typeof item.user_id !== 'string'
      || typeof item.event_key !== 'string'
      || (item.kind !== 'inviter_purchase' && item.kind !== 'invitee_first_purchase')
      || (item.status !== 'granted' && item.status !== 'partially_reversed' && item.status !== 'reversed')
    ) {
      return [];
    }
    const credits = requiredSafeInteger(item.credits);
    const activeCredits = requiredSafeInteger(item.active_credits);
    if (credits === null || credits < 0 || activeCredits === null || activeCredits < 0) return [];
    return [{
      eventKey: item.event_key,
      rewardId: item.id,
      userId: item.user_id,
      credits,
      activeCredits,
      kind: item.kind,
      status: item.status,
      notificationType: action === 'refund' ? 'referral_reward_reversed' : 'referral_reward_earned',
    } satisfies ReferralRewardNotification];
  });
}

export async function reconcileMobilePurchaseAdjustment(
  adminSupabase: SupabaseClient,
  input: {
    externalOrderId: string;
    userId: string;
    productId: string;
    providerEventId: string;
    providerEventTimestampMs: number;
    action: 'refund' | 'restore';
  },
): Promise<ReferralRewardSettlement> {
  const { data, error } = await adminSupabase.rpc('reconcile_mobile_purchase_adjustment', {
    p_external_order_id: input.externalOrderId,
    p_user_id: input.userId,
    p_product_id: input.productId,
    p_event_id: input.providerEventId,
    p_event_timestamp_ms: input.providerEventTimestampMs,
    p_action: input.action,
  });
  if (error) {
    throw new Error(error.message || 'Mobile purchase adjustment failed');
  }
  if (!isRecord(data) || typeof data.status !== 'string') {
    throw new Error('Mobile purchase adjustment returned an invalid response');
  }
  if (data.status === 'legacy_product_unbound') {
    throw new Error(
      `Backfilled mobile transaction ${input.externalOrderId} requires catalog binding to ${input.productId}`,
    );
  }

  const settlement: ReferralRewardSettlement = {
    status: data.status,
    rewards: parseMobileAdjustmentRewards(data.rewards, input.action),
  };
  await notifyReferralRewardSettlement(adminSupabase, settlement);
  return settlement;
}

export async function completeMobileCreditPurchase({
  adminSupabase,
  userId,
  productId,
  provider,
  transactionId,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  productId: string;
  provider: MobilePurchaseProvider;
  transactionId: string;
}): Promise<MobileCommerceSyncResult> {
  const plan = resolveMobileCreditProduct(productId);
  if (!plan) {
    throw new MobileCommerceError('Unknown mobile credit product.');
  }
  return completeMobilePurchase({
    adminSupabase,
    userId,
    provider,
    transactionId,
    authority: {
      entitlementType: 'credits',
      productId,
      purchaseIntentId: null,
      resourceId: null,
      amountSubunits: plan.priceInr * 100,
      currency: 'INR',
      credits: plan.credits,
    },
  });
}

export async function completeMobileMarketplaceUnlock({
  adminSupabase,
  userId,
  purchaseIntentId,
  productId,
  provider,
  transactionId,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  purchaseIntentId: string;
  productId: string;
  provider: MobilePurchaseProvider;
  transactionId: string;
}): Promise<MobileCommerceSyncResult> {
  const authority = await resolveMobilePurchaseAuthority({
    adminSupabase,
    userId,
    productId,
    purchaseIntentId,
  });
  if (authority.entitlementType !== 'marketplace_unlock') {
    throw new MobileCommerceError('Purchase intent is not a marketplace unlock.', 409);
  }
  return completeMobilePurchase({ adminSupabase, userId, authority, provider, transactionId });
}

export async function unlockMarketplaceAssetWithCredits({
  adminSupabase,
  userId,
  assetId,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  assetId: string;
}): Promise<MobileCommerceSyncResult> {
  const { data, error } = await adminSupabase.rpc('unlock_marketplace_asset_with_credits', {
    p_user_id: userId,
    p_asset_id: assetId,
  });

  if (error || !isRecord(data)) {
    throw new MobileCommerceError('Failed to unlock marketplace purchase.', 500);
  }

  const status = normalizeOptionalString(data.status);
  const remainingCredits = typeof data.remaining_credits === 'number' ? data.remaining_credits : null;
  const creditCost = typeof data.credit_cost === 'number' ? data.credit_cost : 0;
  const sellerUserId = normalizeOptionalString(data.seller_user_id);

  if (status === 'not_found') {
    throw new MobileCommerceError('Marketplace unlock not found.', 404);
  }

  if (status === 'owned_by_user') {
    throw new MobileCommerceError('You already own this listing.', 400);
  }

  if (status === 'not_paid') {
    throw new MobileCommerceError('This listing does not require paid access.', 400);
  }

  if (status === 'insufficient_credits') {
    throw new MobileCommerceError(`Insufficient credits. This unlock costs ${creditCost} credits.`, 402);
  }

  const alreadyProcessed = status === 'already_owned';
  if (status !== 'completed' && !alreadyProcessed) {
    throw new MobileCommerceError('Failed to unlock marketplace purchase.', 500);
  }

  if (!alreadyProcessed) {
    if (!sellerUserId) {
      throw new MobileCommerceError('Failed to unlock marketplace purchase.', 500);
    }
    await notifyMarketplaceUnlockCompleted(adminSupabase, {
      buyerUserId: userId,
      sellerUserId,
      assetId,
      alreadyProcessed: false,
    });
  }

  return {
    success: true,
    entitlement: 'marketplace_unlock',
    assetId,
    credits: remainingCredits,
    alreadyProcessed,
  };
}

export async function completeMobilePostResourceUnlock({
  adminSupabase,
  userId,
  purchaseIntentId,
  productId,
  provider,
  transactionId,
  invalidateMarketplaceResourceListCache,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  purchaseIntentId: string;
  productId: string;
  provider: MobilePurchaseProvider;
  transactionId: string;
  invalidateMarketplaceResourceListCache?: () => void;
}): Promise<MobileCommerceSyncResult> {
  const authority = await resolveMobilePurchaseAuthority({
    adminSupabase,
    userId,
    productId,
    purchaseIntentId,
  });
  if (authority.entitlementType !== 'post_resource_unlock') {
    throw new MobileCommerceError('Purchase intent is not a post resource unlock.', 409);
  }
  return completeMobilePurchase({
    adminSupabase,
    userId,
    authority,
    provider,
    transactionId,
    invalidateMarketplaceResourceListCache,
  });
}

export async function unlockPostResourceBundleWithCredits({
  adminSupabase,
  userId,
  postId,
  invalidateMarketplaceResourceListCache = defaultInvalidateMarketplaceResourceListCache,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  postId: string;
  invalidateMarketplaceResourceListCache?: () => void;
}): Promise<MobileCommerceSyncResult> {
  const { data, error } = await adminSupabase.rpc('unlock_post_resource_bundle_with_credits', {
    p_user_id: userId,
    p_post_id: postId,
  });

  if (error || !isRecord(data)) {
    throw new MobileCommerceError('Failed to unlock post resources.', 500);
  }

  const status = normalizeOptionalString(data.status);
  const remainingCredits = typeof data.remaining_credits === 'number' ? data.remaining_credits : null;
  const creditCost = typeof data.credit_cost === 'number' ? data.credit_cost : 0;
  const bundleId = normalizeOptionalString(data.bundle_id);
  const ownerUserId = normalizeOptionalString(data.owner_user_id);

  if (status === 'not_found') {
    throw new MobileCommerceError('Post unlock not found.', 404);
  }

  if (status === 'owned_by_user') {
    throw new MobileCommerceError('You already own this unlock.', 400);
  }

  if (status === 'not_paid') {
    throw new MobileCommerceError('This post unlock does not require paid access.', 400);
  }

  if (status === 'insufficient_credits') {
    throw new MobileCommerceError(`Insufficient credits. This unlock costs ${creditCost} credits.`, 402);
  }

  const alreadyProcessed = status === 'already_owned';
  if (status !== 'completed' && !alreadyProcessed) {
    throw new MobileCommerceError('Failed to unlock post resources.', 500);
  }

  if (!alreadyProcessed) {
    if (!ownerUserId || !bundleId) {
      throw new MobileCommerceError('Failed to unlock post resources.', 500);
    }
    invalidateMarketplaceResourceListCache();
    await notifyPostResourceUnlockCompleted(adminSupabase, {
      buyerUserId: userId,
      ownerUserId,
      postId,
      bundleId,
      alreadyProcessed: false,
    });
  }

  return {
    success: true,
    entitlement: 'post_resource_unlock',
    postId,
    credits: remainingCredits,
    alreadyProcessed,
  };
}

export async function restoreMobileEntitlements(
  adminSupabase: SupabaseClient,
  userId: string,
  options: {
    fetcher?: typeof fetch;
    revenueCatApiKey?: string;
  } = {}
) {
  const revenueCatResponse = await fetchRevenueCatSubscriber({
    userId,
    fetcher: options.fetcher,
    revenueCatApiKey: options.revenueCatApiKey,
  });
  const creditResults: MobileCommerceSyncResult[] = [];
  let restoredCreditPurchases = 0;
  let alreadyProcessedCreditPurchases = 0;

  for (const purchase of listRestorableMobileCreditPurchases(revenueCatResponse)) {
    const result = await completeMobileCreditPurchase({
      adminSupabase,
      userId,
      productId: purchase.productId,
      provider: purchase.provider,
      transactionId: purchase.transactionId,
    });
    creditResults.push(result);
    if (result.alreadyProcessed) {
      alreadyProcessedCreditPurchases += 1;
    } else {
      restoredCreditPurchases += 1;
    }
  }

  const [credits, marketplacePurchases, bundlePurchases] = await Promise.all([
    getProfileCredits(adminSupabase, userId),
    adminSupabase
      .from('marketplace_purchases')
      .select('asset_id')
      .eq('buyer_user_id', userId),
    adminSupabase
      .from('post_resource_bundle_purchases')
      .select('bundle_id, post_resource_bundles(post_id)')
      .eq('buyer_user_id', userId),
  ]);

  if (marketplacePurchases.error || bundlePurchases.error) {
    throw new MobileCommerceError('Failed to restore mobile entitlements.', 500);
  }

  const marketplaceEntitlements = (marketplacePurchases.data ?? []).map((purchase) => ({
    success: true as const,
    entitlement: 'marketplace_unlock' as const,
    assetId: purchase.asset_id as string,
    alreadyProcessed: true,
  }));

  const postEntitlements = (bundlePurchases.data ?? []).flatMap((purchase) => {
    const joinedBundle = purchase.post_resource_bundles as { post_id?: string | null } | null;
    return joinedBundle?.post_id
      ? [{
        success: true as const,
        entitlement: 'post_resource_unlock' as const,
        postId: joinedBundle.post_id,
        alreadyProcessed: true,
      }]
      : [];
  });

  await notifyMobilePurchasesRestored(adminSupabase, userId);

  return {
    success: true,
    credits,
    restoredCreditPurchases,
    alreadyProcessedCreditPurchases,
    entitlements: [...creditResults, ...marketplaceEntitlements, ...postEntitlements],
  };
}
