import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260801090000_close_post_resource_bundle_client_writes.sql',
), 'utf8');

describe('close post resource bundle client writes migration', () => {
  it('revokes every client privilege on the three bundle tables', () => {
    expect(migration).toContain(`REVOKE ALL PRIVILEGES ON TABLE
  public.post_resource_bundles,
  public.post_resource_bundle_orders,
  public.post_resource_bundle_purchases
FROM PUBLIC, anon, authenticated, service_role;`);
  });

  it('also strips column-scoped grants, which a table REVOKE leaves behind', () => {
    expect(migration).toContain('information_schema.columns');
    expect(migration).toContain('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role');
  });

  it('restores the backend contract so the service-role RPCs keep working', () => {
    expect(migration).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.post_resource_bundles,
  public.post_resource_bundle_orders,
  public.post_resource_bundle_purchases
TO service_role;`);
  });

  it('drops the owner write policies that bypassed the bundle mutation RPC', () => {
    // These let a creator PostgREST-write their own bundle row directly, which
    // skipped the marketplace quality gate and left sales_count writable.
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can insert their own post resource bundles"');
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can update their own post resource bundles"');
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can delete their own post resource bundles"');
  });

  it('keeps the owner and buyer SELECT policies as defense in depth', () => {
    expect(migration).not.toContain('DROP POLICY IF EXISTS "Owners can view their own post resource bundles"');
    expect(migration).not.toContain('DROP POLICY IF EXISTS "Buyers can view their own post resource bundle purchases"');
    expect(migration).not.toContain('DROP POLICY IF EXISTS "Buyers can view their own post resource bundle orders"');
  });
});
