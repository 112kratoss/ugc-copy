import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260819020000_marketplace_seller_wallet_crediting.sql',
), 'utf8');

describe('marketplace seller wallet crediting migration', () => {
  it('credits sellers through the same exact-subunit 85/15 split as bundles', () => {
    expect(migration).toContain("v_creator_subunits := NEW.price_usd_cents::bigint * 85;");
    expect(migration).toContain("v_platform_subunits := NEW.price_usd_cents::bigint * 15;");
    // The split must come from the purchase row's token price; provider
    // amount_subunits may be INR and must never drive the creator share.
    expect(migration).not.toContain('amount_subunits * 85');
  });

  it('settles inside the purchase insert transaction via an idempotent ledger entry', () => {
    expect(migration).toContain('AFTER INSERT ON public.marketplace_purchases');
    expect(migration).toContain("'marketplace-purchase:' || NEW.id::text");
    expect(migration).toContain('ON CONFLICT (event_key) DO NOTHING');
  });

  it('credits nothing for free unlocks', () => {
    expect(migration).toContain('IF NEW.price_usd_cents <= 0 THEN\n    RETURN NEW;\n  END IF;');
  });

  it('reverses the credit when a refund removes the entitlement', () => {
    expect(migration).toContain('AFTER UPDATE OF status ON public.marketplace_orders');
    // Reversal only after the purchase row is really gone: deletions remove
    // orders rather than transitioning them, and the double-purchase guard
    // never wrote a sale entry for its order.
    expect(migration).toContain("IF OLD.status <> 'paid' OR NEW.status <> 'failed' THEN");
    expect(migration).toContain('FROM public.marketplace_purchases\n    WHERE order_id = NEW.id');
    expect(migration).toContain("'refund-marketplace-purchase:' || v_sale.purchase_id::text");
    expect(migration).toContain('lifetime_refunded_token_subunits = lifetime_refunded_token_subunits');
  });

  it('backfills accrued sales by accumulating, never overwriting, wallet balances', () => {
    // The sale-economics migration could SET absolute totals because wallets
    // were empty then; here bundle earnings already exist and must survive.
    expect(migration).toContain('SET available_token_subunits = creator_resource_wallets.available_token_subunits\n      + EXCLUDED.available_token_subunits');
    expect(migration).not.toMatch(/SET available_token_subunits = EXCLUDED\.available_token_subunits/);
    expect(migration).toContain("'marketplace-legacy:' || asset_id::text");
    expect(migration).toContain('WHERE purchases.price_usd_cents > 0');
  });

  it('keeps the settlement functions out of client reach', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.apply_marketplace_wallet_purchase_change()\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.reverse_marketplace_wallet_on_refund()\n  FROM PUBLIC, anon, authenticated;',
    );
  });
});
