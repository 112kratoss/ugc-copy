import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260819010000_money_integrity_fixes.sql',
), 'utf8');

describe('money integrity fixes migration', () => {
  it('adds a defaulted, validated currency to the credit-purchase ledger', () => {
    // Every historical row is INR (web billing is INR-only and mobile rows
    // record the nominal INR catalog price), so the default doubles as the
    // backfill.
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR'");
    expect(migration).toContain("CHECK (currency ~ '^[A-Z]{3}$')");
  });

  it('records the settlement currency on mobile credit transactions', () => {
    expect(migration).toContain('status,\n        mobile_product_id,\n        currency\n      )');
    expect(migration).toContain("'created',\n        p_product_id,\n        v_currency\n      )");
  });

  it('drops the old complete_mobile_purchase overload before recreating it', () => {
    // CREATE OR REPLACE with added parameters would create a second overload;
    // PostgREST rpc dispatch would then be ambiguous for named-argument calls.
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text);',
    );
    expect(migration).toContain('p_store_reported_price numeric DEFAULT NULL');
    expect(migration).toContain('p_store_reported_currency text DEFAULT NULL');
  });

  it('keeps the recreated settlement function service-role only', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text)\n  TO service_role;',
    );
  });

  it('stores the store-reported price as an all-or-nothing pair', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS store_reported_price numeric(12,4)');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS store_reported_currency text');
    expect(migration).toContain(
      'CHECK ((store_reported_price IS NULL) = (store_reported_currency IS NULL))',
    );
    // Malformed webhook evidence degrades to NULL; it must never fail a
    // settlement that the catalog already authorized.
    expect(migration).toContain('v_store_reported_price := p_store_reported_price;');
  });

  it('unlocks free marketplace assets atomically under the asset row lock', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.unlock_free_marketplace_asset(');
    expect(migration).toContain('FROM public.marketplace_assets\n  WHERE id = p_asset_id\n  FOR UPDATE;');
    expect(migration).toContain('ON CONFLICT (razorpay_order_id) DO NOTHING');
    expect(migration).toContain('ON CONFLICT (asset_id, buyer_user_id) DO NOTHING');
  });

  it('never leaves an entitlement-less free order behind on the ownership race', () => {
    expect(migration).toContain('DELETE FROM public.marketplace_orders WHERE id = v_order_id;');
    expect(migration).toContain("'status', 'already_owned'");
  });

  it('keeps the free unlock service-role only and free of earnings side effects', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.unlock_free_marketplace_asset(uuid, uuid, text, text)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.unlock_free_marketplace_asset(uuid, uuid, text, text)\n  TO service_role;',
    );
    // A $0 unlock increments sales_count only; earnings_usd_cents must not
    // move inside unlock_free_marketplace_asset.
    const unlockBody = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.unlock_free_marketplace_asset('),
      migration.indexOf('REVOKE ALL ON FUNCTION public.unlock_free_marketplace_asset'),
    );
    expect(unlockBody).toContain('SET sales_count = sales_count + 1');
    expect(unlockBody).not.toContain('earnings_usd_cents');
  });

  it('extends the abandoned free-order sweeper to the marketplace rail', () => {
    expect(migration).toContain("AND orders.razorpay_order_id LIKE 'free_bundle_%'");
    expect(migration).toContain("AND orders.razorpay_order_id LIKE 'free\\_%' ESCAPE '\\'");
    expect(migration).toContain('DELETE FROM public.marketplace_orders AS orders');
    // Only never-completed strands qualify: paid orders and orders with a
    // purchase row must survive the sweep.
    expect(migration).toContain('RETURN v_deleted_bundle + v_deleted_marketplace;');
  });

  it('relaxes the payout details bound to ciphertext size in both check and RPC', () => {
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS creator_payout_requests_payout_details_check;',
    );
    expect(migration).toContain('CHECK (char_length(btrim(payout_details)) BETWEEN 3 AND 4000)');
    expect(migration).toContain("char_length(v_details) > 4000 THEN\n    RETURN jsonb_build_object('status', 'invalid_details');");
  });
});
