import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PUBLIC_SEARCH_BLEND_MAX_PLACE, PUBLIC_SEARCH_MAX_LIMIT } from '@/lib/public-search';
import { SEARCH_EMBEDDING_MODEL, SEARCH_RELATED_THIN_POST_COUNT } from '@/lib/search-embeddings';
import { parseSearchBlendConstants } from '@/lib/search-relevance';

// What search_blended_posts does to real rows is held by
// supabase/tests/database/search_blended_posts.test.sql: the merged order,
// who is left out, the filters, the pages. This file holds what a later edit
// could quietly undo: the word list is search_public_posts itself, the
// meaning list reads only the public-text vectors and only against the hash
// of the text a post shows now, the one copy of the word match is the
// original's, nothing is written or asked of the embedding function, the
// constants are what the service and the runbook say, and the function stays
// the service role's.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261115130046_search_blended_posts.sql';
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, '');
const migration = readFileSync(join(migrationsDirectory, MIGRATION), 'utf8');
const statements = withoutComments(migration);

const SIGNATURE = 'public.search_blended_posts(text, text, extensions.vector, uuid, timestamptz, integer, integer, text, text, boolean, boolean, text)';

/** The definition of `public.<name>` in one migration, comments left out. */
function definitionIn(file: string, name: string): string {
  const sql = withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'));
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'gi');
  let start = -1;
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) start = match.index;
  expect(start, `${file} must define ${name}`).toBeGreaterThanOrEqual(0);
  const fromDefinition = sql.slice(start);
  const closing = fromDefinition.search(/\n\$(?:function)?\$;/);
  expect(closing, `the definition of ${name} must close`).toBeGreaterThan(0);
  return fromDefinition.slice(0, closing);
}

