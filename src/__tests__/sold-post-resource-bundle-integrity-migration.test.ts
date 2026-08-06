import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260806120000_freeze_sold_post_resource_bundles.sql',
  ),
  'utf8',
);
const proofMediaMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260806130000_purchase_proof_media_snapshots.sql',
  ),
  'utf8',
);

describe('sold post resource bundle integrity migration', () => {
  it('serializes explicit bundle mutation with canonical purchases', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.apply_post_resource_bundle_mutation');
    expect(migration).toMatch(/FROM public\.post_resource_bundles AS bundles[\s\S]*FOR UPDATE/);
    expect(migration).toMatch(/FROM public\.post_resource_bundle_purchases AS purchases/);
    expect(migration).toContain('purchases.price_usd_cents > 0');
    expect(migration).toContain('RESOURCE_BUNDLE_LOCKED');
  });

  it('freezes buyer-visible content while permitting status-only restoration', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.protect_sold_post_resource_bundle_content');
    expect(migration).toContain('post_resource_bundle_content_fingerprint(NEW)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.sync_sold_post_resource_bundle_visibility');
    expect(migration).toMatch(/NEW\.visibility = 'public'[\s\S]*'published'/);
    expect(migration).toMatch(/public\.marketplace_assets AS assets[\s\S]*status = 'active'/);
  });

  it('commits post, bundle, and media rows through one transaction', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.update_post_with_resource_bundle_and_media');
    expect(migration).toContain('FROM public.update_post_with_resource_bundle(');
    expect(migration).toContain('PERFORM public.replace_post_media(');
    expect(migration).toContain('New uploads must use a new post media key');
  });

  it('locks the bundle in the web cash completion rail', () => {
    const cashCompletion = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.complete_post_resource_bundle_purchase'),
    );
    expect(cashCompletion).toMatch(
      /FROM public\.post_resource_bundles\s+WHERE id = v_order\.bundle_id\s+FOR UPDATE/,
    );
  });

  it('persists an all-or-none immutable order quote and rejects rolling-deploy legacy inserts', () => {
    expect(migration).toContain('quoted_price_usd_cents integer');
    expect(migration).toContain('quoted_revision_id uuid');
    expect(migration).toContain('quoted_content_fingerprint text');
    expect(migration).toContain('quoted_media jsonb');
    expect(migration).toMatch(/quoted_price_usd_cents IS NOT NULL[\s\S]*quoted_media IS NOT NULL[\s\S]*jsonb_typeof\(quoted_media\) = 'array'/);
    expect(migration).toContain("IF NEW.status = 'created' AND NEW.quoted_revision_id IS NULL");
    expect(migration).toContain('Created post resource orders require an immutable quote');
    expect(migration).toContain('leave those rows unquoted and make');
  });

  it('quotes and records cash orders under the bundle lock with exact replay identity', () => {
    const recorder = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.record_post_resource_bundle_cash_order'),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.unlock_free_post_resource_bundle'),
    );
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_post_resource_bundle_cash_quote');
    expect(recorder).toMatch(/FROM public\.post_resource_bundles[\s\S]*FOR UPDATE/);
    expect(recorder).toContain('v_bundle.price_usd_cents IS DISTINCT FROM p_expected_price_usd_cents');
    expect(recorder).toContain('v_revision.id IS DISTINCT FROM p_expected_revision_id');
    expect(recorder).toContain("v_existing.status = 'created'");
    expect(recorder.indexOf("RETURN jsonb_build_object('status', 'replay'") )
      .toBeLessThan(recorder.indexOf("IF v_bundle.status <> 'published'"));
  });

  it('settles only the price and immutable revision frozen on the order', () => {
    const cashCompletion = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.complete_post_resource_bundle_purchase'),
    );
    expect(cashCompletion).toContain('v_order.quoted_revision_id');
    expect(cashCompletion).toContain('v_order.quoted_price_usd_cents');
    expect(cashCompletion).toContain('v_order.quoted_content_fingerprint');
    expect(cashCompletion).toContain('earnings_usd_cents + v_order.quoted_price_usd_cents');
    expect(cashCompletion).not.toContain('earnings_usd_cents + v_bundle.price_usd_cents');
  });

  it('creates free orders and their exact pinned entitlement in one locked transaction', () => {
    const freeUnlock = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.unlock_free_post_resource_bundle'),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.complete_post_resource_bundle_purchase'),
    );
    expect(freeUnlock).toMatch(/FROM public\.post_resource_bundles[\s\S]*FOR UPDATE/);
    expect(freeUnlock).toContain("v_bundle.access_mode <> 'free'");
    expect(freeUnlock).toContain('v_revision.content_fingerprint');
    expect(freeUnlock).toContain('quoted_revision_id');
    expect(freeUnlock).toContain('INSERT INTO public.post_resource_bundle_purchases');
  });

  it('retains normal posts and bundles while a provider cash order can still settle', () => {
    expect(migration).toContain('RESOURCE_CHECKOUT_PENDING');
    expect(migration).toMatch(/orders\.status = 'created'[\s\S]*orders\.amount_subunits > 0/);
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.reject_sold_post_delete');
    expect(migration).toContain('ON DELETE SET NULL');
  });

  it('copies order-time proof media into purchases and prefers it during rollout backfill', () => {
    expect(migration).toContain('snapshot_post_resource_proof_media');
    expect(proofMediaMigration).toContain('SELECT orders.quoted_media');
    expect(proofMediaMigration).toContain('jsonb_array_elements(v_quoted_media)');
    const quotedBackfill = proofMediaMigration.indexOf('jsonb_array_elements(orders.quoted_media)');
    const liveBackfill = proofMediaMigration.lastIndexOf('JOIN public.post_media AS media');
    expect(quotedBackfill).toBeGreaterThan(0);
    expect(quotedBackfill).toBeLessThan(liveBackfill);
    expect(proofMediaMigration).toContain('WHERE orders.quoted_media IS NULL');
    expect(proofMediaMigration).toContain('ON CONFLICT DO NOTHING');
  });

  it('keeps creator account deletion exempt from the sold delete guard', () => {
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.owner_user_id)');
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM public.posts WHERE id = OLD.post_id)');
  });
});
