import 'server-only';

import {
  EXTERNAL_API_REQUEST_TIMEOUT_MS,
  ExternalServiceTimeoutError,
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';

const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';

export class RazorpayOrderError extends Error {
  constructor(
    message: string,
    public status = 502,
    public providerStatus?: number,
  ) {
    super(message);
    this.name = 'RazorpayOrderError';
  }
}

export interface CreateRazorpayOrderInput {
  keyId?: string | null;
  keySecret?: string | null;
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
  fetcher?: typeof fetch;
}

export interface RazorpayOrderResponse {
  id: string;
  amount?: number;
  currency?: string;
  receipt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) {
    return false;
  }

  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function authorizationHeader(keyId: string, keySecret: string) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

function parseRazorpayOrderResponse(value: unknown): RazorpayOrderResponse {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) {
    throw new RazorpayOrderError('Razorpay returned an invalid order response.');
  }

  return {
    id: value.id,
    amount: typeof value.amount === 'number' ? value.amount : undefined,
    currency: typeof value.currency === 'string' ? value.currency : undefined,
    receipt: typeof value.receipt === 'string' ? value.receipt : undefined,
  };
}

export async function createRazorpayOrder({
  keyId,
  keySecret,
  amount,
  currency,
  receipt,
  notes,
  fetcher = fetch,
}: CreateRazorpayOrderInput): Promise<RazorpayOrderResponse> {
  const resolvedKeyId = keyId?.trim();
  const resolvedKeySecret = keySecret?.trim();
  if (!resolvedKeyId || !resolvedKeySecret) {
    throw new RazorpayOrderError('Razorpay order creation is not configured.', 500);
  }

  let response: Response;
  try {
    response = await fetchWithProviderTimeout(
      RAZORPAY_ORDERS_URL,
      {
        method: 'POST',
        headers: {
          Authorization: authorizationHeader(resolvedKeyId, resolvedKeySecret),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount,
          currency,
          receipt,
          ...(notes ? { notes } : {}),
        }),
      },
      EXTERNAL_API_REQUEST_TIMEOUT_MS,
      fetcher,
      'Razorpay'
    );
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new ExternalServiceTimeoutError('Razorpay', EXTERNAL_API_REQUEST_TIMEOUT_MS);
    }

    throw error;
  }

  if (!response.ok) {
    throw new RazorpayOrderError('Unable to create Razorpay order.', 502, response.status);
  }

  return parseRazorpayOrderResponse(await response.json());
}
