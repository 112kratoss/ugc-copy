import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const MIGRATION_FILE = '20261027172920_sold_recipes_can_be_corrected.sql';
const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations', MIGRATION_FILE),
  'utf8',
);

/** The body of one `CREATE [OR REPLACE] FUNCTION public.<name>(` in this migration. */
function functionBody(name: string): string {
  const start = migration.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\(`));
  expect(start, `${name} is defined in ${MIGRATION_FILE}`).toBeGreaterThanOrEqual(0);
  const bodyStart = migration.indexOf('$$', start);
  const bodyEnd = migration.indexOf('$$', bodyStart + 2);
  return migration.slice(start, bodyEnd + 2);
}

// Recipe audit 2026-10-27: owner decision D1 (a sold recipe can be corrected,
// removing one people have retires it), H4 (a credits unlock charges the
// confirmed price) and H1 (a creation post's recipe includes its Remix).
describe('sold recipes can be corrected migration', () => {
  it('keeps the save serialized with sales but no longer refuses a sold recipe', () => {
    const body = functionBody('apply_post_resource_bundle_mutation');

    expect(body).toMatch(/FROM public\.post_resource_bundles AS bundles[\s\S]*FOR UPDATE/);
    expect(body).toContain('apply_post_resource_bundle_mutation_unlocked_20260806(');
    expect(body).not.toContain('RAISE EXCEPTION');
    expect(body).not.toContain('post_resource_bundle_purchases');
    // A recipe saved again after it was retired is the post's recipe again.
    expect(body).toMatch(/SET retired_at = NULL[\s\S]*bundles\.retired_at IS NOT NULL/);
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.apply_post_resource_bundle_mutation(\n  uuid, uuid, text, text, jsonb\n) TO service_role;');
  });

  it('guards a sold recipe’s post and creator, not its content or retirement', () => {
    const body = functionBody('protect_sold_post_resource_bundle_content');

    expect(body).not.toContain('post_resource_bundle_content_fingerprint');
    expect(body).not.toContain('retired_at');
    expect(body).toMatch(/NEW\.post_id IS DISTINCT FROM OLD\.post_id[\s\S]*NEW\.owner_user_id IS DISTINCT FROM OLD\.owner_user_id[\s\S]*NEW\.legacy_asset_id IS DISTINCT FROM OLD\.legacy_asset_id/);
    expect(body).toContain('purchases.price_usd_cents > 0');
    // Erasure and a still-payable checkout keep their rules.
    expect(body).toContain('SELECT 1 FROM auth.users WHERE id = OLD.owner_user_id');
    expect(body).toContain('RESOURCE_CHECKOUT_PENDING');
    // Trusted-owner execution, as 20260901090000 set it and its pgTAP pins.
    expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = ''/);
    expect(migration).toContain('ALTER FUNCTION public.protect_sold_post_resource_bundle_content()\n  OWNER TO postgres;');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.protect_sold_post_resource_bundle_content()\n  FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('retires a recipe that anyone has instead of deleting it', () => {
    const body = functionBody('retire_sold_post_resource_bundle_instead_of_delete');

    // Any purchase, paid or free, and erasure still deletes.
    expect(body).toMatch(/FROM public\.post_resource_bundle_purchases AS purchases\s+WHERE purchases\.bundle_id = OLD\.id\s+\)/);
    expect(body).not.toContain('price_usd_cents > 0');
    expect(body).toMatch(/NOT EXISTS \(SELECT 1 FROM auth\.users WHERE id = OLD\.owner_user_id\)[\s\S]*RETURN OLD/);
    expect(body).toMatch(/SET status = 'draft',\s+retired_at = coalesce\(retired_at, timezone\('utc'::text, now\(\)\)\)/);
    expect(body).toContain('RETURN NULL;');
    expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = ''/);
    expect(migration).toMatch(/CREATE TRIGGER post_resource_bundles_retire_instead_of_delete\s+BEFORE DELETE ON public\.post_resource_bundles\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.retire_sold_post_resource_bundle_instead_of_delete\(\);/);
    // A privileged function no client may call (client_rpc_boundaries.test.sql).
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete()\n  FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('never promotes a retired recipe, and grades a sold draft like any other', () => {
    const body = functionBody('sync_post_resource_bundle_exposure');

    expect(body).toContain('AND bundles.retired_at IS NULL');
    expect(body).toContain('AND public.post_resource_bundle_quality_issue_for(bundles.id) IS NULL;');
    expect(body).not.toContain('retired_at = NULL');
    // The marketplace asset rules are unchanged.
    expect(body).toMatch(/SET status = 'unlisted'/);
    expect(body).toMatch(/assets\.status = 'unlisted'[\s\S]*purchases\.price_usd_cents > 0/);
  });

  it('lets a sold recipe’s title follow its post', () => {
    const body = functionBody('sync_post_resource_bundle_title');

    expect(body).not.toContain('post_resource_bundle_purchases');
    expect(body).toMatch(/FOR UPDATE/);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.sync_post_resource_bundle_title(uuid, uuid)\n  FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('charges a credits unlock only at the price the buyer confirmed, under the row lock', () => {
    const body = functionBody('unlock_post_resource_bundle_with_credits');

    expect(migration).toContain('DROP FUNCTION IF EXISTS public.unlock_post_resource_bundle_with_credits(uuid, uuid);');
    expect(body).toContain('p_expected_credit_cost integer DEFAULT NULL');
    expect(body).toMatch(/WHERE post_id = p_post_id\s+FOR UPDATE/);
    // The check comes after the row lock and before anything is spent.
    const lockAt = body.indexOf('FOR UPDATE');
    const checkAt = body.indexOf("'status', 'price_changed'");
    const spendAt = body.indexOf('SET credits = credits - v_bundle.price_usd_cents');
    expect(lockAt).toBeGreaterThan(0);
    expect(checkAt).toBeGreaterThan(lockAt);
    expect(spendAt).toBeGreaterThan(checkAt);
    // Compared with the live cost (0 for a recipe made free meanwhile), and
    // before the "not paid" answer, so a buyer whose recipe went free is told
    // the price changed to 0 rather than refused.
    expect(body).toContain('p_expected_credit_cost IS DISTINCT FROM (');
    expect(checkAt).toBeLessThan(body.indexOf("'status', 'not_paid'"));
    expect(body).toMatch(/'status', 'price_changed'[\s\S]*?'credit_cost', CASE WHEN v_bundle\.access_mode = 'paid' AND v_bundle\.price_usd_cents > 0/);
    expect(body).toContain('SECURITY INVOKER');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid, integer)\n  FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid, integer)\n  TO service_role;');
  });

  it('reports a creation post’s published recipe as remix-included in the public summaries', () => {
    const body = functionBody('get_public_post_resource_bundle_summaries');

    expect(body).toMatch(/WHEN bundles\.status = 'published' THEN \(\s+coalesce\(bundles\.allow_remix, false\)\s+OR EXISTS/);
    expect(body).toContain('generations.template_run_id IS NULL');
    expect(body).toContain('generations.template_run_step_id IS NULL');
    // A draft still hands out nothing (hydratePublicBundleSummaryRows fails closed otherwise).
    expect(body).toMatch(/ELSE NULL\s+END AS allow_remix/);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_public_post_resource_bundle_summaries(uuid[])\n  FROM PUBLIC, anon, authenticated;');
  });
});
