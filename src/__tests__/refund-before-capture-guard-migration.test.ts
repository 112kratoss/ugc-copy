import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260725230000_guard_refund_before_capture_reconciliation.sql',
), 'utf8');

describe('refund before capture guard migration', () => {
  it('replaces the reconciliation function in place', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.reconcile_credit_purchase_adjustment(',
    );
  });

  it('keeps the hardened definer envelope the original function shipped with', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
  });

  it('re-asserts the service-role-only grant so the replacement cannot widen access', () => {
    const signature = 'public.reconcile_credit_purchase_adjustment(uuid, text, text, bigint, text, text)';
    expect(migration).toContain(
      `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`,
    );
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
  });

  it('derives grant-applied from durable state rather than the mutable flag alone', () => {
    // A granted-then-fully-reversed transaction also carries
    // credit_effect_applied = false, so the flag alone would misclassify it as
    // never granted and skip the debit on a later reversal.
    expect(migration).toContain('v_grant_applied');
    expect(migration).toMatch(/base_credit_delta/);
  });

  it('never debits the balance when the purchase grant was not applied', () => {
    // The debit has to be conditional on the grant; an unconditional
    // `credits - delta` is exactly the bug this migration removes.
    expect(migration).toMatch(/IF\s+v_grant_applied/i);
    expect(migration).toContain('v_applied_credit_delta');
  });

  it('voids the never-granted transaction so a late capture cannot grant it', () => {
    // add_credits only grants rows still in 'created'; marking the row refunded
    // is what stops a delayed payment.captured from crediting a refunded order.
    expect(migration).toMatch(/refunded/i);
  });

  it('does not drop or truncate any ledger data', () => {
    expect(migration).not.toMatch(/drop\s+table/i);
    expect(migration).not.toMatch(/truncate/i);
    expect(migration).not.toMatch(/delete\s+from/i);
  });
});
