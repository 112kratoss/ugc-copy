import 'server-only';

import {
  EXTERNAL_API_REQUEST_TIMEOUT_MS,
  ExternalServiceTimeoutError,
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';

const RAZORPAY_API_BASE_URL = 'https://api.razorpay.com/v1';
const RAZORPAY_ORDERS_URL = `${RAZORPAY_API_BASE_URL}/orders`;
const MAX_RAZORPAY_RESPONSE_BYTES = 64 * 1024;

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

export type RazorpayPaymentStatus =
  | 'created'
  | 'authorized'
  | 'captured'
  | 'refunded'
  | 'failed';

export interface RazorpayPaymentResponse {
  id: string;
  orderId: string;
  amount: number;
  amountRefunded: number;
  currency: string;
  status: RazorpayPaymentStatus;
  captured: boolean;
  notes: Record<string, string>;
}

export interface FetchRazorpayPaymentInput {
  keyId?: string | null;
  keySecret?: string | null;
  paymentId: string;
  fetcher?: typeof fetch;
}

export interface FetchRazorpayOrderByReceiptInput {
  keyId?: string | null;
  keySecret?: string | null;
  receipt: string;
  fetcher?: typeof fetch;
}

export class RazorpayPaymentError extends Error {
  constructor(
    message: string,
    public status = 502,
    public providerStatus?: number,
  ) {
    super(message);
    this.name = 'RazorpayPaymentError';
  }
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

function isRazorpayPaymentStatus(value: unknown): value is RazorpayPaymentStatus {
  return value === 'created'
    || value === 'authorized'
    || value === 'captured'
    || value === 'refunded'
    || value === 'failed';
}

function parsePaymentNotes(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, noteValue]) => (
      typeof noteValue === 'string' && noteValue.trim()
        ? [[key, noteValue.trim()]]
        : []
    )),
  );
}

export function parseRazorpayPaymentResponse(value: unknown): RazorpayPaymentResponse {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !value.id.trim()
    || typeof value.order_id !== 'string'
    || !value.order_id.trim()
    || !Number.isSafeInteger(value.amount)
    || (value.amount as number) < 0
    || typeof value.currency !== 'string'
    || !value.currency.trim()
    || !isRazorpayPaymentStatus(value.status)
    || typeof value.captured !== 'boolean'
  ) {
    throw new RazorpayPaymentError('Razorpay returned an invalid payment response.');
  }

  const amountRefunded = value.amount_refunded;
  if (!Number.isSafeInteger(amountRefunded) || (amountRefunded as number) < 0) {
    throw new RazorpayPaymentError('Razorpay returned an invalid payment response.');
  }

  return {
    id: value.id.trim(),
    orderId: value.order_id.trim(),
    amount: value.amount as number,
    amountRefunded: amountRefunded as number,
    currency: value.currency.trim().toUpperCase(),
    status: value.status,
    captured: value.captured,
    notes: parsePaymentNotes(value.notes),
  };
}

async function readBoundedJson(
  response: Response,
  responseKind: 'order' | 'payment',
): Promise<unknown> {
  const responseError = (message: string) => (
    responseKind === 'order'
      ? new RazorpayOrderError(message)
      : new RazorpayPaymentError(message)
  );
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RAZORPAY_RESPONSE_BYTES) {
    throw responseError('Razorpay returned an oversized response.');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RAZORPAY_RESPONSE_BYTES) {
    throw responseError('Razorpay returned an oversized response.');
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw responseError('Razorpay returned an invalid response.');
  }
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

  return parseRazorpayOrderResponse(await readBoundedJson(response, 'order'));
}

export async function fetchRazorpayPayment({
  keyId,
  keySecret,
  paymentId,
  fetcher = fetch,
}: FetchRazorpayPaymentInput): Promise<RazorpayPaymentResponse> {
  const resolvedKeyId = keyId?.trim();
  const resolvedKeySecret = keySecret?.trim();
  const resolvedPaymentId = paymentId.trim();
  if (!resolvedKeyId || !resolvedKeySecret) {
    throw new RazorpayPaymentError('Razorpay payment lookup is not configured.', 500);
  }
  if (
    !resolvedPaymentId
    || resolvedPaymentId.length > 64
    || !/^pay_[A-Za-z0-9]+$/.test(resolvedPaymentId)
  ) {
    throw new RazorpayPaymentError('Invalid Razorpay payment identifier.', 400);
  }

  let response: Response;
  try {
    response = await fetchWithProviderTimeout(
      `${RAZORPAY_API_BASE_URL}/payments/${encodeURIComponent(resolvedPaymentId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: authorizationHeader(resolvedKeyId, resolvedKeySecret),
          Accept: 'application/json',
        },
        cache: 'no-store',
      },
      EXTERNAL_API_REQUEST_TIMEOUT_MS,
      fetcher,
      'Razorpay',
    );
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new ExternalServiceTimeoutError('Razorpay', EXTERNAL_API_REQUEST_TIMEOUT_MS);
    }

    throw error;
  }

  if (!response.ok) {
    throw new RazorpayPaymentError(
      'Unable to retrieve Razorpay payment.',
      response.status === 404 ? 400 : 502,
      response.status,
    );
  }

  return parseRazorpayPaymentResponse(await readBoundedJson(response, 'payment'));
}

export async function fetchRazorpayOrderByReceipt({
  keyId,
  keySecret,
  receipt,
  fetcher = fetch,
}: FetchRazorpayOrderByReceiptInput): Promise<RazorpayOrderResponse | null> {
  const resolvedKeyId = keyId?.trim();
  const resolvedKeySecret = keySecret?.trim();
  const resolvedReceipt = receipt.trim();
  if (!resolvedKeyId || !resolvedKeySecret) {
    throw new RazorpayOrderError('Razorpay order recovery is not configured.', 500);
  }
  if (
    !resolvedReceipt
    || resolvedReceipt.length > 40
    || !/^[A-Za-z0-9._:-]+$/.test(resolvedReceipt)
  ) {
    throw new RazorpayOrderError('Invalid Razorpay order receipt.', 400);
  }

  let response: Response;
  try {
    response = await fetchWithProviderTimeout(
      `${RAZORPAY_ORDERS_URL}?receipt=${encodeURIComponent(resolvedReceipt)}&count=2`,
      {
        method: 'GET',
        headers: {
          Authorization: authorizationHeader(resolvedKeyId, resolvedKeySecret),
          Accept: 'application/json',
        },
        cache: 'no-store',
      },
      EXTERNAL_API_REQUEST_TIMEOUT_MS,
      fetcher,
      'Razorpay',
    );
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new ExternalServiceTimeoutError('Razorpay', EXTERNAL_API_REQUEST_TIMEOUT_MS);
    }
    throw error;
  }

  if (!response.ok) {
    throw new RazorpayOrderError('Unable to recover Razorpay order.', 502, response.status);
  }

  const parsed = await readBoundedJson(response, 'order');
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new RazorpayOrderError('Razorpay returned an invalid order recovery response.');
  }
  const matches = parsed.items.filter((item) => (
    isRecord(item) && item.receipt === resolvedReceipt
  ));
  if (matches.length === 0) {
    return null;
  }
  if (matches.length !== 1) {
    throw new RazorpayOrderError('Razorpay returned an ambiguous order recovery response.');
  }

  return parseRazorpayOrderResponse(matches[0]);
}
