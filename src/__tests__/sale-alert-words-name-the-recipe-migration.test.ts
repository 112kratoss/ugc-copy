import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sellerUnlockWords } from '@/lib/mobile-notifications';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', file), 'utf8');

/** The migration's statements, without its comments. */
const code = read('20261027180743_sale_alert_words_name_the_recipe.sql')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const titlePatterns = Array.from(code.matchAll(/p_title ~ '([^']+)'/g), (match) => new RegExp(match[1]));
const bodyPatterns = Array.from(code.matchAll(/p_body ~ '([^']+)'/g), (match) => new RegExp(match[1]));
const matchesAny = (patterns: RegExp[], words: string) => patterns.some((pattern) => pattern.test(words));

// What the function does to stored alerts, in both sets of words, is pinned
// live in supabase/tests/database/sale_alert_names.test.sql.
describe('sale alert words name the recipe migration', () => {
  it('takes the name out of the words the server writes, back to the words it writes with no name', () => {
    for (const handle of ['maya', 'creator-0a1b2c3d']) {
      expect(matchesAny(titlePatterns, sellerUnlockWords(true, handle).title)).toBe(true);
      expect(matchesAny(bodyPatterns, sellerUnlockWords(false, handle).body)).toBe(true);
    }
    expect(matchesAny(titlePatterns, sellerUnlockWords(true, null).title)).toBe(false);
    expect(matchesAny(bodyPatterns, sellerUnlockWords(false, null).body)).toBe(false);

    const unnamedFreeOpen = sellerUnlockWords(true, null);
    const unnamedSale = sellerUnlockWords(false, null);
    expect(code).toContain(`title := '${unnamedFreeOpen.title}';`);
    expect(code).toContain(`body := '${unnamedFreeOpen.body}';`);
    expect(code).toContain(`body := '${unnamedSale.body}';`);
    // A sale's title names no one, so it is never rewritten.
    expect(sellerUnlockWords(false, 'maya').title).toBe(unnamedSale.title);
  });

  it('still takes the name out of the words written before 2026-10-27, which their rows keep', () => {
    for (const handle of ['maya', 'creator-0a1b2c3d']) {
      expect(matchesAny(titlePatterns, `@${handle} opened your free resources`)).toBe(true);
      expect(matchesAny(bodyPatterns, `@${handle} bought the resources attached to your post.`)).toBe(true);
    }
    expect(code).toContain("title := 'Someone opened your free resources';");
    expect(code).toContain("body := 'A creator opened the resources attached to your post.';");
    expect(code).toContain("body := 'A creator bought the resources attached to your post.';");
  });

  it('replaces the function in place, out of the Data API, on a fixed search path', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.unnamed_sale_alert_words(');
    expect(code).toContain("SET search_path = ''");
    expect(code).toContain('REVOKE ALL ON FUNCTION public.unnamed_sale_alert_words(text, text) FROM PUBLIC, anon, authenticated;');
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.unnamed_sale_alert_words(text, text) TO service_role;');
    // The triggers of 20261020053858 call it by name: nothing is dropped or re-created.
    expect(code).not.toMatch(/DROP|TRIGGER|LOCK TABLE/);
  });
});
