import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';

/**
 * Captured payments that credited nothing.
 *
 * A Razorpay `payment.captured` whose payment does not match its order
 * (amount, currency, buyer, or not captured after all) is acknowledged with
 * 200 so Razorpay stops retrying, and nothing is credited. That is right for
 * the ledger and wrong for the person who paid, so it is recorded durably in
 * `payment_capture_anomalies` (one row per payment and reason) and reported on
 * /api/ops/backend-alerts as PAYMENT_CAPTURE_UNMATCHED for three days, which
 * fails the hourly watchdog so the owner looks at it in Razorpay.
 *
 * Not recorded through recordPaymentWebhookProcessingFailure: that writes a
 * provider_dependency_events row, which backend health reports as
 * PAYMENT_WEBHOOK_PROCESSING_FAILURE (degraded) for an hour, and any
 * non-success row as a provider-dependency warning; health that is not
 * strictly ok holds every production release, for an event only a manual
 * refund or credit in Razorpay can settle.
 */

export const PAYMENT_CAPTURE_ANOMALY_ALERT_LOOKBACK_HOURS = 72;
const SAMPLE_LIMIT = 50;
const LISTED_PAYMENTS = 5;

export type PaymentCaptureAnomaly = {
  provider: 'razorpay';
  paymentId: string;
  orderId: string | null;
  purchaseKind: 'credits' | 'marketplace' | 'post_resource';
  reason: string;
};

export type PaymentCaptureAnomalyStatus = {
  available: boolean;
  error: string | null;
  count: number;
  truncated: boolean;
  payments: Array<{ paymentId: string; purchaseKind: string; reason: string }>;
};

/** Never throws; answers whether the anomaly is on record (a redelivery finds it already there). */
export async function recordPaymentCaptureAnomaly(
  client: Pick<SupabaseClient, 'from'>,
  anomaly: PaymentCaptureAnomaly,
): Promise<boolean> {
  try {
    const { error } = await client.from('payment_capture_anomalies').insert({
      provider: anomaly.provider,
      payment_id: anomaly.paymentId.slice(0, 200),
      order_id: anomaly.orderId ? anomaly.orderId.slice(0, 200) : null,
      purchase_kind: anomaly.purchaseKind,
      reason: anomaly.reason.slice(0, 120),
    });
    if (error && (error as { code?: string }).code !== '23505') throw error;
    return true;
  } catch (error) {
    logBackendError('payment_capture_anomaly_record_failed', {
      provider: anomaly.provider,
      orderId: anomaly.orderId,
      purchaseKind: anomaly.purchaseKind,
      reason: anomaly.reason,
      error,
    });
    return false;
  }
}

export async function collectPaymentCaptureAnomalies(
  client: SupabaseClient,
  now: Date,
): Promise<PaymentCaptureAnomalyStatus> {
  const empty: PaymentCaptureAnomalyStatus = { available: true, error: null, count: 0, truncated: false, payments: [] };
  try {
    const since = new Date(now.getTime() - PAYMENT_CAPTURE_ANOMALY_ALERT_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    const { data, error } = await client
      .from('payment_capture_anomalies')
      .select('purchase_kind,reason,payment_id,created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(SAMPLE_LIMIT);
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []) as Array<{ purchase_kind: string; reason: string; payment_id: string }>;
    return {
      ...empty,
      count: rows.length,
      truncated: rows.length >= SAMPLE_LIMIT,
      payments: rows.map((row) => ({ paymentId: row.payment_id, purchaseKind: row.purchase_kind, reason: row.reason })),
    };
  } catch (error) {
    logBackendError('payment_capture_anomalies_unreadable', { error });
    return { ...empty, available: false, error: error instanceof Error ? error.message : 'unreadable' };
  }
}

export function paymentCaptureAlertFromStatus(
  status: PaymentCaptureAnomalyStatus,
): { code: 'PAYMENT_CAPTURE_UNMATCHED'; message: string } | null {
  if (!status.available || status.count === 0) return null;
  const listed = status.payments.slice(0, LISTED_PAYMENTS)
    .map((payment) => `${payment.paymentId} (${payment.purchaseKind}, ${payment.reason})`)
    .join(', ');
  return {
    code: 'PAYMENT_CAPTURE_UNMATCHED',
    message: `${status.count}${status.truncated ? '+' : ''} captured Razorpay payment(s) in the last ${PAYMENT_CAPTURE_ANOMALY_ALERT_LOOKBACK_HOURS} hours matched no order and credited nothing: ${listed}. `
      + 'Refund or credit each by hand in Razorpay and the admin console; the full list is payment_capture_anomalies.',
  };
}
