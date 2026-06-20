import { createHash, timingSafeEqual } from 'node:crypto';

import {
  buildMobileExternalOrderId,
  resolveMobileCreditProduct,
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

type ParseResult =
  | { kind: 'ignored' }
  | { kind: 'invalid'; message: string }
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

function storeProvider(store: unknown): MobilePurchaseProvider | null {
  if (store === 'APP_STORE') return 'app_store';
  if (store === 'PLAY_STORE') return 'play_store';
  return null;
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
  if (type !== 'CANCELLATION' && type !== 'REFUND_REVERSED') {
    return { kind: 'ignored' };
  }

  const productId = nonEmptyString(event.product_id);
  if (!productId || !resolveMobileCreditProduct(productId)) {
    return { kind: 'ignored' };
  }

  const eventId = nonEmptyString(event.id);
  const transactionId = nonEmptyString(event.transaction_id)
    ?? nonEmptyString(event.original_transaction_id);
  const userId = nonEmptyString(event.app_user_id);
  const provider = storeProvider(event.store);
  const eventTimestampMs = event.event_timestamp_ms;

  if (
    !eventId
    || !transactionId
    || !userId
    || !isUuid(userId)
    || !provider
    || typeof eventTimestampMs !== 'number'
    || !Number.isSafeInteger(eventTimestampMs)
    || eventTimestampMs <= 0
  ) {
    return { kind: 'invalid', message: 'Incomplete RevenueCat credit refund event.' };
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
