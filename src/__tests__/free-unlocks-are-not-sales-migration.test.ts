import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'supabase', 'migrations');
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith('_free_unlocks_are_not_sales.sql'));
const migrationName = migrationNames[0] ?? '';
const migration = migrationName ? readMigration(migrationName) : '';

function readMigration(name: string) {
  return readFileSync(join(migrationsDirectory, name), 'utf8');
}

/** One function's CREATE [OR REPLACE] statement, through its closing dollar quote. */
function functionDefinition(sql: string, name: string) {
  const match = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`).exec(sql);
  expect(match, `${name} is not defined`).not.toBeNull();
  const start = match!.index;
  const tag = /\bAS (\$[a-z_]*\$)/.exec(sql.slice(start));
  if (!tag) throw new Error(`${name} has no dollar-quoted body`);
  const bodyStart = start + tag.index + tag[0].length;
  const end = sql.indexOf(`${tag[1]};`, bodyStart);
  expect(end, `${name} body is not closed`).toBeGreaterThan(bodyStart);
  return sql.slice(start, end + tag[1].length + 1);
}

/** A definition with its comment lines dropped and its header made comparable. */
function comparable(definition: string) {
  return definition
    .replace(/^CREATE (?:OR REPLACE )?FUNCTION/, 'CREATE FUNCTION')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

function expectServiceRoleOnly(sql: string, signature: string) {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${escaped}\\s+FROM PUBLIC, anon, authenticated;`));
  expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${escaped}\\s+TO service_role;`));
}

describe('free unlocks are not sales migration', () => {
  it('is one migration', () => {
    expect(migrationNames).toHaveLength(1);
    expect(migrationName).toMatch(/^\d{14}_free_unlocks_are_not_sales\.sql$/);
  });

  it('adds a non-negative free unlock counter that starts at zero', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.post_resource_bundles\s+ADD COLUMN IF NOT EXISTS free_unlock_count integer NOT NULL DEFAULT 0;/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT post_resource_bundles_free_unlock_count_check\s+CHECK \(free_unlock_count >= 0\);/,
    );
  });

  it('changes nothing in the free unlock but the counter it bumps', () => {
    const previous = functionDefinition(
      readMigration('20260806120000_freeze_sold_post_resource_bundles.sql'),
      'unlock_free_post_resource_bundle',
    );
    const current = functionDefinition(migration, 'unlock_free_post_resource_bundle');

    expect(previous).toContain('  SET sales_count = sales_count + 1,\n');
    expect(comparable(current)).not.toContain('sales_count');
    expect(comparable(current)).toBe(comparable(previous).replace(
      '  SET sales_count = sales_count + 1,\n',
      '  SET free_unlock_count = free_unlock_count + 1,\n',
    ));
    expectServiceRoleOnly(migration, 'public.unlock_free_post_resource_bundle(uuid, uuid, text, text)');
  });

  it('never adds to sales_count anywhere', () => {
    expect(migration).not.toMatch(/sales_count\s*=\s*(?:bundles\.)?sales_count\s*\+/);
  });

  it('moves only free purchases, never past the paid ones and never below zero', () => {
    const split = functionDefinition(migration, 'split_post_resource_bundle_free_unlocks');

    // A free unlock is a purchase that cost nothing, whichever rail made it and
    // whatever the bundle costs today.
    expect(split).toContain('purchases.price_usd_cents = 0');
    // Only the free purchases not counted as free yet, bounded by the sales the
    // bundle has beyond its paid purchases...
    expect(split).toMatch(/greatest\(coalesce\(free_purchases\.free_count, 0\) - bundles\.free_unlock_count, 0\)/);
    // ...except on a free recipe, which takes no paid unlock: every count beyond
    // its paid purchases is a free one, a count whose purchase is gone included.
    expect(split).toMatch(/WHEN bundles\.access_mode = 'free' AND bundles\.price_usd_cents = 0 THEN\s+greatest\(bundles\.sales_count - coalesce\(paid_purchases\.paid_count, 0\), 0\)/);
    expect(split).toMatch(/LEFT JOIN free_purchases ON free_purchases\.bundle_id = bundles\.id/);
    expect(split).toMatch(/greatest\(bundles\.sales_count - coalesce\(paid_purchases\.paid_count, 0\), 0\)/);
    expect(split).toMatch(/SET sales_count = bundles\.sales_count - moves\.moved,\s+free_unlock_count = bundles\.free_unlock_count \+ moves\.moved/);
    // The check the plan asks for: no bundle ends with fewer sales than paid purchases.
    expect(split).toMatch(/purchases\.price_usd_cents > 0/);
    expect(split).toMatch(/RAISE EXCEPTION/);
    expect(split).toContain('SECURITY INVOKER');

    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.split_post_resource_bundle_free_unlocks\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.split_post_resource_bundle_free_unlocks/);
  });

  it('runs the split once with only the stamp and the deletion freeze set aside, in one statement', () => {
    const blockStart = migration.indexOf('DO $split$');
    expect(blockStart).toBeGreaterThanOrEqual(0);
    const block = migration.slice(blockStart, migration.indexOf('$split$;', blockStart));
    const disabled = block.match(/DISABLE TRIGGER \w+/g) ?? [];
    const enabled = block.match(/ENABLE TRIGGER \w+/g) ?? [];

    expect(disabled.sort()).toEqual([
      'DISABLE TRIGGER post_resource_bundles_freeze_for_account_deletion',
      'DISABLE TRIGGER post_resource_bundles_set_updated_at',
    ]);
    expect(enabled.sort()).toEqual([
      'ENABLE TRIGGER post_resource_bundles_freeze_for_account_deletion',
      'ENABLE TRIGGER post_resource_bundles_set_updated_at',
    ]);
    // The split runs between the two, and the listing refresh stays on so the
    // marketplace's top-sales key follows the new paid count.
    const split = block.indexOf('public.split_post_resource_bundle_free_unlocks()');
    expect(split).toBeGreaterThan(block.lastIndexOf('DISABLE TRIGGER'));
    expect(split).toBeLessThan(block.indexOf('ENABLE TRIGGER'));
    expect(block).not.toContain('refresh_marketplace_listing');
  });

  it('hands free_unlock_count to every read that hands out sales_count', () => {
    const ownerRows = functionDefinition(migration, 'get_owner_post_bundle_summaries');
    expect(ownerRows).toMatch(/sales_count integer,\s+free_unlock_count integer,/);
    expect(ownerRows).toMatch(/bundles\.sales_count,\s+bundles\.free_unlock_count,/);
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.get_owner_post_bundle_summaries(uuid[]);');
    expectServiceRoleOnly(migration, 'public.get_owner_post_bundle_summaries(uuid[])');

    const ownerTotals = functionDefinition(migration, 'get_owner_post_sales_summary');
    expect(ownerTotals).toContain("'salesCount', coalesce(sum(bundles.sales_count), 0)::bigint");
    expect(ownerTotals).toContain("'freeUnlockCount', coalesce(sum(bundles.free_unlock_count), 0)::bigint");
    expectServiceRoleOnly(migration, 'public.get_owner_post_sales_summary(uuid)');

    const publicSummaries = functionDefinition(migration, 'get_public_post_resource_bundle_summaries');
    expect(publicSummaries).toMatch(/sales_count integer,\s+free_unlock_count integer,/);
    // Counted for a published bundle only, like every other public field.
    expect(publicSummaries).toContain(
      "CASE WHEN bundles.status = 'published' THEN bundles.free_unlock_count ELSE NULL END AS free_unlock_count",
    );
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.get_public_post_resource_bundle_summaries(uuid[]);');
    expectServiceRoleOnly(migration, 'public.get_public_post_resource_bundle_summaries(uuid[])');

    const listing = functionDefinition(migration, 'list_marketplace_resource_bundles');
    expect(listing).toMatch(/sales_count integer, free_unlock_count integer,/);
    expect(listing).toMatch(/bundles\.sales_count, bundles\.free_unlock_count,/);
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer);',
    );
    expectServiceRoleOnly(
      migration,
      'public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)',
    );
  });

  it('keeps the listing, its filters and its best-selling order exactly as they were', () => {
    const previous = functionDefinition(
      readMigration('20260810112000_index_marketplace_search.sql'),
      'list_marketplace_resource_bundles',
    );
    const current = functionDefinition(migration, 'list_marketplace_resource_bundles');

    expect(comparable(current)).toBe(comparable(previous)
      .replace('  sales_count integer, earnings_usd_cents integer,', '  sales_count integer, free_unlock_count integer, earnings_usd_cents integer,')
      .replace('      bundles.price_usd_cents, bundles.sales_count, bundles.earnings_usd_cents,', '      bundles.price_usd_cents, bundles.sales_count, bundles.free_unlock_count, bundles.earnings_usd_cents,'));
    expect(current).toContain("WHEN 'top-sales' THEN 'listings.sales_count DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'");
  });

  it('keeps the owner and public summaries otherwise unchanged', () => {
    const ownerRowsBefore = functionDefinition(
      readMigration('20260723120000_post_resource_media_scope.sql'),
      'get_owner_post_bundle_summaries',
    );
    expect(comparable(functionDefinition(migration, 'get_owner_post_bundle_summaries'))).toBe(comparable(ownerRowsBefore)
      .replace('  sales_count integer,\n', '  sales_count integer,\n  free_unlock_count integer,\n')
      .replace('    bundles.sales_count,\n', '    bundles.sales_count,\n    bundles.free_unlock_count,\n'));

    const publicBefore = functionDefinition(
      readMigration('20260715101500_public_bundle_summary_hydration.sql'),
      'get_public_post_resource_bundle_summaries',
    );
    expect(comparable(functionDefinition(migration, 'get_public_post_resource_bundle_summaries'))).toBe(comparable(publicBefore)
      .replace('  sales_count integer,\n', '  sales_count integer,\n  free_unlock_count integer,\n')
      .replace(
        "    CASE WHEN bundles.status = 'published' THEN bundles.sales_count ELSE NULL END AS sales_count,\n",
        "    CASE WHEN bundles.status = 'published' THEN bundles.sales_count ELSE NULL END AS sales_count,\n"
          + "    CASE WHEN bundles.status = 'published' THEN bundles.free_unlock_count ELSE NULL END AS free_unlock_count,\n",
      ));
  });
});
