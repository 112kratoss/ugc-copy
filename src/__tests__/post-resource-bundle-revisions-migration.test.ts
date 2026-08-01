import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260801100000_post_resource_bundle_revisions.sql',
), 'utf8');

describe('post resource bundle revisions migration', () => {
  it('stores revisions in an append-only table with a per-bundle sequence', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.post_resource_bundle_revisions');
    expect(migration).toContain('UNIQUE (bundle_id, revision_number)');
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.post_resource_bundle_revisions TO service_role;');
    // No UPDATE or DELETE grant: a revision is a historical fact.
    expect(migration).not.toMatch(/GRANT[^;]*UPDATE[^;]*post_resource_bundle_revisions/);
  });

  it('blocks rewriting a revision even from the service role', () => {
    expect(migration).toContain('Post resource bundle revisions are immutable');
    expect(migration).toContain('BEFORE UPDATE ON public.post_resource_bundle_revisions');
  });

  it('keeps revisions unreadable by clients', () => {
    expect(migration).toContain('"No client access to post_resource_bundle_revisions"');
    expect(migration).toContain('USING (false) WITH CHECK (false)');
  });

  it('snapshots on content change only, not on every sale', () => {
    // sales_count and the wallet columns are excluded from the fingerprint, so
    // a purchase does not mint a revision.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.post_resource_bundle_content_fingerprint');
    expect(migration).not.toMatch(/'sales_count',\s*p_bundle\.sales_count/);
    expect(migration).not.toMatch(/'creator_earnings_token_subunits'/);
    expect(migration).toContain('IF FOUND AND v_latest.content_fingerprint = v_fingerprint THEN');
    expect(migration).toContain('AFTER INSERT OR UPDATE ON public.post_resource_bundles');
  });

  it('fingerprints the storefront copy so a sold bundle cannot be relabelled', () => {
    expect(migration).toContain("'title', p_bundle.title");
    expect(migration).toContain("'preview_text', p_bundle.preview_text");
    expect(migration).toContain("'price_usd_cents', p_bundle.price_usd_cents");
    expect(migration).toContain("'resource_items', coalesce(p_bundle.resource_items, '[]'::jsonb)");
  });

  it('backfills one revision per existing bundle so old purchases can pin', () => {
    expect(migration).toContain('FROM public.post_resource_bundles AS bundles');
    expect(migration).toContain('ON CONFLICT (bundle_id, revision_number) DO NOTHING');
    expect(migration).toContain('WHERE purchases.revision_id IS NULL');
  });

  it('pins the revision in a trigger so no purchase rail can forget it', () => {
    // Cash, credits and mobile all insert into the same table; the trigger is
    // the one place that cannot be bypassed by adding a fourth rail.
    expect(migration).toContain('BEFORE INSERT ON public.post_resource_bundle_purchases');
    expect(migration).toContain('public.pin_post_resource_bundle_purchase_revision');
    expect(migration).toContain('ORDER BY revision_number DESC');
  });

  it('refuses to drop a revision that a purchase still points at', () => {
    expect(migration).toContain('REFERENCES public.post_resource_bundle_revisions(id) ON DELETE RESTRICT');
  });

  it('retires a sold bundle instead of deleting it', () => {
    expect(migration).toContain('BEFORE DELETE ON public.post_resource_bundles');
    expect(migration).toContain('retire_sold_post_resource_bundle_instead_of_delete');
    expect(migration).toContain("SET status = 'draft'");
    // Returning NULL from a BEFORE DELETE trigger cancels the delete.
    expect(migration).toContain('RETURN NULL;');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS retired_at timestamptz');
  });

  it('refuses to hard-delete a post that has purchased unlocks', () => {
    expect(migration).toContain('BEFORE DELETE ON public.posts');
    expect(migration).toContain('must be tombstoned rather than deleted');
    expect(migration).toContain("USING ERRCODE = 'restrict_violation'");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz');
  });

  it('exposes the purchased revision only to the buyer who owns it', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_purchased_post_resource_bundle_revision');
    expect(migration).toContain('AND purchases.buyer_user_id = p_buyer_user_id');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.get_purchased_post_resource_bundle_revision(uuid, uuid)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_purchased_post_resource_bundle_revision(uuid, uuid)\n  TO service_role;',
    );
  });

  it('tells the caller whether the purchased revision is still current', () => {
    expect(migration).toContain('is_latest boolean');
    expect(migration).toContain('SELECT max(latest.revision_number)');
  });
});
