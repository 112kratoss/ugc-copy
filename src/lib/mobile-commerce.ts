import type { SupabaseClient } from '@supabase/supabase-js';

import {
  notifyMarketplaceUnlockCompleted,
  notifyMobileCreditPurchase,
  notifyMobilePurchasesRestored,
  notifyPostResourceUnlockCompleted,
} from '@/lib/mobile-notifications';
import { PRICING_PLAN_MAP, type PricingPlan } from '@/lib/pricing';

export type MobilePurchaseProvider = 'app_store' | 'play_store' | 'revenuecat' | 'sandbox';

type MobilePurchaseEntitlement =
  | { type: 'credits'; productId: string; credits?: number }
  | { type: 'marketplace_unlock'; productId: string; assetId: string }
  | { type: 'post_resource_unlock'; productId: string; postId: string };

export interface NormalizedMobileCommercePayload {
  provider: MobilePurchaseProvider;
  productId: string;
  transactionId: string | null;
  receiptToken: string | null;
  entitlement: MobilePurchaseEntitlement;
}

export interface MobileCommerceSyncResult {
  success: true;
  entitlement: MobilePurchaseEntitlement['type'];
  credits?: number | null;
  alreadyProcessed?: boolean;
  assetId?: string;
  postId?: string;
  message?: string;
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

function normalizeEntitlement(value: unknown, fallbackProductId: string): MobilePurchaseEntitlement | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = value.type;
  const productId = normalizeOptionalString(value.productId) ?? fallbackProductId;

  if (type === 'credits') {
    const credits = typeof value.credits === 'number' && Number.isFinite(value.credits) ? value.credits : undefined;
    return { type, productId, credits };
  }

  if (type === 'marketplace_unlock') {
    const assetId = normalizeOptionalString(value.assetId);
    return assetId ? { type, productId, assetId } : null;
  }

  if (type === 'post_resource_unlock') {
    const postId = normalizeOptionalString(value.postId);
    return postId ? { type, productId, postId } : null;
  }

  return null;
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

  const entitlement = normalizeEntitlement(body.entitlement, productId);
  if (!entitlement) {
    throw new MobileCommerceError('Missing mobile purchase entitlement.');
  }

  if (entitlement.productId !== productId) {
    throw new MobileCommerceError('Purchase product does not match entitlement product.');
  }