/** The newest migration that defines `public.<name>`. */
function newestDefiner(name: string): string {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const definers = migrationNames.filter((file) => pattern.test(withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'))));
  expect(definers.length, `${name} must be defined`).toBeGreaterThan(0);
  return definers[definers.length - 1];
}

const blended = definitionIn(MIGRATION, 'search_blended_posts');
const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('search blended posts migration', () => {
  it('adds one function and changes nothing else', () => {
    expect(statements.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi)).toHaveLength(1);
    expect(statements).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|POLICY|EXTENSION)\b/i);
    expect(statements).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(statements).toMatch(/^BEGIN;/m);
    expect(statements).toMatch(/^COMMIT;/m);
  });

  it('is a security definer with an empty search path, stable, and the service role\'s alone', () => {
    expect(blended).toMatch(/\bSTABLE\b/);
    expect(blended).toMatch(/\bSECURITY DEFINER\b/);
    expect(blended).toMatch(/SET search_path = ''/);
    expect(statements).toContain(`REVOKE ALL ON FUNCTION ${SIGNATURE}\n  FROM PUBLIC, anon, authenticated;`);
    expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${SIGNATURE}\n  TO service_role;`);
    expect(statements).not.toMatch(/GRANT[^;]*\b(?:anon|authenticated|PUBLIC)\b/);
  });

  it('writes nothing, counts nothing and asks nothing of the embedding function', () => {
    expect(blended).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(blended).not.toMatch(/reserve_search_query_embedding|release_search_query_embedding|store_search_query_embedding|check_backend_rate_limit/);
    expect(blended).not.toMatch(/\bhttp\b|net\.http|pg_net/i);
  });

  it('reads the word list by calling search_public_posts, in the ranked order, with the filters and the correction on', () => {
    const calls = blended.match(/public\.search_public_posts\(/g) ?? [];
    // The first page, the rest of the window, and the rows after the window.
    expect(calls).toHaveLength(3);
    expect(collapse(blended)).toContain(collapse(`
      FROM public.search_public_posts(
        p_query, p_viewer_user_id, NULL, NULL, c_word_page, p_as_of, 'top', NULL,
        p_made_with, p_media_kind, v_has_recipe, v_followed_only, true
      ) WITH ORDINALITY`));
    // Every later read continues from a keyset place of the same order.
    expect(collapse(blended)).toContain("v_scores[cardinality(v_scores)], v_ids[cardinality(v_ids)], v_take, p_as_of, 'top', NULL,");
    expect(collapse(blended)).toContain("v_scores[c_word_window], v_ids[c_word_window], least(v_needed, c_word_page), p_as_of, 'top', NULL,");
    expect(blended).not.toMatch(/'latest'/);
  });

  it('reads meaning only from the public-text vectors, never the feed\'s', () => {
    expect(blended).toContain('FROM public.post_search_embeddings AS embeddings');
    expect(migration).not.toMatch(/FROM\s+public\.post_content_embeddings/i);
    expect(blended).not.toContain('post_content_embeddings');
    // A vector is read only while it is of the text the post shows now, and of the asked model.
    expect(blended).toContain("near.content_hash = encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex')");
    expect(blended).toContain('embeddings.embedding_model = p_embedding_model');
  });

  it('measures every vector: a distance in a WHERE clause of a materialised step, which no index answers', () => {
    expect(blended).toMatch(/near AS MATERIALIZED \(/);
    expect(blended).toContain('(embeddings.embedding OPERATOR(extensions.<=>) v_embedding) <= v_max_distance');
    expect(blended).not.toMatch(/ORDER BY\s+embeddings\.embedding/i);
    expect(statements).not.toMatch(/USING\s+(?:hnsw|ivfflat)/i);
  });

  it('holds the meaning list to the rules and the filters of the word list, before its limit', () => {
    const meaning = blended.slice(blended.indexOf('meaning AS ('), blended.indexOf('fused AS ('));
    const limit = meaning.lastIndexOf('LIMIT c_meaning_window');
    expect(limit).toBeGreaterThan(0);
    for (const rule of [
      'posts.is_nsfw = false',
      'blocks.blocker_user_id = p_viewer_user_id',
      'blocks.blocked_user_id = p_viewer_user_id',
      '(p_media_kind IS NULL OR posts.category = p_media_kind)',
      "recipes.status = 'published'",
      'followed.follower_id = p_viewer_user_id',
      'members.kind = v_entity_kind',
    ]) {
      expect(meaning.indexOf(rule), rule).toBeGreaterThan(0);
      expect(meaning.indexOf(rule), rule).toBeLessThan(limit);
    }
    // The rules as search_public_posts writes them: its own two block reads and four filters.
    const words = collapse(definitionIn(newestDefiner('search_public_posts'), 'search_public_posts'));
    const filters = collapse(meaning.slice(meaning.indexOf('AND NOT EXISTS ('), meaning.indexOf('AND (\n        NOT v_word_list_full')));
    expect(filters.length).toBeGreaterThan(400);
    expect(words).toContain(filters);
  });

  it('asks whether a meaning candidate holds the words by the match search_public_posts itself uses', () => {
    const match = `documents.search_vector @@ v_tsquery
          OR documents.search_text ILIKE ('%' || v_like || '%')
          OR documents.title_normalized OPERATOR(extensions.%) v_query
          OR documents.tool_normalized OPERATOR(extensions.%) v_query`;
    expect(collapse(blended)).toContain(collapse(match));
    const words = definitionIn(newestDefiner('search_public_posts'), 'search_public_posts');
    // The original writes it three times (the reading, Latest, Top): every one of them is this text.
    expect(collapse(words).split(collapse(match)).length - 1).toBe(3);
    // And reads the query the same way before matching it.
    for (const line of [
      "lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')))",
      "replace(replace(replace(v_query, '\\', '\\\\'), '%', '\\%'), '_', '\\_')",
      'public.search_query_tsquery(v_query, true)',
      'char_length(v_query) < 3 OR char_length(v_query) > 100',
    ]) {
      expect(blended, line).toContain(line);
      expect(words, line).toContain(line);
    }
  });

  it('declares the constants its header, the service and the runbook state', () => {
    const constants = parseSearchBlendConstants(migration);
    expect(constants).toEqual({
      rrfK: 50,
      wordWeight: 1,
      meaningWeight: 0.9,
      wordWindow: 50,
      meaningWindow: 30,
      minSimilarity: 0.82,
      exactTitleScore: 30,
    });
    // The furthest place a cursor may name is the two lists together.
    expect(constants.wordWindow + constants.meaningWindow).toBe(PUBLIC_SEARCH_BLEND_MAX_PLACE);
    expect(blended).toContain('v_after > c_word_window + c_meaning_window');
    // A word match at rank r outranks the nearest meaning-only post while
    // 1 / (k + r) > weight / (k + 1): the first six do, the number under
    // which an answer counts as thin, and the seventh does not.
    const wordRow = (rank: number) => constants.wordWeight / (constants.rrfK + rank);
    const nearestMeaningOnly = constants.meaningWeight / (constants.rrfK + 1);
    expect(wordRow(SEARCH_RELATED_THIN_POST_COUNT)).toBeGreaterThan(nearestMeaningOnly);
    expect(wordRow(SEARCH_RELATED_THIN_POST_COUNT + 1)).toBeLessThan(nearestMeaningOnly);
    // Lower than the related group's bar, which stands alone under a heading.
    const related = definitionIn(newestDefiner('search_related_posts'), 'search_related_posts');
    expect(Number(/c_min_similarity CONSTANT double precision := ([0-9.]+);/.exec(related)?.[1])).toBeGreaterThan(constants.minSimilarity);
    expect(blended).toContain(`p_embedding_model text DEFAULT '${SEARCH_EMBEDDING_MODEL}'`);
  });

  it('pins a title match by the score tier search_post_score gives it, and reads pages of the size search_public_posts allows', () => {
    const score = definitionIn(newestDefiner('search_post_score'), 'search_post_score');
    expect(score).toContain('c_tier_title_is_query CONSTANT double precision := 30.0;');
    expect(score).toContain('c_tier_title_starts_with_query CONSTANT double precision := 20.0;');
    expect(blended).toContain('c_exact_title_score CONSTANT double precision := 30.0;');
    expect(blended).toContain('coalesce(words.search_score >= c_exact_title_score, false) AS pinned');
    const words = definitionIn(newestDefiner('search_public_posts'), 'search_public_posts');
    expect(words).toContain('IF p_limit < 1 OR p_limit > 25 THEN');
    expect(blended).toContain('c_word_page CONSTANT integer := 25;');
    expect(blended).toContain('p_limit > c_word_page');
    // The service reads a page and one row more.
    expect(PUBLIC_SEARCH_MAX_LIMIT + 1).toBeLessThanOrEqual(25);
  });

  it('reads the cached vector as search_query_embedding reads it, and answers the word order without one', () => {
    expect(blended).toContain('v_embedding := public.search_query_embedding(p_query_hash, p_embedding_model);');
    expect(blended).toContain('IF v_embedding IS NULL OR v_read_as IS NOT NULL THEN');
    expect(blended).toContain("CASE WHEN v_read_as IS NOT NULL THEN 'corrected' ELSE 'no_vector' END");
  });

  it('leaves the functions it stands on as they were: none is re-created here', () => {
    for (const name of ['search_public_posts', 'search_related_posts', 'search_post_score', 'search_query_embedding', 'search_query_tsquery']) {
      expect(newestDefiner(name), name).not.toBe(MIGRATION);
    }
  });
});
