import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261004161150_allow_service_recipe_exposure_quality_check.sql', 'utf8');
describe('post restore quality gate permission', () => {
  it('allows only the trusted service alongside the owner to execute the private quality predicate', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.post_resource_bundle_quality_issue_for\(uuid\)\s+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_resource_bundle_quality_issue_for\(uuid\)\s+TO service_role/);
    expect(sql).not.toMatch(/SECURITY DEFINER|CREATE OR REPLACE|UPDATE public\./);
  });
});
