import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260926135311_harden_identity_access_and_merge_balances.sql',
), 'utf8');

// Behavior is exercised by identity_access_boundaries/account_merge_debt pgTAP.
// These guards pin rollout compatibility and the immutable migration artifact.
describe('identity access boundaries migration', () => {
  it('shares API admission with RLS without broadening function privileges', () => {
    expect(migration).toContain('public.current_identity_admission()');
    expect(migration).toContain('"state":"active","session_valid":true,"banned":false');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.current_identity_is_active() FROM PUBLIC, anon');
  });

  it('limits the registration policy to profile updates so guest reads survive', () => {
    expect(migration).toContain('ON public.profiles AS RESTRICTIVE FOR UPDATE TO authenticated');
    expect(migration).toContain('WITH CHECK ((SELECT public.current_identity_is_registered()))');
    expect(migration).not.toContain('REVOKE SELECT');
  });

  it('guards both compatible definer mutations without removing their signatures', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.start_workflow_canvas_run(');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.initialize_workflow_canvas_run(');
    expect(migration.match(/RAISE EXCEPTION 'Active identity required'/g)).toHaveLength(2);
    expect(migration).not.toContain('DROP FUNCTION');
  });

  it('preserves signed transfer amounts and the service-only merge boundary', () => {
    expect(migration).toContain('DROP CONSTRAINT account_merges_credits_moved_check');
    expect(migration).toContain('DROP CONSTRAINT account_merges_promotional_credits_moved_check');
    expect(migration).toContain('v_credits_moved := coalesce(v_guest.credits, 0)');
    expect(migration).toContain('SET credits = coalesce(credits, 0) + v_credits_moved');
    expect(migration).not.toContain('greatest(coalesce(');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
  });
});
