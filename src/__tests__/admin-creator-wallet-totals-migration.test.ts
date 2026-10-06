import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(), 'supabase/migrations/20261006193446_admin_creator_wallet_totals.sql',
), 'utf8');

describe('admin creator wallet totals migration', () => {
  it('restricts the definer aggregate to the service role', () => {
    expect(migration).toContain('LANGUAGE sql STABLE SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.admin_creator_wallet_totals() FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.admin_creator_wallet_totals() TO service_role;');
  });

  it('aggregates the complete wallet table without a row bound', () => {
    expect(migration).toContain('FROM public.creator_resource_wallets w');
    expect(migration).not.toMatch(/\bLIMIT\b|\bOFFSET\b/i);
  });
});
