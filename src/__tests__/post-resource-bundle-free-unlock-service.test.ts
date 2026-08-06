import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { unlockFreePostResourceBundleForRoute } from '@/lib/post-resource-bundle-free-unlock-service';

type BundleForUnlock = {
  id: string;
  post_id: string;
  owner_user_id: string;
  access_mode: 'free' | 'paid';
  status: 'published' | 'draft';
  price_usd_cents: number;
};

function createBundle(overrides?: Partial<BundleForUnlock>): BundleForUnlock {
  return {
    id: 'bundle-1',
    post_id: 'post-1',
    owner_user_id: 'owner-1',
    access_mode: 'free',
    status: 'published',
    price_usd_cents: 0,
    ...overrides,
  };
}

function createAdminSupabaseMock(options?: {
  rateLimited?: boolean;
  unlockResult?: Record<string, unknown>;
  unlockError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const tableCalls: string[] = [];

  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });

      if (fn === 'check_backend_rate_limit') {
        return {
          data: {
            allowed: !options?.rateLimited,
            limit: 60,
            remaining: options?.rateLimited ? 0 : 59,
            retryAfterSeconds: options?.rateLimited ? 29 : 0,
            resetAt: '2026-06-22T10:00:00.000Z',
          },
          error: null,
        };
      }

      if (fn === 'unlock_free_post_resource_bundle') {
        return {
          data: options?.unlockResult ?? {
            status: 'completed',
            bundle_id: 'bundle-1',
            owner_user_id: 'owner-1',
            purchase_id: 'purchase-1',
          },
          error: options?.unlockError ?? null,
        };
      }

      throw new Error(`Unexpected RPC: ${fn}`);
    },
    from(table: string) {
      tableCalls.push(table);
      throw new Error(`Unexpected direct table access: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
    tableCalls,
  };
}

describe('unlockFreePostResourceBundleForRoute', () => {
  it('rate limits before bundle lookup, atomic unlock, or notifications', async () => {
    const admin = createAdminSupabaseMock({ rateLimited: true });
    const getBundleForOrderByPostId = vi.fn();
    const notifyPostResourceUnlockCompleted = vi.fn();

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId,
      notifyPostResourceUnlockCompleted,
      createId: vi.fn(() => 'unused'),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: { code: 'RATE_LIMITED', retryAfterSeconds: 29 },
    });
    expect(admin.rpcCalls).toEqual([
      {
        fn: 'check_backend_rate_limit',
        args: {
          p_scope: 'post-resource-free-unlock:open',
          p_subject_key: 'buyer-1',
          p_limit: 60,
          p_window_seconds: 600,
        },
      },
    ]);
    expect(getBundleForOrderByPostId).not.toHaveBeenCalled();
    expect(admin.tableCalls).toEqual([]);
    expect(notifyPostResourceUnlockCompleted).not.toHaveBeenCalled();
  });

  it('returns not found for missing or unpublished bundles', async () => {
    const admin = createAdminSupabaseMock();

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle({ status: 'draft' })),
      notifyPostResourceUnlockCompleted: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Unlock not found.' },
    });
    expect(admin.rpcCalls.map((call) => call.fn)).not.toContain('unlock_free_post_resource_bundle');
    expect(admin.tableCalls).toEqual([]);
  });

  it('treats owner access as already purchased without invoking the unlock transaction', async () => {
    const admin = createAdminSupabaseMock();

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'owner-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      notifyPostResourceUnlockCompleted: vi.fn(),
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyPurchased: true },
    });
    expect(admin.rpcCalls.map((call) => call.fn)).not.toContain('unlock_free_post_resource_bundle');
    expect(admin.tableCalls).toEqual([]);
  });

  it('rejects a bundle already known to require payment', async () => {
    const admin = createAdminSupabaseMock();

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle({
        access_mode: 'paid',
        price_usd_cents: 500,
      })),
      notifyPostResourceUnlockCompleted: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'This bundle requires payment.' },
    });
    expect(admin.rpcCalls.map((call) => call.fn)).not.toContain('unlock_free_post_resource_bundle');
  });

  it('creates the order and entitlement in one locked database transaction', async () => {
    const admin = createAdminSupabaseMock();
    const notifyPostResourceUnlockCompleted = vi.fn();
    const invalidateMarketplaceResourceListCache = vi.fn();
    const idValues = ['order-id', 'payment-id'];

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      notifyPostResourceUnlockCompleted,
      invalidateMarketplaceResourceListCache,
      createId: vi.fn(() => idValues.shift() ?? 'fallback-id'),
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, free: true, alreadyProcessed: false },
    });
    expect(admin.rpcCalls).toContainEqual({
      fn: 'unlock_free_post_resource_bundle',
      args: {
        p_buyer_user_id: 'buyer-1',
        p_post_id: 'post-1',
        p_order_reference: 'free_bundle_order-id',
        p_payment_reference: 'free_unlock_payment-id',
      },
    });
    expect(admin.rpcCalls.map((call) => call.fn)).not.toContain('complete_post_resource_bundle_purchase');
    expect(admin.tableCalls).toEqual([]);
    expect(notifyPostResourceUnlockCompleted).toHaveBeenCalledWith(admin.client, {
      buyerUserId: 'buyer-1',
      ownerUserId: 'owner-1',
      postId: 'post-1',
      bundleId: 'bundle-1',
      alreadyProcessed: false,
    });
    expect(invalidateMarketplaceResourceListCache).toHaveBeenCalledTimes(1);
  });

  it('returns an existing atomic entitlement without creating or notifying again', async () => {
    const admin = createAdminSupabaseMock({
      unlockResult: {
        status: 'already_owned',
        bundle_id: 'bundle-1',
        owner_user_id: 'owner-1',
      },
    });
    const notifyPostResourceUnlockCompleted = vi.fn();
    const invalidateMarketplaceResourceListCache = vi.fn();

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      notifyPostResourceUnlockCompleted,
      invalidateMarketplaceResourceListCache,
      createId: vi.fn(() => 'id'),
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyPurchased: true },
    });
    expect(invalidateMarketplaceResourceListCache).not.toHaveBeenCalled();
    expect(notifyPostResourceUnlockCompleted).not.toHaveBeenCalled();
    expect(admin.tableCalls).toEqual([]);
  });

  it('does not grant access if the seller switches from free to paid before the lock is acquired', async () => {
    const admin = createAdminSupabaseMock({ unlockResult: { status: 'not_free' } });
    const notifyPostResourceUnlockCompleted = vi.fn();
    const invalidateMarketplaceResourceListCache = vi.fn();

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      notifyPostResourceUnlockCompleted,
      invalidateMarketplaceResourceListCache,
      createId: vi.fn(() => 'id'),
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'This bundle requires payment.' },
    });
    expect(notifyPostResourceUnlockCompleted).not.toHaveBeenCalled();
    expect(invalidateMarketplaceResourceListCache).not.toHaveBeenCalled();
    expect(admin.tableCalls).toEqual([]);
  });

  it('returns a stable error when the atomic unlock RPC fails', async () => {
    const admin = createAdminSupabaseMock({ unlockError: { message: 'rpc failed' } });
    const notifyPostResourceUnlockCompleted = vi.fn();

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      notifyPostResourceUnlockCompleted,
      createId: vi.fn(() => 'id'),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to get the free recipe.' },
    });
    expect(notifyPostResourceUnlockCompleted).not.toHaveBeenCalled();
    expect(admin.tableCalls).toEqual([]);
  });

  it('fails closed if the exact immutable free revision cannot be quoted', async () => {
    const admin = createAdminSupabaseMock({ unlockResult: { status: 'quote_unavailable' } });

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      notifyPostResourceUnlockCompleted: vi.fn(),
      createId: vi.fn(() => 'id'),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to get the free recipe.' },
    });
  });
});
