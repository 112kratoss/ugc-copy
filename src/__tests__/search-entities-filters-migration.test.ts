import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// What the migration does to real rows is held by
// supabase/tests/database/search_entities_filters.test.sql: which entities a
// post has, the counts a viewer gets, each filter before the limit, the
// corrected reading, the call of the app live during the release. This file
// holds the parts a later CREATE OR REPLACE could quietly undo: post search
// keeps every rule of the ranking migration, each filter sits in all three
// reads and ahead of the limit, a template result never gets a model, an
// entity is offered only by posts a viewer may see and counted as the search
// pressing it runs, nothing is kept of an entity beside its posts' rows, the
// table stays the backend's, and the release-window signature keeps its first
// eight parameters.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261112174210_search_entities_filters_corrected_reading.sql';
const migration = readFileSync(join(migrationsDirectory, MIGRATION), 'utf8');
const statements = migration.replace(/--.*$/gm, '');

const POSTS_SIGNATURE = 'public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz, text, text, boolean, boolean, boolean)';
const ENTITIES_SIGNATURE = 'public.search_public_entities(text, uuid, integer, text)';

/** `CREATE [OR REPLACE] FUNCTION public.<name>(` through its closing `$function$;`, comments left out. */
function definitionOf(name: string): string {
  const start = statements.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`));
  expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
  const end = statements.indexOf('\n$function$;', start);
  expect(end, `${name} has no closing $function$;`).toBeGreaterThan(start);
  return statements.slice(start, end);
}

/** The newest migration that defines `public.<name>`. */
function newestDefiner(name: string): string {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const definers = migrationNames.filter((file) => (
    pattern.test(readFileSync(join(migrationsDirectory, file), 'utf8').replace(/--.*$/gm, ''))
  ));
  return definers[definers.length - 1];
}

const BLOCKED_BY_VIEWER = /AND NOT EXISTS \(\s+SELECT 1\s+FROM public\.user_blocks AS blocks\s+WHERE blocks\.blocker_user_id = p_viewer_user_id\s+AND blocks\.blocked_user_id = (?:documents|members)\.creator_user_id\s+\)/g;
const BLOCKED_THE_VIEWER = /AND NOT EXISTS \(\s+SELECT 1\s+FROM public\.user_blocks AS blocks\s+WHERE blocks\.blocker_user_id = (?:documents|members)\.creator_user_id\s+AND blocks\.blocked_user_id = p_viewer_user_id\s+\)/g;

describe('search entities and filters migration', () => {
  it('runs after the ranking and typeahead migrations, as one transaction that gives up on a busy table', () => {
    expect(MIGRATION > '20261112103547').toBe(true);
    // The release applies migrations in stamp order and refuses a pending one
    // stamped at or before the newest applied: this file was re-stamped behind
    // the typeahead migration (20261112144018, #775), which reached main first.
    expect(MIGRATION > '20261112144018').toBe(true);
    expect(migrationNames.at(-1) >= MIGRATION).toBe(true);
    expect(statements.trim().startsWith("BEGIN;\nSET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(statements.trim().endsWith('COMMIT;')).toBe(true);
    for (const name of [
      'search_public_posts', 'search_public_entities', 'search_recipes_corrected_query',
      'refresh_post_search_entities', 'post_search_entity_rows', 'search_entity_key',
    ]) {
      expect(newestDefiner(name), name).toBe(MIGRATION);
    }
  });

  it('takes one lock, which searches read beside, and none on posts', () => {
    expect(statements.match(/LOCK TABLE [^;]+;/g)).toEqual([
      'LOCK TABLE public.post_search_documents IN SHARE ROW EXCLUSIVE MODE;',
    ]);
    expect(statements).not.toContain('ACCESS EXCLUSIVE');
    // The documents gain a trigger and nothing else: no column, no rewrite.
    expect(statements).not.toMatch(/ALTER TABLE public\.post_search_documents/);
    expect(statements.match(/CREATE (?:OR REPLACE )?TRIGGER \w+\s+AFTER \w+ ON public\.\w+/g)).toEqual([
      'CREATE TRIGGER post_search_documents_refresh_entities\nAFTER INSERT ON public.post_search_documents',
    ]);
    expect(statements).toMatch(
      /REFERENCING NEW TABLE AS new_documents\s+FOR EACH STATEMENT\s+EXECUTE FUNCTION public\.trg_refresh_post_search_entities\(\);/,
    );
  });

  it('re-creates nothing the ranking, recall and log migrations own but post search', () => {
    for (const name of [
      'search_post_score', 'search_creator_score', 'search_public_creators',
      'rebuild_search_terms', 'search_corrected_query', 'refresh_post_search_documents',
      'refresh_creator_search_documents', 'search_query_tsquery', 'search_split_terms', 'search_term_variants',
      'search_query_report', 'list_marketplace_resource_bundles', 'marketplace_search_texts_match',
      // The typeahead migration's (20261112144018), which this file applies after.
      'search_suggest_completions', 'search_suggest_creators', 'search_suggestions',
    ]) {
      expect(statements, name).not.toMatch(new RegExp(`FUNCTION public\\.${name}\\(`));
    }
    expect(statements).not.toMatch(/\bsearch_terms\b/);
    expect(statements).not.toContain('search_suggestion_denylist');
    expect(statements).not.toContain('creator_search_documents');
    // Each of those is still defined last where it was: nothing here shadows one.
    expect(newestDefiner('rebuild_search_terms')).toBe('20261112144018_search_suggestions_typeahead.sql');
    for (const name of ['search_suggest_completions', 'search_suggest_creators', 'search_suggestions']) {
      expect(newestDefiner(name), name).toBe('20261112144018_search_suggestions_typeahead.sql');
    }
    expect(newestDefiner('search_corrected_query')).toBe('20261111231942_recipe_search_recall_and_relevance.sql');
    expect(newestDefiner('refresh_post_search_documents')).toBe('20261111224010_search_recall_models_prefixes_stems_typos.sql');
  });

  it('keeps the call of the app live during the release resolving to one function', () => {
    // Dropped and re-created in this transaction: the eight parameters the
    // live app names first and in order, the new ones after them, each with a
    // default that changes nothing.
    expect(statements).toMatch(
      /DROP FUNCTION public\.search_public_posts\(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz\);\s+CREATE FUNCTION public\.search_public_posts\(\s+p_query text,\s+p_viewer_user_id uuid DEFAULT NULL,\s+p_after_score double precision DEFAULT NULL,\s+p_after_id uuid DEFAULT NULL,\s+p_limit integer DEFAULT 20,\s+p_as_of timestamptz DEFAULT NULL,\s+p_sort text DEFAULT 'top',\s+p_after_created_at timestamptz DEFAULT NULL,\s+p_made_with text DEFAULT NULL,\s+p_media_kind text DEFAULT NULL,\s+p_has_recipe boolean DEFAULT false,\s+p_followed_only boolean DEFAULT false,\s+p_correct boolean DEFAULT true\s+\)/,
    );
    // One drop and one create: never a second overload beside the first.
    expect(statements.match(/(?:DROP|CREATE(?: OR REPLACE)?) FUNCTION public\.search_public_posts\(/g))
      .toEqual(['DROP FUNCTION public.search_public_posts(', 'CREATE FUNCTION public.search_public_posts(']);
    // The four columns that app reads, in their places, and one more after them.
    expect(definitionOf('search_public_posts')).toMatch(
      /RETURNS TABLE\(\s+post_id uuid,\s+creator_user_id uuid,\s+search_score double precision,\s+created_at timestamptz,\s+corrected_query text\s+\)/,
    );
    // What the app sends now.
    const service = readFileSync(join(process.cwd(), 'src/lib/public-search-service.ts'), 'utf8');
    expect(service).toMatch(
      /rpc\('search_public_posts', \{\s+p_query: query,\s+p_viewer_user_id: viewerUserId,\s+p_after_score: after\?\.score \?\? null,\s+p_after_id: after\?\.id \?\? null,\s+p_limit: limit,\s+p_as_of: asOf\.toISOString\(\),\s+p_sort: sort,\s+p_after_created_at: after\?\.createdAt \?\? null,\s+p_made_with: filters\.madeWith,\s+p_media_kind: filters\.mediaKind,\s+p_has_recipe: filters\.hasRecipe,\s+p_followed_only: filters\.following,\s+p_correct: !exact,\s+\}\)/,
    );
    expect(service).toMatch(
      /rpc\('search_public_entities', \{\s+p_query: query,\s+p_viewer_user_id: viewerUserId,\s+p_limit: limit,\s+p_made_with: madeWith \?\? null,\s+\}\)/,
    );
    expect(service).toContain("rpc('search_recipes_corrected_query', { p_query: query })");
  });

  it('keeps the ranking migration’s rules in post search', () => {
    const definition = definitionOf('search_public_posts');
    expect(definition).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
    expect(definition).toContain('public.search_post_score(');
    expect(definition).toContain('ts_rank_cd(documents.search_vector, v_tsquery, 1 | 32)');
    expect(definition).toMatch(/documents\.tool_normalized = v_query\s+OR ts_filter\(documents\.search_vector, '\{a,c\}'\) @@ v_tsquery/);
    // One instant for every page, never now().
    expect(definition).toContain("v_as_of timestamptz := coalesce(p_as_of, date_trunc('day', now(), 'UTC'));");
    expect(definition).toContain('extract(epoch FROM (v_as_of - documents.created_at))');
    expect(definition.match(/\bnow\(\)/g)).toHaveLength(1);
    expect(definition).toMatch(/public\.search_post_score\(\s+shown\.title = v_query,\s+shown\.title LIKE v_like \|\| '%',/);
    expect(definition).toContain('ORDER BY scored.search_score DESC, scored.post_id ASC');
    // Latest: the same matches, keyset on created_at and id.
    expect(definition).toContain("IF v_sort NOT IN ('top', 'latest') THEN");
    expect(definition).toMatch(
      /p_after_created_at IS NULL\s+OR documents\.created_at < p_after_created_at\s+OR \(documents\.created_at = p_after_created_at AND documents\.post_id > p_after_id\)/,
    );
    expect(definition).toContain('ORDER BY documents.created_at DESC, documents.post_id ASC');
    // The label and both sides of a block: in the check that decides how a
    // query is read, the ranked search and Latest, each ahead of its limit.
    expect(definition.match(/posts\.is_nsfw = false/g)).toHaveLength(3);
    expect(definition.match(BLOCKED_BY_VIEWER)).toHaveLength(3);
    expect(definition.match(BLOCKED_THE_VIEWER)).toHaveLength(3);
    expect(definition.lastIndexOf('blocks.blocked_user_id = p_viewer_user_id')).toBeLessThan(definition.lastIndexOf('LIMIT p_limit'));
  });

  it('applies every filter in all three reads, ahead of the limit', () => {
    const definition = definitionOf('search_public_posts');
    const filters = [
      /AND \(p_media_kind IS NULL OR posts\.category = p_media_kind\)/g,
      /AND \(NOT v_has_recipe OR EXISTS \(\s+SELECT 1\s+FROM public\.post_resource_bundles AS recipes\s+WHERE recipes\.post_id = documents\.post_id\s+AND recipes\.status = 'published'\s+\)\)/g,
      /AND \(NOT v_followed_only OR EXISTS \(\s+SELECT 1\s+FROM public\.follows AS followed\s+WHERE followed\.follower_id = p_viewer_user_id\s+AND followed\.following_id = documents\.creator_user_id\s+\)\)/g,
      /AND \(v_entity_key IS NULL OR EXISTS \(\s+SELECT 1\s+FROM public\.post_search_entities AS members\s+WHERE members\.kind = v_entity_kind\s+AND members\.key = v_entity_key\s+AND members\.post_id = documents\.post_id\s+\)\)/g,
    ];
    for (const filter of filters) {
      // The decision of how the query is read, Latest, and the ranked search.
      expect(definition.match(filter), String(filter)).toHaveLength(3);
    }
    // The last filter of each search sits before that search's cut.
    const latestCut = definition.indexOf('ORDER BY documents.created_at DESC, documents.post_id ASC');
    const rankedCut = definition.indexOf('ORDER BY scored.search_score DESC, scored.post_id ASC');
    const filterPlaces = [...definition.matchAll(/members\.post_id = documents\.post_id/g)].map((found) => found.index);
    expect(filterPlaces).toHaveLength(3);
    expect(filterPlaces[1]).toBeLessThan(latestCut);
    expect(filterPlaces[2]).toBeGreaterThan(latestCut);
    expect(filterPlaces[2]).toBeLessThan(rankedCut);
    // A filter value outside what it may name is refused, never read as off.
    expect(definition).toContain("IF p_media_kind IS NOT NULL AND p_media_kind NOT IN ('image', 'video') THEN");
    expect(definition).toContain("IF v_entity_kind NOT IN ('model', 'tool') OR v_entity_key = '' THEN");
  });

  it('reads nothing a visitor cannot see', () => {
    const posts = definitionOf('search_public_posts');
    // The document alone carries a post's text; the post row gives counters,
    // the label and the kind its card is drawn as.
    expect(posts).not.toMatch(/\bposts\.(?:title|body|prompt|description)\b/);
    expect(posts.match(/\bposts\.\w+/g)?.filter((column, index, all) => all.indexOf(column) === index).sort()).toEqual([
      'posts.category', 'posts.comment_count', 'posts.id', 'posts.is_nsfw', 'posts.remix_count', 'posts.save_count',
    ]);
    for (const table of posts.match(/\bpublic\.[a-z_]+ AS\b/g) ?? []) {
      expect([
        'public.post_search_documents AS', 'public.posts AS', 'public.user_blocks AS',
        // A published recipe's existence (never its contents), a follow, and
        // the models and tools the post's page prints.
        'public.post_resource_bundles AS', 'public.follows AS', 'public.post_search_entities AS',
      ]).toContain(table);
    }
    // A recipe is read for whether a published one exists, by two columns.
    expect(posts.match(/\brecipes\.\w+/g)?.filter((column, index, all) => all.indexOf(column) === index).sort())
      .toEqual(['recipes.post_id', 'recipes.status']);
  });

  it('says how the query was read, and reads it as typed when asked', () => {
    const definition = definitionOf('search_public_posts');
    expect(definition).toContain('IF coalesce(p_correct, true) AND NOT EXISTS (');
    expect(definition).toContain('v_corrected := public.search_corrected_query(v_query);');
    expect(definition).toMatch(/v_query := v_corrected;\s+v_read_as := v_corrected;/);
    // On every row of either order, NULL while the query is read as typed.
    expect(definition.match(/v_read_as AS corrected_query/g)).toHaveLength(2);
    expect(definition).toContain('v_read_as text;');

    // The recipes' reading is the list's own test, with no filter, and the
    // recipes' dictionary.
    const recipes = definitionOf('search_recipes_corrected_query');
    expect(recipes).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
    expect(recipes).toContain('WHERE listings.listable');
    expect(recipes).toContain('search.search_vector @@ public.search_query_tsquery(v_query, true)');
    expect(recipes).toContain('v_corrected := public.search_corrected_query(v_query, true);');
    expect(recipes).toContain("v_query text := lower(btrim(coalesce(p_query, '')));");
  });

  it('never gives a template result a model, and keys an entity one way', () => {
    const rows = definitionOf('post_search_entity_rows');
    expect(rows).toMatch(
      /coalesce\(\s+generations\.template_run_id IS NOT NULL OR generations\.template_run_step_id IS NOT NULL,\s+false\s+\) AS is_template_result/,
    );
    // Both sources of a model, the Made with row and the creation, are closed to it.
    const modelBranches = rows.split("'model',").slice(1);
    expect(modelBranches).toHaveLength(2);
    for (const branch of modelBranches) {
      expect(branch.split('UNION ALL')[0]).toContain('WHERE NOT subjects.is_template_result');
    }
    // Only a post with a search document (public, unarchived, visible) has entities.
    expect(rows).toContain('FROM public.post_search_documents AS documents');
    expect(rows).toContain('WHERE documents.post_id = ANY (p_post_ids)');
    expect(rows.match(/public\.search_entity_key\(/g)).toHaveLength(4);
    expect(definitionOf('search_entity_key')).toContain("'[^[:alnum:].]+', '-', 'g'");
  });

  it('offers an entity only by posts the viewer may see, counted as the Posts search pressing it runs', () => {
    const entities = definitionOf('search_public_entities');
    expect(entities).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/);
    // Posts are searched from three characters, and an offer must lead to posts.
    expect(entities).toContain('IF char_length(v_query) < 3 OR char_length(v_query) > 100 THEN');
    // The posts of an offer are found by post search's own match: the block
    // search_public_posts holds three times, a fourth time here, the same text.
    const match = "posts.is_nsfw = false AND ( documents.search_vector @@ v_tsquery"
      + " OR documents.search_text ILIKE ('%' || v_like || '%')"
      + ' OR documents.title_normalized OPERATOR(extensions.%) v_query'
      + ' OR documents.tool_normalized OPERATOR(extensions.%) v_query )';
    const oneLine = (definition: string) => definition.replace(/\s+/g, ' ');
    expect(oneLine(entities).split(match)).toHaveLength(2);
    expect(oneLine(definitionOf('search_public_posts')).split(match)).toHaveLength(4);
    // And read as post search reads the query: stemmed for the documents, and the same escape.
    expect(entities).toContain('v_tsquery := public.search_query_tsquery(v_query, true);');
    expect(entities).toContain(String.raw`v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');`);
    // Both sides of a block, in the offer's count and in the count by key.
    expect(entities.match(BLOCKED_BY_VIEWER)).toHaveLength(2);
    expect(entities.match(BLOCKED_THE_VIEWER)).toHaveLength(2);
    expect(entities.match(/posts\.is_nsfw = false/g)).toHaveLength(2);
    // Offered only with a post to open, one of which names it as the query does (unstemmed).
    expect(entities).toContain('v_name_tsquery := public.search_query_tsquery(v_query, false);');
    expect(entities).toContain('members.name_vector @@ v_name_tsquery AS names_it');
    expect(entities).toMatch(/WHERE counted\.post_total > 0\s+AND counted\.named/);
    // The name shown is one those posts print: never a name read from anywhere else.
    expect(entities).toMatch(/SELECT\s+candidates\.kind,\s+candidates\.key,\s+counted\.label,/);
    expect(entities.match(/FROM seen AS printed\s+GROUP BY printed\.label/g)).toHaveLength(2);
    // Counted no further than the cap, so one entity every post has costs no more.
    expect(entities).toContain('c_count_cap CONSTANT integer := 1000;');
    expect(entities.match(/LIMIT c_count_cap \+ 1/g)).toHaveLength(2);
    // The posts' own rows, their documents, the label and the blocks: nothing else is read.
    for (const table of entities.match(/\bpublic\.[a-z_]+ AS\b/g) ?? []) {
      expect([
        'public.post_search_entities AS', 'public.post_search_documents AS', 'public.posts AS', 'public.user_blocks AS',
      ]).toContain(table);
    }
  });

  it('keeps nothing of an entity beside its posts’ rows, and writes no row two saves share', () => {
    // One table, keyed by the post: no list of names to outlive a post, and
    // nothing for two saves naming the same new tools to wait on each other for.
    expect(statements.match(/CREATE TABLE public\.\w+/g)).toEqual(['CREATE TABLE public.post_search_entities']);
    expect(statements).not.toContain('search_entity_labels');
    expect(statements).toMatch(
      /post_id uuid NOT NULL REFERENCES public\.post_search_documents\(post_id\) ON DELETE CASCADE,/,
    );
    expect(statements).toContain('PRIMARY KEY (kind, key, post_id)');
    const refresh = definitionOf('refresh_post_search_entities');
    expect(refresh.match(/\b(?:INSERT INTO|UPDATE|DELETE FROM) public\.\w+/g)).toEqual([
      'DELETE FROM public.post_search_entities', 'INSERT INTO public.post_search_entities',
    ]);
    expect(refresh).not.toContain('ON CONFLICT');
    expect(refresh).toContain('WHERE post_id = ANY (p_post_ids)');
    // The rows are worked out once per statement, by a function whose plan is kept.
    expect(refresh.match(/public\.post_search_entity_rows\(/g)).toHaveLength(1);
    expect(definitionOf('post_search_entity_rows')).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = ''/);
    // A row's own name and key are what a query is matched against.
    expect(statements).toMatch(
      /name_vector tsvector GENERATED ALWAYS AS \(\s+to_tsvector\(\s+'pg_catalog\.simple',\s+coalesce\(public\.search_term_variants\(label\), ''\) \|\| ' ' \|\| coalesce\(public\.search_term_variants\(key\), ''\)\s+\)\s+\) STORED,/,
    );
  });

  it('keeps the entity tables the backend’s and every function the service role’s', () => {
    for (const table of ['post_search_entities']) {
      expect(statements, table).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(statements, table).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(statements, table).toContain(`GRANT SELECT ON TABLE public.${table} TO service_role;`);
    }
    expect(statements).not.toMatch(/CREATE POLICY/);
    for (const signature of [POSTS_SIGNATURE, ENTITIES_SIGNATURE]) {
      expect(statements, signature).toContain(`REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated;`);
      expect(statements, signature).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    }
    for (const signature of [
      'public.search_recipes_corrected_query(text)', 'public.refresh_post_search_entities(uuid[])',
      'public.post_search_entity_rows(uuid[])', 'public.search_entity_key(text)',
    ]) {
      expect(statements, signature).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
      expect(statements, signature).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    }
    expect(statements).toMatch(
      /REVOKE ALL ON FUNCTION public\.trg_refresh_post_search_entities\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
    // The writers run with definer rights and an empty search path.
    for (const name of ['refresh_post_search_entities', 'trg_refresh_post_search_entities', 'post_search_entity_rows']) {
      expect(definitionOf(name), name).toMatch(/SECURITY DEFINER\s+SET search_path = ''/);
    }
  });

  it('adds only nullable columns to the search log', () => {
    const alter = /ALTER TABLE public\.search_query_events([\s\S]*?);/.exec(statements)?.[1] ?? '';
    expect(alter.match(/ADD COLUMN \w+/g)).toEqual([
      'ADD COLUMN made_with', 'ADD COLUMN media_kind', 'ADD COLUMN has_recipe',
      'ADD COLUMN followed_only', 'ADD COLUMN corrected',
    ]);
    expect(alter).not.toMatch(/NOT NULL|DEFAULT/);
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(2);
  });
});
