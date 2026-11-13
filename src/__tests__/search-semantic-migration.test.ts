import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { OPERATIONAL_TABLE_ROW_BUDGETS } from '@/lib/operational-table-growth';

// What the migration does to real rows is held by
// supabase/tests/database/search_related_posts.test.sql: the text that is
// embedded, who is left out, the cache and its daily count. This file holds
// the parts a later CREATE OR REPLACE or a careless edit could quietly undo:
// the embedded text is the search document's and nothing else, a vector is
// read only against the hash of the text the post shows now, the rules are
// search_public_posts's own, the read never goes through the HNSW index, no
// post save writes here, a post with no words of its own gets no vector, the
// growth accounting counts the tables, and everything stays the service role's.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261112215420_search_semantic_related_posts.sql';
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, '');
const migration = readFileSync(join(migrationsDirectory, MIGRATION), 'utf8');
const statements = withoutComments(migration);

const HASH_OF_DOCUMENT = "encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex')";

const FUNCTIONS = [
  'public.list_posts_pending_search_embedding(text, integer)',
  'public.post_search_embedding_texts(uuid[], text)',
  'public.store_post_search_embeddings(jsonb, text)',
  'public.post_search_document_has_own_words(text, tsvector)',
  'public.search_query_embedding(text, text)',
  'public.reserve_search_query_embedding(integer)',
  'public.release_search_query_embedding(integer)',
  'public.store_search_query_embedding(text, text, extensions.vector)',
  'public.prune_search_embeddings(integer)',
  'public.search_embedding_backlog(text)',
  'public.search_related_posts(extensions.vector, uuid, uuid[], integer, text)',
] as const;

const TABLES = [
  'public.post_search_embeddings',
  'public.search_query_embeddings',
  'public.search_query_embedding_days',
] as const;

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

