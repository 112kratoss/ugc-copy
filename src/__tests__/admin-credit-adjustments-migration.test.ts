import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260728160000_admin_credit_adjustments.sql',
), 'utf8');

describe('admin credit adjustments migration', () => {
  it('records the operator and a mandatory justification for every balance change', () => {
    expect(migration).toContain('CREATE TABLE public.admin_credit_adjustments');
    expect(migration).toContain('reviewer_id uuid NOT NULL REFERENCES auth.users(id)');
    expect(migration).toContain('CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000)');
    expect(migration).toContain('credits_balance_after integer NOT NULL');
    expect(migration).toContain('promotional_credits_balance_after integer NOT NULL');
  });

  it('keeps the reviewer reference from being deleted out from under the audit trail', () => {
    // ON DELETE RESTRICT rather than SET NULL: an audit row that no longer names
    // who authorised the change is not an audit row.
    expect(migration).toContain('reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT');
  });

  it('makes a replayed adjustment idempotent instead of double-crediting', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX admin_credit_adjustments_idempotency_key_idx');
    expect(migration).toContain("RETURN jsonb_build_object(\n      'status', 'already_applied'");
    expect(migration).toContain('WHERE idempotency_key = btrim(p_idempotency_key)');
  });

  it('locks the profile row so concurrent adjustments cannot interleave', () => {
    expect(migration).toContain('FROM public.profiles\n  WHERE id = p_user_id\n  FOR UPDATE');
  });

  it('rejects a no-op adjustment at both the table and the function', () => {
    expect(migration).toContain('CONSTRAINT admin_credit_adjustments_nonzero');
    expect(migration).toContain('IF coalesce(p_credits_delta, 0) = 0 AND coalesce(p_promotional_credits_delta, 0) = 0');
  });

  it('does not clamp balances at zero, matching the refund clawback decision', () => {
    // 20260725231000_credit_integrity_constraints.sql deliberately allows
    // negative balances so refunds cannot silently forgive already-spent value.
    expect(migration).not.toContain('greatest(v_credits_after, 0)');
    expect(migration).not.toContain('CHECK (credits_balance_after >= 0)');
  });

  it('keeps operator audit data off the public Data API', () => {
    expect(migration).toContain('ALTER TABLE public.admin_credit_adjustments ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.admin_credit_adjustments FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.admin_credit_adjustments TO service_role');
  });

  it('restricts the adjustment RPC to the service role', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.apply_admin_credit_adjustment(uuid, uuid, integer, integer, text, text) FROM authenticated',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.apply_admin_credit_adjustment(uuid, uuid, integer, integer, text, text) TO service_role',
    );
    expect(migration).toContain('SET search_path = public, pg_temp');
  });
});
