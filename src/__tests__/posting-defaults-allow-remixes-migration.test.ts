import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveRecipeAllowRemix } from '@/lib/post-resource-bundles';

import { RECIPE_TITLE_MIN_LENGTH } from '../../ugc-mobile/lib/post-publish-policy/post-publish-policy';

// Remix plan, phase 2 (owner, 2026-11-05): a post's own "Allow remixes", and a recipe's title of 3
// characters. Behaviour is proved in supabase/tests/database/posting_defaults_allow_remixes.test.sql;
// this pins the SQL.
const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20261105152921_posting_defaults_allow_remixes.sql'),
  'utf8',
);
const sql = migration.replace(/--.*$/gm, '');

function functionBody(name: string): string {
  const match = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$(function)?\\$([\\s\\S]*?)\\$(function)?\\$;`, 'i'));
  expect(match, name).not.toBeNull();
  return match![0];
}

describe('posting defaults: allow remixes migration', () => {
  it('runs in one transaction that waits at most five seconds for a lock', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('adds the post’s own switch, on for every post already there', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS remixes_allowed boolean NOT NULL DEFAULT true;');
    // Not the recipe's stored hand-over, which the old "own uploads" rule wrote false.
    expect(sql).not.toMatch(/update public\.posts set remixes_allowed = [^(]*allow_remix/i);
  });

  it('writes the switch from both saves only when it is sent, as a boolean, after the save', () => {
    for (const [name, payload, where] of [
      ['upsert_post_with_resource_bundle', 'p_post', 'where id = v_result.post_id'],
      ['update_post_with_resource_bundle', 'p_post_patch', 'where id = p_post_id and user_id = p_owner_user_id'],
    ] as const) {
      const body = functionBody(name);
      expect(body, name).toMatch(/security definer\s+set search_path = ''/);
      expect(body, name).toContain(
        `if ${payload} ? 'remixes_allowed' and jsonb_typeof(${payload}->'remixes_allowed') <> 'boolean' then raise exception 'Invalid remix switch'; end if;`,
      );
      expect(body, name).toContain(
        `if ${payload} ? 'remixes_allowed' then update public.posts set remixes_allowed = (${payload}->>'remixes_allowed')::boolean ${where}; end if;`,
      );
      // The save's own body is the one 20261026150925 runs, unchanged.
      expect(body, name).toContain(`public.${name}_before_nsfw(`);
    }
  });

  it('lets only the server call the saves', () => {
    expect(sql).toMatch(/revoke all on function public\.upsert_post_with_resource_bundle\(jsonb, jsonb, boolean\)\s+from public, anon, authenticated;/);
    expect(sql).toMatch(/revoke all on function public\.update_post_with_resource_bundle\(uuid, uuid, jsonb, boolean, jsonb\)\s+from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.upsert_post_with_resource_bundle\(jsonb, jsonb, boolean\)\s+to service_role;/);
    expect(sql).toMatch(/grant execute on function public\.update_post_with_resource_bundle\(uuid, uuid, jsonb, boolean, jsonb\)\s+to service_role;/);
  });

  // The review of phase 2: the marketplace's Remix filter and search text follow the post's switch.
  it('counts no Remix in the marketplace for a post with remixes off, its refreshes otherwise as 20261101072014 left them', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/migrations/20261101072014_marketplace_list_public_read_rules.sql'),
      'utf8',
    ).replace(/--.*$/gm, '');
    const readsSwitch = (indent: string) => [
      `public.post_resource_bundle_kinds(`,
      `${indent}bundles.resource_items,`,
      `${indent}bundles.allow_remix AND coalesce(posts.remixes_allowed, true),`,
      `${indent}bundles.status,`,
      `${indent}CASE WHEN coalesce(posts.remixes_allowed, true) THEN posts.generation_id END`,
    ].join('\n');
    for (const [name, indent, before] of [
      ['refresh_marketplace_bundle_search_documents', '        ', 'public.post_resource_bundle_kinds(\n        bundles.resource_items, bundles.allow_remix, bundles.status, posts.generation_id'],
      ['refresh_marketplace_bundle_listings', '    ', 'public.post_resource_bundle_kinds(\n    bundles.resource_items, bundles.allow_remix, bundles.status, posts.generation_id'],
    ] as const) {
      const body = functionBody(name);
      expect(body, name).toContain(readsSwitch(indent));
      const original = source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`))?.[0];
      expect(original, name).toBeDefined();
      expect(body.replace(readsSwitch(indent), before), name).toBe(original);
      expect(sql, name).toContain(`REVOKE ALL ON FUNCTION public.${name}(uuid[])\n  FROM PUBLIC, anon, authenticated;`);
      expect(sql, name).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(uuid[])\n  TO service_role;`);
    }
    for (const trigger of ['posts_refresh_marketplace_search', 'posts_refresh_marketplace_listing']) {
      const block = sql.match(new RegExp(`CREATE OR REPLACE TRIGGER ${trigger}\\n[\\s\\S]*?EXECUTE FUNCTION [^;]+;`))?.[0] ?? '';
      expect(block, trigger).toContain('OR OLD.remixes_allowed IS DISTINCT FROM NEW.remixes_allowed');
      expect(block, trigger).toContain('OR OLD.generation_id IS DISTINCT FROM NEW.generation_id');
    }
  });

  // The app reports the recipe's Remix by the same rule the SQL now reads (`hydrateBundleRows`).
  it('reports a recipe of a post with remixes off without Remix, in the app as in the marketplace', () => {
    const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/post-resource-bundles-server.ts'), 'utf8');
    expect(serverSource).toMatch(
      /resolveRecipeAllowRemix\(\{\s+storedAllowRemix: row\.allow_remix,\s+status: row\.status,\s+generationId: post\?\.generationId \?\? null,\s+remixesAllowed: post\?\.remixesAllowed,\s+\}\)/,
    );
    for (const storedAllowRemix of [true, false, null]) {
      for (const generationId of ['generation-1', null]) {
        for (const remixesAllowed of [true, false, undefined]) {
          // As the SQL calls post_resource_bundle_kinds: the stored switch and the creation, each only
          // while the post allows remixes.
          const open = remixesAllowed !== false;
          const sqlRule = (storedAllowRemix === true && open) || (generationId !== null && open);
          expect(resolveRecipeAllowRemix({ storedAllowRemix, status: 'published', generationId, remixesAllowed }), JSON.stringify({ storedAllowRemix, generationId, remixesAllowed }))
            .toBe(sqlRule);
        }
      }
    }
  });

  it('re-lists the recipes the shorter title minimum makes listable', () => {
    expect(sql).toContain("WHERE length(btrim(coalesce(bundles.title, ''))) BETWEEN 3 AND 5");
    expect(sql).toMatch(/SELECT public\.refresh_marketplace_bundle_listings\(ARRAY\(\n  SELECT bundles\.id\n  FROM public\.post_resource_bundles AS bundles\n  WHERE length/);
  });

  it('reads a recipe’s title minimum as the shared rule does', () => {
    expect(RECIPE_TITLE_MIN_LENGTH).toBe(3);
    const body = functionBody('marketplace_resource_bundle_quality_issue');
    expect(body).toContain(`IF v_title = '' OR length(v_title) < ${RECIPE_TITLE_MIN_LENGTH} THEN`);
    expect(body).toContain(`RETURN 'Add a clear listing title with at least ${RECIPE_TITLE_MIN_LENGTH} characters.';`);
    expect(body).not.toMatch(/length\(v_title\) < 6/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.marketplace_resource_bundle_quality_issue(text, text, text, text, text, text, jsonb, jsonb, boolean, integer, text, text, text, text, timestamptz, text, boolean, text, text) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.marketplace_resource_bundle_quality_issue(text, text, text, text, text, text, jsonb, jsonb, boolean, integer, text, text, text, text, timestamptz, text, boolean, text, text) TO service_role;');
  });
});
