import { createHash, timingSafeEqual } from 'node:crypto';

import {
  buildMobileExternalOrderId,
  type MobilePurchaseProvider,
} from '@/lib/mobile-commerce';

export interface RevenueCatRefundEvent {
  action: 'refund' | 'restore';
  eventId: string;
  eventTimestampMs: number;
  externalOrderId: string;
  productId: string;
  userId: string;
}

export interface RevenueCatPurchaseEvent {
  eventId: string;
  eventTimestampMs: number;
  productId: string;
  provider: Exclude<MobilePurchaseProvider, 'revenuecat' | 'sandbox'>;
  transactionId: string;
  userId: string;
  /**
   * What the store actually charged, as RevenueCat reported it
   * (`price_in_purchased_currency` + `currency`). Evidence for revenue
   * reporting only — the settlement amount stays the server catalog's nominal
   * price. Both null when the event omits or malforms the pair.
   */
  storeReportedPrice: number | null;
  storeReportedCurrency: string | null;
}

type ParseResult =
  | { kind: 'ignored' }
  | { kind: 'invalid'; message: string }
  | { kind: 'purchase'; event: RevenueCatPurchaseEvent }
  | { kind: 'refund'; event: RevenueCatRefundEvent };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function storeProvider(
  store: unknown,
): Exclude<MobilePurchaseProvider, 'revenuecat' | 'sandbox'> | null {
  if (store === 'APP_STORE') return 'app_store';
  if (store === 'PLAY_STORE') return 'play_store';
  return null;
}

function storeReportedPricePair(event: Record<string, unknown>): {
  storeReportedPrice: number | null;
  storeReportedCurrency: string | null;
} {
  const price = event.price_in_purchased_currency;
  const currency = nonEmptyString(event.currency);
  if (
    typeof price !== 'number'
    || !Number.isFinite(price)
    || price < 0
    || !currency
    || !/^[A-Z]{3}$/.test(currency)
  ) {
    return { storeReportedPrice: null, storeReportedCurrency: null };
  }

  return { storeReportedPrice: price, storeReportedCurrency: currency };
}

export function webhookAuthorizationMatches(actual: string | null, expected: string) {
  if (!actual || !expected) return false;

  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function parseRevenueCatRefundEvent(payload: unknown): ParseResult {
  if (!isRecord(payload) || !isRecord(payload.event)) {
    return { kind: 'invalid', message: 'Invalid RevenueCat webhook payload.' };
  }

  const event = payload.event;
  const type = nonEmptyString(event.type);
  const isPurchase = type === 'NON_RENEWING_PURCHASE' || type === 'INITIAL_PURCHASE';
  if (!isPurchase && type !== 'CANCELLATION' && type !== 'REFUND_REVERSED') {
    return { kind: 'ignored' };
  }

  const productId = nonEmptyString(event.product_id);

  const eventId = nonEmptyString(event.id);
  const transactionId = nonEmptyString(event.transaction_id)
    ?? nonEmptyString(event.original_transaction_id);
  const userId = nonEmptyString(event.app_user_id);
  const provider = storeProvider(event.store);
  const eventTimestampMs = event.event_timestamp_ms;

  if (
    !productId
    || !eventId
    || !transactionId
    || !userId
    || !isUuid(userId)
    || !provider
    || typeof eventTimestampMs !== 'number'
    || !Number.isSafeInteger(eventTimestampMs)
    || eventTimestampMs <= 0
  ) {
    return { kind: 'invalid', message: 'Incomplete RevenueCat purchase adjustment event.' };
  }

  if (isPurchase) {
    return {
      kind: 'purchase',
      event: {
        eventId,
        eventTimestampMs,
        productId,
        provider,
        transactionId,
        userId,
        ...storeReportedPricePair(event),
      },
    };
  }

  return {
    kind: 'refund',
    event: {
      action: type === 'REFUND_REVERSED' ? 'restore' : 'refund',
      eventId,
      eventTimestampMs,
      externalOrderId: buildMobileExternalOrderId(provider, transactionId),
      productId,
      userId,
    },
  };
}
