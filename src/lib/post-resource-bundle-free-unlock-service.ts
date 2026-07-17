import 'server-only';

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_RESOURCE_FREE_UNLOCK_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { notifyPostResourceUnlockCompleted as defaultNotifyPostResourceUnlockCompleted } from '@/lib/mobile-notifications';
import { invalidateMarketplaceResourceListCache as defaultInvalidateMarketplaceResourceListCache } from '@/lib/marketplace-resource-list-cache';
import {
  getBundleForOrderByPostId as defaultGetBundleForOrderByPostId,
} from '@/lib/post-resource-bundles-server';

type BundleForFreeUnlock = {
  id: string;
  post_id: string;
  owner_user_id: string;
  access_mode: string;
  status: string;
  price_usd_cents: number;
};

type NotifyPostResourceUnlockCompleted = typeof defaultNotifyPostResourceUnlockCompleted;
type GetBundleForOrderByPostId = (postId: string) => Promise<BundleForFreeUnlock | null>;

export type PostResourceBundleFreeUnlockRouteResult =
  | {
      ok: true;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 404 | 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

function createRateLimitResult(error: BackendRateLimitError): PostResourceBundleFreeUnlockRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

export async function unlockFreePostResourceBundleForRoute({
  adminSupabase,
  postId,
  buyerUserId,
  getBundleForOrderByPostId = defaultGetBundleForOrderByPostId as GetBundleForOrderByPostId,
  notifyPostResourceUnlockCompleted = defaultNotifyPostResourceUnlockCompleted,
  invalidateMarketplaceResourceListCache = defaultInvalidateMarketplaceResourceListCache,
  createId = randomUUID,
}: {
  adminSupabase: SupabaseClient;
  postId: string;
  buyerUserId: string;
  getBundleForOrderByPostId?: GetBundleForOrderByPostId;
  notifyPostResourceUnlockCompleted?: NotifyPostResourceUnlockCompleted;
  invalidateMarketplaceResourceListCache?: () => void;
  createId?: () => string;
}): Promise<PostResourceBundleFreeUnlockRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_RESOURCE_FREE_UNLOCK_RATE_LIMIT,
      key: buyerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    console.error('Failed to enforce free unlock rate limit:', error);
    return { ok: false, status: 500, body: { error: 'Failed to unlock the free recipe.' } };
  }

  const bundle = await getBundleForOrderByPostId(postId);
  if (!bundle || bundle.status !== 'published') {
    return { ok: false, status: 404, body: { error: 'Unlock not found.' } };
  }

  if (bundle.owner_user_id === buyerUserId) {
    return { ok: true, body: { success: true, alreadyPurchased: true } };
  }

  if (bundle.access_mode !== 'free' || bundle.price_usd_cents !== 0) {
    return { ok: false, status: 400, body: { error: 'This bundle requires payment.' } };
  }

  const { data: existingPurchase, error: existingPurchaseError } = await adminSupabase
    .from('post_resource_bundle_purchases')
    .select('bundle_id')
    .eq('bundle_id', bundle.id)
    .eq('buyer_user_id', buyerUserId)
    .maybeSingle();

  if (existingPurchaseError) {
    console.error('Failed to check post resource bundle purchase:', existingPurchaseError);
    return { ok: false, status: 500, body: { error: 'Failed to check purchase history.' } };
  }

  if (existingPurchase) {
    return { ok: true, body: { success: true, alreadyPurchased: true } };
  }

  const freeOrderId = `free_bundle_${createId()}`;
  const { error: orderError } = await adminSupabase
    .from('post_resource_bundle_orders')
    .insert({
      bundle_id: bundle.id,
      buyer_user_id: buyerUserId,
      razorpay_order_id: freeOrderId,
      razorpay_payment_id: `free_${createId()}`,
      amount_subunits: 0,
      currency: 'USD',
      status: 'created',
    });

  if (orderError) {
    console.error('Failed to create free bundle order:', orderError);
    return { ok: false, status: 500, body: { error: 'Failed to unlock the free recipe.' } };
  }

  const { data: completed, error: completionError } = await adminSupabase.rpc(
    'complete_post_resource_bundle_purchase',
    {
      p_razorpay_order_id: freeOrderId,
      p_razorpay_payment_id: `free_unlock_${createId()}`,
    }
  );

  if (completionError) {
    console.error('Failed to complete free bundle unlock:', completionError);
    return { ok: false, status: 500, body: { error: 'Failed to unlock the free recipe.' } };
  }

  if (completed) {
    invalidateMarketplaceResourceListCache();
  }

  await notifyPostResourceUnlockCompleted(adminSupabase, {
    buyerUserId,
    ownerUserId: bundle.owner_user_id,
    postId,
    bundleId: bundle.id,
    alreadyProcessed: !completed,
  });

  return {
    ok: true,
    body: {
      success: true,
      free: true,
      alreadyProcessed: !completed,
    },
  };
}
