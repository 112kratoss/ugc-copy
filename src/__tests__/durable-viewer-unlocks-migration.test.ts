import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260801150000_purchases_and_payouts_survive_account_deletion.sql',
), 'utf8');

describe('durable viewer unlock migration', () => {
  it('uses purchase UUID as the durable library and detail identity', () => {
    expect(migration).toContain('purchase_id uuid');
    expect(migration).toContain('purchases.id AS purchase_id');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_viewer_post_resource_unlock');
    expect(migration).toContain('purchases.id = p_purchase_id');
    expect(migration).toContain('purchases.buyer_user_id = p_buyer_user_id');
  });

  it('persists moderation retraction independently from post lifetime', () => {
    expect(migration).toContain('moderation_retracted_at timestamptz');
    expect(migration).toContain('posts_sync_purchase_moderation_update');
    expect(migration).toContain('posts_sync_purchase_moderation_delete');
    expect(migration).toContain('purchases.moderation_retracted_at IS NULL');
  });

  it('keeps retention tables and projections service-only', () => {
    for (const table of [
      'post_resource_bundle_revision_files',
      'post_resource_bundle_revision_supplements',
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ON public.${table}\n  FOR ALL TO anon, authenticated`);
      expect(migration).toContain(`ON TABLE public.${table} TO service_role`);
    }
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.list_creator_purchased_revisions_for_retention(uuid)\n  FROM PUBLIC, anon, authenticated;',
    );
  });

  it('retains neutral escrow objects only while a purchase references the revision', () => {
    expect(migration).toContain('retained_paths AS');
    expect(migration).toContain('JOIN purchased_revisions ON purchased_revisions.revision_id = files.revision_id');
    expect(migration).toContain("files.retained_bucket = 'post_resource_files'");
  });
});
