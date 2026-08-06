import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

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

type FreeUnlockResult = {
  status: string;
  bundle_id?: string;
  owner_user_id?: string;
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

function rpcObject<T extends { status: string }>(value: unknown): T | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const status = (candidate as { status?: unknown }).status;
  return typeof status === 'string' ? candidate as T : null;
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

    logBackendError('failed_to_enforce_free_unlock_rate_limit', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to get the free recipe.' } };
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

  const freeOrderId = `free_bundle_${createId()}`;
  let unlockResult: FreeUnlockResult;
  try {
    const { data, error } = await adminSupabase.rpc('unlock_free_post_resource_bundle', {
      p_buyer_user_id: buyerUserId,
      p_post_id: postId,
      p_order_reference: freeOrderId,
      p_payment_reference: `free_unlock_${createId()}`,
    });
    if (error) throw error;

    const result = rpcObject<FreeUnlockResult>(data);
    if (!result) throw new Error('Invalid free post resource unlock response.');
    unlockResult = result;
  } catch (error) {
    logBackendError('failed_to_unlock_free_post_resource_bundle', { error });
    return { ok: false, status: 500, body: { error: 'Failed to get the free recipe.' } };
  }

  if (unlockResult.status === 'owned_by_user' || unlockResult.status === 'already_owned') {
    return { ok: true, body: { success: true, alreadyPurchased: true } };
  }
  if (unlockResult.status === 'not_found') {
    return { ok: false, status: 404, body: { error: 'Unlock not found.' } };
  }
  if (unlockResult.status === 'not_free') {
    return { ok: false, status: 400, body: { error: 'This bundle requires payment.' } };
  }
  if (
    unlockResult.status !== 'completed'
    || typeof unlockResult.bundle_id !== 'string'
    || unlockResult.bundle_id.length === 0
    || typeof unlockResult.owner_user_id !== 'string'
    || unlockResult.owner_user_id.length === 0
  ) {
    logBackendError('invalid_free_post_resource_unlock_result', { status: unlockResult.status });
    return { ok: false, status: 500, body: { error: 'Failed to get the free recipe.' } };
  }

  invalidateMarketplaceResourceListCache();

  await notifyPostResourceUnlockCompleted(adminSupabase, {
    buyerUserId,
    ownerUserId: unlockResult.owner_user_id,
    postId,
    bundleId: unlockResult.bundle_id,
    alreadyProcessed: false,
  });

  return {
    ok: true,
    body: {
      success: true,
      free: true,
      alreadyProcessed: false,
    },
  };
}
