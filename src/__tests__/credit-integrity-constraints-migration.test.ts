import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260725231000_credit_integrity_constraints.sql',
), 'utf8');

describe('credit integrity constraints migration', () => {
  it('backfills null balances before tightening the columns', () => {
    // SET NOT NULL fails outright if any row still holds NULL, so the backfill
    // has to come first in the file.
    const backfillIndex = migration.indexOf('SET credits = 0');
    const notNullIndex = migration.indexOf('ALTER COLUMN credits SET NOT NULL');
    expect(backfillIndex).toBeGreaterThan(-1);
    expect(notNullIndex).toBeGreaterThan(-1);
    expect(backfillIndex).toBeLessThan(notNullIndex);
  });

  it('locks both balance columns to NOT NULL DEFAULT 0', () => {
    expect(migration).toContain('ALTER COLUMN credits SET DEFAULT 0');
    expect(migration).toContain('ALTER COLUMN credits SET NOT NULL');
    expect(migration).toContain('ALTER COLUMN promotional_credits SET DEFAULT 0');
    expect(migration).toContain('ALTER COLUMN promotional_credits SET NOT NULL');
  });

  it('deliberately omits a non-negative balance check', () => {
    // Refund clawback (reconcile_credit_purchase_adjustment,
    // reconcile_mobile_credit_refund, referral reward reversal) debits without
    // clamping, so a >= 0 CHECK would make legitimate refunds fail mid-flight.
    // The decision is load-bearing: assert it stays documented and unenforced.
    expect(migration).not.toMatch(/CHECK\s*\(\s*credits\s*>=\s*0\s*\)/i);
    expect(migration).not.toMatch(/CHECK\s*\(\s*promotional_credits\s*>=\s*0\s*\)/i);
    expect(migration).toContain('DECISION:');
    expect(migration).toContain('clawback');
  });

  it('guards transaction amounts without validating historical rows', () => {
    // NOT VALID keeps the lock short and leaves pre-history rows alone; the
    // constraint still applies to every new write.
    expect(migration).toContain('transactions_amount_positive_check');
    expect(migration).toMatch(/CHECK\s*\(amount\s*>\s*0\)\s*NOT VALID/i);
    expect(migration).not.toMatch(/VALIDATE CONSTRAINT transactions_amount_positive_check/i);
  });

  it('is re-runnable', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS transactions_amount_positive_check');
  });

  it('does not delete any rows', () => {
    expect(migration).not.toMatch(/drop\s+table/i);
    expect(migration).not.toMatch(/truncate/i);
    expect(migration).not.toMatch(/delete\s+from/i);
  });
});
