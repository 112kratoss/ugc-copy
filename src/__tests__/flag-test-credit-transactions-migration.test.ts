import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const migration = fs.readFileSync(
  path.resolve(projectRoot, 'supabase/migrations/20260826090000_flag_test_credit_transactions.sql'),
  'utf8',
);
const read = (relativePath: string) => fs.readFileSync(path.resolve(projectRoot, relativePath), 'utf8');

describe('flag test credit transactions migration', () => {
  it('adds the flag without disturbing existing rows', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false');
  });

  it('detects tests by price per credit, not by date or id', () => {
    // Every real purchase settles at exactly 83 paise per credit, because the
    // amount is derived from PRICING_PLAN_MAP and the credits come from the same
    // row. The test rows sit at 1.00 and 0.20. Hardcoding February ids would not
    // survive a replay onto a fresh database.
    expect(migration).toContain('amount < credits * 20');
    expect(migration).not.toMatch(/razorpay_order_id\s*=/);
    expect(migration).not.toMatch(/created_at\s*<\s*'2026/);
  });

  it('only ever looks at the web rail', () => {
    // Mobile settles at the server catalog price too, and has its own sandbox
    // exclusion. Sweeping it in here would double up.
    expect(migration).toContain('mobile_product_id IS NULL');
  });

  it('is re-runnable', () => {
    expect(migration).toContain('AND NOT is_test');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS');
  });

  it('does not touch the credits those purchases granted', () => {
    // Three of these accounts still hold the balances. Reporting was wrong; the
    // balances are not, and clawing them back would take spendable credits from
    // people who did nothing wrong.
    expect(migration).not.toContain('public.profiles');
    expect(migration).not.toMatch(/credits\s*=\s*credits/);
    expect(migration).not.toMatch(/delete\s+from/i);
  });

  it('excludes flagged rows from both revenue surfaces', () => {
    // A flag nothing reads would leave the numbers exactly as wrong as before.
    expect(read('src/lib/admin-revenue-service.ts')).toContain(".eq('is_test', false)");
    expect(read('src/lib/admin-overview-service.ts')).toContain(".eq('is_test', false)");
  });
});
