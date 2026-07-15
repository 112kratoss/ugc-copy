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
  existingPurchase?: { bundle_id: string } | null;
  existingPurchaseError?: { message: string } | null;
  rateLimited?: boolean;
  orderError?: { message: string } | null;
  completionResult?: boolean;
  completionError?: { message: string } | null;
}) {
  const tableReads: string[] = [];
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

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

      if (fn === 'complete_post_resource_bundle_purchase') {
        return {
          data: options?.completionResult ?? true,
          error: options?.completionError ?? null,
        };
      }

      throw new Error(`Unexpected RPC: ${fn}`);
    },
    from(table: string) {
      if (table === 'post_resource_bundle_purchases') {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            tableReads.push(table);
            return {
              data: options?.existingPurchase ?? null,
              error: options?.existingPurchaseError ?? null,
            };
          },
        };

        return query;
      }

      if (table === 'post_resource_bundle_orders') {
        return {
          async insert(payload: Record<string, unknown>) {
            inserts.push({ table, payload });
            return { error: options?.orderError ?? null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    inserts,
    rpcCalls,
    tableReads,
  };
}

describe('unlockFreePostResourceBundleForRoute', () => {
  it('rate limits before bundle lookup, purchase reads, order creation, or notifications', async () => {
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
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 29,
      },
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
    expect(admin.tableReads).toEqual([]);
    expect(admin.inserts).toEqual([]);
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
    expect(admin.tableReads).toEqual([]);
    expect(admin.inserts).toEqual([]);
  });

  it('treats owner access as already purchased without writing an order', async () => {
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
    expect(admin.tableReads).toEqual([]);
    expect(admin.inserts).toEqual([]);
  });

  it('rejects paid bundles before purchase reads or order creation', async () => {
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
    expect(admin.tableReads).toEqual([]);
    expect(admin.inserts).toEqual([]);
  });

  it('returns existing purchases without creating another free order', async () => {
    const admin = createAdminSupabaseMock({
      existingPurchase: { bundle_id: 'bundle-1' },
    });

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      notifyPostResourceUnlockCompleted: vi.fn(),
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyPurchased: true },
    });
    expect(admin.tableReads).toEqual(['post_resource_bundle_purchases']);
    expect(admin.inserts).toEqual([]);
  });

  it('stops on purchase lookup errors instead of creating duplicate access rows', async () => {
    const admin = createAdminSupabaseMock({
      existingPurchaseError: { message: 'read failed' },
    });

    const result = await unlockFreePostResourceBundleForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      notifyPostResourceUnlockCompleted: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to check purchase history.' },
    });
    expect(admin.inserts).toEqual([]);
  });

  it('creates, completes, and notifies free unlock orders', async () => {
    const admin = createAdminSupabaseMock();
    const notifyPostResourceUnlockCompleted = vi.fn();
    const invalidateMarketplaceResourceListCache = vi.fn();
    const idValues = ['order-id', 'order-payment-id', 'completion-payment-id'];

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
      body: {
        success: true,
        free: true,
        alreadyProcessed: false,
      },
    });
    expect(admin.inserts).toEqual([
      {
        table: 'post_resource_bundle_orders',
        payload: {
          bundle_id: 'bundle-1',
          buyer_user_id: 'buyer-1',
          razorpay_order_id: 'free_bundle_order-id',
          razorpay_payment_id: 'free_order-payment-id',
          amount_subunits: 0,
          currency: 'USD',
          status: 'created',
        },
      },
    ]);
    expect(admin.rpcCalls).toContainEqual({
      fn: 'complete_post_resource_bundle_purchase',
      args: {
        p_razorpay_order_id: 'free_bundle_order-id',
        p_razorpay_payment_id: 'free_unlock_completion-payment-id',
      },
    });
    expect(notifyPostResourceUnlockCompleted).toHaveBeenCalledWith(admin.client, {
      buyerUserId: 'buyer-1',
      ownerUserId: 'owner-1',
      postId: 'post-1',
      bundleId: 'bundle-1',
      alreadyProcessed: false,
    });
    expect(invalidateMarketplaceResourceListCache).toHaveBeenCalledTimes(1);
  });

  it('marks concurrent completions as already processed in the notification and response', async () => {
    const admin = createAdminSupabaseMock({ completionResult: false });
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
      body: {
        success: true,
        free: true,
        alreadyProcessed: true,
      },
    });
    expect(invalidateMarketplaceResourceListCache).not.toHaveBeenCalled();
    expect(notifyPostResourceUnlockCompleted).toHaveBeenCalledWith(
      admin.client,
      expect.objectContaining({ alreadyProcessed: true })
    );
  });

  it('returns a stable error when free order creation fails', async () => {
    const admin = createAdminSupabaseMock({
      orderError: { message: 'insert failed' },
    });
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
      body: { error: 'Failed to open the free unlock.' },
    });
    expect(admin.rpcCalls.map((call) => call.fn)).toEqual(['check_backend_rate_limit']);
    expect(notifyPostResourceUnlockCompleted).not.toHaveBeenCalled();
  });

  it('returns a stable error when free order completion fails', async () => {
    const admin = createAdminSupabaseMock({
      completionError: { message: 'rpc failed' },
    });
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
      body: { error: 'Failed to open the free unlock.' },
    });
    expect(notifyPostResourceUnlockCompleted).not.toHaveBeenCalled();
  });
});
