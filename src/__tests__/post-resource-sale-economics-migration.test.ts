import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'supabase/migrations/20260723130000_post_resource_sale_economics.sql',
  ),
  'utf8',
);

describe('post resource sale economics migration', () => {
  it('creates an exact creator wallet ledger with an 85/15 token split', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.creator_resource_wallets');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.creator_resource_wallet_entries');
    expect(migration).toContain('NEW.price_usd_cents::bigint * 85');
    expect(migration).toContain('NEW.price_usd_cents::bigint * 15');
    expect(migration).toContain('AFTER INSERT ON public.post_resource_bundle_purchases');
  });

  it('settles in hundredths of a token and reverses refunds idempotently', () => {
    expect(migration).toContain("'purchase:' || NEW.id::text");
    expect(migration).toContain("'refund-purchase:' || v_sale.purchase_id::text");
    expect(migration).toContain('ON CONFLICT (event_key) DO NOTHING');
    expect(migration).toContain('creator_amount_token_subunits + platform_fee_token_subunits');
    expect(migration).toContain('gross_token_units::bigint * 100');
    expect(migration).toContain('AFTER UPDATE OF status ON public.post_resource_bundle_orders');
    expect(migration).toContain("OLD.status <> 'paid' OR NEW.status <> 'failed'");
  });

  it('keeps wallet mutation private while allowing creators read-only access', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('USING (auth.uid() = user_id)');
    expect(migration).toContain(
      'REVOKE ALL ON public.creator_resource_wallets FROM PUBLIC, anon, authenticated',
    );
  });

  it('blocks new direct-IAP post resource intents while preserving credit unlocks', () => {
    expect(migration).toContain("WHERE entitlement_type = 'post_resource_unlock'");
    expect(migration).toContain('BEFORE INSERT ON public.mobile_purchase_intents');
    expect(migration).toContain('Post resource packages are credit-only on mobile');
    expect(migration).not.toContain('DROP FUNCTION public.unlock_post_resource_bundle_with_credits');
  });
});
