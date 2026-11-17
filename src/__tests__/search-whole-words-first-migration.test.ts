import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseSearchBlendConstants } from '@/lib/search-relevance';

// Whole words first (20261116200234): what the functions do to real rows is
// held by supabase/tests/database/search_whole_words_first.test.sql (the order
// of "cat", the bounds, related searches) and the relevance check
// (search-relevance.test.ts). This file holds what a later edit could quietly
// undo: the match is the same rows, a partial match is scored a whole tier
// under every whole one, the score keeps one signature whose ten-argument
// call reads as whole words, related searches never read a post found only
// inside a longer word, and every function stays the service role's.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261116200234_search_whole_words_first.sql';
const PREVIOUS_POSTS = '20261112174210_search_entities_filters_corrected_reading.sql';
const PREVIOUS_RELATED = '20261115105944_search_content_suggestions.sql';
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, '');
const statements = withoutComments(readFileSync(join(migrationsDirectory, MIGRATION), 'utf8'));

const SCORE_SIGNATURE = 'public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean, boolean)';
const OLD_SCORE_SIGNATURE = 'public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean)';
const POSTS_SIGNATURE = 'public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz, text, text, boolean, boolean, boolean)';
const RELATED_SIGNATURE = 'public.search_related_searches(text, uuid, uuid[], text, integer)';

/** The definition of `public.<name>` in one migration's statements, comments left out. */
function definitionIn(sql: string, name: string): string {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'gi');
  let start = -1;
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) start = match.index;
  expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
  const fromDefinition = sql.slice(start);
  const closing = fromDefinition.search(/\n\$(?:function)?\$;/);
  expect(closing, `the definition of ${name} must close`).toBeGreaterThan(0);
  return fromDefinition.slice(0, closing);
}

