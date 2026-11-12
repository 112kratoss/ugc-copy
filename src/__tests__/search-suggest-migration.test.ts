import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SEARCH_SUGGEST_MAX_COMPLETIONS, SEARCH_SUGGEST_MAX_CREATORS } from '@/lib/search-suggest';

// What the migration does to real rows is held by
// supabase/tests/database/search_suggestions.test.sql: who and what is never
// offered, the orders, the odd input. This file holds the parts a later
// CREATE OR REPLACE could quietly undo: a completion needs two creators, the
// dictionary's words still come only from the documents the public can read,
// a creator is never a guest, a suspended account or either side of a block,
// the functions stay the service role's, and the route calls the one function
// by the names of its parameters.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261112144018_search_suggestions_typeahead.sql';
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, '');
const migration = readFileSync(join(migrationsDirectory, MIGRATION), 'utf8');
const statements = withoutComments(migration);
const serviceSource = readFileSync(join(process.cwd(), 'src/lib/search-suggest-service.ts'), 'utf8');

const COMPLETIONS_SIGNATURE = 'public.search_suggest_completions(text, integer)';
const CREATORS_SIGNATURE = 'public.search_suggest_creators(text, uuid, boolean, integer)';
const SUGGESTIONS_SIGNATURE = 'public.search_suggestions(text, uuid, boolean, integer, integer)';

