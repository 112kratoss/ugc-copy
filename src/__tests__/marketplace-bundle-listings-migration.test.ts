import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809210000_marketplace_bundle_listings.sql',
), 'utf8');

const postsTrigger = migration.slice(
  migration.indexOf('CREATE TRIGGER posts_refresh_marketplace_listing'),
  migration.indexOf('EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_post();'),
);

describe('marketplace bundle listings migration', () => {
  it('recomputes on every post column the listing gate reads', () => {
    // THE moderation property. The listing gate is denormalized now, so a post
    // column that changes the gate but is missing from this WHEN clause means
    // taken-down content stays listed. Each name below is an argument the list
    // function passes to marketplace_resource_bundle_quality_issue(), or one of
    // the three visibility gates, or a tool-slug input.
    for (const column of [
      'visibility',
      'archived_at',
      'review_status',
      'title',
      'body',
      'showcase_asset_path',
      'output_url',
      'source_tool_slug',
      'source_tool',
    ]) {
      expect(postsTrigger).toContain(`OLD.${column} IS DISTINCT FROM NEW.${column}`);
    }
  });

  it('excludes hot post counters from the recompute', () => {
    // posts.save_count / comment_count / share_count / report_count are written
    // on hot paths. Widening the WHEN clause to cover them — or to
    // `OLD.* IS DISTINCT FROM NEW.*` — puts a plpgsql quality predicate on
    // every comment. The pgTAP test asserts the runtime behaviour via xmin.
    for (const counter of ['save_count', 'comment_count', 'share_count', 'report_count', 'remix_count']) {
      expect(postsTrigger).not.toContain(counter);
    }
    expect(postsTrigger).not.toContain('OLD.* IS DISTINCT FROM NEW.*');
  });

  it('restricts the profiles trigger to the two name columns', () => {
    // profiles.credits changes on every generation, so an unconditional row
    // trigger here would recompute every bundle a creator owns per charge.
    const profilesTrigger = migration.slice(
      migration.indexOf('CREATE TRIGGER profiles_refresh_marketplace_listing'),
      migration.indexOf('EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_profile();'),
    );
    expect(profilesTrigger).toContain('OLD.username IS DISTINCT FROM NEW.username');
    expect(profilesTrigger).toContain('OLD.display_name IS DISTINCT FROM NEW.display_name');
    expect(profilesTrigger).not.toContain('credits');
  });

  it('keeps the listing gate in a table nothing else writes to', () => {
    // Not a column on post_resource_bundles. That table carries six triggers
    // written for user edits, and validate_post_resource_bundle_write() raises
    // "Only public posts can publish resource bundles" — so a recompute during
    // a take-down would make the take-down itself fail. See the migration
    // header; this is the single most important shape decision in the item.
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.marketplace_bundle_listings');
    expect(migration).not.toMatch(/ALTER TABLE public\.post_resource_bundles\s+ADD COLUMN/);
  });

  it('gives every sort an index whose ordering matches its ORDER BY exactly', () => {
    // A mismatched NULLS direction silently costs the index and reintroduces a
    // full sort of the filtered catalog — the exact regression this item is
    // about, and invisible without an EXPLAIN.
    const pairs: Array<[string, string]> = [
      ['(created_at DESC, bundle_id DESC)', 'listings.created_at DESC, listings.bundle_id DESC'],
      ['(sales_count DESC NULLS LAST, created_at DESC, bundle_id DESC)', 'listings.sales_count DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'],
      ['(price_usd_cents ASC NULLS LAST, created_at DESC, bundle_id DESC)', 'listings.price_usd_cents ASC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'],
      ['(price_usd_cents DESC NULLS LAST, created_at DESC, bundle_id DESC)', 'listings.price_usd_cents DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'],
    ];
    for (const [index, orderBy] of pairs) {
      expect(migration).toContain(index);
      expect(migration).toContain(orderBy);
    }
    // Partial on the gate, or the index covers delisted rows too.
    expect(migration.match(/WHERE listable;/g) ?? []).toHaveLength(4);
  });

  it('builds its ORDER BY from hard-coded literals, never from caller input', () => {
    // The listing function uses dynamic SQL so each sort gets a literal ORDER
    // BY its index can serve. p_sort selects among four constants; it is never
    // interpolated, and every value is bound through USING.
    const orderBlock = migration.slice(
      migration.indexOf('v_order := CASE'),
      migration.indexOf('RETURN QUERY EXECUTE format('),
    );
    expect(orderBlock).not.toContain('p_sort ||');
    expect(orderBlock).toContain("WHEN 'top-sales' THEN");
    expect(migration).toContain('USING p_access_filter, p_resource_filter, p_tool_slug, p_query, p_offset, p_limit');
    expect(migration).not.toContain('|| p_query');
    expect(migration).not.toContain('|| p_tool_slug');
  });

  it('keeps the listing table off the public API surface', () => {
    expect(migration).toContain('REVOKE ALL ON public.marketplace_bundle_listings FROM anon, authenticated');
    expect(migration).toContain('ALTER TABLE public.marketplace_bundle_listings ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[]) TO service_role');
  });

  it('backfills, so existing bundles are not invisible until their next edit', () => {
    expect(migration).toContain('SELECT public.refresh_marketplace_bundle_listings(NULL);');
  });
});