  return {
    provider,
    productId,
    transactionId: normalizeOptionalString(body.transactionId),
    receiptToken:
      normalizeOptionalString(body.receiptToken)
      ?? normalizeOptionalString(body.receipt)
      ?? normalizeOptionalString(body.fetchToken),
    entitlement,
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

  const response = await fetcher(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Bearer ${revenueCatApiKey}`,
      'Content-Type': 'application/json',
    },
  });

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

async function getMobileCreditTransaction(adminSupabase: SupabaseClient, userId: string, externalOrderId: string) {
  const { data, error } = await adminSupabase
    .from('transactions')
    .select('id, credits, status')
    .eq('razorpay_order_id', externalOrderId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new MobileCommerceError('Failed to check mobile credit purchase.', 500);
  }

  return data;
}

function isDuplicateInsertError(error: unknown) {
  return isRecord(error) && error.code === '23505';
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

  const externalOrderId = buildMobileExternalOrderId(provider, transactionId);
  const existing = await getMobileCreditTransaction(adminSupabase, userId, externalOrderId);

  if (existing?.status === 'success') {
    return {
      success: true,
      entitlement: 'credits',
      credits: await getProfileCredits(adminSupabase, userId),
      alreadyProcessed: true,
    };
  }

  let transaction = existing;
  if (!transaction) {
    const { data: insertedTransaction, error: insertError } = await adminSupabase
      .from('transactions')
      .insert({
        user_id: userId,
        razorpay_order_id: externalOrderId,
        razorpay_payment_id: `mobile_${provider}_${transactionId}`,
        amount: plan.priceInr * 100,
        credits: plan.credits,
        status: 'created',
        mobile_product_id: productId,
      })
      .select('id, credits, status')
      .single();

    if (insertError) {
      if (isDuplicateInsertError(insertError)) {
        transaction = await getMobileCreditTransaction(adminSupabase, userId, externalOrderId);
      }

      if (!transaction) {
        throw new MobileCommerceError('Failed to record mobile credit purchase.', 500);
      }
    } else {
      transaction = insertedTransaction;
    }
  }

  if (!transaction) {
    throw new MobileCommerceError('Failed to record mobile credit purchase.', 500);
  }

  const { data: rpcSuccess, error: rpcError } = await adminSupabase.rpc('add_credits', {
    p_user_id: userId,
    p_credits: plan.credits,
    p_transaction_id: transaction.id,
    p_payment_id: `mobile_${provider}_${transactionId}`,
  });

  if (rpcError) {
    throw new MobileCommerceError('Failed to assign mobile credits.', 500);
  }

  const credits = await getProfileCredits(adminSupabase, userId);
  const alreadyProcessed = !rpcSuccess;
  if (!alreadyProcessed) {
    await notifyMobileCreditPurchase(adminSupabase, {
      userId,
      credits,
      transactionId,
    });
  }

  return {
    success: true,
    entitlement: 'credits',
    credits,
    alreadyProcessed,
  };
}

export async function completeMobileMarketplaceUnlock({
  adminSupabase,
  userId,
  assetId,
  provider,
  transactionId,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  assetId: string;
  provider: MobilePurchaseProvider;
  transactionId: string;
}): Promise<MobileCommerceSyncResult> {
  const { data: asset, error: assetError } = await adminSupabase
    .from('marketplace_assets')
    .select('id, seller_user_id, price_usd_cents, status')
    .eq('id', assetId)
    .maybeSingle();

  if (assetError) {
    throw new MobileCommerceError('Failed to load marketplace unlock.', 500);
  }

  if (!asset || (asset.status !== 'active' && asset.status !== 'unlisted')) {
    throw new MobileCommerceError('Marketplace unlock not found.', 404);
  }

  if (asset.seller_user_id === userId) {
    throw new MobileCommerceError('You already own this listing.', 400);
  }

  const { data: existingPurchase, error: existingPurchaseError } = await adminSupabase
    .from('marketplace_purchases')
    .select('asset_id')
    .eq('asset_id', assetId)
    .eq('buyer_user_id', userId)
    .maybeSingle();

  if (existingPurchaseError) {
    throw new MobileCommerceError('Failed to check marketplace purchase history.', 500);
  }

  if (existingPurchase) {
    return { success: true, entitlement: 'marketplace_unlock', assetId, alreadyProcessed: true };
  }

  const externalOrderId = buildMobileExternalOrderId(provider, transactionId);
  const { error: orderError } = await adminSupabase
    .from('marketplace_orders')
    .insert({
      asset_id: assetId,
      buyer_user_id: userId,
      razorpay_order_id: externalOrderId,
      razorpay_payment_id: `mobile_${provider}_${transactionId}`,
      amount_subunits: asset.price_usd_cents,
      currency: 'USD',
      status: 'created',
    });

  if (orderError) {
    throw new MobileCommerceError('Failed to record marketplace mobile order.', 500);
  }

  const { data: completed, error: completionError } = await adminSupabase.rpc('complete_marketplace_purchase', {
    p_razorpay_order_id: externalOrderId,
    p_razorpay_payment_id: `mobile_${provider}_${transactionId}`,
  });

  if (completionError) {
    throw new MobileCommerceError('Failed to unlock marketplace purchase.', 500);
  }

  await notifyMarketplaceUnlockCompleted(adminSupabase, {
    buyerUserId: userId,
    sellerUserId: asset.seller_user_id,
    assetId,
    alreadyProcessed: !completed,
  });

  return {
    success: true,
    entitlement: 'marketplace_unlock',
    assetId,
    alreadyProcessed: !completed,
  };
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
  postId,
  provider,
  transactionId,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  postId: string;
  provider: MobilePurchaseProvider;
  transactionId: string;
}): Promise<MobileCommerceSyncResult> {
  const { data: bundle, error: bundleError } = await adminSupabase
    .from('post_resource_bundles')
    .select('id, owner_user_id, access_mode, status, price_usd_cents')
    .eq('post_id', postId)
    .maybeSingle();

  if (bundleError) {
    throw new MobileCommerceError('Failed to load post unlock.', 500);
  }

  if (!bundle || bundle.status !== 'published') {
    throw new MobileCommerceError('Post unlock not found.', 404);
  }

  if (bundle.owner_user_id === userId) {
    throw new MobileCommerceError('You already own this unlock.', 400);
  }

  if (bundle.access_mode !== 'paid' || bundle.price_usd_cents <= 0) {
    throw new MobileCommerceError('This post unlock does not require a mobile purchase.', 400);
  }

  const { data: existingPurchase, error: existingPurchaseError } = await adminSupabase
    .from('post_resource_bundle_purchases')
    .select('bundle_id')
    .eq('bundle_id', bundle.id)
    .eq('buyer_user_id', userId)
    .maybeSingle();

  if (existingPurchaseError) {
    throw new MobileCommerceError('Failed to check post unlock purchase history.', 500);
  }

  if (existingPurchase) {
    return { success: true, entitlement: 'post_resource_unlock', postId, alreadyProcessed: true };
  }

  const externalOrderId = buildMobileExternalOrderId(provider, transactionId);
  const { error: orderError } = await adminSupabase
    .from('post_resource_bundle_orders')
    .insert({
      bundle_id: bundle.id,
      buyer_user_id: userId,
      razorpay_order_id: externalOrderId,
      razorpay_payment_id: `mobile_${provider}_${transactionId}`,
      amount_subunits: bundle.price_usd_cents,
      currency: 'USD',
      status: 'created',
    });

  if (orderError) {
    throw new MobileCommerceError('Failed to record post unlock mobile order.', 500);
  }

  const { data: completed, error: completionError } = await adminSupabase.rpc('complete_post_resource_bundle_purchase', {
    p_razorpay_order_id: externalOrderId,
    p_razorpay_payment_id: `mobile_${provider}_${transactionId}`,
  });

  if (completionError) {
    throw new MobileCommerceError('Failed to unlock post resources.', 500);
  }

  await notifyPostResourceUnlockCompleted(adminSupabase, {
    buyerUserId: userId,
    ownerUserId: bundle.owner_user_id,
    postId,
    bundleId: bundle.id,
    alreadyProcessed: !completed,
  });

  return {
    success: true,
    entitlement: 'post_resource_unlock',
    postId,
    alreadyProcessed: !completed,
  };
}

export async function unlockPostResourceBundleWithCredits({
  adminSupabase,
  userId,
  postId,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  postId: string;
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
