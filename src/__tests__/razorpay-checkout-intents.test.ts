import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  claimRazorpayCheckoutIntent,
  createOrRecoverRazorpayCheckoutOrder,
  createRazorpayCheckoutRequestHash,
  RazorpayCheckoutIntentError,
} from '@/lib/razorpay-checkout-intents';

function adminWithRpc(
  handler: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
) {
  return {
    rpc: vi.fn(handler),
  } as unknown as SupabaseClient;
}

describe('Razorpay checkout intents', () => {
  it('hashes equivalent payloads deterministically', () => {
    expect(createRazorpayCheckoutRequestHash({
      amount: 10_000,
      nested: { currency: 'INR', item: 'asset-1' },
    })).toBe(createRazorpayCheckoutRequestHash({
      nested: { item: 'asset-1', currency: 'INR' },
      amount: 10_000,
    }));
  });

  it('maps in-progress claims to a stable conflict', async () => {
    const admin = adminWithRpc(async () => ({
      data: {
        status: 'in_progress',
        intent_id: 'intent-1',
        provider_receipt: 'mb_1234567890123456',
        provider_order_id: null,
      },
      error: null,
    }));

    await expect(claimRazorpayCheckoutIntent(admin, {
      userId: 'user-1',
      purchaseKind: 'credits',
      clientIntentKey: 'intent-credit-123456',
      requestPayload: { amount: 10_000 },
    })).rejects.toMatchObject({
      status: 409,
      code: 'CHECKOUT_IN_PROGRESS',
    });
  });

  it('recovers an ambiguously created provider order by stable receipt', async () => {
    const admin = adminWithRpc(async (name, args) => {
      if (name === 'complete_razorpay_checkout_intent') {
        return {
          data: {
            status: 'recorded',
            provider_order_id: args.p_provider_order_id,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const createProviderOrder = vi.fn(async () => {
      throw new Error('connection reset after provider accepted request');
    });
    const fetchProviderOrderByReceipt = vi.fn(async () => ({
      id: 'order_recovered',
      amount: 10_000,
      currency: 'INR',
      receipt: 'mb_1234567890123456',
    }));

    await expect(createOrRecoverRazorpayCheckoutOrder({
      adminSupabase: admin,
      claim: {
        status: 'claimed',
        intentId: 'intent-1',
        providerReceipt: 'mb_1234567890123456',
        providerOrderId: null,
      },
      userId: 'user-1',
      keyId: 'key',
      keySecret: 'secret',
      expectedAmount: 10_000,
      expectedCurrency: 'INR',
      createProviderOrder,
      fetchProviderOrderByReceipt,
    })).resolves.toMatchObject({ id: 'order_recovered' });
    expect(fetchProviderOrderByReceipt).toHaveBeenCalledWith({
      keyId: 'key',
      keySecret: 'secret',
      receipt: 'mb_1234567890123456',
    });
  });

  it('never creates a second provider order for a replayed intent', async () => {
    const admin = adminWithRpc(async () => ({ data: null, error: null }));
    const createProviderOrder = vi.fn();

    await expect(createOrRecoverRazorpayCheckoutOrder({
      adminSupabase: admin,
      claim: {
        status: 'replay',
        intentId: 'intent-1',
        providerReceipt: 'mb_1234567890123456',
        providerOrderId: 'order_existing',
      },
      userId: 'user-1',
      expectedAmount: 10_000,
      expectedCurrency: 'INR',
      createProviderOrder,
    })).resolves.toEqual({
      id: 'order_existing',
      amount: 10_000,
      currency: 'INR',
      receipt: 'mb_1234567890123456',
    });
    expect(createProviderOrder).not.toHaveBeenCalled();
  });

  it('rejects a recovered provider order with mismatched purchase details', async () => {
    const admin = adminWithRpc(async (name) => (
      name === 'abandon_razorpay_checkout_intent'
        ? { data: { status: 'abandoned' }, error: null }
        : { data: null, error: null }
    ));

    await expect(createOrRecoverRazorpayCheckoutOrder({
      adminSupabase: admin,
      claim: {
        status: 'claimed',
        intentId: 'intent-1',
        providerReceipt: 'mb_1234567890123456',
        providerOrderId: null,
      },
      userId: 'user-1',
      expectedAmount: 10_000,
      expectedCurrency: 'INR',
      createProviderOrder: vi.fn(async () => {
        throw new Error('ambiguous');
      }),
      fetchProviderOrderByReceipt: vi.fn(async () => ({
        id: 'order_wrong',
        amount: 1,
        currency: 'INR',
        receipt: 'mb_1234567890123456',
      })),
    })).rejects.toBeInstanceOf(RazorpayCheckoutIntentError);
  });
});
