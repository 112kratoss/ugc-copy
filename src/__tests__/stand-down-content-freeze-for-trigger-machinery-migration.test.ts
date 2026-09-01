import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260901190000_stand_down_content_freeze_for_trigger_machinery.sql',
), 'utf8');

describe('content freeze stands down for trigger machinery', () => {
  it('exempts trigger-driven writes in both freeze guards', () => {
    // The owner-already-gone exemption from 20260901175000 cannot help while
    // auth.users BEFORE DELETE triggers run: anonymizing the user's comments
    // decrements comment_count on their own posts while the auth row still
    // exists, so the freeze raised 55000 and rolled the erasure back.
    // pg_trigger_depth() = 1 for a direct API write; every cascade or
    // trigger-driven maintenance write arrives at depth >= 2.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.reject_post_write_during_account_deletion');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.reject_post_resource_bundle_write_during_account_deletion');
    const guards = migration.match(/IF pg_trigger_depth\(\) > 1 THEN\s+RETURN NEW;\s+END IF;/g) ?? [];
    expect(guards).toHaveLength(2);
  });

  it('keeps the freeze for direct live-owner writes', () => {
    const raises = migration.match(/RAISE EXCEPTION 'Account deletion is already in progress'/g) ?? [];
    expect(raises).toHaveLength(3);
    expect(migration).toContain("USING ERRCODE = 'object_not_in_prerequisite_state'");
    expect(migration).toContain('NEW.review_status IS NOT DISTINCT FROM OLD.review_status');
  });

  it('keeps trusted-owner execution and revoked app-role execute', () => {
    expect(migration).toContain('ALTER FUNCTION public.reject_post_write_during_account_deletion()\n  OWNER TO postgres');
    expect(migration).toContain('ALTER FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()\n  OWNER TO postgres');
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.reject_post_write_during_account_deletion\(\)\s+FROM PUBLIC, anon, authenticated, service_role/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.reject_post_resource_bundle_write_during_account_deletion\(\)\s+FROM PUBLIC, anon, authenticated, service_role/);
  });
});
