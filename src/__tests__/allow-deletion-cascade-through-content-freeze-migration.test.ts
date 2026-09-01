import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260901175000_allow_deletion_cascade_through_content_freeze.sql',
), 'utf8');

describe('account deletion through the content freeze', () => {
  it('lets the auth.users cascade through both freeze triggers', () => {
    // ON DELETE SET NULL actions are UPDATEs: deleting auth.users cascades
    // into generations, which answers with UPDATE posts SET generation_id =
    // NULL on the frozen rows. Without the exemption the freeze raised 55000
    // and rolled back the entire account deletion (production, 2026-09-01).
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.reject_post_write_during_account_deletion');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.reject_post_resource_bundle_write_during_account_deletion');
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.user_id)');
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.owner_user_id)');
  });

  it('keeps the freeze for live owners', () => {
    // The exemption must only stand down for erasure; direct writes while a
    // deletion job exists still raise, including the INSERT branch and the
    // moderation-only UPDATE carve-out.
    const raises = migration.match(/RAISE EXCEPTION 'Account deletion is already in progress'/g) ?? [];
    expect(raises).toHaveLength(3);
    expect(migration).toContain("USING ERRCODE = 'object_not_in_prerequisite_state'");
    expect(migration).toContain('NEW.review_status IS NOT DISTINCT FROM OLD.review_status');
  });

  it('extends the sold-content erasure exemption to cascade UPDATEs', () => {
    // marketplace_assets ON DELETE SET NULL answers erasure with an UPDATE of
    // legacy_asset_id on a sold bundle; the previous exemption only covered
    // TG_OP = 'DELETE'.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.protect_sold_post_resource_bundle_content');
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.owner_user_id)');
    expect(migration).toMatch(/IF NOT EXISTS \(SELECT 1 FROM auth\.users WHERE id = OLD\.owner_user_id\) THEN\s+IF TG_OP = 'DELETE' THEN\s+RETURN OLD;\s+END IF;\s+RETURN NEW;/);
  });

  it('keeps the trusted-owner execution on the replaced sold-content guard', () => {
    // CREATE OR REPLACE resets SECURITY and search_path, and the guard reads
    // auth.users, so the 20260901090000 hardening must be restated.
    expect(migration).toMatch(/protect_sold_post_resource_bundle_content\(\)\nRETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = ''/);
    expect(migration).toContain('ALTER FUNCTION public.protect_sold_post_resource_bundle_content()\n  OWNER TO postgres');
  });

  it('passes cascade maintenance through the attached-post validator', () => {
    // A bundle UPDATE with no post row is only reachable mid-erasure
    // (post_id is ON DELETE CASCADE); INSERTs without a post keep raising.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.validate_post_resource_bundle_write');
    expect(migration).toMatch(/IF NOT FOUND THEN\s+IF TG_OP = 'UPDATE' THEN[\s\S]{0,400}?RETURN NEW;\s+END IF;\s+RAISE EXCEPTION 'Attached post not found';/);
  });

  it('runs the freeze guards as their trusted owner', () => {
    expect(migration).toContain('ALTER FUNCTION public.reject_post_write_during_account_deletion()\n  OWNER TO postgres');
    expect(migration).toContain('ALTER FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()\n  OWNER TO postgres');
  });
});
