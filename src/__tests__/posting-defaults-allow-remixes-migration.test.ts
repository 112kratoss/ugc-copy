import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
  const match = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`, 'i'));
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