/** The tables a definition reads or writes, schema included. */
function relationsOf(definition: string): string[] {
  return Array.from(new Set(
    Array.from(definition.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(public\.\w+)(?!\()/g), (match) => match[1]),
  )).sort();
}

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('semantic search migration', () => {
  it('runs after the entities migration, as one transaction that gives up on a busy table', () => {
    expect(migrationNames.indexOf('20261112174210_search_entities_filters_corrected_reading.sql')).toBeGreaterThanOrEqual(0);
    expect(migrationNames.indexOf(MIGRATION)).toBeGreaterThan(
      migrationNames.indexOf('20261112174210_search_entities_filters_corrected_reading.sql'),
    );
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    expect(statements.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(statements.match(/\bCOMMIT;/g)).toHaveLength(1);
    expect(statements.trim()).toMatch(/COMMIT;$/);
  });

  it('adds no trigger, locks no table by name, and writes no row of posts or their documents', () => {
    // A post save costs what it cost before: nothing here runs inside one.
    expect(statements).not.toMatch(/CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER/i);
    expect(statements).not.toMatch(/\bLOCK TABLE\b/i);
    expect(statements).not.toMatch(/\bDROP\s+(?:TRIGGER|FUNCTION|INDEX|TABLE|COLUMN)\b/i);
    expect(statements).not.toMatch(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.(?:posts|post_search_documents)\b/i);
    // No backfill in the release: the job fills the table.
    expect(statements).not.toMatch(/^\s*SELECT\s+public\./m);
  });

  it('leaves search itself, its documents and the feed’s embeddings alone', () => {
    for (const notThisFiles of [
      'search_public_posts', 'search_public_creators', 'search_public_entities', 'search_post_score',
      'search_creator_score', 'search_corrected_query', 'refresh_post_search_documents', 'rebuild_search_terms',
      'match_post_content_embeddings', 'list_posts_pending_embedding', 'search_query_report',
      'prune_operational_backend_data', 'marketplace_text_is_placeholder', 'recipe_post_public_body',
    ]) {
      expect(statements, notThisFiles).not.toMatch(new RegExp(`FUNCTION public\\.${notThisFiles}\\(`));
    }
    // Named in a comment on the new table, for the reader; never read or written.
    expect(statements).not.toContain('public.post_content_embeddings');
    expect(statements).not.toContain('public.search_terms');
  });

  it('declares the vector as the feed does, 384 dimensions in the extensions schema, and builds no index nothing would read', () => {
    expect(statements).toContain("IF to_regtype('extensions.vector') IS NULL THEN");
    expect(collapse(statements)).toContain(collapse(`
      CREATE TABLE public.post_search_embeddings (
        post_id uuid PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
        embedding_model text NOT NULL CHECK (char_length(embedding_model) BETWEEN 1 AND 160),
        content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        embedding extensions.vector(384) NOT NULL,
        embedded_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );`));
    // The read measures every vector (below), so an HNSW index would only be
    // paid for on every re-embed. The one index of the file is the cache's age.
    expect(statements).not.toMatch(/USING\s+(?:hnsw|ivfflat)/i);
    expect(statements.match(/CREATE (?:UNIQUE )?INDEX/g)).toHaveLength(1);
    expect(collapse(statements)).toContain(
      'CREATE INDEX search_query_embeddings_created_at_idx ON public.search_query_embeddings (created_at);',
    );
    // The query cache is keyed by a hash, and holds no column a query's text could sit in.
    expect(collapse(statements)).toContain(collapse(`
      CREATE TABLE public.search_query_embeddings (
        query_hash text PRIMARY KEY CHECK (query_hash ~ '^[0-9a-f]{64}$'),
        embedding_model text NOT NULL CHECK (char_length(embedding_model) BETWEEN 1 AND 160),
        embedding extensions.vector(384) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );`));
  });

  it('keeps every table and function the service role’s alone, the tables read-only to it', () => {
    for (const table of TABLES) {
      expect(statements).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(statements).toContain(`REVOKE ALL ON TABLE ${table} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(statements).toContain(`GRANT SELECT ON TABLE ${table} TO service_role;`);
    }
    expect(statements).not.toMatch(/CREATE POLICY/i);
    expect(statements).not.toMatch(/GRANT\s+(?!SELECT ON TABLE|EXECUTE ON FUNCTION)/);
    expect(statements).not.toMatch(/TO\s+(?:anon|authenticated|PUBLIC)\b/);
    for (const signature of FUNCTIONS) {
      expect(statements).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
      expect(statements).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    }
    // Every function of its own: an empty search path, every name qualified;
    // a definer but for the rule, which reads only what it is handed.
    const created = statements.match(/CREATE FUNCTION public\.\w+\(/g) ?? [];
    expect(created).toHaveLength(FUNCTIONS.length);
    expect(statements.match(/SET search_path = ''\s+AS \$function\$/g)).toHaveLength(FUNCTIONS.length);
    expect(statements.match(/SECURITY DEFINER\s+SET search_path = ''\s+AS \$function\$/g)).toHaveLength(FUNCTIONS.length - 1);
    expect(statements).not.toMatch(/SET search_path TO/);
    expect(statements).not.toContain('hnsw.');
  });

  it('hands the embedder the search document’s text, and no column of the post but its label', () => {
    const { file, definition } = newestDefinition('post_search_embedding_texts');
    expect(file).toBe(MIGRATION);
    expect(relationsOf(definition)).toEqual([
      'public.post_search_documents', 'public.post_search_embeddings', 'public.posts',
    ]);
    // The one text a post is embedded from, cut, and the hash of the whole of it.
    expect(definition).toContain('left(documents.search_text, 2000) AS embedding_text');
    expect(definition).toContain(`${HASH_OF_DOCUMENT} AS content_hash`);
    // posts is read for the label and nothing else: never a title, body or prompt.
    expect(Array.from(definition.matchAll(/\bposts\.(\w+)/g), (match) => match[1]).sort()).toEqual(['id', 'is_nsfw']);
    expect(definition).toContain('posts.is_nsfw = false');
    expect(definition).not.toMatch(/\b(?:prompt|body|title|description)\b/);
    // And only for a post whose public text has words of its own.
    expect(definition).toContain('public.post_search_document_has_own_words(documents.title_normalized, documents.search_vector)');
    expect(definition).not.toContain('post_resource_bundles');
    expect(definition).not.toContain('generations');
  });

  it('lists and stores only for posts search could return, a vector only under the hash of the text shown now', () => {
    const pending = newestDefinition('list_posts_pending_search_embedding').definition;
    expect(relationsOf(pending)).toEqual([
      'public.post_search_documents', 'public.post_search_embeddings', 'public.posts',
    ]);
    expect(pending).toContain('posts.is_nsfw = false');
    expect(pending).toContain(`embeddings.content_hash <> ${HASH_OF_DOCUMENT}`);
    // The rule is asked of the candidates, a materialised few, never of every document.
    expect(pending).toContain('WITH candidates AS MATERIALIZED (');
    expect(pending.slice(pending.indexOf('FROM candidates'))).toContain(
      'public.post_search_document_has_own_words(candidates.title_normalized, candidates.search_vector)',
    );
    expect(pending).toContain('ORDER BY candidates.created_at DESC, candidates.post_id ASC');

    const store = newestDefinition('store_post_search_embeddings').definition;
    expect(relationsOf(store)).toEqual([
      'public.post_search_documents', 'public.post_search_embeddings', 'public.posts',
    ]);
    expect(store).toContain('posts.is_nsfw = false');
    expect(store).toContain(`incoming.content_hash = ${HASH_OF_DOCUMENT}`);
    expect(store).toContain('public.post_search_document_has_own_words(documents.title_normalized, documents.search_vector)');
    expect(store).toContain('incoming.embedding::extensions.vector(384)');
  });

  it('says a post has words of its own from its search document alone: its title, or a word of public caption or prompt', () => {
    const { file, definition } = newestDefinition('post_search_document_has_own_words');
    expect(file).toBe(MIGRATION);
    // Two columns of the public projection are its whole input: no table is
    // read, so a paid recipe's hidden caption cannot count as a caption.
    expect(definition).toContain('p_title_normalized text,');
    expect(definition).toContain('p_search_vector tsvector');
    expect(relationsOf(definition)).toEqual([]);
    expect(collapse(definition)).toContain(collapse(`
      SELECT coalesce(length(ts_filter(p_search_vector, '{b}')) > 0, false)
        OR NOT public.marketplace_text_is_placeholder(p_title_normalized);`));
    // B is the caption as public reads show it and the prompt no recipe covers
    // (20261111224010); the title and model names are A, the tool names C.
    const projection = newestDefinition('refresh_post_search_documents').definition;
    expect(projection).toContain(
      "setweight(to_tsvector('pg_catalog.simple', coalesce(public.recipe_post_public_body(posts.body, bundles.access_mode), '')), 'B')",
    );
    expect(projection).toContain(
      "setweight(to_tsvector('pg_catalog.simple', coalesce(CASE WHEN bundles.id IS NULL THEN posts.prompt END, '')), 'B')",
    );
    expect(Array.from(projection.matchAll(/'([ABCD])'\)?,?\s*$/gm), (match) => match[1]).filter((weight) => weight === 'B'))
      .toHaveLength(4);
    // The placeholder rule is the product's own, held to its word lists elsewhere.
    expect(newestDefinition('marketplace_text_is_placeholder').file).toBe('20261025094552_marketplace_placeholder_text_all_words.sql');
  });

  it('reads a related post by search_public_posts’s rules, before the limit, on a vector of its current text', () => {
    const { file, definition } = newestDefinition('search_related_posts');
    expect(file).toBe(MIGRATION);
    expect(relationsOf(definition)).toEqual([
      'public.post_search_documents', 'public.post_search_embeddings', 'public.posts', 'public.user_blocks',
    ]);

    // The constants, named, in the one place the header says they are.
    expect(definition).toContain('c_min_similarity CONSTANT double precision := 0.84;');
    expect(definition).toContain('c_max_limit CONSTANT integer := 12;');
    expect(definition).toContain('v_max_distance CONSTANT double precision := 1.0 - c_min_similarity;');
    expect(migration).toContain('--        c_min_similarity  0.84 ');
    expect(migration).toContain('--        c_max_limit       12 ');

    const rules = definition.slice(definition.indexOf('FROM near'));
    const limit = rules.indexOf('LIMIT p_limit');
    expect(limit).toBeGreaterThan(0);
    const beforeLimit = rules.slice(0, limit);
    // A document (public, unarchived, visible) and no label: search_public_posts's own two conditions.
    expect(beforeLimit).toContain('JOIN public.post_search_documents AS documents ON documents.post_id = near.post_id');
    expect(beforeLimit).toContain('JOIN public.posts AS posts ON posts.id = documents.post_id');
    expect(beforeLimit).toContain('posts.is_nsfw = false');
    // The vector is of the text the post shows at this instant.
    expect(beforeLimit).toContain(`near.content_hash = ${HASH_OF_DOCUMENT}`);
    expect(beforeLimit).toContain('NOT (near.post_id = ANY (v_exclude))');
    // Both sides of a block, in the words search_public_posts uses.
    const postSearch = newestDefinition('search_public_posts').definition;
    for (const block of [
      `NOT EXISTS (
        SELECT 1 FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = p_viewer_user_id AND blocks.blocked_user_id = documents.creator_user_id )`,
      `NOT EXISTS (
        SELECT 1 FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = documents.creator_user_id AND blocks.blocked_user_id = p_viewer_user_id )`,
    ]) {
      expect(collapse(beforeLimit)).toContain(collapse(block));
      expect(collapse(postSearch)).toContain(collapse(block));
    }
    expect(collapse(postSearch)).toContain('WHERE posts.is_nsfw = false');
    expect(beforeLimit).toContain('ORDER BY near.distance ASC, near.post_id ASC');
  });

  it('measures every vector: the read never goes through the HNSW index', () => {
    const { definition } = newestDefinition('search_related_posts');
    const near = definition.slice(definition.indexOf('WITH near AS MATERIALIZED ('), definition.indexOf('FROM near'));
    expect(near.length).toBeGreaterThan(0);
    // An index scan returns its nearest rows whatever the rules then make of
    // them. A distance in WHERE with no ORDER BY in the same step is a read
    // of the whole table.
    expect(near).toContain('(embeddings.embedding OPERATOR(extensions.<=>) p_query_embedding) <= v_max_distance');
    expect(near).toContain('embeddings.embedding_model = p_embedding_model');
    expect(near).not.toMatch(/ORDER BY|LIMIT/);
    expect(definition.match(/ORDER BY/g)).toHaveLength(1);
    expect(definition.match(/\bLIMIT\b/g)).toHaveLength(1);
    expect(definition).not.toMatch(/set_config|iterative_scan|ef_search/);
  });

  it('reads the cache without counting, and counts a new query embedding in one statement under a ceiling no caller can raise', () => {
    const cache = newestDefinition('search_query_embedding').definition;
    expect(relationsOf(cache)).toEqual(['public.search_query_embeddings']);
    // Reads only: a cache hit spends nothing, of the day or of anybody's allowance.
    expect(cache).toMatch(/LANGUAGE plpgsql\s+STABLE/);
    expect(cache).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);

    const { definition } = newestDefinition('reserve_search_query_embedding');
    expect(relationsOf(definition)).toEqual(['public.search_query_embedding_days']);
    expect(definition).toContain('c_daily_cap_ceiling CONSTANT integer := 5000;');
    expect(definition).toContain('v_cap integer := least(greatest(coalesce(p_daily_cap, 0), 0), c_daily_cap_ceiling);');
    expect(collapse(definition)).toContain(collapse(`
      INSERT INTO public.search_query_embedding_days AS days (day, requested)
      VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT ON CONSTRAINT search_query_embedding_days_pkey DO UPDATE
        SET requested = days.requested + 1
        WHERE days.requested < v_cap;
      RETURN FOUND;`));

    // A place is given back in one statement too: never below zero, and never
    // more of them a day than the same clamped cap, so a failing function is
    // asked at most twice the cap of times.
    const release = newestDefinition('release_search_query_embedding').definition;
    expect(relationsOf(release)).toEqual(['public.search_query_embedding_days']);
    expect(release).toContain('c_daily_cap_ceiling CONSTANT integer := 5000;');
    expect(release).toContain('v_cap integer := least(greatest(coalesce(p_daily_cap, 0), 0), c_daily_cap_ceiling);');
    expect(collapse(release)).toContain(collapse(`
      UPDATE public.search_query_embedding_days AS days
      SET requested = days.requested - 1,
          released = days.released + 1
      WHERE days.day = (now() AT TIME ZONE 'UTC')::date
        AND days.requested > 0
        AND days.released < v_cap;
      RETURN FOUND;`));
    expect(release).not.toMatch(/\b(?:INSERT|DELETE)\b/);
    expect(statements).toContain('released integer NOT NULL DEFAULT 0 CHECK (released >= 0)');
    // The cache and the prune agree on how long a vector lives: a week.
    const prune = newestDefinition('prune_search_embeddings').definition;
    const backlog = newestDefinition('search_embedding_backlog').definition;
    for (const body of [cache, prune, backlog]) {
      expect(body).toContain("c_retention CONSTANT interval := interval '7 days';");
    }
    expect(statements).not.toContain("interval '30 days'");
    expect(cache).toContain('cached.created_at > now() - c_retention');
    expect(prune).toContain('cached.created_at <= now() - c_retention');
  });

  it('prunes only the vectors of posts search can no longer return, or whose text lost its own words', () => {
    const { definition } = newestDefinition('prune_search_embeddings');
    const gone = collapse(`
      FROM public.post_search_embeddings AS embeddings
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.post_search_documents AS documents
        JOIN public.posts AS posts ON posts.id = documents.post_id
        WHERE documents.post_id = embeddings.post_id
          AND posts.is_nsfw = false
          AND (
            embeddings.content_hash = ${HASH_OF_DOCUMENT}
            OR public.post_search_document_has_own_words(documents.title_normalized, documents.search_vector)
          )
      )`);
    expect(collapse(definition)).toContain(`${gone} LIMIT p_limit`);
    // The job is told of the same rows.
    expect(collapse(newestDefinition('search_embedding_backlog').definition)).toContain(gone);
  });

  it('adds the two tables that grow to the growth accounting, each with a budget, and drops none it counted', () => {
    const { file, definition } = newestDefinition('get_operational_table_growth');
    expect(file).toBe(MIGRATION);
    const before = withoutComments(readFileSync(join(migrationsDirectory, '20261112084002_search_query_events.sql'), 'utf8'));
    const previous = before.slice(before.search(/CREATE OR REPLACE FUNCTION public\.get_operational_table_growth\(/));
    const tablesOf = (sql: string) => Array.from(
      sql.slice(sql.indexOf('ANY (ARRAY['), sql.indexOf('])')).matchAll(/'(\w+)'/g), (match) => match[1],
    );
    const added = ['post_search_embeddings', 'search_query_embeddings'];
    expect(tablesOf(definition)).toEqual([...tablesOf(previous), ...added].sort());
    expect(tablesOf(previous)).toHaveLength(27);
    // But for those two lines the definition is the one it replaces.
    const withoutAdded = definition.replace(/\n\s+'(?:post_search_embeddings|search_query_embeddings)',/g, '');
    expect(collapse(withoutAdded)).toBe(collapse(previous.slice(0, previous.search(/\n\$function\$;/))));
    for (const table of added) {
      expect(OPERATIONAL_TABLE_ROW_BUDGETS[table], table).toBeDefined();
    }
    // The cache's budget sits between what the code's cap and the database's ceiling allow in a week.
    expect(OPERATIONAL_TABLE_ROW_BUDGETS.search_query_embeddings.warning).toBeGreaterThanOrEqual(2_000 * 7);
    expect(OPERATIONAL_TABLE_ROW_BUDGETS.search_query_embeddings.degraded).toBeGreaterThanOrEqual(5_000 * 7);
    expect(statements).toContain('REVOKE ALL ON FUNCTION public.get_operational_table_growth()\n  FROM PUBLIC, anon, authenticated;');
    expect(statements).toContain('GRANT EXECUTE ON FUNCTION public.get_operational_table_growth()\n  TO service_role;');
  });

  it('adds one nullable column to the search log and leaves its report alone', () => {
    expect(collapse(statements)).toContain(collapse(`
      ALTER TABLE public.search_query_events
        ADD COLUMN related_count integer CHECK (related_count IS NULL OR related_count BETWEEN 0 AND 24);`));
    expect(statements.match(/ALTER TABLE public\.search_query_events/g)).toHaveLength(1);
    expect(newestDefinition('search_query_report').file).toBe('20261112084002_search_query_events.sql');
  });
});
