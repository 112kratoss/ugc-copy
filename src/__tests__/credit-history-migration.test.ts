import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import creditPacks from '../../contracts/credit-packs-v1.json';

const projectRoot = process.cwd();
const migrationsDirectory = join(projectRoot, 'supabase', 'migrations');
const migrationName = readdirSync(migrationsDirectory).find((name) => name.endsWith('_credit_history.sql'));
const migration = migrationName ? readFileSync(join(migrationsDirectory, migrationName), 'utf8') : '';
// What the database runs, without the header's prose about what it does not read.
const statements = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
const signature = 'public.list_credit_history(uuid[], timestamp with time zone, text, integer)';

describe('credit history migration', () => {
  it('defines one definer function that only the service role may call', () => {
    expect(migrationName).toBeDefined();
    expect(statements).toMatch(/CREATE OR REPLACE FUNCTION public\.list_credit_history\(\s*p_user_ids uuid\[\],\s*p_before_occurred_at timestamp with time zone DEFAULT NULL,\s*p_before_id text DEFAULT NULL,\s*p_limit integer DEFAULT 31\s*\)/);
    expect(statements).toMatch(/RETURNS TABLE \(\s*entry_id text,\s*kind text,\s*amount integer,\s*occurred_at timestamp with time zone,\s*title text,\s*detail text\s*\)/);
    expect(statements).toMatch(/STABLE\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
    expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
  });

  it('refuses a set that is not one identity and the guests linked to it', () => {
    expect(statements).toContain('linked.merged_into_user_id = p_user_ids[1]');
    expect(statements).toMatch(/cardinality\(p_user_ids\) > 100/);
    expect(statements).toMatch(/p_limit < 1 OR p_limit > 101/);
    expect(statements).toContain('(p_before_occurred_at IS NULL) <> (p_before_id IS NULL)');
  });

  it('pages newest first on the time and an id compared byte for byte', () => {
    expect(statements).toContain('ORDER BY e.occurred_at DESC, e.entry_id COLLATE "C" DESC');
    expect(statements).toContain('e.entry_id COLLATE "C" < p_before_id COLLATE "C"');
  });

  it('names each credit pack as the packs contract does', () => {
    expect(creditPacks.packs.length).toBeGreaterThan(0);
    for (const pack of creditPacks.packs) {
      expect(statements).toContain(`('${pack.mobileProductId}', ${pack.credits}, '${pack.name} pack')`);
    }
    const namedPacks = statements.match(/\('magicbooklet\.credits\.[a-z]+', \d+, '[A-Za-z ]+ pack'\)/g) ?? [];
    expect(namedPacks).toHaveLength(creditPacks.packs.length);
  });

  it('reads every table a credit movement leaves a record in', () => {
    for (const table of [
      'transactions',
      'credit_purchase_adjustments',
      'credit_grants',
      'referral_credit_ledger',
      'admin_credit_adjustments',
      'generations',
      'generation_spend_audits',
      'ai_usage_events',
      'creation_credit_reservations',
      'post_resource_bundle_purchases',
      'marketplace_purchases',
    ]) {
      expect(statements, table).toMatch(new RegExp(`FROM public\\.${table} AS `));
    }
  });

  it('does not list the guest link or the store-side twin of an app purchase', () => {
    // The link moves the guest's balance, which the guest's own rows already
    // explain; an app purchase is listed from its credit transaction.
    expect(statements).not.toContain('public.account_merges');
    expect(statements).not.toContain('public.mobile_store_transactions');
  });

  it('tells credit unlocks from cash, store and free ones as the unlock library does', () => {
    const viewerUnlocks = readFileSync(join(projectRoot, 'src/lib/viewer-unlocks.ts'), 'utf8');

    expect(viewerUnlocks).toContain("const CREDIT_ORDER_REFERENCE_PREFIXES = ['credits_bundle_', 'credits_asset_'];");
    expect(statements).toContain("starts_with(o.razorpay_order_id, 'credits_bundle_')");
    expect(statements).toContain("starts_with(o.razorpay_order_id, 'credits_asset_')");
    expect(statements).toContain("starts_with(mo.razorpay_order_id, 'credits_asset_')");
    expect(statements).toContain('copied.legacy_purchase_id = mp.id');
  });

  it('keeps the operator\'s reason out of the list', () => {
    expect(statements).not.toMatch(/x\.reason/);
    expect(statements).toContain("'Made by Magicbooklet support'");
  });

  it('is pinned by a pgTAP file of its own', () => {
    const pgTap = join(projectRoot, 'supabase', 'tests', 'database', 'credit_history.test.sql');

    expect(existsSync(pgTap)).toBe(true);
    expect(readFileSync(pgTap, 'utf8')).toContain('public.list_credit_history(');
  });
});