/** The newest migration that defines `public.<name>`, and that definition, comments left out. */
function newestDefinition(name: string): { file: string; definition: string } {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const definers = migrationNames.filter((file) => pattern.test(withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'))));
  expect(definers.length, `${name} must be defined`).toBeGreaterThan(0);
  const file = definers[definers.length - 1];
  const sql = withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'));
  const fromDefinition = sql.slice(sql.search(pattern));
  const closing = fromDefinition.search(/\n\$(?:function)?\$;/);
  expect(closing, `the newest definition of ${name} must close`).toBeGreaterThan(0);
  return { file, definition: fromDefinition.slice(0, closing) };
}

/** The tables and views a definition names, schema included. */
function relationsOf(definition: string): string[] {
  return Array.from(new Set(
    Array.from(definition.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+((?:public|auth)\.\w+)(?!\()/g), (match) => match[1]),
  )).sort();
}

describe('search suggestions migration', () => {
  it('runs after the ranking migration, whose creator score it calls, as one transaction that gives up on a busy table', () => {
    expect(migrationNames.indexOf(MIGRATION)).toBeGreaterThan(
      migrationNames.indexOf('20261112103547_search_ranking_tiers_decay_latest.sql'),
    );
    expect(migrationNames.indexOf('20261112103547_search_ranking_tiers_decay_latest.sql')).toBeGreaterThanOrEqual(0);
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    expect(statements.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(statements.match(/\bCOMMIT;/g)).toHaveLength(1);
    // The dictionary is rebuilt last, so the new counts are filled at release.
    expect(statements.trim()).toMatch(/SELECT \* FROM public\.rebuild_search_terms\(\);\s+COMMIT;$/);
  });

  it('takes the rebuild’s lock, then the creators’ documents, then the dictionary, and nothing a save holds', () => {
    const advisory = statements.indexOf("SELECT pg_advisory_xact_lock(hashtext('public.rebuild_search_terms'));");
    const creators = statements.indexOf('LOCK TABLE public.creator_search_documents IN SHARE MODE;');
    const dictionary = statements.indexOf('LOCK TABLE public.search_terms IN ACCESS EXCLUSIVE MODE;');
    const firstChange = statements.search(/\b(?:ALTER TABLE|CREATE (?:OR REPLACE )?FUNCTION|CREATE INDEX)\b/);
    // The advisory lock first: the rebuild at the end of the file then cannot
    // find it held by a job waiting on the table, and skip itself.
    expect(advisory).toBeGreaterThan(0);
    expect(creators).toBeGreaterThan(advisory);
    // The dictionary last, as 20261111231942 takes it.
    expect(dictionary).toBeGreaterThan(creators);
    expect(firstChange).toBeGreaterThan(dictionary);
    expect(statements.match(/\bLOCK TABLE\b/g)).toHaveLength(2);
    // Nothing here stops a read of posts or drops what a search is using.
    expect(statements).not.toMatch(/\bDROP\s+(?:TRIGGER|FUNCTION|INDEX|TABLE|COLUMN)\b/i);
    expect(statements).not.toMatch(/CREATE (?:OR REPLACE )?TRIGGER/);
  });

  it('leaves search itself alone', () => {
    for (const notThisFiles of [
      'search_public_posts', 'search_public_creators', 'search_post_score', 'search_creator_score',
      'search_corrected_query', 'refresh_post_search_documents', 'refresh_creator_search_documents',
    ]) {
      expect(statements, notThisFiles).not.toMatch(new RegExp(`FUNCTION public\\.${notThisFiles}\\(`));
    }
    // The job and both forms of search_corrected_query read these as before.
    expect(statements).not.toMatch(/DROP COLUMN|ALTER COLUMN|RENAME/i);
    expect(newestDefinition('search_corrected_query').file).toBe('20261111231942_recipe_search_recall_and_relevance.sql');
  });

  it('gives each word its counts, and no index that would end an in-place update of one', () => {
    expect(statements).toMatch(
      /ALTER TABLE public\.search_terms\s+ADD COLUMN post_count integer NOT NULL DEFAULT 0,\s+ADD COLUMN creator_count integer NOT NULL DEFAULT 0,\s+ADD CONSTRAINT search_terms_counts_hold CHECK \(\s+post_count >= 0 AND creator_count >= 0 AND creator_count <= post_count\s+\);/,
    );
    const indexes = Array.from(statements.matchAll(/CREATE INDEX[\s\S]*?;/g), (match) => match[0].replace(/\s+/g, ' '));
    expect(indexes).toEqual([
      'CREATE INDEX search_terms_term_prefix_idx ON public.search_terms (term text_pattern_ops);',
      'CREATE INDEX creator_search_documents_username_prefix_idx ON public.creator_search_documents (username_normalized text_pattern_ops);',
      'CREATE INDEX creator_search_documents_display_name_prefix_idx ON public.creator_search_documents (display_name_normalized text_pattern_ops);',
    ]);
    // An index naming a count, in a column, an INCLUDE or a WHERE, would make
    // every hourly rebuild write the trigram index again for each moved word.
    expect(indexes.join(' ')).not.toMatch(/post_count|creator_count|WHERE|INCLUDE|CONCURRENTLY/);
  });

  it('counts a word only where a public document shows it, and reads names only to leave a post out', () => {
    const { file, definition } = newestDefinition('rebuild_search_terms');
    expect(file).toBe(MIGRATION);
    expect(definition).toContain('SECURITY DEFINER');
    expect(definition).toContain("SET search_path = ''");
    expect(definition).toContain("IF NOT pg_try_advisory_xact_lock(hashtext('public.rebuild_search_terms')) THEN");
    // Every counted word is a lexeme of a document's own text: the documents
    // stay the one place that says what the public can read.
    expect(definition).toContain("CROSS JOIN LATERAL unnest(to_tsvector('pg_catalog.simple', documents.search_text)) AS words");
    expect(definition).toContain('WHERE posts.is_nsfw = false');
    // Never from a post's own columns or a recipe's, which hold what a
    // document leaves out (a paid recipe's caption, a prompt, the items).
    expect(definition).not.toMatch(/posts\.(?:title|body|prompt)\b/);
    expect(definition).not.toMatch(/post_resource_bundles|resource_items|resource_sections|prompt_text|notes_markdown/);
    // The names take a post out of a count and can do nothing else.
    expect(definition).toContain('NOT (words.lexeme = ANY (names.words)) AS written');
    expect(definition.match(/names\.words/g)).toHaveLength(1);
    expect(definition).toContain('count(*) FILTER (WHERE post_lexemes.written) AS written_posts');
    expect(definition).toMatch(
      /sum\(creator_words\.written_posts\)::integer AS post_count,\s+\(count\(\*\) FILTER \(WHERE creator_words\.written_posts > 0\)\)::integer AS creator_count\s+FROM creator_words\s+GROUP BY creator_words\.term/,
    );
    expect(definition).toContain('GROUP BY post_lexemes.term, post_lexemes.creator_user_id');
    // The letters-only test once per word, behind a fence the planner cannot move it through.
    expect(definition).toContain('counted AS MATERIALIZED (');
    expect(definition.match(/~ '\^\[\[:alpha:\]\]\{4,40\}\$'/g)).toHaveLength(2);
    // The counts are written with the flags, and only when something moved.
    expect(definition).toMatch(
      /INSERT INTO public\.search_terms AS terms \(term, in_posts, in_recipes, post_count, creator_count\)\s+SELECT shown\.term, shown\.in_posts, shown\.in_recipes, shown\.post_count, shown\.creator_count/,
    );
    expect(definition).toMatch(/post_count = excluded\.post_count, creator_count = excluded\.creator_count\s+WHERE \(terms\.in_posts, terms\.in_recipes, terms\.post_count, terms\.creator_count\)\s+IS DISTINCT FROM/);
    // Its shape, as the search-dictionary job reads it.
    expect(definition).toMatch(/^CREATE OR REPLACE FUNCTION public\.rebuild_search_terms\(\)\s+RETURNS TABLE\(added integer, removed integer\)/);
    expect(definition).toContain('RETURN QUERY SELECT v_added, v_removed;');
    expect(statements).toContain('REVOKE ALL ON FUNCTION public.rebuild_search_terms() FROM PUBLIC, anon, authenticated;');
    expect(statements).toContain('GRANT EXECUTE ON FUNCTION public.rebuild_search_terms() TO service_role;');
  });

  it('offers a completion only for a word, or a phrase, that two creators write', () => {
    const { file, definition } = newestDefinition('search_suggest_completions');
    expect(file).toBe(MIGRATION);
    expect(definition).toContain('c_min_creators CONSTANT integer := 2;');
    // Both readings of the dictionary, the one word and the candidates for a phrase.
    expect(definition.match(/AND terms\.in_posts\s+AND terms\.creator_count >= c_min_creators/g)).toHaveLength(2);
    expect(definition.match(/\bcreator_count\b/g)).toHaveLength(4);
    // A phrase by the posts that match all of it: two creators' posts, unlabelled, read as post search reads a query.
    expect(definition).toContain('WHERE checked.creators >= c_min_creators');
    expect(definition).toContain('count(DISTINCT matched.creator_user_id) AS creators');
    expect(definition).toMatch(/WHERE posts\.is_nsfw = false\s+AND documents\.search_vector @@ public\.search_query_tsquery\(v_head \|\| ' ' \|\| candidates\.term, true\)/);
    // A ceiling on what one call reads.
    expect(definition).toMatch(/c_phrase_candidates CONSTANT integer := \d+;/);
    expect(definition).toMatch(/c_phrase_posts_read CONSTANT integer := \d+;/);
    expect(definition).toContain('LIMIT c_phrase_candidates');
    expect(definition).toContain('LIMIT c_phrase_posts_read');
    expect(definition).toContain('v_limit integer := least(greatest(coalesce(p_limit, 6), 0), 10);');
    // Only letters reach a LIKE, so nothing typed is a wildcard.
    const lettersOnly = definition.indexOf("IF v_last IS NULL OR v_last !~ '^[[:alpha:]]{2,39}$' THEN");
    expect(lettersOnly).toBeGreaterThan(0);
    expect(definition.indexOf('LIKE v_last')).toBeGreaterThan(lettersOnly);
    // It reads the dictionary and the public documents, and nothing else.
    expect(relationsOf(definition)).toEqual(['public.post_search_documents', 'public.posts', 'public.search_terms']);
    // With the caller's rights: the service role's own grants are enough.
    expect(definition).not.toContain('SECURITY DEFINER');
    expect(definition).toContain("SET search_path = ''");
    expect(definition).toMatch(/\bSTABLE\b/);
  });

  it('offers creators by prefix, in search’s order, and never a guest, a suspended account or a blocked pair', () => {
    const { file, definition } = newestDefinition('search_suggest_creators');
    expect(file).toBe(MIGRATION);
    expect(definition).toMatch(/RETURNS TABLE\(\s+creator_user_id uuid,\s+username text,\s+display_name text,\s+avatar_url text,\s+is_following boolean\s+\)/);
    // A %, an _ or a \ typed matches itself.
    expect(definition).toContain(String.raw`v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';`);
    expect(definition).toMatch(/WHERE documents\.username_normalized LIKE v_like\s+OR \(NOT v_handles_only AND documents\.display_name_normalized LIKE v_like\)/);
    // No other way in: not a word inside a name, not a near miss, not the bio.
    expect(definition).not.toMatch(/OPERATOR\(extensions\.<?%\)|search_vector @@|ILIKE/);
    // Search's own score, so the two agree on who comes first.
    expect(definition).toContain('public.search_creator_score(');
    expect(definition).toContain('ORDER BY scored.search_score DESC, scored.creator_user_id ASC');
    expect(definition).toMatch(/c_candidates CONSTANT integer := \d+;/);
    expect(definition).toContain('LIMIT c_candidates');
    expect(definition).toContain('v_limit integer := least(greatest(coalesce(p_limit, 5), 0), 10);');
    // A creator is an account in good standing.
    expect(definition).toContain('JOIN auth.users AS users ON users.id = documents.creator_user_id');
    expect(definition).toContain('users.is_anonymous IS NOT TRUE');
    expect(definition).toContain('AND (users.banned_until IS NULL OR users.banned_until <= now())');
    expect(definition).toContain("AND profiles.identity_state = 'active'");
    // Neither side of a block, before the limit.
    expect(definition).toMatch(/AND NOT EXISTS \(\s+SELECT 1\s+FROM public\.user_blocks AS blocks\s+WHERE blocks\.blocker_user_id = p_viewer_user_id\s+AND blocks\.blocked_user_id = documents\.creator_user_id\s+\)/);
    expect(definition).toMatch(/AND NOT EXISTS \(\s+SELECT 1\s+FROM public\.user_blocks AS blocks\s+WHERE blocks\.blocker_user_id = documents\.creator_user_id\s+AND blocks\.blocked_user_id = p_viewer_user_id\s+\)/);
    expect(definition.lastIndexOf('public.user_blocks')).toBeLessThan(definition.lastIndexOf('LIMIT v_limit'));
    // It reads auth.users, which the service role may not: definer rights, on an empty search path.
    expect(definition).toContain('SECURITY DEFINER');
    expect(definition).toContain("SET search_path = ''");
    expect(relationsOf(definition)).toEqual([
      'auth.users', 'public.creator_search_documents', 'public.follows', 'public.profiles', 'public.user_blocks',
    ]);
  });

  it('answers the route in one call, with a marked place for model and tool suggestions', () => {
    const { file, definition } = newestDefinition('search_suggestions');
    expect(file).toBe(MIGRATION);
    expect(definition).toMatch(/RETURNS jsonb\s+LANGUAGE sql\s+STABLE\s+SET search_path = ''/);
    expect(definition).not.toContain('SECURITY DEFINER');
    expect(definition).toContain("'creators', coalesce((");
    expect(definition).toContain("'completions', coalesce((");
    for (const key of ['id', 'username', 'display_name', 'avatar_url', 'is_following']) {
      expect(definition, key).toContain(`'${key}', creators.`);
    }
    expect(definition).toContain("jsonb_build_object('text', completions.completion)");
    // A query typed as a handle is offered no words.
    expect(definition).toContain('WHERE NOT coalesce(p_handles_only, false)');
    // The seam: named in the SQL and in the response type, and not built yet.
    expect(migration).toContain("-- SEAM (model and tool suggestions): 'entities', a third key, joins here.");
    expect(definition).not.toContain("'entities'");
    expect(readFileSync(join(process.cwd(), 'src/lib/search-suggest.ts'), 'utf8'))
      .toContain('// SEAM (model and tool suggestions): `entities: SearchSuggestEntity[]` joins');
  });

  it('keeps every function off the client roles', () => {
    for (const signature of [COMPLETIONS_SIGNATURE, CREATORS_SIGNATURE, SUGGESTIONS_SIGNATURE]) {
      expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
      expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    }
    expect(statements).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\b(?:anon|authenticated|PUBLIC)\b/i);
  });

  it('is called by the service under its parameters’ names, with the caps it defaults to', () => {
    const header = /CREATE FUNCTION public\.search_suggestions\(([\s\S]*?)\)\s+RETURNS jsonb/.exec(statements);
    expect(header).not.toBeNull();
    const parameters = header![1].split(',').map((parameter) => parameter.trim().split(/\s+/)[0]);
    expect(parameters).toEqual(['p_query', 'p_viewer_user_id', 'p_handles_only', 'p_creator_limit', 'p_completion_limit']);
    // PostgREST finds a function by its arguments' names: each one the service sends must be one of these.
    const sent = Array.from(serviceSource.matchAll(/^\s+(p_\w+):/gm), (match) => match[1]);
    expect(sent).toEqual(parameters);
    expect(serviceSource).toContain(".rpc('search_suggestions', {");
    expect(header![1]).toContain(`p_creator_limit integer DEFAULT ${SEARCH_SUGGEST_MAX_CREATORS}`);
    expect(header![1]).toContain(`p_completion_limit integer DEFAULT ${SEARCH_SUGGEST_MAX_COMPLETIONS}`);
  });
});
