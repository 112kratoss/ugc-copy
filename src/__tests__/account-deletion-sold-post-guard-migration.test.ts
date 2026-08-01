import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260801140000_allow_account_deletion_through_sold_post_guard.sql',
), 'utf8');

describe('account deletion through the sold-post guard', () => {
  it('lets the auth.users cascade through both delete guards', () => {
    // posts.user_id and post_resource_bundles.owner_user_id both cascade from
    // auth.users. Without an exemption, any creator who had ever sold an unlock
    // could no longer delete their account.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.reject_sold_post_delete');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete');

    const exemptions = migration.match(/NOT EXISTS \(SELECT 1 FROM auth\.users WHERE id = OLD\.\w+\)/g) ?? [];
    expect(exemptions).toHaveLength(2);
  });

  it('detects the cascade by the owner already being gone', () => {
    // A cascade from auth.users runs after the parent row is deleted, so the
    // owner lookup fails; an ordinary post delete always has a live owner.
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id)');
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.owner_user_id)');
  });

  it('also stands down when the attached post is already gone', () => {
    // The cascade removes the post before the bundle. Answering that delete
    // with a retire UPDATE trips the bundle write validator with
    // 'Attached post not found'.
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM public.posts WHERE id = OLD.post_id)');
  });

  it('still refuses an ordinary delete of a sold post', () => {
    expect(migration).toContain('must be tombstoned rather than deleted');
    expect(migration).toContain("USING ERRCODE = 'restrict_violation'");
  });

  it('still retires an ordinary delete of a sold bundle', () => {
    expect(migration).toContain("SET status = 'draft'");
    expect(migration).toContain('RETURN NULL;');
  });
});
