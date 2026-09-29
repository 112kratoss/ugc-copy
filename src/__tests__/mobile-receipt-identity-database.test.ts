import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeMobileCreditPurchase,
  restoreMobileEntitlements,
  verifyMobilePurchase,
} from '@/lib/mobile-commerce';
import { postRevenueCatWebhookRouteResponse } from '@/lib/revenuecat-webhook-route-adapter-service';

// Only unrelated notification/referral fan-out is stubbed. Receipt verification,
// webhook parsing and settlement/adjustment RPCs run their real implementation.
vi.mock('@/lib/credit-referral-integration', () => ({
  settleCreditPurchaseReferralRewards: vi.fn().mockResolvedValue({ status: 'no_referral', rewards: [] }),
  notifyReferralRewardSettlement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/mobile-notifications', () => ({
  notifyMobileCreditPurchase: vi.fn().mockResolvedValue(undefined),
  notifyMobilePurchasesRestored: vi.fn().mockResolvedValue(undefined),
}));

const connectionString = process.env.SUPABASE_TEST_DB_URL;
describe.skipIf(!connectionString)('mobile receipt identity against real settlement SQL', () => {
  let db: Client;
  let userId: string;
  let readQueue: Promise<unknown>;
  const productId = 'magicbooklet.credits.starter';

  beforeEach(async () => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString });
    readQueue = Promise.resolve();
    await db.connect();
    await db.query('begin');
    await db.query("set local lock_timeout='3s'");
    await db.query("set local statement_timeout='10s'");
    userId = randomUUID();
    await db.query(`insert into auth.users(id,email,aud,role,is_anonymous,created_at)
      values($1::uuid,$1::text || '@example.invalid','authenticated','authenticated',false,now())`, [userId]);
    await db.query('update public.profiles set credits=0,promotional_credits=0 where id=$1', [userId]);
    await db.query('set local role service_role');
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`);
  });

  afterEach(async () => {
    try { await db?.query('rollback'); } finally { await db?.end(); }
  });

  function client() {
    return {
      from(table: string) {
        const reads: Record<string, { columns: string; filter: string }> = {
          profiles: { columns: 'credits', filter: 'id' },
          marketplace_purchases: { columns: 'asset_id', filter: 'buyer_user_id' },
          post_resource_bundle_purchases: { columns: 'bundle_id', filter: 'buyer_user_id' },
        };
        const read = reads[table];
        if (!read) throw new Error(`Unexpected table ${table}`);
        return { select: () => ({ eq: (column: string, value: unknown) => {
          if (column !== read.filter) throw new Error('Unexpected filter');
          const rows = readQueue.then(() => db.query(`select ${read.columns} from public.${table} where ${column}=$1`, [value]));
          readQueue = rows;
          const result = rows.then(({ rows: data }) => ({ data, error: null }));
          return Object.assign(result, {
            maybeSingle: async () => ({ data: (await rows).rows[0] ?? null, error: null }),
          });
        } }) };
      },
      async rpc(name: string, args: Record<string, unknown>) {
        if (!['complete_mobile_purchase', 'reconcile_mobile_purchase_adjustment'].includes(name)) {
          throw new Error(`Unexpected RPC ${name}`);
        }
        const keys = Object.keys(args);
        if (!keys.every(key => /^p_[a-z_]+$/.test(key))) throw new Error('Unexpected argument');
        const result = await db.query(
          `select public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(',')}) as result`,
          Object.values(args),
        );
        return { data: result.rows[0].result, error: null };
      },
    } as unknown as SupabaseClient;
  }

  function receiptFetcher(store: string, storeId: string | undefined) {
    // Synthetic identifiers with the field structure observed in live REST
    // receipts. This is not evidence of provider delivery or field transitions.
    return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      subscriber: { non_subscriptions: { [productId]: [{
        id: 'rc-audit-purchase-identity', store, store_transaction_id: storeId,
        is_sandbox: true, purchase_date: '2026-09-29T00:00:00Z',
      }] } },
    }), { status: 200 }));
  }

  async function sync(store: 'app_store' | 'play_store', storeId: string | undefined, transactionId?: string) {
    const verified = await verifyMobilePurchase({
      userId, productId, provider: store, transactionId,
      revenueCatApiKey: 'test-key', nodeEnv: 'production', fetcher: receiptFetcher(store, storeId),
    });
    return completeMobileCreditPurchase({ adminSupabase: client(), userId, productId, ...verified });
  }

  async function webhook(store: 'app_store' | 'play_store', storeId: string, type: string, receiptStoreId: string | null = storeId, eventId = `event-${type}`, eventTimestampMs = 1000) {
    return postRevenueCatWebhookRouteResponse({
      request: new Request('https://example.invalid/api/webhooks/revenuecat', {
        method: 'POST', headers: { authorization: 'audit-token' },
        body: JSON.stringify({ event: {
          id: eventId, type, app_user_id: userId, product_id: productId,
          transaction_id: storeId, original_transaction_id: storeId,
          store: store.toUpperCase(), environment: 'SANDBOX', event_timestamp_ms: eventTimestampMs,
        } }),
      }),
      dependencies: {
        getExpectedAuthorization: () => 'audit-token', createServiceClient: client,
        verifyMobilePurchase: args => verifyMobilePurchase({
          ...args, fetcher: receiptFetcher(store, receiptStoreId ?? undefined), revenueCatApiKey: 'test-key', nodeEnv: 'production',
        }),
        logError: vi.fn(), recordPaymentWebhookProcessingFailure: vi.fn().mockResolvedValue(undefined),
      },
    });
  }

  async function state() {
    return (await db.query(`select credits,
      (select count(*)::int from public.mobile_store_transactions where user_id=$1) as receipts,
      (select count(*)::int from public.transactions where user_id=$1) as transactions
      from public.profiles where id=$1`, [userId])).rows[0];
  }

  describe.each([
    ['app_store', '1000000999999999'],
    ['play_store', 'GPA.9999-8888-7777-66666'],
  ] as const)('%s', (store, storeId) => {
    it('defers an ID-only sync until the store ID arrives, then grants and refunds once', async () => {
      await expect(sync(store, undefined, 'rc-audit-purchase-identity')).rejects.toMatchObject({
        message: 'Mobile purchase receipt did not include a store transaction id.',
      });
      expect(await state()).toEqual({ credits: 0, receipts: 0, transactions: 0 });
      expect(await sync(store, storeId, 'rc-audit-purchase-identity')).toMatchObject({ alreadyProcessed: false });
      expect(await (await webhook(store, storeId, 'NON_RENEWING_PURCHASE')).json())
        .toMatchObject({ result: 'already_processed' });
      expect(await state()).toEqual({ credits: 500, receipts: 1, transactions: 1 });
      expect(await (await webhook(store, storeId, 'CANCELLATION')).json())
        .toMatchObject({ result: 'refunded' });
      expect(await state()).toEqual({ credits: 0, receipts: 1, transactions: 1 });
    });

    it('skips an ID-only restore, then restores the store receipt exactly once', async () => {
      expect(await restoreMobileEntitlements(client(), userId, {
        fetcher: receiptFetcher(store, undefined), revenueCatApiKey: 'test-key',
      })).toMatchObject({ restoredCreditPurchases: 0, alreadyProcessedCreditPurchases: 0 });
      expect(await state()).toEqual({ credits: 0, receipts: 0, transactions: 0 });
      expect(await restoreMobileEntitlements(client(), userId, {
        fetcher: receiptFetcher(store, storeId), revenueCatApiKey: 'test-key',
      })).toMatchObject({ restoredCreditPurchases: 1, alreadyProcessedCreditPurchases: 0 });
      expect(await sync(store, storeId, 'rc-audit-purchase-identity')).toMatchObject({ alreadyProcessed: true });
      expect(await state()).toEqual({ credits: 500, receipts: 1, transactions: 1 });
    });

    it('settles once across both IDs, latest receipt, restore and webhook retries', async () => {
      expect(await sync(store, storeId, 'rc-audit-purchase-identity')).toMatchObject({ alreadyProcessed: false });
      expect(await sync(store, storeId, storeId)).toMatchObject({ alreadyProcessed: true });
      expect(await sync(store, storeId)).toMatchObject({ alreadyProcessed: true });
      expect(await restoreMobileEntitlements(client(), userId, {
        fetcher: receiptFetcher(store, storeId), revenueCatApiKey: 'test-key',
      })).toMatchObject({ restoredCreditPurchases: 0, alreadyProcessedCreditPurchases: 1 });
      const response = await webhook(store, storeId, 'NON_RENEWING_PURCHASE');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: 'already_processed' });
      expect(await state()).toEqual({ credits: 500, receipts: 1, transactions: 1 });
      expect((await db.query('select store_transaction_id,provider from public.mobile_store_transactions where user_id=$1', [userId])).rows)
        .toEqual([{ store_transaction_id: storeId, provider: store }]);
    });

    it('refunds the same settlement through the webhook store ID', async () => {
      await sync(store, storeId, 'rc-audit-purchase-identity');
      const response = await webhook(store, storeId, 'CANCELLATION');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: 'refunded' });
      expect(await state()).toEqual({ credits: 0, receipts: 1, transactions: 1 });
      const duplicate = await webhook(store, storeId, 'CANCELLATION');
      expect(await duplicate.json()).toMatchObject({ result: 'duplicate_event' });
      expect(await state()).toEqual({ credits: 0, receipts: 1, transactions: 1 });
    });

    it('rejects a refund event reused for another receipt without consuming that receipt', async () => {
      const otherStoreId = `${storeId}-other`;
      await sync(store, storeId);
      await sync(store, otherStoreId);
      expect((await webhook(store, storeId, 'CANCELLATION')).status).toBe(200);
      const before = (await db.query(`select status, provider_event_id, provider_event_timestamp_ms
        from public.mobile_store_transactions where store_transaction_id=$1`, [otherStoreId])).rows;
      const conflict = await webhook(store, otherStoreId, 'CANCELLATION');
      expect(conflict.status).toBe(503);
      expect((await db.query(`select status, provider_event_id, provider_event_timestamp_ms
        from public.mobile_store_transactions where store_transaction_id=$1`, [otherStoreId])).rows).toEqual(before);
      expect((await state()).credits).toBe(500);
      const corrected = await webhook(store, otherStoreId, 'CANCELLATION', otherStoreId, 'distinct-refund-event');
      expect(corrected.status).toBe(200);
      expect(await corrected.json()).toMatchObject({ result: 'refunded' });
      expect((await state()).credits).toBe(0);
    });

    it('rejects the same credit event with a changed action and accepts a distinct restore', async () => {
      await sync(store, storeId);
      await webhook(store, storeId, 'CANCELLATION');
      const conflict = await webhook(store, storeId, 'REFUND_REVERSED', storeId, 'event-CANCELLATION');
      expect(conflict.status).toBe(503);
      expect((await state()).credits).toBe(0);
      const restored = await webhook(store, storeId, 'REFUND_REVERSED', storeId, 'distinct-restore', 2000);
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ result: 'restored' });
      expect((await state()).credits).toBe(500);
      const replay = await webhook(store, storeId, 'CANCELLATION', storeId, 'event-CANCELLATION', 1000);
      expect(await replay.json()).toMatchObject({ result: 'stale_event' });
      expect((await state()).credits).toBe(500);
    });

    it('retries a store webhook with no matching store ID in REST without granting credits', async () => {
      // Removing this field is a fault injection, not an observed live receipt.
      const response = await webhook(store, storeId, 'NON_RENEWING_PURCHASE', null);
      expect(response.status).toBe(503);
      expect(await state()).toEqual({ credits: 0, receipts: 0, transactions: 0 });
    });
  });
});
