import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SEARCH_SUGGEST_MAX_COMPLETIONS,
  SEARCH_SUGGEST_MAX_CREATORS,
  SEARCH_SUGGEST_MAX_ENTITIES,
} from '@/lib/search-suggest';
import { isAppSourceToolLabel } from '@/lib/source-tools';
import { PRIVATE_POST_MEDIA_PREFIX } from '@/lib/post-media-storage';

import { SEARCH_RELATED_SEARCHES_MAX } from '../../ugc-mobile/lib/public-search-policy/public-search-policy';
import { SEARCH_STARTER_PERIODS } from '../../ugc-mobile/lib/public-search-policy/search-starter';

// What the migration does to rows is held by
// supabase/tests/database/search_content_suggestions.test.sql. This file
// holds what a later re-creation, or an edit to this one, could quietly undo:
// that everything it offers is read from what a visitor can see, that the
// functions the live route calls keep their names, parameters and keys, and
// that the services send what the SQL takes.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261115105944_search_content_suggestions.sql';
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, '');
const read = (file: string) => withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'));
const statements = read(MIGRATION);
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** A function as one migration defines it, comments left out. */
function definitionIn(sql: string, name: string): string {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const start = sql.search(pattern);
  expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
  const fromDefinition = sql.slice(start);
  const closing = fromDefinition.search(/\n\$(?:function)?\$;/);
  expect(closing, `the definition of ${name} must close`).toBeGreaterThan(0);
  return fromDefinition.slice(0, closing);
}

/** The newest migration that defines `public.<name>`. */
function newestDefiner(name: string): string {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const definers = migrationNames.filter((file) => pattern.test(read(file)));
  expect(definers.length, `${name} must be defined`).toBeGreaterThan(0);
  return definers[definers.length - 1];
}

/** The tables a definition reads or writes, schema included. */
function relationsOf(definition: string): string[] {
  return Array.from(new Set(
    // The whole name, then no bracket: a function called in FROM is not a table.
    Array.from(definition.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+((?:public|auth)\.\w+)\b(?!\()/g), (match) => match[1]),
  )).sort();
}

const mine = (name: string) => definitionIn(statements, name);

// Every function this file creates or re-creates, by signature.
const FUNCTIONS: Record<string, { signature: string; definer: boolean }> = {
  search_text_phrases: { signature: 'public.search_text_phrases(text)', definer: false },
  search_entity_phrase: { signature: 'public.search_entity_phrase(text, text, text)', definer: false },
  rebuild_search_phrases: { signature: 'public.rebuild_search_phrases()', definer: true },
  search_post_picture: { signature: 'public.search_post_picture(uuid, uuid)', definer: true },
  search_entity_picture: { signature: 'public.search_entity_picture(text, text, uuid, text)', definer: true },
  search_query_post_floor: { signature: 'public.search_query_post_floor(text, uuid, integer)', definer: true },
  search_query_picture: { signature: 'public.search_query_picture(text, uuid, boolean)', definer: true },
  search_week_score: { signature: 'public.search_week_score(double precision, double precision)', definer: false },
  search_suggest_completions: { signature: 'public.search_suggest_completions(text, integer, uuid)', definer: true },
  search_suggest_creators: { signature: 'public.search_suggest_creators(text, uuid, boolean, integer)', definer: true },
  search_suggest_catalog_models: { signature: 'public.search_suggest_catalog_models(text)', definer: true },
  search_suggestions: { signature: 'public.search_suggestions(text, uuid, boolean, integer, integer, boolean)', definer: false },
  search_starter: { signature: 'public.search_starter(uuid, text[], integer, integer, integer)', definer: true },
  search_related_searches: { signature: 'public.search_related_searches(text, uuid, uuid[], text, integer)', definer: true },
};

const BLOCKED_BY_VIEWER = (creator: string) => new RegExp(
  `AND NOT EXISTS \\(\\s+SELECT 1\\s+FROM public\\.user_blocks AS blocks\\s+WHERE blocks\\.blocker_user_id = p_viewer_user_id\\s+AND blocks\\.blocked_user_id = ${creator}\\s+\\)`,
);
const BLOCKS_VIEWER = (creator: string) => new RegExp(
  `AND NOT EXISTS \\(\\s+SELECT 1\\s+FROM public\\.user_blocks AS blocks\\s+WHERE blocks\\.blocker_user_id = ${creator}\\s+AND blocks\\.blocked_user_id = p_viewer_user_id\\s+\\)`,
);

