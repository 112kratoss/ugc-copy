import { describe, expect, it, vi } from 'vitest';

import {
  collectPaymentCaptureAnomalies,
  paymentCaptureAlertFromStatus,
  recordPaymentCaptureAnomaly,
} from '@/lib/payment-capture-anomalies';

describe('payment capture anomalies', () => {
  it('records one row per payment and reason, and treats a redelivery as already recorded', async () => {
    const insert = vi.fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key value' } });
    const client = { from: vi.fn(() => ({ insert })) };
    const anomaly = {
      provider: 'razorpay' as const,
      paymentId: 'pay_1',
      orderId: 'order_1',
      purchaseKind: 'credits' as const,
      reason: 'amount_mismatch',
    };

    await expect(recordPaymentCaptureAnomaly(client as never, anomaly)).resolves.toBe(true);
    await expect(recordPaymentCaptureAnomaly(client as never, anomaly)).resolves.toBe(true);

    expect(client.from).toHaveBeenCalledWith('payment_capture_anomalies');
    expect(insert).toHaveBeenCalledWith({
      provider: 'razorpay',
      payment_id: 'pay_1',
      order_id: 'order_1',
      purchase_kind: 'credits',
      reason: 'amount_mismatch',
    });
  });

  it('never throws: a record that cannot be written is logged and answered false', async () => {
    const client = { from: vi.fn(() => ({ insert: vi.fn().mockRejectedValue(new Error('network')) })) };
    await expect(recordPaymentCaptureAnomaly(client as never, {
      provider: 'razorpay', paymentId: 'pay_1', orderId: null, purchaseKind: 'marketplace', reason: 'currency_mismatch',
    })).resolves.toBe(false);
  });

  it('reports the last three days as one degraded alert naming what to check', async () => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.gte = vi.fn(() => builder);
    builder.order = vi.fn(() => builder);
    builder.limit = vi.fn(async () => ({
      data: [
        { purchase_kind: 'credits', reason: 'amount_mismatch', payment_id: 'pay_1', created_at: '2026-11-27T10:00:00.000Z' },
        { purchase_kind: 'post_resource', reason: 'buyer_mismatch', payment_id: 'pay_2', created_at: '2026-11-26T10:00:00.000Z' },
      ],
      error: null,
    }));
    const client = { from: vi.fn(() => builder) };

    const status = await collectPaymentCaptureAnomalies(client as never, new Date('2026-11-27T12:00:00.000Z'));
    expect(builder.gte).toHaveBeenCalledWith('created_at', '2026-11-24T12:00:00.000Z');
    expect(status).toMatchObject({ available: true, count: 2 });

    const alert = paymentCaptureAlertFromStatus(status);
    expect(alert?.code).toBe('PAYMENT_CAPTURE_UNMATCHED');
    expect(alert?.message).toContain('2 captured Razorpay payment(s)');
    expect(alert?.message).toContain('pay_1');
    expect(paymentCaptureAlertFromStatus({ ...status, count: 0, payments: [] })).toBeNull();
    expect(paymentCaptureAlertFromStatus({ ...status, available: false })).toBeNull();
  });
});
