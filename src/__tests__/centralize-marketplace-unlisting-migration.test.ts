import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20260824100000_centralize_marketplace_unlisting_in_exposure_trigger.sql',
);

/**
 * The exposure trigger owns both directions of the linked marketplace asset,
 * and the post RPCs no longer carry their own unlisting. The behaviour is
 * asserted by pgTAP (post_resource_bundle_exposure_sync.test.sql); this pins
 * the migration's shape so a later edit cannot quietly hand the unlisting
 * back to the RPCs or drop the re-emitted grants.
 */
describe('centralize marketplace unlisting in the exposure trigger', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('gives the trigger the unlisting direction', () => {
    const triggerBody = sql.slice(
      sql.indexOf('FUNCTION public.sync_post_resource_bundle_exposure()'),
      sql.indexOf('FUNCTION public.upsert_post_with_resource_bundle('),
    );
    expect(triggerBody).toContain("SET status = 'unlisted'");
    expect(triggerBody).toContain("assets.status = 'active'");
    // The sold-only reactivation stays as it was.
    expect(triggerBody).toContain("SET status = 'active'");
    expect(triggerBody).toContain('purchases.price_usd_cents > 0');
  });

  it('re-emits both post RPCs without any marketplace writes', () => {
    const rpcBodies = sql.slice(sql.indexOf('FUNCTION public.upsert_post_with_resource_bundle('));
    expect(rpcBodies).toContain('FUNCTION public.update_post_with_resource_bundle(');
    expect(rpcBodies).not.toContain('marketplace_assets');
    // The demotion belt is gone too; the posts trigger and the bundle write
    // validation cover both directions.
    expect(rpcBodies).not.toContain("SET status = 'draft'");
  });

  it('keeps the RPCs service-role only', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)',
    );
    expect(sql.match(/GRANT EXECUTE ON FUNCTION public\.(?:upsert|update)_post_with_resource_bundle[\s\S]*?TO service_role/g)).toHaveLength(2);
  });
});
