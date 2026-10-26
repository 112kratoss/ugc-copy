import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261026150925_recipe_title_follows_post_title.sql',
);

/**
 * A save that changes a post's title and sends no recipe takes an unsold
 * recipe's title along. The behaviour is asserted by pgTAP
 * (post_resource_bundle_title_follows_post.test.sql); this pins the
 * migration's shape so a later edit cannot quietly write a sold recipe's
 * frozen title, move a recipe's title on a save that left the post's alone, or
 * drop the grants.
 */
describe('recipe title follows the post title', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const helperBody = sql.slice(
    sql.indexOf('create function public.sync_post_resource_bundle_title('),
    sql.indexOf('create or replace function public.upsert_post_with_resource_bundle('),
  );
  const upsertBody = sql.slice(
    sql.indexOf('create or replace function public.upsert_post_with_resource_bundle('),
    sql.indexOf('create or replace function public.update_post_with_resource_bundle('),
  );
  const updateBody = sql.slice(
    sql.indexOf('create or replace function public.update_post_with_resource_bundle('),
    sql.indexOf('revoke all on function public.upsert_post_with_resource_bundle('),
  );

  it('leaves a sold recipe alone, checking for a sale under the row lock purchases take', () => {
    expect(helperBody).toMatch(/from public\.post_resource_bundles as bundles[\s\S]*?for update;/);
    const lock = helperBody.indexOf('for update;');
    const saleCheck = helperBody.indexOf('purchases.price_usd_cents > 0');
    expect(lock).toBeGreaterThan(-1);
    expect(saleCheck).toBeGreaterThan(lock);
    expect(helperBody.indexOf('update public.post_resource_bundles')).toBeGreaterThan(saleCheck);
  });

  it('writes the title a save with the recipe writes, and only when it differs', () => {
    // apply_post_resource_bundle_mutation's own form of the post's title.
    expect(helperBody).toContain("coalesce(nullif(btrim(posts.title), ''), 'Attached unlock')");
    expect(helperBody).toContain('bundles.title is distinct from v_title');
  });

  it('keeps the helper off every caller grant', () => {
    expect(helperBody).toContain('security definer');
    expect(helperBody).toContain("set search_path = ''");
    expect(sql).toContain(
      'revoke all on function public.sync_post_resource_bundle_title(uuid, uuid)\n  from public, anon, authenticated, service_role;',
    );
    expect(sql).not.toMatch(/grant [^;]*sync_post_resource_bundle_title/);
  });

  it('keeps both RPCs the wrappers of their bodies, with the NSFW label step', () => {
    expect(upsertBody).toContain('public.upsert_post_with_resource_bundle_before_nsfw(p_post, p_bundle, p_has_bundle)');
    expect(upsertBody).toContain("update public.posts set is_nsfw = (p_post->>'is_nsfw')::boolean");
    expect(updateBody).toContain(
      'public.update_post_with_resource_bundle_before_nsfw(p_post_id, p_owner_user_id, p_post_patch, p_has_bundle, p_bundle)',
    );
    expect(updateBody).toContain("update public.posts set is_nsfw = (p_post_patch->>'is_nsfw')::boolean");
  });

  it('syncs only for a save that sends no recipe and changes the title', () => {
    for (const body of [upsertBody, updateBody]) {
      // The title before the save is read under the post's row lock, before the wrapped body runs.
      const previousTitle = body.indexOf('into v_previous_title');
      const lock = body.indexOf('for update;', previousTitle);
      expect(previousTitle).toBeGreaterThan(-1);
      expect(lock).toBeGreaterThan(previousTitle);
      expect(lock).toBeLessThan(body.indexOf('_before_nsfw('));
      expect(body).toContain('if p_has_bundle is not true');
      expect(body).toContain('if v_title is distinct from v_previous_title then');
      expect(body).toContain('perform public.sync_post_resource_bundle_title(');
    }
    // A post the upsert creates has no recipe to retitle.
    expect(upsertBody).toContain('if p_has_bundle is not true and v_existed then');
  });

  it('finds the post the upsert updates as the upsert finds it', () => {
    expect(upsertBody).toContain("v_existing_post_id uuid := nullif(p_post->>'id', '')::uuid;");
    expect(upsertBody).toContain("where posts.generation_id = (p_post->>'generation_id')::uuid;");
    expect(upsertBody).toContain('and posts.user_id = v_owner_user_id');
  });

  it('keeps the RPCs service-role only and leaves the marketplace to its triggers', () => {
    expect(sql).toContain(
      'revoke all on function public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)\n  from public, anon, authenticated;',
    );
    expect(sql).toContain(
      'revoke all on function public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)\n  from public, anon, authenticated;',
    );
    expect(sql.match(/grant execute on function public\.(?:upsert|update)_post_with_resource_bundle[\s\S]*?to service_role;/g)).toHaveLength(2);
    // post_resource_bundle_exposure_sync.test.sql pins this for both RPCs.
    expect(upsertBody + updateBody).not.toContain('marketplace_assets');
  });
});
