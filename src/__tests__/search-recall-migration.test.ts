import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// What the migration does to real rows is held by
// supabase/tests/database/search_recall.test.sql. This file holds the parts a
// later CREATE OR REPLACE could quietly undo: the document still reads a
// post's text as public reads show it, the searches still leave labelled
// posts out and stay the service role's, and the triggers that keep a
// document current are all there.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
// Version order: every name starts with its UTC stamp.
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();

function readMigration(suffix: string): string {
  const matches = migrationNames.filter((name) => name.endsWith(suffix));
  expect(matches, `${suffix} must exist exactly once`).toHaveLength(1);
  return readFileSync(join(migrationsDirectory, matches[0]), 'utf8');
}

/** The one `CREATE OR REPLACE FUNCTION public.<name>(` statement, through its closing `$function$;`. */
function functionDefinition(sql: string, name: string): string {
  const opener = `CREATE OR REPLACE FUNCTION public.${name}(`;
  expect(sql.split(opener), `${name} must be defined exactly once`).toHaveLength(2);
  const start = sql.indexOf(opener);
  const end = sql.indexOf('\n$function$;', start);
  expect(end, `${name} has no closing $function$;`).toBeGreaterThan(start);
  return sql.slice(start, end + '\n$function$;'.length);
}

/** The newest migration that defines `public.<name>`, and that definition. */
function newestDefinition(name: string): { file: string; definition: string } {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const definers = migrationNames.filter((file) => pattern.test(readFileSync(join(migrationsDirectory, file), 'utf8')));
  expect(definers.length, `${name} must be defined`).toBeGreaterThan(0);
  const file = definers[definers.length - 1];
  const sql = readFileSync(join(migrationsDirectory, file), 'utf8');
  const fromDefinition = sql.slice(sql.search(pattern));
  const closing = fromDefinition.search(/\n\$(?:function)?\$;/);
  expect(closing, `the newest definition of ${name} must close`).toBeGreaterThan(0);
  return { file, definition: fromDefinition.slice(0, closing) };
}

const migration = readMigration('_search_recall_models_prefixes_stems_typos.sql');

