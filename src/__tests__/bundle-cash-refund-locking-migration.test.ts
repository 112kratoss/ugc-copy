import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const migration = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20260928082335_serialize_bundle_cash_refunds.sql'), 'utf8');
describe('bundle cash refund locking migration', () => {
  it('preserves the service-only adjustment boundary', () => {
    const signature = 'public.reconcile_post_resource_cash_adjustment(text, text, text, text, text)';
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated;`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).not.toMatch(/DROP\s+(TABLE|FUNCTION)|TRUNCATE/i);
  });
});
