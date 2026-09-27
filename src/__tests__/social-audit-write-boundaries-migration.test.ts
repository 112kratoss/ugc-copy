import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260927024241_restrict_social_audit_and_marketplace_client_writes.sql',
), 'utf8');

describe('social and marketplace table boundary migration', () => {
  it('revokes table and separate column grants before restoring owner reads', () => {
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE');
    expect(migration).toContain('REVOKE ALL PRIVILEGES (%s)');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT SELECT ON TABLE public.post_saves, public.showcase_saves');
    expect(migration).not.toMatch(/GRANT SELECT, INSERT[^;]+TO authenticated/);
  });
  it('installs identity gates even when fresh databases lacked ambient grants', () => {
    expect(migration.match(/CREATE POLICY authenticated_identity_active/g)).toHaveLength(4);
    expect(migration.match(/AS RESTRICTIVE FOR ALL TO authenticated/g)).toHaveLength(4);
    expect(migration.match(/WITH CHECK \(\(SELECT public.current_identity_is_active\(\)\)\)/g)).toHaveLength(4);
  });
  it('keeps the trusted service path and does not rewrite stored data', () => {
    expect(migration).toContain('public.marketplace_asset_content TO service_role');
    expect(migration).not.toMatch(/\b(?:DELETE FROM|UPDATE public|INSERT INTO|SECURITY DEFINER)\b/);
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
  });
});
