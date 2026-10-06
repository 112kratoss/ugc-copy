import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const migration = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20261006172011_reconcile_detached_bundle_cash_refunds.sql'), 'utf8');
describe('detached bundle cash refund migration', () => {
  it('keeps erasure, bundle and order lock order and service-only execution', () => {
    expect(migration.indexOf('FROM auth.users')).toBeLessThan(migration.indexOf('    PERFORM 1 FROM public.post_resource_bundles'));
    expect(migration).toContain('FOR KEY SHARE');
    expect(migration).toContain('orders.bundle_id IS NOT DISTINCT FROM v_order.bundle_id');
    expect(migration).toContain('OR orders.bundle_id IS NULL');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
    expect(migration).toContain("RAISE EXCEPTION 'Unexpected post-resource cash adjustment locking definition'");
    expect(migration).not.toMatch(/DROP\s+(TABLE|FUNCTION)|TRUNCATE/i);
  });
});
