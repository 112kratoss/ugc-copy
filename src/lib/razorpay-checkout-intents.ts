import 'server-only';

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  fetchRazorpayOrderByReceipt as defaultFetchRazorpayOrderByReceipt,
  type RazorpayOrderResponse,
} from '@/lib/razorpay-orders';

export type RazorpayCheckoutPurchaseKind = 'credits' | 'marketplace' | 'post_resource';

export type RazorpayCheckoutIntentClaim =
  | {
      status: 'claimed';
      intentId: string;
      providerReceipt: string;
      providerOrderId: null;
    }
  | {
      status: 'replay';
      intentId: string;
      providerReceipt: string;
      providerOrderId: string;
    };

export class RazorpayCheckoutIntentError extends Error {
  constructor(
    message: string,
    public status: 400 | 409 | 500,
    public code:
      | 'INVALID_CHECKOUT_INTENT'
      | 'CHECKOUT_IN_PROGRESS'
      | 'CHECKOUT_PAYLOAD_MISMATCH'
      | 'CHECKOUT_INTENT_FAILED',
  ) {
    super(message);
    this.name = 'RazorpayCheckoutIntentError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function createRazorpayCheckoutRequestHash(value: Record<string, unknown>) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function isValidRazorpayCheckoutIntentKey(value: string) {
  return value.length >= 16
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export async function claimRazorpayCheckoutIntent(
  adminSupabase: SupabaseClient,
  {
    clientIntentKey,
    purchaseKind,
    requestPayload,
    userId,
  }: {
    clientIntentKey: string;
    purchaseKind: RazorpayCheckoutPurchaseKind;
    requestPayload: Record<string, unknown>;
    userId: string;
  },
): Promise<RazorpayCheckoutIntentClaim> {
  const normalizedKey = clientIntentKey.trim();
  if (!isValidRazorpayCheckoutIntentKey(normalizedKey)) {
    throw new RazorpayCheckoutIntentError(
      'A valid checkout intent is required.',
      400,
      'INVALID_CHECKOUT_INTENT',
    );
  }

  const { data, error } = await adminSupabase.rpc('claim_razorpay_checkout_intent', {
    p_user_id: userId,
    p_purchase_kind: purchaseKind,
    p_client_intent_key: normalizedKey,
    p_request_hash: createRazorpayCheckoutRequestHash(requestPayload),
  });
  if (error || !isRecord(data)) {
    throw new RazorpayCheckoutIntentError(
      'Unable to reserve checkout.',
      500,
      'CHECKOUT_INTENT_FAILED',
    );
  }

  const status = typeof data.status === 'string' ? data.status : '';
  const intentId = typeof data.intent_id === 'string' ? data.intent_id : '';
  const providerReceipt = typeof data.provider_receipt === 'string'
    ? data.provider_receipt
    : '';
  const providerOrderId = typeof data.provider_order_id === 'string'
    ? data.provider_order_id
    : null;

  if (status === 'payload_mismatch') {
    throw new RazorpayCheckoutIntentError(
      'This checkout intent was already used for different purchase details.',
      409,
      'CHECKOUT_PAYLOAD_MISMATCH',
    );
  }
  if (status === 'in_progress') {
    throw new RazorpayCheckoutIntentError(
      'Checkout creation is already in progress. Please retry shortly.',
      409,
      'CHECKOUT_IN_PROGRESS',
    );
  }
  if (!intentId || !providerReceipt) {
    throw new RazorpayCheckoutIntentError(
      'Unable to reserve checkout.',
      500,
      'CHECKOUT_INTENT_FAILED',
    );
  }
  if (status === 'replay' && providerOrderId) {
    return {
      status,
      intentId,
      providerReceipt,
      providerOrderId,
    };
  }
  if (status === 'claimed' && !providerOrderId) {
    return {
      status,
      intentId,
      providerReceipt,
      providerOrderId: null,
    };
  }

  throw new RazorpayCheckoutIntentError(
    'Unable to reserve checkout.',
    500,
    'CHECKOUT_INTENT_FAILED',
  );
}

export async function completeRazorpayCheckoutIntent(
  adminSupabase: SupabaseClient,
  {
    intentId,
    providerOrderId,
    userId,
  }: {
    intentId: string;
    providerOrderId: string;
    userId: string;
  },
) {
  const { data, error } = await adminSupabase.rpc('complete_razorpay_checkout_intent', {
    p_intent_id: intentId,
    p_user_id: userId,
    p_provider_order_id: providerOrderId,
  });
  const status = isRecord(data) && typeof data.status === 'string' ? data.status : '';
  const recordedOrderId = isRecord(data) && typeof data.provider_order_id === 'string'
    ? data.provider_order_id
    : '';

  if (
    error
    || (status !== 'recorded' && status !== 'replay')
    || recordedOrderId !== providerOrderId
  ) {
    throw new RazorpayCheckoutIntentError(
      'Unable to record checkout.',
      500,
      'CHECKOUT_INTENT_FAILED',
    );
  }
}

export async function abandonRazorpayCheckoutIntent(
  adminSupabase: SupabaseClient,
  {
    errorMessage,
    intentId,
    userId,
  }: {
    errorMessage: string;
    intentId: string;
    userId: string;
  },
) {
  await adminSupabase.rpc('abandon_razorpay_checkout_intent', {
    p_intent_id: intentId,
    p_user_id: userId,
    p_error: errorMessage.slice(0, 500),
  });
}

export async function createOrRecoverRazorpayCheckoutOrder({
  adminSupabase,
  claim,
  createProviderOrder,
  expectedAmount,
  expectedCurrency,
  fetchProviderOrderByReceipt = defaultFetchRazorpayOrderByReceipt,
  keyId,
  keySecret,
  userId,
}: {
  adminSupabase: SupabaseClient;
  claim: RazorpayCheckoutIntentClaim;
  createProviderOrder: (receipt: string) => Promise<RazorpayOrderResponse>;
  expectedAmount: number;
  expectedCurrency: string;
  fetchProviderOrderByReceipt?: typeof defaultFetchRazorpayOrderByReceipt;
  keyId?: string | null;
  keySecret?: string | null;
  userId: string;
}): Promise<RazorpayOrderResponse> {
  if (claim.status === 'replay') {
    return {
      id: claim.providerOrderId,
      amount: expectedAmount,
      currency: expectedCurrency,
      receipt: claim.providerReceipt,
    };
  }

  let providerOrder: RazorpayOrderResponse;
  try {
    providerOrder = await createProviderOrder(claim.providerReceipt);
  } catch (creationError) {
    let recoveredOrder: RazorpayOrderResponse | null = null;
    try {
      recoveredOrder = await fetchProviderOrderByReceipt({
        keyId,
        keySecret,
        receipt: claim.providerReceipt,
      });
    } catch {
      // Preserve the original create error; it carries the most useful route
      // status while the durable receipt still prevents a duplicate order.
    }

    if (!recoveredOrder) {
      await abandonRazorpayCheckoutIntent(adminSupabase, {
        intentId: claim.intentId,
        userId,
        errorMessage: creationError instanceof Error
          ? creationError.message
          : 'Razorpay order creation failed',
      });
      throw creationError;
    }
    providerOrder = recoveredOrder;
  }

  if (
    !providerOrder.id
    || (providerOrder.amount !== undefined && providerOrder.amount !== expectedAmount)
    || (
      providerOrder.currency !== undefined
      && providerOrder.currency.trim().toUpperCase() !== expectedCurrency.trim().toUpperCase()
    )
    || (
      providerOrder.receipt !== undefined
      && providerOrder.receipt !== claim.providerReceipt
    )
  ) {
    await abandonRazorpayCheckoutIntent(adminSupabase, {
      intentId: claim.intentId,
      userId,
      errorMessage: 'Razorpay order recovery details did not match checkout',
    });
    throw new RazorpayCheckoutIntentError(
      'Payment provider returned mismatched order details.',
      500,
      'CHECKOUT_INTENT_FAILED',
    );
  }

  await completeRazorpayCheckoutIntent(adminSupabase, {
    intentId: claim.intentId,
    userId,
    providerOrderId: providerOrder.id,
  });
  return providerOrder;
}