describe('search recall migration', () => {
  it('reads a query as typed and split, every word required and the last a prefix', () => {
    const split = functionDefinition(migration, 'search_split_terms');
    expect(split).toContain(String.raw`'([[:alpha:]])([[:digit:]])', '\1 \2', 'g'`);
    expect(split).toContain(String.raw`'([[:digit:]])([[:alpha:]])', '\1 \2', 'g'`);
    expect(split).toContain("'[^[:alnum:]]+', ' ', 'g'");

    const prefix = functionDefinition(migration, 'search_prefix_tsquery');
    expect(prefix).toContain('plainto_tsquery(p_config');
    expect(prefix).toContain("(parsed.query::text || ':*')::tsquery");
    // An empty query must stay empty: ':*' alone is not a tsquery.
    expect(prefix).toContain('WHEN numnode(parsed.query) = 0 THEN parsed.query');

    const query = functionDefinition(migration, 'search_query_tsquery');
    expect(query).toContain("public.search_prefix_tsquery('pg_catalog.simple', p_query)");
    expect(query).toContain("public.search_prefix_tsquery('pg_catalog.simple', public.search_split_terms(p_query))");
    expect(query).toContain("public.search_prefix_tsquery('pg_catalog.english', p_query)");
  });

  it('keeps the helpers off the client roles', () => {
    for (const signature of [
      'search_split_terms(text)',
      'search_term_variants(text)',
      'search_prefix_tsquery(regconfig, text)',
      'search_query_tsquery(text, boolean)',
      'search_corrected_query(text)',
      'rebuild_search_terms()',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
  });

  it('adds the creation’s model and every Made with name to the document', () => {
    const projection = functionDefinition(migration, 'refresh_post_search_documents');
    expect(projection).toContain('LEFT JOIN public.generations AS generations\n    ON generations.id = posts.generation_id');
    // As public reads name it (shownGenerationModel, src/lib/template-result.ts):
    // a template result's model is its author's and is never given out.
    expect(projection).toContain(
      '          SELECT CASE\n'
        + '            WHEN generations.template_run_id IS NOT NULL OR generations.template_run_step_id IS NOT NULL\n'
        + "              THEN 'template-workflow'\n"
        + '            ELSE lower(btrim(generations.model))\n'
        + '          END AS name',
    );
    // The only read of the creation's model.
    expect(projection.split('generations.model')).toHaveLength(2);
    for (const column of ['tool_label', 'tool_slug', 'model_label', 'model_slug']) {
      expect(projection).toContain(`lower(btrim(tools.${column}))`);
    }
    // A model weighs as the title does; a tool as it did.
    expect(projection).toContain("setweight(to_tsvector('pg_catalog.simple', coalesce(made_with.model_terms, '')), 'A')");
    expect(projection).toContain("concat_ws(' ', posts.source_tool, posts.source_tool_slug, made_with.tool_terms)\n      ), 'C')");
    // Eligibility is the 20260827110000 rule.
    expect(projection).toContain("posts.visibility = 'public'");
    expect(projection).toContain('posts.archived_at IS NULL');
    expect(projection).toContain("posts.review_status = 'visible'");
  });

  it('keeps the newest projection reading a post’s text as public reads show it', () => {
    // 20261101124828: the caption through recipe_post_public_body, the prompt
    // only without a published recipe. A projection copied from an older body
    // would index a paid recipe's setup and prompt again.
    const { file, definition } = newestDefinition('refresh_post_search_documents');
    expect(file).toMatch(/_search_recall_models_prefixes_stems_typos\.sql$/);
    const shownBody = 'public.recipe_post_public_body(posts.body, bundles.access_mode)';
    const shownPrompt = 'CASE WHEN bundles.id IS NULL THEN posts.prompt END';
    // Once in the text, once per configuration in the vector.
    expect(definition.split(shownBody)).toHaveLength(4);
    expect(definition.split(shownPrompt)).toHaveLength(4);
    // Every other read of the two columns would be the stored text.
    expect(definition.split('posts.body')).toHaveLength(4);
    expect(definition.split('posts.prompt')).toHaveLength(4);
    expect(definition).toContain("AND bundles.status = 'published'");
  });

  it('re-projects a document when its creation or its Made with changes', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE TRIGGER posts_refresh_public_search_document\n'
        + 'AFTER INSERT OR UPDATE OF\n'
        + '  title, body, prompt, source_tool, source_tool_slug, generation_id, visibility, archived_at, review_status\n'
        + 'ON public.posts\n'
        + 'FOR EACH ROW EXECUTE FUNCTION public.trg_refresh_post_search_document();',
    );
    for (const [event, tables] of [
      ['INSERT', 'REFERENCING NEW TABLE AS changed_rows'],
      ['UPDATE', 'REFERENCING OLD TABLE AS replaced_rows NEW TABLE AS changed_rows'],
      ['DELETE', 'REFERENCING OLD TABLE AS changed_rows'],
    ] as const) {
      expect(migration).toContain(
        `CREATE OR REPLACE TRIGGER post_source_tools_refresh_post_search_${event.toLowerCase()}\n`
          + `AFTER ${event} ON public.post_source_tools\n`
          + `${tables}\n`
          + 'FOR EACH STATEMENT\n'
          + 'EXECUTE FUNCTION public.trg_refresh_post_search_document_for_source_tools();',
      );
    }
    const trigger = functionDefinition(migration, 'trg_refresh_post_search_document_for_source_tools');
    expect(trigger).toContain('SECURITY DEFINER');
    expect(trigger).toContain("SET search_path = ''");
    // Locked before projecting, in id order, as the recipe trigger does.
    expect(trigger.indexOf('FOR NO KEY UPDATE')).toBeGreaterThan(0);
    expect(trigger.indexOf('FOR NO KEY UPDATE')).toBeLessThan(trigger.indexOf('PERFORM public.refresh_post_search_documents'));
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.trg_refresh_post_search_document_for_source_tools()\n'
        + '  FROM PUBLIC, anon, authenticated, service_role;',
    );
  });

  it('keeps a dictionary of the words unlabelled public posts show, closed to the client roles', () => {
    expect(migration).toContain(
      "CREATE TABLE public.search_terms (\n  term text PRIMARY KEY CHECK (term ~ '^[[:alpha:]]{4,40}$')\n);",
    );
    expect(migration).toContain('ON public.search_terms USING gin (term extensions.gin_trgm_ops);');
    expect(migration).toContain('ALTER TABLE public.search_terms ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('REVOKE ALL ON TABLE public.search_terms FROM PUBLIC, anon, authenticated;');

    // No post save writes the dictionary: two saves adding the same new words
    // in different statements could wait on each other in a ring.
    expect(newestDefinition('refresh_post_search_documents').definition).not.toContain('search_terms');

    // One job makes it exactly the words shown now, adding and removing.
    const rebuild = functionDefinition(migration, 'rebuild_search_terms');
    expect(rebuild).toContain('SECURITY DEFINER');
    expect(rebuild).toContain("SET search_path = ''");
    expect(rebuild).toContain("IF NOT pg_try_advisory_xact_lock(hashtext('public.rebuild_search_terms')) THEN");
    expect(rebuild).toContain('FROM public.post_search_documents AS documents');
    // A labelled post's words never become a correction.
    expect(rebuild).toContain('WHERE posts.is_nsfw = false');
    expect(rebuild).toContain("AND words.lexeme ~ '^[[:alpha:]]{4,40}$'");
    expect(rebuild).toContain('DELETE FROM public.search_terms AS terms\n    WHERE NOT EXISTS (SELECT 1 FROM shown WHERE shown.term = terms.term)');
    expect(rebuild).toContain('ON CONFLICT (term) DO NOTHING');
  });

  it('corrects only a word that is letters, starts no known word and has a near neighbour', () => {
    const corrected = functionDefinition(migration, 'search_corrected_query');
    expect(corrected).toContain("WHERE words.word ~ '^[[:alpha:]]{4,40}$'");
    expect(corrected).toContain("WHERE known.term LIKE words.word || '%'");
    expect(corrected).toContain('AND terms.term OPERATOR(extensions.%) words.word');
    expect(corrected).toContain('AND extensions.similarity(terms.term, words.word) >= 0.35');
    expect(corrected).toContain('AND left(terms.term, 1) = left(words.word, 1)');
    expect(corrected).toContain('AND abs(char_length(terms.term) - char_length(words.word)) <= 2');
    expect(corrected).toContain('ORDER BY extensions.similarity(terms.term, words.word) DESC, terms.term');
  });

  it('matches posts on the new query, labelled posts still left out, and corrects a query nothing holds', () => {
    // Re-created since by the ranking migration (20261112103547: tiers, an
    // instant, Latest, blocks) and by the entities and filters migration
    // (20261112143757: filters, the corrected reading), which must keep every
    // rule below.
    const { file, definition } = newestDefinition('search_public_posts');
    expect(file).toMatch(/_search_entities_filters_corrected_reading\.sql$/);
    expect(definition).toContain('v_tsquery := public.search_query_tsquery(v_query, true);');
    const match = '    WHERE posts.is_nsfw = false\n'
      + '      AND (\n'
      + '        documents.search_vector @@ v_tsquery\n'
      + "        OR documents.search_text ILIKE ('%' || v_like || '%')\n"
      + '        OR documents.title_normalized OPERATOR(extensions.%) v_query\n'
      + '        OR documents.tool_normalized OPERATOR(extensions.%) v_query\n'
      + '      )\n';
    // Three times, the same: once to ask whether any post holds the query as
    // typed (label included, so a labelled post never decides how a query is
    // read), once to search by score and once to search newest first.
    expect(definition.split(match)).toHaveLength(4);
    // Decided once, ahead of both searches, unless the request reads the query as typed.
    const decision = definition.indexOf('IF coalesce(p_correct, true) AND NOT EXISTS (');
    expect(decision).toBeGreaterThan(0);
    expect(decision).toBeLessThan(definition.indexOf('RETURN QUERY'));
    expect(definition).not.toMatch(/\bIF NOT EXISTS \(/);
    expect(definition).toContain('v_corrected := public.search_corrected_query(v_query);');
    expect(definition).toContain(
      'IF v_corrected IS NOT NULL AND v_corrected <> v_query AND char_length(v_corrected) BETWEEN 3 AND 100 THEN',
    );
    // Every document is matched through an index: nothing reads each text.
    expect(definition).not.toContain('word_similarity');
    // The keyset and the limits of 20260827110000.
    expect(definition).toContain('ORDER BY scored.search_score DESC, scored.post_id ASC');
    // A query outside the limits finds nothing: the route refuses one first,
    // and a character the two count differently must not be a 500.
    expect(definition).toContain('IF char_length(v_query) < 3 OR char_length(v_query) > 100 THEN\n    RETURN;\n  END IF;');
    expect(definition).not.toContain('Post search query must contain');
    expect(definition).toContain('Post search limit must be between 1 and 25');
    // Set again for a corrected query.
    expect(definition.split(String.raw`v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');`)).toHaveLength(3);
    expect(definition).not.toContain('plainto_tsquery');
  });

  it('matches creators on the new query, unstemmed, and on a misspelt name', () => {
    const { file, definition } = newestDefinition('search_public_creators');
    expect(file).toMatch(/_search_ranking_tiers_decay_latest\.sql$/);
    expect(definition).toContain('v_tsquery := public.search_query_tsquery(v_query, false);');
    expect(definition).toContain('OR documents.search_vector @@ v_tsquery');
    expect(definition).toContain('OR v_query OPERATOR(extensions.<%) documents.username_normalized');
    expect(definition).toContain('OR v_query OPERATOR(extensions.<%) documents.display_name_normalized');
    expect(definition).toContain('ORDER BY scored.search_score DESC, scored.creator_user_id ASC');
    expect(definition).toContain('IF char_length(v_query) < 2 OR char_length(v_query) > 100 THEN\n    RETURN;\n  END IF;');
    expect(definition).not.toContain('Creator search query must contain');
    expect(definition).not.toContain('plainto_tsquery');
  });

  it('keeps both searches callable only by the service role', () => {
    for (const name of ['search_public_creators', 'search_public_posts']) {
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.${name}(text, uuid, double precision, uuid, integer)\n`
          + '  FROM PUBLIC, anon, authenticated;',
      );
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION public.${name}(text, uuid, double precision, uuid, integer)\n`
          + '  TO service_role;',
      );
      const definition = functionDefinition(migration, name);
      expect(definition).toContain('SECURITY DEFINER');
      expect(definition).toContain("SET search_path TO 'public', 'pg_temp'");
    }
  });

  it('runs as one transaction that gives up on a busy table, and re-projects every document last', () => {
    const statements = migration.replace(/^--.*$/gm, '').trim();
    expect(statements.startsWith("BEGIN;\nSET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(statements.endsWith('COMMIT;')).toBe(true);
    // Made with first, as its save takes them; then posts and the recipes, as
    // 20261101124828 took them. The recipes are locked because their trigger
    // projects the same documents the last statement does.
    const locks = ['post_source_tools', 'posts', 'post_resource_bundles']
      .map((table) => migration.indexOf(`LOCK TABLE public.${table} IN SHARE ROW EXCLUSIVE MODE;`));
    expect(locks.every((position) => position > 0)).toBe(true);
    expect(locks).toEqual([...locks].sort((left, right) => left - right));
    // DROP TRIGGER takes ACCESS EXCLUSIVE, which stops the feed's reads of posts.
    expect(statements).not.toMatch(/DROP\s+TRIGGER/i);
    const backfill = migration.lastIndexOf('SELECT public.refresh_post_search_documents(ARRAY(');
    expect(backfill).toBeGreaterThan(migration.lastIndexOf('$function$;'));
    const dictionary = migration.lastIndexOf('SELECT * FROM public.rebuild_search_terms();');
    expect(dictionary).toBeGreaterThan(backfill);
    expect(dictionary).toBeLessThan(migration.lastIndexOf('COMMIT;'));
  });
});
