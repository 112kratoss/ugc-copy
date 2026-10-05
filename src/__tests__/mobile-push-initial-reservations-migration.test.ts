import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync('supabase/migrations/20261005043056_reserve_initial_mobile_push_deliveries.sql', 'utf8');
describe('initial push reservation migration', () => {
  it('adds service-only invoker batch wrappers and retains the existing finalizer', () => {
    expect(sql.match(/SECURITY INVOKER SET search_path\s*=\s*''/g)).toHaveLength(3);
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.finish_mobile_push_retry');
    for (const signature of ['record_initial_mobile_push_outcomes(jsonb)', 'finish_initial_mobile_push_outcomes(jsonb)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`);
    }
  });
});