const definitionOf = (name: string) => definitionIn(statements, name);
const previousDefinition = (file: string, name: string) => definitionIn(withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8')), name);

/** The newest migration that defines `public.<name>`. */
function newestDefiner(name: string): string {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const definers = migrationNames.filter((file) => pattern.test(withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'))));
  return definers[definers.length - 1];
}

/** Every `c_<name> CONSTANT double precision := <number>;` of a definition. */
function constantsOf(definition: string): Record<string, number> {
  const constants: Record<string, number> = {};
  for (const [, name, value] of definition.matchAll(/\bc_(\w+) CONSTANT double precision := ([\d.]+);/g)) {
    constants[name] = Number(value);
  }
  return constants;
}

/** The three-part condition every post read matches on, as search_public_posts writes it. */
const MATCH = '    WHERE posts.is_nsfw = false\n'
  + '      AND (\n'
  + '        documents.search_vector @@ v_tsquery\n'
  + "        OR documents.search_text ILIKE ('%' || v_like || '%')\n"
  + '        OR documents.title_normalized OPERATOR(extensions.%) v_query\n'
  + '        OR documents.tool_normalized OPERATOR(extensions.%) v_query\n'
  + '      )\n';

describe('search whole words first migration', () => {
  it('runs after the blend, as one transaction that gives up on a busy table, and re-creates four functions alone', () => {
    expect(migrationNames.indexOf(MIGRATION)).toBeGreaterThan(migrationNames.indexOf('20261115130046_search_blended_posts.sql'));
    expect(statements.trim().startsWith("BEGIN;\nSET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(statements.trim().endsWith('COMMIT;')).toBe(true);
    expect(Array.from(statements.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi), (match) => match[1]))
      .toEqual(['search_query_whole_tsquery', 'search_post_score', 'search_public_posts', 'search_related_searches']);
    for (const name of ['search_query_whole_tsquery', 'search_post_score', 'search_public_posts', 'search_related_searches']) {
      expect(newestDefiner(name), name).toBe(MIGRATION);
    }
    // No table, index, trigger or policy: the documents, the dictionary and the phrases are as they were.
    expect(statements).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|POLICY|EXTENSION|VIEW)\b/i);
    expect(statements).not.toMatch(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\./i);
    // The one function dropped is the score, for its new parameter, and it is made again after.
    expect(Array.from(statements.matchAll(/DROP FUNCTION ([^;]+);/g), (match) => match[1])).toEqual([OLD_SCORE_SIGNATURE]);
    expect(statements.indexOf(`DROP FUNCTION ${OLD_SCORE_SIGNATURE};`)).toBeLessThan(statements.indexOf('CREATE FUNCTION public.search_post_score('));
    // The other two keep their signatures, so the app live during the release calls them as before.
    expect(statements).toContain('CREATE OR REPLACE FUNCTION public.search_public_posts(');
    expect(statements).toContain('CREATE OR REPLACE FUNCTION public.search_related_searches(');
  });

  it('reads a query whole as search_query_tsquery reads it, with no word a prefix', () => {
    const whole = definitionOf('search_query_whole_tsquery');
    expect(whole).toMatch(/RETURNS tsquery\s+LANGUAGE sql\s+IMMUTABLE\s+PARALLEL SAFE\s+SET search_path = ''/);
    expect(whole.match(/plainto_tsquery\('pg_catalog\.(simple|english)'/g)).toEqual([
      "plainto_tsquery('pg_catalog.simple'", "plainto_tsquery('pg_catalog.simple'",
      "plainto_tsquery('pg_catalog.english'", "plainto_tsquery('pg_catalog.english'",
    ]);
    expect(whole.match(/public\.search_split_terms\(p_query\)/g)).toHaveLength(2);
    expect(whole).not.toContain(':*');
  });

  it('scores a partial match a whole tier under every whole one, and keeps every other part', () => {
    const score = definitionOf('search_post_score');
    const before = previousDefinition('20261112103547_search_ranking_tiers_decay_latest.sql', 'search_post_score');
    expect(score).toMatch(/LANGUAGE plpgsql\s+IMMUTABLE\s+PARALLEL SAFE\s+SET search_path = ''/);
    // One more parameter, last, read as whole words when left out: the call of ten arguments scores as before.
    expect(score).toMatch(/p_viewer_follows_creator boolean,\s+p_whole_words boolean DEFAULT true\s+\)/);
    const c = constantsOf(score);
    const old = constantsOf(before);
    const { partial_words_drop: drop, ...kept } = c;
    expect(kept).toEqual(old);
    const inside = c.text_weight + c.similarity_weight + c.engagement_weight + c.freshness_weight + c.follow_weight;
    expect(inside).toBeCloseTo(8.8, 9);
    // The best partial tier (a title starting with the letters) plus all a tier's parts stays under
    // the least whole one (a caption, 0); the partial tiers stay as far apart as the whole ones.
    expect(c.tier_title_starts_with_query - drop + inside).toBeLessThan(0);
    expect(c.tier_title_starts_with_query - c.tier_headline_holds_query).toBeGreaterThan(inside);
    expect(c.tier_headline_holds_query).toBeGreaterThan(inside);
    // A title that is the query holds its words whole; nothing else reaches the blend's pin.
    expect(score).toMatch(/WHEN coalesce\(p_whole_words, true\) OR coalesce\(p_title_is_query, false\) THEN 0\.0\s+ELSE c_partial_words_drop/);
    const pin = parseSearchBlendConstants(previousDefinition(newestDefiner('search_blended_posts'), 'search_blended_posts')).exactTitleScore;
    expect(c.tier_title_is_query).toBe(pin);
    expect(c.tier_title_starts_with_query + inside).toBeLessThan(pin);
    // Rounded to six decimals, as every score that travels as a cursor is.
    expect(score).toContain(')::numeric, 6)::double precision;');
  });

  it('matches post search on the same rows, and places each by where it holds the query whole', () => {
    const posts = definitionOf('search_public_posts');
    const before = previousDefinition(PREVIOUS_POSTS, 'search_public_posts');
    // The same match in the same three reads (how the query is read, Top and Latest): nothing found or lost.
    expect(posts.split(MATCH)).toHaveLength(4);
    expect(before.split(MATCH)).toHaveLength(4);
    // The reading of the query, as typed and whole, set again for a corrected one.
    expect(posts.match(/v_tsquery := public\.search_query_tsquery\(v_query, true\);/g)).toHaveLength(2);
    expect(posts.match(/v_whole := public\.search_query_whole_tsquery\(v_query\);/g)).toHaveLength(2);
    // Where the post holds the query: as typed, and whole.
    expect(posts).toContain('shown.title = v_query AS title_is_query');
    expect(posts).toContain("shown.title LIKE v_like || '%' AS title_starts");
    // A hyphen goes on with the word: 'cat-eye' does not start with 'cat' (review of #839).
    expect(posts).toMatch(/shown\.title LIKE v_like \|\| '%'\s+AND substr\(shown\.title, char_length\(v_query\) \+ 1, 1\) !~ '\[\[:alnum:\]-\]' AS title_starts_whole/);
    expect(posts).toContain('documents.tool_normalized = v_query OR shown.headline @@ v_tsquery AS headline_holds');
    expect(posts).toContain('documents.tool_normalized = v_query OR shown.headline @@ v_whole AS headline_whole');
    expect(posts).toContain('documents.search_vector @@ v_whole AS body_whole');
    // The title and the headline lexemes worked out once a row, and the places that read them
    // once: OFFSET 0 keeps the planner from copying ts_filter into each of them (five a row,
    // half as long again on 5,000 posts, 2026-11-17).
    expect(posts).toMatch(/ts_filter\(documents\.search_vector, '\{a,c\}'\) AS headline\s+OFFSET 0\s+\) AS shown\s+OFFSET 0\s+\) AS holds/);
    expect(posts.match(/ts_filter\(/g)).toHaveLength(1);
    expect(posts).toContain('holds.title_is_query OR holds.title_starts_whole OR holds.headline_whole OR holds.body_whole AS whole_words');
    // The score is told where, and whether whole, last.
    expect(posts).toMatch(/public\.search_post_score\(\s+matched\.title_is_query,\s+CASE WHEN matched\.whole_words THEN matched\.title_starts_whole ELSE matched\.title_starts END,\s+CASE WHEN matched\.whole_words THEN matched\.headline_whole ELSE matched\.headline_holds END,\s+ts_rank_cd\(documents\.search_vector, v_tsquery, 1 \| 32\),/);
    expect(posts).toMatch(/following_id = documents\.creator_user_id\s+\),\s+matched\.whole_words\s+\) AS search_score,/);
    // Everything else of 20261112174210 is kept: the instant, the keysets, the limits, the label and the blocks.
    expect(posts).toContain("v_as_of timestamptz := coalesce(p_as_of, date_trunc('day', now(), 'UTC'));");
    expect(posts).toContain('ORDER BY scored.search_score DESC, scored.post_id ASC');
    expect(posts).toContain('ORDER BY documents.created_at DESC, documents.post_id ASC');
    expect(posts.match(/posts\.is_nsfw = false/g)).toHaveLength(3);
    expect(posts.match(/blocks\.blocker_user_id = p_viewer_user_id/g)).toHaveLength(3);
    expect(posts.match(/blocks\.blocked_user_id = p_viewer_user_id/g)).toHaveLength(3);
    expect(posts).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
    // The signature and the result the service reads (public-search-service.ts, search_blended_posts).
    const header = (sql: string) => sql.slice(0, sql.indexOf('AS $function$'));
    expect(header(posts).replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')).toBe(header(before));
  });

  it('reads related searches from the posts about the search, a phrase holding the query first', () => {
    const related = definitionOf('search_related_searches');
    const before = previousDefinition(PREVIOUS_RELATED, 'search_related_searches');
    // The query as the posts were read (corrected where they were): as a LIKE pattern, whole and as typed.
    expect(related).toContain('v_read := coalesce(v_corrected, v_query);');
    expect(related).toContain(String.raw`v_like := replace(replace(replace(v_read, '\', '\\'), '%', '\%'), '_', '\_');`);
    expect(related).toContain('v_whole := public.search_query_whole_tsquery(v_read);');
    expect(related).toContain('v_typing := public.search_query_tsquery(v_read, true);');
    expect(related).toContain('v_has_words := numnode(v_typing) > 0;');
    // Each post: whole, or matched only by search_public_posts' partial reading (the word typed, the
    // run of characters, the near-miss title or tool), which is that function's own match.
    expect(related).toMatch(/CASE WHEN v_has_words THEN documents\.search_vector @@ v_whole ELSE false END AS whole/);
    expect(related).toMatch(/CASE WHEN v_has_words THEN documents\.search_vector @@ v_typing ELSE false END\s+OR documents\.search_text ILIKE \('%' \|\| v_like \|\| '%'\)\s+OR documents\.title_normalized OPERATOR\(extensions\.%\) v_read\s+OR documents\.tool_normalized OPERATOR\(extensions\.%\) v_read AS lexical/);
    // Once a post holds the words whole: those, and the posts that match no word (found by meaning);
    // while none does, the whole page. Never a partial match beside a whole one (review of #839:
    // dropping the meaning posts too left "sea after sunset" with none).
    expect(related).toMatch(/array_agg\(documents\.post_id\) FILTER \(WHERE matched\.whole\)/);
    expect(related).toMatch(/array_agg\(documents\.post_id\) FILTER \(WHERE matched\.whole OR NOT matched\.lexical\)/);
    expect(related).toContain('v_read_ids := CASE WHEN cardinality(v_whole_ids) > 0 THEN v_kept_ids ELSE v_page_ids END;');
    expect(related).toMatch(/IF cardinality\(v_read_ids\) < c_min_posts THEN\s+RETURN;/);
    expect(related).toContain('WHERE documents.post_id = ANY (v_read_ids)');
    // Read as search reads a post, as before: the first 30 of the page, unlabelled, neither side of a block.
    expect(related).toContain('WHERE documents.post_id = ANY (p_post_ids[1:c_posts])');
    expect(related).toContain('AND posts.is_nsfw = false');
    expect(related.match(/blocks\.blocker_user_id = p_viewer_user_id/g)).toHaveLength(1);
    expect(related.match(/blocks\.blocked_user_id = p_viewer_user_id/g)).toHaveLength(1);
    expect(related).toContain('IF NOT public.search_phrases_are_fresh() THEN');
    // What the posts write first, then a phrase that holds the query.
    expect(related).toMatch(/ORDER BY\s+\(phrases\.is_name AND NOT phrases\.in_text\),\s+\(to_tsvector\('pg_catalog\.simple', phrases\.phrase\) \|\| to_tsvector\('pg_catalog\.english', phrases\.phrase\)\) @@ v_whole DESC,\s+counted\.posts DESC,/);
    // The rest of 20261115105944: the constants, the exclusions, the loop.
    for (const kept of [
      'c_posts CONSTANT integer := 30;', 'c_min_posts CONSTANT integer := 2;', 'c_candidates CONSTANT integer := 24;', 'c_names CONSTANT integer := 2;',
      'AND NOT (string_to_array(phrases.phrase, \' \') <@ v_said)', 'AND phrases.phrase IS DISTINCT FROM v_corrected',
      'CONTINUE WHEN v_candidate.is_name AND v_names >= c_names;',
    ]) {
      expect(before, kept).toContain(kept);
      expect(related, kept).toContain(kept);
    }
    expect(related).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = ''/);
  });

  it('keeps every function the service role’s alone', () => {
    for (const signature of ['public.search_query_whole_tsquery(text)', RELATED_SIGNATURE]) {
      expect(statements, signature).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
      expect(statements, signature).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    }
    for (const signature of [SCORE_SIGNATURE, POSTS_SIGNATURE]) {
      expect(statements, signature).toContain(`REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated;`);
      expect(statements, signature).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    }
  });
});
