import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import publicPostQuality from '../../contracts/public-post-quality-v1.json';

// The database keeps its own copy of the placeholder rule,
// public.marketplace_text_is_placeholder, which apply_post_resource_bundle_mutation
// runs on every public recipe post. When the TypeScript rule was relaxed and the
// SQL one was not, "Free sample pack" passed both composers and the server and was
// then refused inside the publish RPC as a 500. The newest migration that defines
// the function must carry the contract's word lists.
const MIGRATIONS = 'supabase/migrations';
const definingMigration = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .filter((file) => /CREATE OR REPLACE FUNCTION public\.marketplace_text_is_placeholder\(/.test(readFileSync(`${MIGRATIONS}/${file}`, 'utf8')))
  .at(-1)!;
const sql = readFileSync(`${MIGRATIONS}/${definingMigration}`, 'utf8');

/** The quoted words of each `IN ( … )` list, in the order they appear. */
function inLists(text: string): string[][] {
  return [...text.matchAll(/\bIN \(([^)]*)\)/g)].map((match) => [...match[1].matchAll(/'([^']*)'/g)].map((word) => word[1]));
}

describe('the database placeholder rule', () => {
  it('is defined last by the migration that moved it to the contract rule', () => {
    expect(definingMigration).toBe('20261025094552_marketplace_placeholder_text_all_words.sql');
  });

  it('holds the decisive, placeholder and filler words the contract lists', () => {
    const [decisive, placeholderAny, placeholderEvery, filler] = inLists(sql);
    expect(decisive).toEqual(publicPostQuality.decisivePlaceholderTokens);
    expect(placeholderAny).toEqual(publicPostQuality.placeholderTokens);
    expect(placeholderEvery).toEqual(publicPostQuality.placeholderTokens);
    expect(filler).toEqual(publicPostQuality.fillerTokens);
  });

  it('lowercases before it cuts, and keeps the letters of every script', () => {
    expect(sql).toMatch(/regexp_replace\(lower\(coalesce\(p_value, ''\)\), 'https\?:\/\/\\S\+', ' ', 'g'\)/);
    expect(sql).toContain("'[^[:alnum:]]+'");
    expect(sql).not.toContain('[^a-z0-9]');
    // Keyboard mash is judged on Latin letters and digits only.
    expect(sql).toContain("~ '^[a-z0-9]{6,}$'");
  });

  it('keeps the function a pure helper with the same signature', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.marketplace_text_is_placeholder\(p_value text\)\s+RETURNS boolean\s+LANGUAGE sql\s+IMMUTABLE\s+SET search_path = public/);
    expect(sql).not.toMatch(/SECURITY DEFINER|DROP FUNCTION|GRANT|REVOKE/);
  });
});
