import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// What the migration does to real rows is held by
// supabase/tests/database/search_related_posts.test.sql: the text that is
// embedded, who is left out, the cache and its daily count. This file holds
// the parts a later CREATE OR REPLACE or a careless edit could quietly undo:
// the embedded text is the search document's and nothing else, a vector is
// read only against the hash of the text the post shows now, the rules are
// search_public_posts's own, the read never goes through the HNSW index, no
// post save writes here, and everything stays the service role's.

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
  'public.search_query_embedding_lookup(text, text, integer)',
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
      'prune_operational_backend_data',
    ]) {
      expect(statements, notThisFiles).not.toMatch(new RegExp(`FUNCTION public\\.${notThisFiles}\\(`));
    }
    // Named in a comment on the new table, for the reader; never read or written.
    expect(statements).not.toContain('public.post_content_embeddings');
    expect(statements).not.toContain('public.search_terms');
  });

  it('declares the vector as the feed does: 384 dimensions in the extensions schema, cosine HNSW', () => {
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
    expect(collapse(statements)).toContain(
      'CREATE INDEX post_search_embeddings_embedding_hnsw_idx ON public.post_search_embeddings USING hnsw (embedding extensions.vector_cosine_ops);',
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
    // Every function: a definer with an empty search path, every name qualified.
    const created = statements.match(/CREATE FUNCTION public\.\w+\(/g) ?? [];
    expect(created).toHaveLength(FUNCTIONS.length);
    expect(statements.match(/SECURITY DEFINER\s+SET search_path = ''\s+AS \$function\$/g)).toHaveLength(FUNCTIONS.length);
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
    expect(pending).toContain('ORDER BY documents.created_at DESC, documents.post_id ASC');

    const store = newestDefinition('store_post_search_embeddings').definition;
    expect(relationsOf(store)).toEqual([
      'public.post_search_documents', 'public.post_search_embeddings', 'public.posts',
    ]);
    expect(store).toContain('posts.is_nsfw = false');
    expect(store).toContain(`incoming.content_hash = ${HASH_OF_DOCUMENT}`);
    expect(store).toContain('incoming.embedding::extensions.vector(384)');
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

  it('counts a new query embedding in one statement, under a ceiling no caller can raise', () => {
    const { definition } = newestDefinition('search_query_embedding_lookup');
    expect(relationsOf(definition)).toEqual([
      'public.search_query_embedding_days', 'public.search_query_embeddings',
    ]);
    expect(definition).toContain('c_daily_cap_ceiling CONSTANT integer := 5000;');
    expect(definition).toContain('v_cap integer := least(greatest(coalesce(p_daily_cap, 0), 0), c_daily_cap_ceiling);');
    expect(collapse(definition)).toContain(collapse(`
      INSERT INTO public.search_query_embedding_days AS days (day, requested)
      VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT ON CONSTRAINT search_query_embedding_days_pkey DO UPDATE
        SET requested = days.requested + 1
        WHERE days.requested < v_cap;
      v_reserved := FOUND;`));
    // The lookup and the prune agree on how long a cached vector lives.
    const prune = newestDefinition('prune_search_embeddings').definition;
    const backlog = newestDefinition('search_embedding_backlog').definition;
    for (const body of [definition, prune, backlog]) {
      expect(body).toContain("c_retention CONSTANT interval := interval '30 days';");
    }
    expect(definition).toContain('cached.created_at > now() - c_retention');
    expect(prune).toContain('cached.created_at <= now() - c_retention');
  });

  it('prunes only the vectors of posts search can no longer return', () => {
    const { definition } = newestDefinition('prune_search_embeddings');
    expect(collapse(definition)).toContain(collapse(`
      FROM public.post_search_embeddings AS embeddings
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.post_search_documents AS documents
        JOIN public.posts AS posts ON posts.id = documents.post_id
        WHERE documents.post_id = embeddings.post_id
          AND posts.is_nsfw = false
      )
      LIMIT p_limit`));
  });

  it('adds one nullable column to the search log and leaves its report alone', () => {
    expect(collapse(statements)).toContain(collapse(`
      ALTER TABLE public.search_query_events
        ADD COLUMN related_count integer CHECK (related_count IS NULL OR related_count BETWEEN 0 AND 24);`));
    expect(statements.match(/ALTER TABLE public\.search_query_events/g)).toHaveLength(1);
    expect(newestDefinition('search_query_report').file).toBe('20261112084002_search_query_events.sql');
  });
});
