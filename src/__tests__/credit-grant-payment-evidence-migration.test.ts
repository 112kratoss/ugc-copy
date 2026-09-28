import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260927184203_require_credit_grant_payment_evidence.sql',
), 'utf8');

describe('credit grant payment evidence migration', () => {
  it('replaces only the existing service-only grant with a pinned search path', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.add_credits(');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    const signature = 'public.add_credits(uuid, integer, uuid, text)';
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    expect(migration).not.toMatch(/DROP\s+(TABLE|FUNCTION)|TRUNCATE|DELETE\s+FROM/i);
  });
});
