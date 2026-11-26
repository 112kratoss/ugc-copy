import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { reconcileMobilePurchaseAdjustment } from '@/lib/mobile-commerce';

/**
 * Security audit, 2026-11-27: a RevenueCat refund that names another app user than the one the
 * purchase was credited to (the receipt moved) now settles on the purchase's owner
 * (20261126210256). The database reports it as `event_user_is_owner: false`; this keeps a trace of
 * it, so a buy-restore-refund pattern can be found in the logs.
 */
const input = {
  externalOrderId: 'mobile_app_store_2000000000000001',
  userId: '22222222-2222-4222-8222-222222222222',
  productId: 'magicbooklet.credits.starter',
  providerEventId: 'evt_refund_1',
  providerEventTimestampMs: 1_795_700_000_000,
  action: 'refund' as const,
};

function adminAnswering(data: Record<string, unknown>) {
  return { rpc: vi.fn().mockResolvedValue({ data, error: null }) } as unknown as SupabaseClient;
}

function captureLogs() {
  const records: BackendLogRecord[] = [];
  const restore = setBackendLogSink((record) => { records.push(record); });
  return { records, restore };
}

let restoreSink: (() => void) | null = null;
afterEach(() => {
  restoreSink?.();
  restoreSink = null;
});

describe('a refund named under another app user', () => {
  it('is logged with the receipt and event, never the users', async () => {
    const { records, restore } = captureLogs();
    restoreSink = restore;
    const settlement = await reconcileMobilePurchaseAdjustment(
      adminAnswering({ status: 'refunded', entitlement_type: 'credits', event_user_is_owner: false, rewards: [] }),
      input,
    );
    expect(settlement.status).toBe('refunded');
    const logged = records.filter((record) => record.msg === 'mobile_purchase_adjustment_other_app_user');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'warn' });
    const text = JSON.stringify(logged[0]);
    expect(text).toContain(input.externalOrderId);
    expect(text).toContain(input.providerEventId);
    expect(text).toContain('refunded');
    expect(text).not.toContain(input.userId);
  });

  it('is not logged when the event names the buyer, or for an answer without the field', async () => {
    const { records, restore } = captureLogs();
    restoreSink = restore;
    await reconcileMobilePurchaseAdjustment(
      adminAnswering({ status: 'refunded', entitlement_type: 'credits', event_user_is_owner: true, rewards: [] }),
      input,
    );
    await reconcileMobilePurchaseAdjustment(adminAnswering({ status: 'duplicate_event', rewards: [] }), input);
    expect(records.filter((record) => record.msg === 'mobile_purchase_adjustment_other_app_user')).toEqual([]);
  });
});
