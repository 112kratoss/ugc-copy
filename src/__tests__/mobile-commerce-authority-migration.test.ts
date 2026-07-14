import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260714113000_harden_mobile_purchase_authority.sql',
  ),
  'utf8',
);
const provisioningRunbook = fs.readFileSync(
  path.join(process.cwd(), 'docs/mobile-store-product-catalog.md'),
  'utf8',
);

describe('mobile commerce authority migration', () => {
  it('binds immutable server intents to product, resource, amount, and currency', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.mobile_purchase_intents');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.protect_mobile_store_product_authority()');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.protect_mobile_purchase_intent_authority()');
    expect(migration).toContain("RAISE EXCEPTION 'mobile purchase intent authority is immutable'");
    expect(migration).toContain('REVOKE ALL ON TABLE public.mobile_purchase_intents FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('v_intent.product_id <> p_product_id');
    expect(migration).toContain('AND amount_subunits = v_amount');
    expect(migration).toContain('The unexpired intent is the locked server quote');
  });

  it('consumes each store transaction and purchase intent globally once', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.mobile_store_transactions');
    expect(migration).toContain('UNIQUE (store_transaction_id)');
    expect(migration).toContain('external_order_id text NOT NULL UNIQUE');
    expect(migration).toContain('purchase_intent_id uuid NOT NULL UNIQUE');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.complete_mobile_purchase(');
    expect(migration).toContain('ON CONFLICT DO NOTHING');
    expect(migration).toContain("RETURN jsonb_build_object('status', 'transaction_conflict')");
  });

  it('anonymizes user linkage without deleting immutable purchase evidence', () => {
    expect(migration.match(/user_id uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/g)).toHaveLength(2);
    expect(migration).not.toContain('user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT');
    expect(migration).toContain('purchase_intent_id uuid NOT NULL UNIQUE');
    expect(migration).toContain('OLD.user_id IS NOT NULL AND NEW.user_id IS NULL');
    expect(migration).toContain("RAISE EXCEPTION 'mobile purchase intent user identity is immutable'");
    expect(migration).toContain("RAISE EXCEPTION 'mobile store transaction user identity is immutable'");
    expect(migration.match(/user_id IS DISTINCT FROM p_user_id/g)).toHaveLength(3);
    expect(migration).toContain('Nullable only for one-way account-deletion anonymization');
    expect(provisioningRunbook).toContain('Account deletion anonymizes');
    expect(provisioningRunbook).toContain('must not delete settled ledger rows');
  });

  it('revokes and explicitly restores every entitlement type', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.reconcile_mobile_purchase_adjustment(');
    expect(migration).toContain('DELETE FROM public.marketplace_purchases');
    expect(migration).toContain('DELETE FROM public.post_resource_bundle_purchases');
    expect(migration).toContain("SET status = CASE WHEN p_action = 'refund' THEN 'revoked' ELSE 'active' END");
    expect(migration).toContain("SET status = CASE WHEN p_action = 'refund' THEN 'revoked' ELSE 'consumed' END");
    expect(migration).toContain('public.reconcile_mobile_credit_purchase_adjustment(');
  });

  it('keeps non-credit tiers fail-closed and provides service-only provisioning', () => {
    const seedBlock = migration.slice(
      migration.indexOf('INSERT INTO public.mobile_store_products'),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.provision_mobile_store_product'),
    );
    expect(seedBlock.match(/magicbooklet\.credits\./g)).toHaveLength(3);
    expect(seedBlock).not.toContain('marketplace_unlock');
    expect(seedBlock).not.toContain('post_resource_unlock');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.provision_mobile_store_product(');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.list_mobile_store_product_provisioning_gaps()');
    expect(migration).toContain('mobile_store_products_one_active_tier_idx');
    expect(migration).toContain('GRANT SELECT ON TABLE public.mobile_store_products TO service_role');
    expect(migration).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_store_products TO service_role');
    expect(migration).toContain("p_entitlement_type NOT IN ('marketplace_unlock', 'post_resource_unlock')");
    expect(migration).toContain("OR p_currency <> 'USD'");
    expect(migration).toContain("RETURN jsonb_build_object('status', 'product_not_configured')");
    expect(provisioningRunbook).toContain('Do not seed guessed product IDs');
    expect(provisioningRunbook).toContain('list_mobile_store_product_provisioning_gaps');
  });

  it('requires constrained product binding before legacy refunds can be acknowledged', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.bind_legacy_mobile_store_transaction_product(');
    expect(migration).toContain("OLD.product_id LIKE 'legacy.%'");
    expect(migration).toContain('products.amount_subunits = OLD.amount_subunits');
    expect(migration).toContain("'status', 'legacy_product_unbound'");
    expect(migration).toContain('DELETE FROM public.marketplace_purchases');
    expect(migration).toContain('DELETE FROM public.post_resource_bundle_purchases');
    expect(provisioningRunbook).toContain('bind_legacy_mobile_store_transaction_product');
    expect(provisioningRunbook).toContain('REFUND_REVERSED');
  });
});