describe('search content suggestions migration', () => {
  it('runs after every search migration, as one transaction, with a stamp of its own', () => {
    const searchMigrations = migrationNames.filter((name) => /search/.test(name) && name !== MIGRATION);
    expect(migrationNames).toContain(MIGRATION);
    for (const earlier of [
      '20261112144018_search_suggestions_typeahead.sql',
      '20261112174210_search_entities_filters_corrected_reading.sql',
      '20261112192423_search_suggestions_entities.sql',
      '20261113152020_search_starter_own_app_and_best_query.sql',
    ]) {
      expect(searchMigrations, earlier).toContain(earlier);
      expect(MIGRATION > earlier, earlier).toBe(true);
    }
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    expect(statements.trim()).toMatch(/SELECT \* FROM public\.rebuild_search_phrases\(\);\s+COMMIT;$/);
  });

  it('keeps both tables to the backend: row-secured, no policy, read-only even for the service role', () => {
    for (const table of ['search_phrases', 'search_popularity']) {
      expect(statements).toMatch(new RegExp(`CREATE TABLE public\\.${table} \\(`));
      expect(statements).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(statements).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated, service_role;`);
      // Nothing but the rebuild writes them, and it runs with its owner's rights.
      expect(statements).toContain(`GRANT SELECT ON TABLE public.${table} TO service_role;`);
      expect(statements).not.toMatch(new RegExp(`GRANT[^;]*(?:INSERT|UPDATE|DELETE)[^;]*public\\.${table}`));
    }
    // Nothing is granted to a client role, so no authenticated_identity_active policy is owed.
    expect(statements).not.toMatch(/CREATE POLICY/i);
    expect(statements).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\b(?:anon|authenticated|PUBLIC)\b/i);
    // Both are read whole by nothing a path could hide in.
    const orphans = source('src/lib/storage-orphans.ts');
    expect(orphans).toContain('search_phrases: SEARCH_PHRASES,');
    expect(orphans).toContain('search_popularity: SEARCH_POPULARITY,');
  });

  it('holds a phrase to two creators and to lowercase words, by the table itself', () => {
    const table = statements.slice(statements.indexOf('CREATE TABLE public.search_phrases ('), statements.indexOf('CREATE INDEX search_phrases_words_idx'));
    expect(table).toContain('phrase = lower(phrase)');
    expect(table).toContain("phrase ~ '^[^[:space:]]+( [^[:space:]]+){0,3}$'");
    expect(table).toContain('creator_count integer NOT NULL CHECK (creator_count >= 2)');
    expect(table).toContain('post_count integer NOT NULL CHECK (post_count >= 2)');
    // What typed text is matched against is made from the phrase alone.
    expect(table).toContain("words tsvector GENERATED ALWAYS AS (to_tsvector('pg_catalog.simple', phrase)) STORED");
    expect(statements).toContain('CREATE INDEX search_phrases_words_idx\n  ON public.search_phrases USING gin (words);');
    // No index names a count: a rebuild's update of one stays in place.
    expect(Array.from(statements.matchAll(/CREATE INDEX (\w+)/g), (match) => match[1])).toEqual([
      'search_phrases_words_idx',
      'creator_search_documents_display_name_words_idx',
    ]);
    const popularity = statements.slice(statements.indexOf('CREATE TABLE public.search_popularity ('), statements.indexOf('ALTER TABLE public.search_popularity'));
    expect(popularity).toContain("subject text NOT NULL CHECK (subject IN ('model', 'tool', 'creator'))");
    expect(popularity).toContain('PRIMARY KEY (subject, key, creator_user_id)');
  });

  it('gives every function an empty search path and the service role alone', () => {
    const created = Array.from(statements.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi), (match) => match[1]);
    expect(created.sort()).toEqual(Object.keys(FUNCTIONS).sort());
    for (const [name, { signature, definer }] of Object.entries(FUNCTIONS)) {
      const definition = mine(name);
      expect(definition, name).toContain("SET search_path = ''");
      expect(/SECURITY DEFINER/.test(definition), name).toBe(definer);
      expect(statements, name).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
      expect(statements, name).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
      expect(newestDefiner(name), name).toBe(MIGRATION);
    }
    // Every function that reads a post runs with its owner's rights; the
    // three that do not read a table need none, and the one call is the
    // caller's, as 20261112192423 left it.
    for (const name of ['search_text_phrases', 'search_entity_phrase', 'search_week_score']) {
      expect(relationsOf(mine(name)), name).toEqual([]);
    }
  });

  it('touches nothing the live code depends on but what it re-creates', () => {
    // The dictionary, its rebuild and spelling correction are as they were:
    // the app live during the release calls rebuild_search_terms and nothing new.
    for (const name of [
      'rebuild_search_terms', 'search_corrected_query', 'search_public_posts', 'search_public_creators',
      'search_public_entities', 'search_starter_entity_offer', 'search_starter_term_finds_post',
      'refresh_post_search_documents', 'refresh_post_search_entities', 'search_related_posts',
      'search_query_tsquery', 'search_prefix_tsquery', 'search_split_terms', 'search_term_variants',
      'get_operational_table_growth',
    ]) {
      expect(statements, name).not.toMatch(new RegExp(`FUNCTION public\\.${name}\\(`));
    }
    expect(statements).not.toMatch(/ALTER TABLE public\.(?!search_phrases|search_popularity)/);
    expect(statements).not.toMatch(/\b(?:CREATE|DROP)\s+TRIGGER\b/i);
    expect(statements).not.toContain('search_query_events');
    // Two functions are dropped, each for one more parameter, and made again in this transaction.
    expect(Array.from(statements.matchAll(/DROP FUNCTION ([^;]+);/g), (match) => match[1])).toEqual([
      'public.search_suggest_completions(text, integer)',
      'public.search_suggestions(text, uuid, boolean, integer, integer)',
    ]);
    expect(statements.indexOf('DROP FUNCTION public.search_suggest_completions(text, integer);'))
      .toBeLessThan(statements.indexOf('CREATE FUNCTION public.search_suggest_completions('));
    expect(statements.indexOf('DROP FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer);'))
      .toBeLessThan(statements.indexOf('CREATE FUNCTION public.search_suggestions('));
    // The catalog's own tables and functions are read, never changed.
    expect(statements).not.toMatch(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.generation_model/i);
    // search_public_entities keeps the nested loops 20261112192423 gave it: nothing here re-creates it.
    expect(newestDefiner('search_public_entities')).toBe('20261112174210_search_entities_filters_corrected_reading.sql');
    expect(newestDefiner('rebuild_search_terms')).toBe('20261112144018_search_suggestions_typeahead.sql');
  });
});

describe('where a phrase comes from', () => {
  it('reads a post’s public search text and nothing else of the post', () => {
    const rebuild = mine('rebuild_search_phrases');
    // The documents of unlabelled posts: a document exists only for a public,
    // unarchived, visible post and holds its text as public reads show it.
    expect(rebuild).toMatch(/FROM public\.post_search_documents AS documents\s+JOIN public\.posts AS posts ON posts\.id = documents\.post_id/);
    expect(rebuild).toMatch(/\)\s+AS cover ON true\s+WHERE posts\.is_nsfw = false/);
    expect(rebuild).toContain('CROSS JOIN LATERAL public.search_text_phrases(shown.search_text) AS grams');
    // Never the post's own columns of text: a paid recipe's caption and
    // prompt are in them, and in no document.
    expect(rebuild).not.toMatch(/posts\.(?:title|body|prompt|description)\b/);
    expect(rebuild).not.toMatch(/post_resource_bundles|marketplace_|generation_references|resource_items/);
    expect(rebuild).not.toMatch(/search_query_events|search_terms\b/);
    expect(relationsOf(rebuild)).toEqual([
      'public.generations',
      'public.post_comments',
      'public.post_media',
      'public.post_saves',
      'public.post_search_documents',
      'public.post_search_entities',
      'public.post_source_tools',
      'public.posts',
      'public.search_phrases',
      'public.search_popularity',
    ]);
    // Every read of them is of a shown post: each other table is joined to `shown` or `active`.
    expect(rebuild).toMatch(/FROM public\.post_saves AS saves\s+JOIN shown ON shown\.post_id = saves\.post_id/);
    expect(rebuild).toMatch(/FROM public\.post_comments AS comments\s+JOIN shown ON shown\.post_id = comments\.post_id/);
    expect(rebuild.match(/FROM public\.post_search_entities AS members\s+JOIN (?:shown|active) ON (?:shown|active)\.post_id = members\.post_id/g)).toHaveLength(2);
  });

  it('names a template result’s model as its document does, never its own', () => {
    const rebuild = mine('rebuild_search_phrases');
    expect(rebuild).toMatch(
      /WHEN generations\.template_run_id IS NOT NULL OR generations\.template_run_step_id IS NOT NULL\s+THEN 'template-workflow'\s+ELSE generations\.model/,
    );
    // The model's own name is read only inside that CASE.
    expect(rebuild.match(/generations\.model\b/g)).toHaveLength(1);
    // A name offered as a search comes from post_search_entities, which holds no model for a template result.
    expect(rebuild).toContain('SELECT public.search_entity_phrase(members.kind, members.key, members.label) AS phrase');
    // No phrase a post writes holds one of that post's own tool or model names.
    expect(rebuild).toContain("WHERE NOT (string_to_array(grams.phrase, ' ') && shown.name_words)");
  });

  it('keeps a phrase only when posts of two creators hold it, and never the app as a name', () => {
    const rebuild = mine('rebuild_search_phrases');
    expect(rebuild).toContain('c_min_creators CONSTANT integer := 2;');
    expect(rebuild).toMatch(/GROUP BY by_creator\.phrase\s+HAVING count\(\*\) >= c_min_creators/);
    expect(rebuild).toMatch(/GROUP BY occurrences\.phrase, occurrences\.creator_user_id/);
    const name = mine('search_entity_phrase');
    expect(name).toContain("WHEN p_kind = 'tool' AND replace(coalesce(p_key, ''), '-', '') IN ('magicbooklet', 'emptybooklet') THEN NULL");
    for (const spelling of ['magicbooklet', 'magic-booklet', 'Magic Booklet']) {
      expect(isAppSourceToolLabel(spelling), spelling).toBe(true);
    }
    // One rebuild at a time, and it says what the tables hold either way.
    expect(rebuild).toContain("IF pg_try_advisory_xact_lock(hashtext('public.rebuild_search_phrases')) THEN");
    expect(rebuild).toMatch(/RETURNS TABLE\(phrases integer, subjects integer\)/);
  });

  it('counts a week from other accounts’ saves and active comments on shown posts', () => {
    const rebuild = mine('rebuild_search_phrases');
    expect(rebuild).toMatch(/WHERE saves\.created_at >= v_month\s+AND saves\.user_id <> shown\.creator_user_id/);
    expect(rebuild).toMatch(/WHERE comments\.created_at >= v_month\s+AND comments\.status = 'active'\s+AND comments\.user_id <> shown\.creator_user_id/);
    expect(rebuild).toContain("v_week timestamptz := now() - interval '7 days';");
    expect(rebuild).toContain("v_month timestamptz := now() - interval '28 days';");
    // A creator's new posts count toward a week up to a cap.
    expect(rebuild).toMatch(/least\(sum\(active\.new_this_week\), c_week_posts\)/);
  });

  it('reads a text 500 characters deep, in runs between punctuation', () => {
    const phrases = mine('search_text_phrases');
    expect(phrases).toContain('c_chars CONSTANT integer := 500;');
    expect(phrases).toContain("regexp_split_to_table(v_text, '[^[:alnum:] ]+') WITH ORDINALITY AS runs(content, run)");
    expect(phrases).toContain("spoken.word ~ '^[[:alpha:]]{2,24}$' AS is_word");
    expect(phrases).toContain('WINDOW following AS (PARTITION BY marked.run ORDER BY marked.place)');
    // plpgsql, for the kept plan: a rebuild calls it once per post.
    expect(phrases).toMatch(/LANGUAGE plpgsql\s+STABLE/);
  });
});

describe('a picture is of a post the viewer may see', () => {
  it('answers a cover preview only for a public, visible, unarchived, unlabelled post with a document, neither side of a block', () => {
    const picture = mine('search_post_picture');
    for (const rule of [
      'JOIN public.post_search_documents AS documents ON documents.post_id = posts.id',
      "AND posts.visibility = 'public'",
      "AND posts.review_status = 'visible'",
      'AND posts.archived_at IS NULL',
      'AND posts.is_nsfw = false',
      "AND cover.preview_status = 'ready'",
      'AND cover.preview_storage_path IS NOT NULL',
      'AND cover.source_unavailable_at IS NULL',
    ]) expect(picture, rule).toContain(rule);
    expect(picture).toMatch(BLOCKED_BY_VIEWER('posts\\.user_id'));
    expect(picture).toMatch(BLOCKS_VIEWER('posts\\.user_id'));
    // The cover is the post's first media row, as a card draws it.
    expect(picture).toMatch(/FROM public\.post_media AS media\s+WHERE media\.post_id = posts\.id\s+ORDER BY media\.sort_order\s+LIMIT 1/);
    // Nothing of the private bucket, where a labelled post's media lives: the prefix the app names it by.
    expect(picture).toContain(`AND cover.preview_storage_path NOT LIKE '${PRIVATE_POST_MEDIA_PREFIX}%'`);
    expect(mine('rebuild_search_phrases')).toContain(`AND media.preview_storage_path NOT LIKE '${PRIVATE_POST_MEDIA_PREFIX}%'`);
    // The keys the service reads.
    for (const key of ['post_id', 'path', 'thumbhash', 'width', 'height', 'media_kind']) {
      expect(picture, key).toContain(`'${key}',`);
    }
    const service = source('src/lib/search-thumbnail.ts');
    for (const key of ['post_id', 'path', 'thumbhash', 'width', 'height', 'media_kind']) {
      expect(service, key).toContain(`row.${key}`);
    }
    // The address is built by the function a post result's cover is built by, with no read of storage.
    expect(service).toContain('postMediaReadUrl(client, row.path)');
    expect(service).toContain('postMediaStorageBucket(row.path) === PRIVATE_POST_MEDIA_BUCKET');
    expect(service).not.toMatch(/createSignedUrl|\.download\(|\.list\(/);
  });

  it('checks every kept candidate again at the read, through that one function', () => {
    const entity = mine('search_entity_picture');
    expect(entity).toMatch(BLOCKED_BY_VIEWER('stats\\.creator_user_id'));
    expect(entity).toMatch(BLOCKS_VIEWER('stats\\.creator_user_id'));
    // Still made with it, and with a query still found by it.
    expect(entity).toMatch(/CONTINUE WHEN NOT EXISTS \(\s+SELECT 1\s+FROM public\.post_search_entities AS members\s+WHERE members\.kind = p_kind\s+AND members\.key = p_key\s+AND members\.post_id = v_post_id\s+\);/);
    expect(entity).toContain('AND documents.search_vector @@ v_tsquery');
    expect(entity).toContain('v_picture := public.search_post_picture(v_post_id, p_viewer_user_id);');
    const query = mine('search_query_picture');
    expect(query.match(/v_picture := public\.search_post_picture\(v_post_id, p_viewer_user_id\);/g)).toHaveLength(2);
    expect(query).toMatch(/WHERE posts\.is_nsfw = false\s+AND documents\.search_vector @@ v_tsquery/);
    expect(query).toMatch(BLOCKED_BY_VIEWER('documents\\.creator_user_id'));
    expect(query).toMatch(BLOCKS_VIEWER('documents\\.creator_user_id'));
    // A bounded read, however common the word.
    expect(query).toMatch(/c_posts_read CONSTANT integer := \d+;/);
    expect(query).toContain('LIMIT c_posts_read');
    // No picture is made anywhere else: every jsonb 'thumbnail' is one of the two pickers' answers.
    const thumbnails = Array.from(statements.matchAll(/'thumbnail', ([^\n]+)/g), (match) => match[1]);
    expect(thumbnails.length).toBeGreaterThanOrEqual(5);
    for (const picked of thumbnails) {
      expect(picked).toMatch(/^public\.search_(?:entity|query)_picture\(/);
    }
  });

  it('counts a floor of posts the viewer may see, by the documents’ word index alone', () => {
    const floor = mine('search_query_post_floor');
    expect(floor).toContain("v_tsquery tsquery := plainto_tsquery('pg_catalog.simple', coalesce(p_query, ''));");
    expect(floor).toMatch(/WHERE posts\.is_nsfw = false\s+AND documents\.search_vector @@ v_tsquery/);
    expect(floor).toMatch(BLOCKED_BY_VIEWER('documents\\.creator_user_id'));
    expect(floor).toMatch(BLOCKS_VIEWER('documents\\.creator_user_id'));
    expect(floor).toContain('LIMIT v_floor');
    for (const setting of ['SET enable_seqscan = off', 'SET enable_indexscan = off']) expect(floor).toContain(setting);
  });
});

describe('completions, creators and the one call', () => {
  it('still offers a word, or a word of several, only when two creators write it', () => {
    const definition = mine('search_suggest_completions');
    expect(definition).toContain('c_min_creators CONSTANT integer := 2;');
    expect(definition.match(/AND terms\.in_posts\s+AND terms\.creator_count >= c_min_creators/g)).toHaveLength(2);
    expect(definition).toMatch(/AND posts\.is_nsfw = false\s+AND documents\.search_vector @@ public\.search_query_tsquery\(v_head \|\| ' ' \|\| v_last, false\)\s+LIMIT c_phrase_posts_read/);
    expect(definition).toContain('count(DISTINCT matched.creator_user_id) AS creators');
    expect(definition).toMatch(/WHERE found\.creators >= c_min_creators\s+AND terms\.in_posts\s+AND terms\.creator_count >= c_min_creators/);
    expect(definition).toContain('v_limit integer := least(greatest(coalesce(p_limit, 6), 0), 10);');
    // Only a word of letters reaches a LIKE on the dictionary, so nothing typed is a wildcard there.
    expect(definition).toContain("v_last_is_word := v_last ~ '^[[:alpha:]]{2,39}$';");
    expect(definition.match(/AND v_last_is_word/g)).toHaveLength(2);
    expect(definition).toMatch(/WHERE v_head = ''\s+AND v_last_is_word\s+AND terms\.term LIKE v_last \|\| '%'/);
    expect(definition).toMatch(/WHERE v_head <> ''\s+AND v_last_is_word\s+AND NOT v_head_withdrawn/);
  });

  it('offers a phrase by any word of it, never one that holds a withdrawn word, and nothing the text does not hold whole', () => {
    const definition = mine('search_suggest_completions');
    expect(definition).toContain('AND phrases.words @@ v_phrase_tsquery');
    // The parser drops what is not a letter or a digit: 'amb%' is not read as 'amb'.
    expect(definition).toMatch(/v_phrase_tsquery := CASE\s+WHEN v_text ~ '\^\[\[:alnum:\] \.\+\]\+\$' THEN public\.search_prefix_tsquery\('pg_catalog\.simple', v_text\)\s+END;/);
    expect(definition).toMatch(/WHERE v_phrase_tsquery IS NOT NULL\s+AND numnode\(v_phrase_tsquery\) > 0/);
    // No empty tsquery literal: its cast prints a NOTICE where the expression is planned.
    expect(definition).not.toContain("''::tsquery");
    expect(definition).toContain(String.raw`v_like := replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';`);
    // A start first, then by the posts that hold it, recent ones weighing more.
    expect(definition).toContain('ORDER BY (phrases.phrase LIKE v_like) DESC, phrases.recent_weight DESC, phrases.phrase');
    // Withdrawn words: the word alone, a word of several, a phrase that holds one, and a query that holds one.
    expect(definition.match(/SELECT 1 FROM public\.search_suggestion_denylist AS denied WHERE denied\.term = (?:terms|found)\.term/g)).toHaveLength(2);
    expect(definition).toMatch(/WHERE denied\.term = ANY \(tsvector_to_array\(to_tsvector\(\s+'pg_catalog\.simple', coalesce\(public\.search_term_variants\(strongest\.offer\), ''\)/);
    expect(definition).toMatch(/v_head_withdrawn := v_head <> '' AND EXISTS \(\s+SELECT 1\s+FROM public\.search_suggestion_denylist AS denied/);
    expect(definition).toContain('AND NOT v_head_withdrawn');
    // It reads the dictionary, the phrases, the public documents and the viewer's blocks, and nothing else.
    expect(relationsOf(definition)).toEqual([
      'public.post_search_documents', 'public.posts', 'public.search_phrases',
      'public.search_suggestion_denylist', 'public.search_terms', 'public.user_blocks',
    ]);
  });

  it('reads the corrected text only when nothing completes it as typed, and holds a viewer with a block to posts they may see', () => {
    const definition = mine('search_suggest_completions');
    expect(definition).toContain('EXIT WHEN v_found > 0 OR v_is_corrected;');
    expect(definition).toContain('v_corrected := public.search_corrected_query(v_query);');
    // The correction is search's own; a text it only split is not a correction.
    expect(definition).toContain('OR v_corrected = public.search_split_terms(v_query)');
    expect(definition).toMatch(/WHERE NOT v_viewer_has_blocks\s+OR public\.search_query_post_floor\(ordered\.offer, p_viewer_user_id, c_post_floor\)/);
    expect(definition).toContain('c_post_floor CONSTANT integer := 2;');
    // The third parameter is last, with a default: the two-argument call still resolves.
    expect(squash(statements)).toContain(
      'CREATE FUNCTION public.search_suggest_completions( p_query text, p_limit integer DEFAULT 6, p_viewer_user_id uuid DEFAULT NULL ) RETURNS TABLE(completion text)',
    );
  });

  it('matches a creator by any word of the display name, and a handle query by the handle’s start alone', () => {
    const definition = mine('search_suggest_creators');
    const earlier = definitionIn(read('20261112144018_search_suggestions_typeahead.sql'), 'search_suggest_creators');
    // The same signature and answer: CREATE OR REPLACE, or Postgres refuses it.
    const header = (sql: string) => squash(sql.slice(0, sql.indexOf('LANGUAGE plpgsql'))).replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION');
    expect(header(definition)).toBe(header(earlier));
    expect(definition).toMatch(
      /WHERE \(\s+documents\.username_normalized LIKE v_like\s+OR \(NOT v_handles_only AND documents\.display_name_normalized LIKE v_like\)\s+OR \(\s+v_words IS NOT NULL\s+AND to_tsvector\('pg_catalog\.simple', documents\.display_name_normalized\) @@ v_words\s+\)\s+\)/,
    );
    // Words only for a query of letters, digits and spaces, from two characters, and never for a handle query.
    expect(definition).toContain("IF NOT v_handles_only AND char_length(v_query) >= 2 AND v_query ~ '^[[:alnum:] ]+$' THEN");
    // The index that match reads.
    expect(squash(statements)).toContain(
      "CREATE INDEX creator_search_documents_display_name_words_idx ON public.creator_search_documents USING gin (to_tsvector('pg_catalog.simple', display_name_normalized));",
    );
    // Not the bio, not a near miss.
    expect(definition).not.toMatch(/OPERATOR\(extensions\.<?%\)|search_vector @@|ILIKE/);
    // Everyone who may not be offered is still left out before either cut.
    const firstCut = definition.indexOf('LIMIT c_candidates');
    for (const exclusion of ['users.is_anonymous IS NOT TRUE', 'users.banned_until', "profiles.identity_state = 'active'"]) {
      expect(definition.indexOf(exclusion), exclusion).toBeGreaterThan(0);
      expect(definition.indexOf(exclusion), exclusion).toBeLessThan(firstCut);
    }
    expect(definition).toMatch(BLOCKED_BY_VIEWER('documents\\.creator_user_id'));
    expect(definition).toMatch(BLOCKS_VIEWER('documents\\.creator_user_id'));
    expect(definition.lastIndexOf('public.user_blocks')).toBeLessThan(firstCut);
    expect(definition).toContain('public.search_creator_score(');
    // A name the text starts stands ahead of one matched by a later word.
    expect(definition).toContain('ORDER BY scored.starts DESC, scored.search_score DESC, scored.creator_user_id ASC');
    expect(relationsOf(definition)).toEqual([
      'auth.users', 'public.creator_search_documents', 'public.follows', 'public.profiles', 'public.user_blocks',
    ]);
  });

  it('keeps the one call’s five parameters and its creators and completions, and adds a sixth that changes nothing by default', () => {
    const definition = mine('search_suggestions');
    const earlier = definitionIn(read('20261112192423_search_suggestions_entities.sql'), 'search_suggestions');
    const header = (sql: string) => squash(/public\.search_suggestions\(([\s\S]*?)\)\s+RETURNS jsonb/.exec(sql)![1]);
    // The five the live route names, as they were, then p_catalog: the
    // five-name call resolves to this function through the default.
    expect(header(definition)).toBe(`${header(earlier)}, p_catalog boolean DEFAULT false`);
    expect(header(definition)).toContain(`p_creator_limit integer DEFAULT ${SEARCH_SUGGEST_MAX_CREATORS}`);
    expect(header(definition)).toContain(`p_completion_limit integer DEFAULT ${SEARCH_SUGGEST_MAX_COMPLETIONS}`);
    expect(definition).toMatch(/RETURNS jsonb\s+LANGUAGE sql\s+STABLE\s+SET search_path = ''/);
    const list = (sql: string, key: string) => {
      const from = sql.indexOf(`'${key}', coalesce((`);
      expect(from, key).toBeGreaterThan(0);
      return squash(sql.slice(from, sql.indexOf("'[]'::jsonb)", from)));
    };
    // Creators: as they were. Completions: for this viewer.
    expect(list(definition, 'creators')).toBe(list(earlier, 'creators'));
    expect(list(definition, 'completions')).toBe(list(earlier, 'completions').replace(
      'public.search_suggest_completions(p_query, p_completion_limit)',
      'public.search_suggest_completions(p_query, p_completion_limit, p_viewer_user_id)',
    ));
    // Every key an entity had, and the new ones.
    for (const key of ['kind', 'key', 'label']) expect(definition, key).toContain(`'${key}', chosen.${key}`);
    for (const key of ['post_count', 'post_count_capped', 'thumbnail', 'in_catalog', 'catalog_model', 'query']) {
      expect(definition, key).toContain(`'${key}',`);
    }
    expect(definition).toContain("'thumbnail', public.search_entity_picture(chosen.kind, chosen.key, p_viewer_user_id, NULL)");
    // The service sends the six arguments under their names, and reads the new keys.
    const service = source('src/lib/search-suggest-service.ts');
    expect(Array.from(service.matchAll(/^\s+(p_\w+):/gm), (match) => match[1]))
      .toEqual(['p_query', 'p_viewer_user_id', 'p_handles_only', 'p_creator_limit', 'p_completion_limit', 'p_catalog']);
    expect(service).toContain('p_catalog: options.catalog ?? false,');
    expect(service).toContain('thumbnail: searchThumbnailFromRow(client, row.thumbnail),');
    for (const key of ['in_catalog', 'catalog_model', 'query']) expect(service, key).toContain(`row.${key}`);
  });

  it('still takes entities from search itself, and exempts only the catalog’s own models from the two-creator rule', () => {
    const definition = mine('search_suggestions');
    // The one source of an entity with posts: the call /api/search makes, for this query and viewer.
    expect(definition).toContain('FROM public.search_public_entities(p_query, p_viewer_user_id, 10, NULL)');
    expect(definition.match(/search_public_entities/g)).toHaveLength(1);
    expect(newestDefiner('search_public_entities')).toBe('20261112174210_search_entities_filters_corrected_reading.sql');
    // Kept when it is a catalog model, or two creators' unlabelled posts are made with it.
    expect(definition).toMatch(/LEFT JOIN catalog ON found\.kind = 'model' AND catalog\.key = found\.key\s+WHERE \(\s+catalog\.model_id IS NOT NULL\s+OR EXISTS \(/);
    expect(definition).toMatch(/WHERE makers\.creator_user_id <> \(/);
    expect(definition).toMatch(/AND posts\.is_nsfw = false\s+LIMIT 500/);
    // No withdrawn word in the name or the key, a catalog model's included: asked of every candidate.
    expect(definition).toMatch(/FROM candidates\s+WHERE NOT EXISTS \(\s+SELECT 1\s+FROM public\.search_suggestion_denylist AS denied\s+WHERE denied\.term = ANY \(tsvector_to_array\(to_tsvector\(\s+'pg_catalog\.simple',\s+coalesce\(public\.search_term_variants\(candidates\.label\), ''\) \|\| ' ' \|\| coalesce\(public\.search_term_variants\(candidates\.key\), ''\)/);
    // Not for a query typed as a handle: neither source is read for one.
    expect(definition.match(/WHERE NOT coalesce\(p_handles_only, false\)/g)).toHaveLength(3);
    // At most the cap, a catalog model the text starts first, then the name that is the text, then the most posts.
    expect(definition).toContain(`ORDER BY offered.place\n        LIMIT ${SEARCH_SUGGEST_MAX_ENTITIES}`);
    expect(definition).toMatch(/ORDER BY\s+\(candidates\.model_id IS NOT NULL AND candidates\.starts\) DESC,\s+\(lower\(candidates\.label\) = [^\n]+\) DESC,\s+candidates\.post_count DESC,\s+candidates\.position NULLS LAST,\s+candidates\.kind,\s+candidates\.key/);
  });

  it('adds a catalog model with nothing to open only for a request that asked, counted as the viewer may see', () => {
    const definition = mine('search_suggestions');
    const added = definition.slice(definition.indexOf('UNION ALL'), definition.indexOf('offered AS ('));
    // Only with p_catalog, and only a model search did not already answer.
    expect(added).toMatch(/WHERE coalesce\(p_catalog, false\)\s+AND NOT EXISTS \(\s+SELECT 1 FROM found WHERE found\.kind = 'model' AND found\.key = catalog\.key\s+\)/);
    // The posts made with it that this viewer may see: unlabelled, neither side of a block.
    expect(added).toMatch(/WHERE members\.kind = 'model'\s+AND members\.key = catalog\.key\s+AND posts\.is_nsfw = false/);
    expect(added).toMatch(BLOCKED_BY_VIEWER('members\\.creator_user_id'));
    expect(added).toMatch(BLOCKS_VIEWER('members\\.creator_user_id'));
    // The count a row states, and its query, are the search that opens it: asked of the rows chosen, at most three.
    expect(definition).toMatch(/LEFT JOIN LATERAL public\.search_starter_entity_offer\(chosen\.kind, chosen\.key, p_viewer_user_id\) AS opened\s+ON chosen\.added/);
    expect(definition).toContain("'post_count', CASE WHEN chosen.added THEN coalesce(opened.post_count, 0) ELSE chosen.post_count END,");
    expect(definition).toContain("'query', opened.query");
    // It reads the entities' rows, the posts, the blocks and the withdrawn words, and no catalog table itself.
    expect(relationsOf(definition)).toEqual([
      'public.post_search_entities', 'public.posts', 'public.search_suggestion_denylist', 'public.user_blocks',
    ]);
  });

  it('reads the catalog as its public projection: the active release’s entries on a platform, by their public name', () => {
    const definition = mine('search_suggest_catalog_models');
    // The release /api/model-catalog/v1 serves, chosen as its own read chooses it.
    expect(definition).toMatch(/WHERE releases\.status = 'active'\s+ORDER BY releases\.schema_version DESC, releases\.activated_at DESC\s+LIMIT 1/);
    expect(squash(definitionIn(read('20260914054905_model_catalog_v1_reads.sql'), 'read_model_catalog_v1_current')))
      .toContain("WHERE status = 'active' ORDER BY schema_version DESC, activated_at DESC LIMIT 1");
    // A model switched off on the web and in the app is not public.
    expect(definition).toContain('WHERE (entries.web_enabled OR entries.mobile_enabled)');
    // Only what the public descriptor shows: never a provider mapping, a price or a rule.
    expect(definition).toContain("entries.public_descriptor ->> 'displayName'");
    expect(definition).not.toMatch(/provider_model_map|pricing_|validation_|verification_|adapter_/);
    // From two characters, every typed word in the name or the id, the last a prefix.
    expect(definition).toContain('IF char_length(v_query) < 2 OR char_length(v_query) > 100 THEN');
    expect(definition).toContain('v_tsquery := public.search_query_tsquery(v_query, false);');
    expect(definition).toContain(String.raw`v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';`);
    // The key posts are found under: search's own key of the catalog's id.
    expect(definition).toContain('public.search_entity_key(entries.model_id) AS key');
    expect(relationsOf(definition)).toEqual([
      'public.generation_model_catalog_entries', 'public.generation_model_catalog_releases', 'public.generation_models',
    ]);
  });
});

describe('the starter', () => {
  const definition = mine('search_starter');
  const earlier = definitionIn(read('20261113152020_search_starter_own_app_and_best_query.sql'), 'search_starter');

  it('keeps its signature and every key the live route reads, and says which period each list is of', () => {
    const header = (sql: string) => squash(/public\.search_starter\(([\s\S]*?)\)\s+RETURNS jsonb/.exec(sql)![1]);
    expect(header(definition)).toBe(header(earlier));
    for (const key of ['kind', 'key', 'label', 'post_count', 'post_count_capped', 'query']) {
      expect(definition.match(new RegExp(`'${key}', offered\\.${key}`, 'g')), key).toHaveLength(2);
    }
    for (const key of ['username', 'display_name', 'bio', 'avatar_url', 'public_post_count']) {
      expect(definition.match(new RegExp(`'${key}', ranked\\.${key}`, 'g')), key).toHaveLength(2);
    }
    expect(squash(definition)).toContain(
      "RETURN jsonb_build_object( 'entities', v_entities, 'creators', v_creators, 'searches', v_searches, 'periods', jsonb_build_object( 'entities', v_entities_period, 'creators', v_creators_period, 'searches', v_searches_period ) );",
    );
    // A period is one of the two words the clients read, and starts all-time.
    for (const list of ['entities', 'creators', 'searches']) {
      expect(definition).toContain(`v_${list}_period text := 'all';`);
      expect(definition).toContain(`v_${list}_period := 'week';`);
    }
    expect(SEARCH_STARTER_PERIODS).toEqual(['week', 'all']);
    // The service sends the same five arguments, and reads the new keys.
    const service = source('src/lib/search-starter-service.ts');
    expect(Array.from(service.matchAll(/^\s+(p_\w+):/gm), (match) => match[1]))
      .toEqual(['p_viewer_user_id', 'p_terms', 'p_entity_limit', 'p_creator_limit', 'p_search_limit']);
    expect(service).toContain("periodOf(data.periods, 'entities')");
  });

  it('falls back to the all-time lists exactly as they were', () => {
    // The window the all-time lists are read from, word for word.
    const window = (sql: string) => squash(sql.slice(sql.indexOf('WITH recent AS MATERIALIZED ('), sql.indexOf('LIMIT c_window')));
    expect(window(definition)).toBe(window(earlier));
    // The all-time creators, word for word.
    const creators = (sql: string) => squash(sql.slice(sql.indexOf('row_number() OVER ('), sql.indexOf('WHERE ranked.position <= v_creator_limit')));
    expect(creators(definition)).toBe(creators(earlier));
    // The all-time entities' candidates, word for word, the app left out before the cut.
    const candidates = (sql: string) => squash(sql.slice(sql.search(/FROM recent\s+JOIN public\.post_search_entities/), sql.lastIndexOf('LIMIT c_entity_candidates')));
    expect(candidates(definition)).toBe(candidates(earlier));
    expect(candidates(definition)).toContain("replace(members.key, '-', '') IN ('magicbooklet', 'emptybooklet')");
    // A list is this week's only with three rows active this week.
    expect(definition).toContain('c_week_rows CONSTANT integer := 3;');
    expect(definition.match(/IF v_week_rows >= c_week_rows THEN/g)).toHaveLength(2);
  });

  it('adds the week up for one viewer: without the creators blocked with them, never the app, two creators', () => {
    const week = definition.slice(definition.indexOf('FROM public.search_popularity AS stats'), definition.indexOf('LIMIT c_entity_candidates'));
    expect(week).toContain("WHERE stats.subject IN ('model', 'tool')");
    expect(week).toMatch(/AND NOT \(\s+stats\.subject = 'tool'\s+AND replace\(stats\.key, '-', ''\) IN \('magicbooklet', 'emptybooklet'\)\s+\)/);
    expect(week).toMatch(BLOCKED_BY_VIEWER('stats\\.creator_user_id'));
    expect(week).toMatch(BLOCKS_VIEWER('stats\\.creator_user_id'));
    expect(week).toContain('HAVING count(*) >= 2 AND sum(stats.week_activity) > 0');
    // Counted and named as before: a row opens exactly the posts it counts.
    expect(definition.match(/CROSS JOIN LATERAL public\.search_starter_entity_offer\(\s+candidates\.kind,\s+candidates\.key,\s+p_viewer_user_id\s+\) AS counted/g)).toHaveLength(2);
    expect(newestDefiner('search_starter_entity_offer')).toBe('20261113152020_search_starter_own_app_and_best_query.sql');
    // This week's creators: an account in good standing, not followed, not the viewer, neither side of a block.
    const creators = definition.slice(definition.indexOf("WHERE stats.subject = 'creator'"), definition.indexOf('LIMIT v_creator_limit'));
    for (const rule of [
      'AND stats.week_activity > 0',
      'AND stats.creator_user_id IS DISTINCT FROM p_viewer_user_id',
      'AND users.is_anonymous IS NOT TRUE',
      'AND (users.banned_until IS NULL OR users.banned_until <= now())',
      "AND profiles.identity_state = 'active'",
    ]) expect(creators, rule).toContain(rule);
    expect(creators).toMatch(/AND NOT EXISTS \(\s+SELECT 1\s+FROM public\.follows AS follows\s+WHERE follows\.follower_id = p_viewer_user_id\s+AND follows\.following_id = stats\.creator_user_id\s+\)/);
    expect(creators).toMatch(BLOCKED_BY_VIEWER('stats\\.creator_user_id'));
    expect(creators).toMatch(BLOCKS_VIEWER('stats\\.creator_user_id'));
  });

  it('offers a phrase only when two posts the viewer may see hold it, and fills with the hand-picked terms as before', () => {
    const searches = definition.slice(definition.indexOf('FOR v_phrase IN'));
    expect(searches).toMatch(/WHERE phrases\.in_text\s+AND NOT phrases\.is_name/);
    expect(searches).toContain('ORDER BY phrases.week_activity DESC, phrases.recent_weight DESC, phrases.phrase');
    expect(searches).toContain('CONTINUE WHEN NOT public.search_query_post_floor(v_phrase.phrase, p_viewer_user_id, c_post_floor);');
    expect(searches).toContain("CONTINUE WHEN string_to_array(v_phrase.core, ' ') && v_used_words;");
    expect(searches.match(/FROM public\.search_suggestion_denylist AS denied/g)).toHaveLength(2);
    // The hand-picked terms, read and checked as 20261113100423 read and checked them.
    expect(searches).toContain('CONTINUE WHEN NOT public.search_starter_term_finds_post(v_term_query, p_viewer_user_id);');
    expect(searches).toContain('EXIT WHEN v_offered >= least(c_search_rows, v_search_limit);');
    expect(definition).toContain('c_search_rows CONSTANT integer := 6;');
    // A list with a hand-picked term in it is never this week's.
    expect(searches).toMatch(/IF v_every_search_this_week AND v_offered >= least\(c_search_rows, v_search_limit\) THEN\s+v_searches_period := 'week';\s+ELSE/);
  });
});

describe('related searches', () => {
  it('reads each post of the page again as search reads one, and offers only kept phrases', () => {
    const definition = mine('search_related_searches');
    expect(definition).toMatch(/WHERE documents\.post_id = ANY \(p_post_ids\[1:c_posts\]\)\s+AND posts\.is_nsfw = false/);
    expect(definition).toMatch(BLOCKED_BY_VIEWER('documents\\.creator_user_id'));
    expect(definition).toMatch(BLOCKS_VIEWER('documents\\.creator_user_id'));
    expect(definition).toContain('CROSS JOIN LATERAL public.search_text_phrases(seen.search_text) AS grams');
    expect(definition).toContain('JOIN public.search_phrases AS phrases ON phrases.phrase = counted.phrase');
    expect(definition).toContain('HAVING count(*) >= c_min_posts');
    expect(definition).toContain('c_min_posts CONSTANT integer := 2;');
    // Never the query, its corrected reading, or a phrase that says nothing more.
    expect(definition).toContain('WHERE phrases.phrase <> v_query');
    expect(definition).toContain('AND phrases.phrase IS DISTINCT FROM v_corrected');
    expect(definition).toContain("AND NOT (string_to_array(phrases.phrase, ' ') <@ v_said)");
    expect(definition).toContain('FROM public.search_suggestion_denylist AS denied');
    expect(definition).toContain(`p_limit integer DEFAULT ${SEARCH_RELATED_SEARCHES_MAX}`);
    // A function of its own: post search is not read, and not changed.
    expect(definition).not.toContain('search_public_posts');
    expect(relationsOf(definition)).toEqual([
      'public.post_search_documents', 'public.post_search_entities', 'public.posts',
      'public.search_phrases', 'public.search_suggestion_denylist', 'public.user_blocks',
    ]);
  });

  it('is called by the service under its parameters’ names', () => {
    const header = /CREATE FUNCTION public\.search_related_searches\(([\s\S]*?)\)\s+RETURNS TABLE\(related text\)/.exec(statements);
    expect(header).not.toBeNull();
    const parameters = header![1].split(',').map((parameter) => parameter.trim().split(/\s+/)[0]);
    const service = source('src/lib/search-related-searches.ts');
    expect(Array.from(service.matchAll(/^\s+(p_\w+):/gm), (match) => match[1])).toEqual(parameters);
    expect(service).toContain(".rpc('search_related_searches', {");
    // The row's one column, as the service reads it.
    expect(service).toContain('(row as { related?: unknown } | null)?.related');
  });

  it('is rebuilt by the job that rebuilds the dictionary, as a call of its own', () => {
    const job = source('src/lib/search-dictionary.ts');
    expect(job.indexOf("client.rpc('rebuild_search_terms')")).toBeGreaterThan(0);
    expect(job.indexOf("client.rpc('rebuild_search_phrases')")).toBeGreaterThan(job.indexOf("client.rpc('rebuild_search_terms')"));
  });
});
