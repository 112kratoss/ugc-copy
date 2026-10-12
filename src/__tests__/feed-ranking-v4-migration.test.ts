import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md, section 2. The
// SQL behaviour itself is exercised by
// supabase/tests/database/feed_ranking_v4_candidates.test.sql; this pins the
// migration's text: every object, the grants, the seeded row, and that each
// function it reproduces from an earlier migration differs only as the plan
// says.

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationNames = fs.readdirSync(migrationsDirectory);

function readMigration(suffix: string): string {
  const matches = migrationNames.filter((candidate) => candidate.endsWith(suffix));
  expect(matches, `${suffix} must exist exactly once`).toHaveLength(1);
  return fs.readFileSync(path.join(migrationsDirectory, matches[0]), 'utf8');
}

const migrationName = migrationNames.find((name) => name.endsWith('_feed_ranking_v4_industry_parity.sql'));
const migration = readMigration('_feed_ranking_v4_industry_parity.sql');
const v3Migration = readMigration('_feed_ranking_v3_x_adoption.sql');
const factsMigration = readMigration('_feed_delivery_facts.sql');
const batchMigration = readMigration('_feed_event_batch_rpc.sql');
const starvationFreeMigration = readMigration('_feed_ranking_v2_starvation_free_refresh.sql');
const interestMigration = readMigration('_track_empty_interest_refreshes.sql');
const factDailyMigration = readMigration('_feed_delivery_fact_daily.sql');
const retentionClampMigration = readMigration('_report_feed_retention_clamp.sql');
const personalizationMigration = readMigration('_feed_personalization_system.sql');
const limitFirstMigration = readMigration('_feed_ranking_limit_first_pools.sql');
const v2Migration = readMigration('_feed_ranking_v2.sql');

/** The four server-written event types, counted with or without a delivery. */
const SERVER_WRITTEN_TYPES = "('comment', 'follow', 'remix_complete', 'purchase')";

/** Every `CREATE OR REPLACE FUNCTION public.<name>(` statement, through its closing `$$;`. */
function functionDefinitions(sql: string, name: string): string[] {
  const definitions: string[] = [];
  const opener = `CREATE OR REPLACE FUNCTION public.${name}(`;
  let start = sql.indexOf(opener);
  while (start >= 0) {
    const end = sql.indexOf('\n$$;', start);
    expect(end, `${name} has no closing $$;`).toBeGreaterThan(start);
    definitions.push(sql.slice(start, end + '\n$$;'.length));
    start = sql.indexOf(opener, end);
  }
  return definitions;
}

function functionDefinition(sql: string, name: string): string {
  const definitions = functionDefinitions(sql, name);
  expect(definitions, `${name} must be defined exactly once`).toHaveLength(1);
  return definitions[0];
}

/** The lines of a parenthesised list that starts at `opener`, e.g. a RETURNS TABLE. */
function listEntries(definition: string, opener: string): string[] {
  const start = definition.indexOf(opener);
  expect(start, `${opener} not found`).toBeGreaterThanOrEqual(0);
  const end = definition.indexOf('\n)', start);
  return definition
    .slice(start + opener.length, end)
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0);
}

/** `text` with `addition` inserted right after its only occurrence of `anchor`. */
function insertAfter(text: string, anchor: string, addition: string): string {
  expect(text.split(anchor), `anchor must occur exactly once: ${anchor}`).toHaveLength(2);
  return text.replace(anchor, `${anchor}${addition}`);
}

/** `text` with its only occurrence of `from` replaced. */
function replaceOnce(text: string, from: string, to: string): string {
  expect(text.split(from), `text must occur exactly once: ${from}`).toHaveLength(2);
  return text.replace(from, to);
}

/** Every ORDER BY clause, up to its LIMIT, its closing parenthesis or the statement's end. */
function orderByClauses(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/g, '');
  const clauses: string[] = [];
  const pattern = /ORDER BY/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments)) !== null) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < withoutComments.length; end += 1) {
      const character = withoutComments[end];
      if (character === '(') depth += 1;
      if (character === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      if (depth === 0 && (character === ';' || withoutComments.startsWith('LIMIT', end))) break;
    }
    clauses.push(withoutComments.slice(match.index, end));
  }
  return clauses;
}

type SeedValue = number | string | boolean;

/** Key/value pairs of each jsonb_build_object(...) in the v4 seed statement. */
function seededV4Row() {
  // At the start of a line: the draft RPC's own INSERT is indented.
  const insertStart = migration.indexOf('\nINSERT INTO public.feed_algorithm_versions (');
  const insertEnd = migration.indexOf('ON CONFLICT (algorithm_key, version) DO NOTHING;', insertStart);
  expect(insertStart).toBeGreaterThanOrEqual(0);
  expect(insertEnd).toBeGreaterThan(insertStart);
  const insert = migration.slice(insertStart, insertEnd);
  const objects = insert.split('jsonb_build_object(').slice(1).map((chunk) => {
    const body = chunk.slice(0, chunk.indexOf('\n  )'));
    const entries: Record<string, SeedValue> = {};
    for (const entry of body.matchAll(/'([a-z0-9_]+)',\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?)|(true|false))/g)) {
      entries[entry[1]] = entry[2] !== undefined
        ? entry[2]
        : entry[3] !== undefined ? Number(entry[3]) : entry[4] === 'true';
    }
    return entries;
  });
  expect(objects).toHaveLength(3);
  return { insert, weights: objects[0], retrievalConfig: objects[1], diversityConfig: objects[2] };
}

// Section 2.10 of the plan: v3's row with these values changed or added.
const PLAN_V4_WEIGHTS = {
  interest_match: 0.16,
  semantic_similarity: 0.14,
  creator_affinity: 0.12,
  smoothed_usefulness: 0.10,
  engagement_depth: 0.22,
  attention_seconds_norm: 0.08,
  freshness: 0.12,
  relevant_trend: 0.08,
  creator_quality: 0.06,
  exploration_ucb: 0.10,
  exploration_bonus: 0.0,
  quick_skip_risk: -0.30,
  negative_feedback_risk: -2.5,
};
const PLAN_V4_RETRIEVAL_CONFIG = {
  candidate_rpc: 'v4',
  following_limit: 100,
  interest_limit: 150,
  trending_limit: 100,
  recent_limit: 150,
  exploration_limit: 100,
  cold_limit: 50,
  cold_max_age_hours: 168,
  cold_impression_threshold: 60,
  max_age_days: 365,
  served_lookback_hours: 6,
  trending_per_author_cap: 5,
  seen_lookback_days: 14,
  seen_penalty: 0.2,
  creator_prior_cap: 0.15,
  creator_prior_mean: 0.15,
  exploration_confidence: 1.5,
  session_item_limit: 60,
  recommendation_max_post_negative_risk: 0.12,
  recommendation_max_creator_negative_rate: 0.08,
  semantic_limit: 150,
  semantic_min_similarity: 0.0,
  taste_lookback_days: 90,
  taste_limit: 50,
  exclude_near_duplicates: true,
  exclude_labelled_accounts: true,
};
const PLAN_V4_DIVERSITY_CONFIG = {
  max_creator_per_20: 3,
  max_semantic_cluster_per_20: 3,
  exploration_per_10: 1,
  max_paid_share: 0.20,
  author_decay: 0.5,
  author_decay_floor: 0.25,
  out_of_network_multiplier: 0.75,
  served_penalty: 0.5,
  cold_start_slot_rank: 6,
  cold_start_max_age_hours: 168,
  cold_start_impression_threshold: 60,
  cold_start_prior_mean: 0.15,
  cold_start_prior_strength: 50,
};

const V4_CANDIDATE_SIGNATURE = [
  'uuid, text, text, integer, integer, integer, integer, integer, integer,',
  'double precision, double precision, timestamptz,',
  'integer, integer, integer, integer, integer, integer, double precision,',
  'integer, double precision, integer, integer, boolean, boolean',
].join('\n  ');

/** Every function the migration defines, with the signature its grants name. */
const FUNCTION_SIGNATURES: Record<string, string> = {
  match_post_content_embeddings: 'extensions.vector, text, double precision, integer',
  is_meaningful_feed_engagement:
    'text, double precision, bigint, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz',
  record_showcase_feed_events: 'uuid, text, jsonb, boolean',
  refresh_post_feed_stats: 'timestamptz, integer',
  refresh_post_feed_engagement_stats: 'timestamptz, integer',
  refresh_creator_feed_stats: 'timestamptz, integer',
  refresh_user_interest_weights: 'timestamptz, integer, integer, integer',
  refresh_feed_delivery_fact_daily: 'timestamptz, integer, integer',
  refresh_feed_viewer_daily: 'timestamptz, integer',
  prune_feed_personalization_data: 'timestamptz, integer, integer, integer, integer, integer',
  get_ranked_feed_candidates_v4: V4_CANDIDATE_SIGNATURE,
  feed_scorecard_viewers: 'integer',
  feed_scorecard_positions: 'integer',
  feed_scorecard_formats: 'integer',
  feed_experiment_assignment_counts: 'text',
  create_feed_algorithm_version_draft: 'text, text, jsonb, jsonb, jsonb',
  list_posts_pending_embedding: 'integer',
  replace_feed_semantic_clusters: 'text, jsonb',
  assign_post_semantic_clusters: 'jsonb',
  mark_post_near_duplicates: 'jsonb',
  upsert_account_labels: 'jsonb',
  delete_expired_account_labels: 'timestamptz',
  clear_orphaned_near_duplicate_marks: 'integer',
  get_ranked_feed_candidates: 'uuid, text, integer, timestamptz',
};

/** Signatures too long for one line are written over three. */
const MULTILINE_GRANTS = new Set([
  'is_meaningful_feed_engagement',
  'prune_feed_personalization_data',
  'get_ranked_feed_candidates_v4',
]);

function grantPair(name: string, signature: string) {
  if (MULTILINE_GRANTS.has(name)) {
    return {
      revoke: `REVOKE ALL ON FUNCTION public.${name}(\n  ${signature}\n) FROM PUBLIC, anon, authenticated;`,
      grant: `GRANT EXECUTE ON FUNCTION public.${name}(\n  ${signature}\n) TO service_role;`,
    };
  }
  return {
    revoke: `REVOKE ALL ON FUNCTION public.${name}(${signature})\n  FROM PUBLIC, anon, authenticated;`,
    grant: `GRANT EXECUTE ON FUNCTION public.${name}(${signature})\n  TO service_role;`,
  };
}

const v3Candidates = functionDefinition(v3Migration, 'get_ranked_feed_candidates_v3');
const v4Candidates = functionDefinition(migration, 'get_ranked_feed_candidates_v4');

describe('feed ranking v4 migration', () => {
  it('is one file, ordered after the v3 migration it builds on', () => {
    expect(migrationName).toMatch(/^\d{14}_feed_ranking_v4_industry_parity\.sql$/);
    expect(migrationNames.filter((name) => name.includes('feed_ranking_v4'))).toHaveLength(1);
    const v3Name = migrationNames.find((name) => name.endsWith('_feed_ranking_v3_x_adoption.sql')) as string;
    expect((migrationName as string).slice(0, 14) > v3Name.slice(0, 14)).toBe(true);
  });

  it('ships v4 as shadow and activates nothing on deploy', () => {
    const seeded = seededV4Row();
    expect(seeded.insert).toContain("'for-you-rules',\n  4,\n  'shadow'");
    expect(seeded.insert).toContain(
      "'Industry parity: gte-small content embeddings, taste-vector semantic retrieval, cluster interests and diversity, near-duplicate canonicalisation, account labels, comment and server-written follow/remix/purchase signals.'",
    );
    expect(migration).toContain('ON CONFLICT (algorithm_key, version) DO NOTHING;');
    const topLevel = migration.replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(topLevel).not.toMatch(/UPDATE public\.feed_algorithm_versions/);
    // v2 and v3 are left alone; v1 is re-created for its interest pool only
    // (pinned below).
    expect(migration).not.toMatch(/FUNCTION public\.get_ranked_feed_candidates_v[23]\(/);
    expect(migration).not.toMatch(/FUNCTION public\.feed_algorithm_scorecard\(/);
  });

  it('seeds exactly the configuration in section 2.10 of the plan', () => {
    const seeded = seededV4Row();
    expect(seeded.weights).toEqual(PLAN_V4_WEIGHTS);
    expect(seeded.retrievalConfig).toEqual(PLAN_V4_RETRIEVAL_CONFIG);
    expect(seeded.diversityConfig).toEqual(PLAN_V4_DIVERSITY_CONFIG);
  });

  it("seeds v3's row with only the plan's changes", () => {
    const v3Seed = v3Migration.slice(v3Migration.indexOf('INSERT INTO public.feed_algorithm_versions ('));
    const v3Objects = v3Seed.split('jsonb_build_object(').slice(1, 4).map((chunk) => chunk.slice(0, chunk.indexOf('\n  )')));
    const v4Objects = seededV4Row().insert.split('jsonb_build_object(').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('\n  )')));
    expect(v4Objects[0]).toBe(
      replaceOnce(v3Objects[0], "    'interest_match', 0.24,\n", "    'interest_match', 0.16,\n    'semantic_similarity', 0.14,\n"),
    );
    expect(v4Objects[1]).toBe(
      replaceOnce(v3Objects[1], "'candidate_rpc', 'v3'", "'candidate_rpc', 'v4'")
        + ",\n    'semantic_limit', 150,\n    'semantic_min_similarity', 0.0,\n    'taste_lookback_days', 90,"
        + "\n    'taste_limit', 50,\n    'exclude_near_duplicates', true,\n    'exclude_labelled_accounts', true",
    );
    expect(v4Objects[2]).toBe(v3Objects[2]);
  });

  it('defines every function, and only invoker-secured ones with a pinned search path', () => {
    for (const name of Object.keys(FUNCTION_SIGNATURES)) {
      expect(migration, name).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
    }
    const created = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/g)].map((match) => match[1]);
    // The two record_showcase_feed_events overloads and the outcome trigger.
    expect(created.sort()).toEqual(
      [...Object.keys(FUNCTION_SIGNATURES), 'record_showcase_feed_events', 'apply_feed_delivery_outcome'].sort(),
    );
    for (const name of new Set(created)) {
      for (const definition of functionDefinitions(migration, name)) {
        expect(definition, name).toMatch(/\nSECURITY INVOKER\nSET search_path = public, pg_temp\nAS \$\$/);
      }
    }
    expect(migration).not.toContain('SECURITY DEFINER');
  });

  it('keeps every callable function locked to the service role', () => {
    for (const [name, signature] of Object.entries(FUNCTION_SIGNATURES)) {
      const { revoke, grant } = grantPair(name, signature);
      expect(migration, name).toContain(revoke);
      expect(migration, name).toContain(grant);
    }
    // The client route's three-argument batch RPC keeps its grants too.
    const { revoke, grant } = grantPair('record_showcase_feed_events', 'uuid, text, jsonb');
    expect(migration).toContain(revoke);
    expect(migration).toContain(grant);
    // Replaced signatures are dropped first, so no call is ambiguous.
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.is_meaningful_feed_engagement(\n'
        + '  text, double precision, bigint, timestamptz, timestamptz, timestamptz, timestamptz\n);',
    );
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.prune_feed_personalization_data(\n'
        + '  timestamptz, integer, integer, integer, integer\n);',
    );
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.match_post_content_embeddings(\n'
        + '  extensions.vector, text, double precision, integer\n);',
    );
  });

  it('moves embeddings to 384 dimensions with cluster and near-duplicate columns', () => {
    // The original found the vector type at run time; so does this, and it
    // refuses to go on without pgvector or outside the extensions schema.
    expect(migration).toContain('DO $feed_v4_vectors$');
    expect(migration).toContain("RAISE EXCEPTION 'Feed ranking v4 requires the pgvector extension';");
    expect(migration).toContain("IF v_vector_schema <> 'extensions' THEN");
    expect(migration).toContain('DELETE FROM public.post_content_embeddings\n  WHERE embedding_dimensions <> 384;');
    expect(migration).toContain(
      "'ALTER TABLE public.post_content_embeddings ALTER COLUMN embedding TYPE %s(384)',\n      v_vector_type",
    );
    expect(migration).toContain("pg_get_constraintdef(constraints.oid) LIKE '%embedding_dimensions%'");
    expect(migration).toContain(
      'ALTER COLUMN embedding_dimensions SET DEFAULT 384,\n'
        + '  ADD CONSTRAINT post_content_embeddings_embedding_dimensions_check\n'
        + '    CHECK (embedding_dimensions = 384);',
    );
    expect(migration).toContain(
      "'CREATE INDEX IF NOT EXISTS post_content_embeddings_embedding_hnsw_idx '\n"
        + "      || 'ON public.post_content_embeddings USING hnsw (embedding %I.vector_cosine_ops)'",
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS cluster_id integer');
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS canonical_post_id uuid\n    REFERENCES public.posts(id) ON DELETE SET NULL',
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS near_duplicate_similarity double precision');
    expect(migration).toContain('near_duplicate_similarity BETWEEN -1 AND 1');
    expect(migration).toContain('CHECK (canonical_post_id IS NULL OR canonical_post_id <> post_id)');
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS post_content_embeddings_cluster_idx\n  ON public.post_content_embeddings (cluster_id);',
    );
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS post_content_embeddings_canonical_post_idx');
    // updated_at becomes the embedded text's version, not a write clock.
    expect(migration).toContain(
      'DROP TRIGGER IF EXISTS post_content_embeddings_set_updated_at\n  ON public.post_content_embeddings;',
    );
    expect(migration).not.toMatch(/CREATE TRIGGER post_content_embeddings_set_updated_at/);
  });

  it('stores a post with no text of its own without a vector, and every reader skips that row', () => {
    expect(migration).toContain(
      'ALTER TABLE public.post_content_embeddings\n  ADD COLUMN IF NOT EXISTS text_empty boolean NOT NULL DEFAULT false;',
    );
    expect(migration).toContain('ALTER TABLE public.post_content_embeddings\n  ALTER COLUMN embedding DROP NOT NULL;');
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS post_content_embeddings_text_empty_check;\n'
        + 'ALTER TABLE public.post_content_embeddings\n'
        + '  ADD CONSTRAINT post_content_embeddings_text_empty_check\n'
        + '    CHECK (text_empty = (embedding IS NULL));',
    );

    expect(functionDefinition(migration, 'match_post_content_embeddings')).toContain(
      'WHERE embeddings.embedding_model = p_embedding_model\n    AND embeddings.embedding IS NOT NULL\n',
    );
    // Taste (which posts, and their mean), the eligible join behind cluster
    // and canonical, and the semantic scores.
    for (const fragment of [
      "          AND taste_embeddings.embedding_model = 'gte-small'\n          AND taste_embeddings.embedding IS NOT NULL\n",
      "     AND taste_embeddings.embedding_model = 'gte-small'\n     AND taste_embeddings.embedding IS NOT NULL\n    HAVING count(*) > 0",
      "     AND embeddings.embedding_model = 'gte-small'\n     AND embeddings.embedding IS NOT NULL\n    WHERE p.visibility = 'public'",
      "       AND semantic_embeddings.embedding_model = 'gte-small'\n       AND semantic_embeddings.embedding IS NOT NULL\n",
    ]) {
      expect(v4Candidates.split(fragment), fragment).toHaveLength(2);
    }
    expect(v4Candidates.match(/post_content_embeddings AS /g)).toHaveLength(4);
    expect(v4Candidates.match(/\.embedding IS NOT NULL/g)).toHaveLength(4);
    // The pending list reads a text-empty row as a check like any other, or
    // it would hand the post back on every run.
    expect(functionDefinition(migration, 'list_posts_pending_embedding')).not.toContain('embedding IS');
  });

  it('recreates the match function at 384 dimensions with the same semantics', () => {
    const match = functionDefinition(migration, 'match_post_content_embeddings');
    expect(match).toContain('p_query_embedding extensions.vector(384),');
    expect(match).toContain('RETURNS TABLE (post_id uuid, semantic_similarity double precision)');
    expect(match).toContain("extensions.vector_dims(p_query_embedding) <> 384");
    expect(match).toContain("RAISE EXCEPTION 'Semantic candidate limit must be between 1 and 500';");
    expect(match).toContain("RAISE EXCEPTION 'Semantic match threshold must be between -1 and 1';");
    expect(match).toContain('ORDER BY embeddings.embedding OPERATOR(extensions.<=>) p_query_embedding\n  LIMIT p_limit;');
    // The original filters, unchanged.
    for (const line of [
      'WHERE embeddings.embedding_model = p_embedding_model',
      "AND posts.visibility = 'public'",
      'AND posts.archived_at IS NULL',
      "AND posts.review_status = 'visible'",
    ]) {
      expect(personalizationMigration).toContain(line);
      expect(match).toContain(line);
    }
  });

  it('creates the cluster, label and viewer-grain tables, service role only', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.feed_semantic_clusters (');
    expect(migration).toContain('  cluster_id integer PRIMARY KEY CHECK (cluster_id >= 0),');
    expect(migration).toContain('  centroid extensions.vector(384) NOT NULL,');
    expect(migration).toContain('  member_count integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.account_labels (');
    expect(migration).toContain('  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,');
    expect(migration).toContain(
      "    CHECK (label IN ('nsfw_account', 'negative_feedback_account', 'spam_account')),",
    );
    expect(migration).toContain('  PRIMARY KEY (user_id, label)');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS account_labels_expires_idx\n  ON public.account_labels (expires_at);');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.feed_viewer_daily (');
    for (const column of [
      'fact_date date NOT NULL',
      'viewer_key text NOT NULL',
      'viewer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE',
      'algorithm_version_id uuid NOT NULL',
      'experiment_id uuid',
      'experiment_variant_id uuid',
      'sessions integer NOT NULL',
      'served integer NOT NULL',
      'rendered integer NOT NULL',
      'qualified integer NOT NULL',
      'meaningful integer NOT NULL',
      'quick_skips integer NOT NULL',
      'negatives integer NOT NULL',
      'saves integer NOT NULL',
      'remix_starts integer NOT NULL',
      'comments integer NOT NULL',
      'first_served_at timestamptz',
      'last_served_at timestamptz',
      'updated_at timestamptz NOT NULL',
    ]) {
      expect(migration, column).toContain(`  ${column}`);
    }
    expect(migration).toContain(
      'CONSTRAINT feed_viewer_daily_grain\n'
        + '    UNIQUE NULLS NOT DISTINCT (fact_date, viewer_key, algorithm_version_id, experiment_variant_id)',
    );

    for (const table of ['feed_semantic_clusters', 'account_labels', 'feed_viewer_daily']) {
      expect(migration, table).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(migration, table).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`);
      expect(migration, table).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO service_role;`);
      expect(migration, table).toContain(
        `CREATE POLICY "No client access to ${table}"\n  ON public.${table} FOR ALL TO anon, authenticated\n  USING (false) WITH CHECK (false);`,
      );
    }
  });

  it('adds the comment event and the semantic_cluster dimension to their vocabularies', () => {
    const eventCheck = migration.slice(migration.indexOf('ADD CONSTRAINT feed_events_event_type_check CHECK ('));
    const eventTypes = [...eventCheck.slice(0, eventCheck.indexOf(');')).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    const originalTypes = [
      ...personalizationMigration
        .slice(personalizationMigration.indexOf('event_type text NOT NULL CHECK ('))
        .split('),')[0]
        .matchAll(/'([a-z_]+)'/g),
    ].map((match) => match[1]);
    expect(originalTypes).toHaveLength(16);
    expect(eventTypes).toEqual([...originalTypes, 'comment']);

    const dimensionCheck = migration.slice(migration.indexOf('ADD CONSTRAINT user_interest_weights_dimension_type_check CHECK ('));
    expect([...dimensionCheck.slice(0, dimensionCheck.indexOf(');')).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]))
      .toEqual(['category', 'creator', 'source_tool', 'media_type', 'resource_kind', 'semantic_cluster']);

    // The generated CHECK names are found by what they constrain.
    expect(migration).toContain("AND pg_get_constraintdef(constraints.oid) LIKE '%remix_complete%'");
    expect(migration).toContain("AND pg_get_constraintdef(constraints.oid) LIKE '%source_tool%'");
    expect(migration).toContain('ALTER TABLE public.feed_delivery_facts\n  ADD COLUMN IF NOT EXISTS commented_at timestamptz;');
    expect(migration).toContain(
      'ALTER TABLE public.post_feed_stats\n  ADD COLUMN IF NOT EXISTS comment_count bigint NOT NULL DEFAULT 0\n    CHECK (comment_count >= 0);',
    );
    expect(migration).toContain(
      'ALTER TABLE public.feed_delivery_fact_daily\n  ADD COLUMN IF NOT EXISTS comment_count bigint NOT NULL DEFAULT 0;',
    );
  });

  it('stamps commented_at write-once from the comment event and changes nothing else', () => {
    const original = functionDefinition(factsMigration, 'apply_feed_delivery_outcome');
    expect(functionDefinition(migration, 'apply_feed_delivery_outcome')).toBe(insertAfter(
      original,
      '        ELSE facts.reported_at END',
      ",\n      commented_at = CASE WHEN NEW.event_type = 'comment'\n"
        + '        THEN coalesce(facts.commented_at, NEW.occurred_at)\n'
        + '        ELSE facts.commented_at END',
    ));
  });

  it('counts a comment as meaningful through a defaulted eighth argument', () => {
    const meaningful = functionDefinition(migration, 'is_meaningful_feed_engagement');
    expect(listEntries(meaningful, 'is_meaningful_feed_engagement(')).toEqual([
      'p_category text',
      'p_media_progress_max double precision',
      'p_dwell_ms_max bigint',
      'p_saved_at timestamptz',
      'p_remix_started_at timestamptz',
      'p_resource_opened_at timestamptz',
      'p_purchased_at timestamptz',
      'p_commented_at timestamptz DEFAULT NULL',
    ]);
    expect(meaningful).toContain('    OR p_purchased_at IS NOT NULL\n    OR p_commented_at IS NOT NULL;');
    expect(meaningful).toContain('IMMUTABLE');
  });

  it('admits server-written events in the batch RPC only on the authoritative path', () => {
    const [batch, wrapper] = functionDefinitions(migration, 'record_showcase_feed_events');
    let expected = functionDefinition(batchMigration, 'record_showcase_feed_events');
    expected = replaceOnce(
      expected,
      '  p_events jsonb\n)',
      '  p_events jsonb,\n  p_authoritative boolean\n)',
    );
    expected = replaceOnce(
      expected,
      '  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)\n',
      "  IF p_authoritative IS NULL THEN\n    RAISE EXCEPTION 'Feed event batch authority must be true or false';\n  END IF;\n\n"
        + '  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)\n',
    );
    const serverOnlyStart = expected.indexOf("      IF v_event_type = ANY (ARRAY['follow', 'remix_complete', 'purchase', 'report']) THEN");
    const serverOnlyEnd = expected.indexOf('      END IF;\n', serverOnlyStart) + '      END IF;\n'.length;
    const batchServerOnlyStart = batch.indexOf('      -- Server-only types.');
    const batchServerOnlyEnd = batch.indexOf("'401|Authentication is required for this feed event.';\n      END IF;\n")
      + "'401|Authentication is required for this feed event.';\n      END IF;\n".length;
    // Outside the server-only block the batch RPC is the original, byte for byte.
    expect(batch.slice(0, batchServerOnlyStart) + batch.slice(batchServerOnlyEnd))
      .toBe(expected.slice(0, serverOnlyStart) + expected.slice(serverOnlyEnd));

    const serverOnly = batch.slice(batchServerOnlyStart, batchServerOnlyEnd);
    expect(serverOnly).toContain("IF v_event_type = 'report'\n        OR (\n          NOT p_authoritative\n"
      + "          AND v_event_type = ANY (ARRAY['comment', 'follow', 'remix_complete', 'purchase'])\n        )");
    expect(serverOnly).toContain("'400|This feed event must be recorded by its authoritative server action.'");
    expect(serverOnly).toContain(
      "IF v_event_type = ANY (ARRAY['comment', 'follow', 'remix_complete', 'purchase'])\n        AND p_actor_user_id IS NULL",
    );
    // A comment's delivery is optional, as a save's is.
    expect(batch).toContain(
      "            'impression', 'open', 'dwell', 'media_progress', 'quick_skip',\n            'share', 'remix_start', 'resource_open'\n",
    );

    // The client route's signature stays and can never be authoritative.
    expect(listEntries(wrapper, 'record_showcase_feed_events(')).toEqual([
      'p_actor_user_id uuid',
      'p_anonymous_key_hash text',
      'p_events jsonb',
    ]);
    expect(wrapper).toContain(
      'RETURN public.record_showcase_feed_events(\n    p_actor_user_id,\n    p_anonymous_key_hash,\n    p_events,\n    false\n  );',
    );
    expect(batch).not.toContain('p_authoritative boolean DEFAULT');
  });

  it('counts comments in v1 post stats, weighs them 1.0 in usefulness, and counts server-written events without a delivery', () => {
    let expected = functionDefinition(v3Migration, 'refresh_post_feed_stats');
    expected = replaceOnce(
      expected,
      '          AND recent_event.delivery_fact_id IS NOT NULL\n',
      '          AND (\n            recent_event.delivery_fact_id IS NOT NULL\n'
        + `            OR recent_event.event_type IN ${SERVER_WRITTEN_TYPES}\n          )\n`,
    );
    expected = replaceOnce(
      expected,
      '     AND events.delivery_fact_id IS NOT NULL\n',
      `     AND (\n       events.delivery_fact_id IS NOT NULL\n       OR events.event_type IN ${SERVER_WRITTEN_TYPES}\n     )\n`,
    );
    expected = insertAfter(
      expected,
      "      count(events.id) FILTER (WHERE events.event_type = 'share')::bigint AS share_count,\n",
      "      count(events.id) FILTER (WHERE events.event_type = 'comment')::bigint AS comment_count,\n",
    );
    expected = insertAfter(
      expected,
      '          + 0.50::double precision * raw.share_count::double precision\n',
      '          + 1.00::double precision * raw.comment_count::double precision\n',
    );
    expected = insertAfter(expected, '    share_count,\n', '    comment_count,\n');
    expected = insertAfter(expected, '    scored.share_count,\n', '    scored.comment_count,\n');
    expected = insertAfter(expected, '      share_count = EXCLUDED.share_count,\n', '      comment_count = EXCLUDED.comment_count,\n');
    expect(functionDefinition(migration, 'refresh_post_feed_stats')).toBe(expected);
  });

  it('passes commented_at to every meaningful-engagement count it re-creates', () => {
    const engagement = functionDefinition(starvationFreeMigration, 'refresh_post_feed_engagement_stats');
    expect(engagement.split('            facts.purchased_at\n          )')).toHaveLength(3);
    expect(functionDefinition(migration, 'refresh_post_feed_engagement_stats')).toBe(
      engagement.replaceAll(
        '            facts.purchased_at\n          )',
        '            facts.purchased_at,\n            facts.commented_at\n          )',
      ),
    );

    const creator = functionDefinition(v3Migration, 'refresh_creator_feed_stats');
    expect(functionDefinition(migration, 'refresh_creator_feed_stats')).toBe(
      replaceOnce(
        creator,
        '          facts.purchased_at\n        )',
        '          facts.purchased_at,\n          facts.commented_at\n        )',
      ),
    );

    // Every call in the migration passes eight arguments; only the v3
    // scorecard, not re-created here, keeps seven through the default.
    const calls = [...migration.matchAll(/(?<!FUNCTION |IF EXISTS )public\.is_meaningful_feed_engagement\(([^)]*)\)/g)]
      .map((match) => match[1]);
    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(call.split(',')).toHaveLength(8);
      expect(call.trim().endsWith('commented_at')).toBe(true);
    }
  });

  it('adds the comment weight, the semantic_cluster dimension, undelivered server events and succeeded creations to interest weights, nothing else', () => {
    let expected = functionDefinition(interestMigration, 'refresh_user_interest_weights');
    expected = replaceOnce(
      expected,
      '        -- delivery_fact_id keeps the full configured interest window usable.\n'
        + '        AND events.delivery_fact_id IS NOT NULL\n',
      '        -- delivery_fact_id keeps the full configured interest window usable.\n'
        + '        AND (\n          events.delivery_fact_id IS NOT NULL\n'
        + `          OR events.event_type IN ${SERVER_WRITTEN_TYPES}\n        )\n`,
    );
    expected = replaceOnce(
      expected,
      '    WHERE events.viewer_user_id = ANY(v_user_ids)\n      AND events.delivery_fact_id IS NOT NULL\n',
      '    WHERE events.viewer_user_id = ANY(v_user_ids)\n'
        + '      AND (\n        events.delivery_fact_id IS NOT NULL\n'
        + `        OR events.event_type IN ${SERVER_WRITTEN_TYPES}\n      )\n`,
    );
    // Generations settle as 'succeeded' (20260621235959); 'completed' never
    // occurs, so the creation signal was always empty.
    expect(expected.split("generations.status = 'completed'")).toHaveLength(3);
    expected = expected.replaceAll("generations.status = 'completed'", "generations.status IN ('succeeded', 'completed')");
    expected = insertAfter(expected, '      posts.source_tool_slug,\n', '      embeddings.cluster_id AS semantic_cluster_id,\n');
    expected = insertAfter(
      expected,
      "          WHEN 'share' THEN 2.00::double precision\n",
      "          WHEN 'comment' THEN 3.00::double precision\n",
    );
    expected = insertAfter(
      expected,
      '    JOIN public.posts AS posts ON posts.id = events.post_id\n',
      '    LEFT JOIN public.post_content_embeddings AS embeddings\n'
        + '      ON embeddings.post_id = events.post_id\n'
        + "     AND embeddings.embedding_model = 'gte-small'\n"
        + '     AND embeddings.embedding IS NOT NULL\n',
    );
    expected = insertAfter(
      expected,
      '      weighted.creator_user_id::text,\n'
        + '      weighted.signed_weight,\n'
        + '      weighted.occurred_at,\n'
        + '      weighted.received_at\n'
        + '    FROM weighted_events AS weighted\n'
        + '    WHERE weighted.signed_weight <> 0\n'
        + '\n'
        + '    UNION ALL\n',
      '\n'
        + '    SELECT\n'
        + '      weighted.user_id,\n'
        + "      'semantic_cluster'::text,\n"
        + "      'c' || weighted.semantic_cluster_id::text,\n"
        + '      weighted.signed_weight,\n'
        + '      weighted.occurred_at,\n'
        + '      weighted.received_at\n'
        + '    FROM weighted_events AS weighted\n'
        + '    WHERE weighted.semantic_cluster_id IS NOT NULL\n'
        + '      AND weighted.signed_weight <> 0\n'
        + '\n'
        + '    UNION ALL\n',
    );
    expect(functionDefinition(migration, 'refresh_user_interest_weights')).toBe(expected);
    // Same weight as a save.
    expect(expected).toContain("WHEN 'save' THEN 3.00::double precision");
  });

  it('adds comment_count to the daily fact rollup and runs it as its caller', () => {
    let expected = functionDefinition(factDailyMigration, 'refresh_feed_delivery_fact_daily');
    expected = replaceOnce(expected, 'SECURITY DEFINER\n', 'SECURITY INVOKER\n');
    expected = replaceOnce(
      expected,
      '    resource_opens, purchases, not_interested, hid_creator, reports,\n',
      '    resource_opens, purchases, not_interested, hid_creator, reports, comment_count,\n',
    );
    expected = insertAfter(
      expected,
      '    count(*) FILTER (WHERE facts.reported_at IS NOT NULL),\n',
      '    count(*) FILTER (WHERE facts.commented_at IS NOT NULL),\n',
    );
    expected = insertAfter(expected, '    reports = excluded.reports,\n', '    comment_count = excluded.comment_count,\n');
    expect(functionDefinition(migration, 'refresh_feed_delivery_fact_daily')).toBe(expected);
  });

  it('rolls deliveries up per viewer and day, from facts and fact-less sessions', () => {
    const refresh = functionDefinition(migration, 'refresh_feed_viewer_daily');
    expect(listEntries(refresh, 'refresh_feed_viewer_daily(')).toEqual([
      "p_as_of timestamptz DEFAULT timezone('utc'::text, now())",
      'p_days integer DEFAULT 3',
    ]);
    expect(refresh).toContain('RETURNS integer');
    expect(refresh).toContain("RAISE EXCEPTION 'Viewer daily rollup days must be between 1 and 30';");
    expect(refresh).toContain("pg_try_advisory_xact_lock(hashtextextended('refresh_feed_viewer_daily', 0))");
    expect(refresh).toContain("coalesce(facts.viewer_user_id::text, 'anon:' || facts.anonymous_key_hash) AS viewer_key");
    expect(refresh).toContain('FROM public.feed_sessions AS sessions');
    expect(refresh).toContain('WHERE session_facts.session_id = sessions.id');
    expect(refresh).toContain('count(DISTINCT combined.session_id)::integer');
    expect(refresh).toContain('facts.commented_at\n        ), false)');
    expect(refresh).toContain('ON CONFLICT ON CONSTRAINT feed_viewer_daily_grain DO UPDATE');
    // A fact-less session is pruned about two days after it expires, before
    // the oldest day of the window is re-read for the last time: a refresh
    // never lowers a day's session count. Everything else comes from facts,
    // kept for months, and is assigned.
    expect(refresh).toContain('      sessions = greatest(target.sessions, EXCLUDED.sessions),\n');
    expect(refresh).toContain('INSERT INTO public.feed_viewer_daily AS target (');
    for (const column of ['served', 'rendered', 'qualified', 'meaningful', 'quick_skips', 'negatives', 'saves', 'remix_starts', 'comments']) {
      expect(refresh).toContain(`      ${column} = EXCLUDED.${column},\n`);
    }
  });

  it('prunes the viewer rollup at 400 days under the facts clamp, reporting what it applied', () => {
    const prune = functionDefinition(migration, 'prune_feed_personalization_data');
    expect(listEntries(prune, 'prune_feed_personalization_data(').at(-1))
      .toBe('p_viewer_daily_retention_days integer DEFAULT 400');
    const originalBody = retentionClampMigration.slice(
      retentionClampMigration.indexOf('AS $function$\n') + 'AS $function$\n'.length,
      retentionClampMigration.indexOf('$function$;'),
    ).trimEnd();
    // Every line of the latest body survives, in order.
    const body = prune.slice(prune.indexOf('AS $$\n') + 'AS $$\n'.length, prune.lastIndexOf('\n$$;'));
    let cursor = 0;
    for (const line of originalBody.split('\n')) {
      const found = body.indexOf(line, cursor);
      expect(found, `kept: ${line}`).toBeGreaterThanOrEqual(0);
      cursor = found + line.length;
    }
    expect(prune).toContain(
      'v_viewer_daily_retention_days := greatest(p_viewer_daily_retention_days, v_fact_retention_days);',
    );
    expect(prune).toContain("RAISE EXCEPTION 'Feed viewer daily retention days must be between 1 and 1460';");
    expect(prune).toContain('DELETE FROM public.feed_viewer_daily AS daily');
    expect(prune).toContain('LIMIT p_limit');
    for (const key of [
      'viewer_daily_deleted',
      'viewer_daily_retention_days_requested',
      'viewer_daily_retention_days_applied',
      'viewer_daily_retention_clamped',
    ]) {
      expect(prune).toContain(`'${key}', `);
    }
  });

  it("returns v3's 24 columns in v3's order, then the three v4 features", () => {
    const v3Columns = listEntries(v3Candidates, 'RETURNS TABLE (');
    const v4Columns = listEntries(v4Candidates, 'RETURNS TABLE (');
    expect(v3Columns).toHaveLength(24);
    expect(v4Columns.slice(0, 24)).toEqual(v3Columns);
    expect(v4Columns.slice(24)).toEqual([
      'semantic_similarity double precision',
      'semantic_cluster text',
      'taste_available boolean',
    ]);
  });

  it("extends v3's parameters without reordering them, and bounds the new ones", () => {
    const v3Parameters = listEntries(v3Candidates, 'get_ranked_feed_candidates_v3(');
    const v4Parameters = listEntries(v4Candidates, 'get_ranked_feed_candidates_v4(');
    expect(v3Parameters).toHaveLength(19);
    expect(v4Parameters.slice(0, 19)).toEqual(v3Parameters);
    expect(v4Parameters.slice(19)).toEqual([
      'p_semantic_limit integer DEFAULT 150',
      'p_semantic_min_similarity double precision DEFAULT 0.0',
      'p_taste_lookback_days integer DEFAULT 90',
      'p_taste_limit integer DEFAULT 50',
      'p_exclude_near_duplicates boolean DEFAULT true',
      'p_exclude_labelled_accounts boolean DEFAULT true',
    ]);
    expect(v4Candidates).toContain('OR p_semantic_limit IS NULL OR p_semantic_limit < 0 OR p_semantic_limit > 500');
    expect(v4Candidates).toContain("RAISE EXCEPTION 'Semantic minimum similarity must be between -1 and 1';");
    expect(v4Candidates).toContain('p_taste_lookback_days < 1 OR p_taste_lookback_days > 365');
    expect(v4Candidates).toContain('p_taste_limit < 1 OR p_taste_limit > 200');
    expect(v4Candidates).toContain('IF p_exclude_near_duplicates IS NULL OR p_exclude_labelled_accounts IS NULL THEN');
  });

  it('builds the taste vector from the viewer\'s newest positive, embedded deliveries', () => {
    const taste = v4Candidates.slice(v4Candidates.indexOf('  taste_facts AS MATERIALIZED ('), v4Candidates.indexOf('  eligible AS MATERIALIZED ('));
    expect(taste).toContain('facts.served_at >= p_as_of - make_interval(days => p_taste_lookback_days)');
    expect(taste).toContain('(p_viewer_user_id IS NOT NULL AND facts.viewer_user_id = p_viewer_user_id)');
    expect(taste).toContain('AND facts.anonymous_key_hash = p_anonymous_key_hash');
    for (const outcome of ['saved_at', 'remix_started_at', 'commented_at', 'purchased_at']) {
      expect(taste).toContain(`facts.${outcome} IS NOT NULL`);
    }
    expect(taste).toContain('AND public.is_meaningful_feed_engagement(');
    expect(taste).toContain("AND taste_embeddings.embedding_model = 'gte-small'");
    expect(taste).toContain('ORDER BY facts.served_at DESC, facts.delivery_id DESC\n    LIMIT p_taste_limit');
    expect(taste).toContain('  taste AS MATERIALIZED (');
    expect(taste).toContain('SELECT extensions.avg(taste_embeddings.embedding) AS embedding');
    expect(taste).toContain('HAVING count(*) > 0');
    expect(v4Candidates).toContain('CROSS JOIN (SELECT EXISTS (SELECT 1 FROM taste) AS available) AS taste_state');
    expect(v4Candidates).toContain('taste_state.available AS taste_available');
  });

  it('lets only the following pool return a near-duplicate or a labelled author', () => {
    // A mark holds a post back only while its canonical is still in the feed.
    expect(v4Candidates).toContain(
      '          p_exclude_near_duplicates\n'
        + '          AND embeddings.canonical_post_id IS NOT NULL\n'
        + '          AND EXISTS (\n'
        + '            SELECT 1\n'
        + '            FROM public.posts AS canonical_posts\n'
        + '            WHERE canonical_posts.id = embeddings.canonical_post_id\n'
        + "              AND canonical_posts.visibility = 'public'\n"
        + '              AND canonical_posts.archived_at IS NULL\n'
        + "              AND canonical_posts.review_status = 'visible'\n"
        + '          )\n',
    );
    expect(v4Candidates).toContain(
      'p_exclude_labelled_accounts\n          AND EXISTS (\n            SELECT 1\n            FROM public.account_labels AS labels\n'
        + '            WHERE labels.user_id = p.user_id\n              AND labels.expires_at > p_as_of',
    );
    expect(v4Candidates).toContain(') AS recommendable');

    const pool = (name: string) => {
      const start = v4Candidates.indexOf(`  ${name} AS (`);
      expect(start, name).toBeGreaterThan(0);
      return v4Candidates.slice(start, v4Candidates.indexOf('\n  ),', start));
    };
    expect(pool('following_pool')).not.toContain('recommendable');
    expect(pool('cold_pool')).toContain('WHERE e.recommendable');
    expect(pool('interest_pool')).toContain('AND e.recommendable');
    expect(pool('semantic_pool')).toContain('WHERE e.recommendable');
    expect(pool('trending_pool')).toContain('WHERE trend.recommendable');
    expect(pool('recent_pool')).toContain('WHERE e.recommendable');
    expect(pool('exploration_pool')).toContain('WHERE e.recommendable');
  });

  it('retrieves from seven prioritised pools, semantic fourth, each preferring unseen posts', () => {
    const pools = [
      ['following', 1], ['cold', 2], ['affinity', 3], ['semantic', 4], ['trending', 5], ['fresh', 6], ['exploration', 7],
    ] as const;
    for (const [source, priority] of pools) {
      expect(v4Candidates).toContain(`'${source}'::text AS source, ${priority} AS source_priority`);
    }
    expect(v4Candidates.match(/ORDER BY e\.seen_recently ASC/g) ?? []).toHaveLength(pools.length);
    expect(v4Candidates).toContain('    UNION ALL SELECT * FROM interest_pool\n    UNION ALL SELECT * FROM semantic_pool\n');
    expect(v4Candidates).toContain(
      'AND 1.0::double precision - semantic.distance >= p_semantic_min_similarity\n'
        + '    ORDER BY e.seen_recently ASC, semantic.distance ASC, e.created_at DESC, e.id DESC\n'
        + '    LIMIT p_semantic_limit',
    );
    expect(v4Candidates).toContain('semantic_embeddings.embedding OPERATOR(extensions.<=>) taste.embedding');
    expect(v4Candidates).toContain("WHERE scored.distance <> 'NaN'::double precision");
  });

  it('computes the semantic features', () => {
    expect(v4Candidates).toContain(
      'coalesce(1.0::double precision - semantic.distance, 0.0::double precision)\n      )\n    ) AS semantic_similarity',
    );
    expect(v4Candidates).toContain(
      "CASE WHEN e.cluster_id IS NOT NULL THEN 'c' || e.cluster_id::text END AS semantic_cluster",
    );
    expect(v4Candidates).toContain(
      "OR (i.dimension_type = 'semantic_cluster' AND i.dimension_value = 'c' || e.cluster_id::text)",
    );
    expect(v4Candidates).toContain('LEFT JOIN semantic_scores AS semantic ON semantic.post_id = e.id');
  });

  it('is v3 otherwise', () => {
    // v3's safety exclusions, served/seen split, velocity trending and v3
    // features all carry over.
    for (const fragment of [
      'AND p.is_nsfw = false',
      'AND p.created_at >= p_as_of - make_interval(days => p_max_age_days)',
      'AND p.user_id IS DISTINCT FROM p_viewer_user_id',
      'WITH seen AS MATERIALIZED',
      'served AS MATERIALIZED',
      'PARTITION BY trend.creator_id\n          ORDER BY trend.velocity DESC',
      'least(p_creator_prior_cap, coalesce(creator_stats.quality_rate, p_creator_prior_mean))',
      '(array_agg(pool.source ORDER BY pool.source_priority))[1] AS source',
    ]) {
      expect(v3Candidates).toContain(fragment);
      expect(v4Candidates).toContain(fragment);
    }
    const finalSelect = v4Candidates.slice(v4Candidates.indexOf('FROM deduplicated AS d'));
    expect(finalSelect).not.toContain('ORDER BY');
    expect(finalSelect).not.toContain('LIMIT');
    expect(v4Candidates.match(/LIMIT p_[a-z_]+_limit/g)).toEqual([
      'LIMIT p_taste_limit',
      'LIMIT p_following_limit',
      'LIMIT p_cold_limit',
      'LIMIT p_interest_limit',
      'LIMIT p_semantic_limit',
      'LIMIT p_trending_limit',
      'LIMIT p_recent_limit',
      'LIMIT p_exploration_limit',
    ]);
  });

  it('never orders by a literal ranking weight', () => {
    const weightedTerm = /(?:^|[^\w.])\d+(?:\.\d+)?(?:::double precision)?\s*\*|\*\s*\d/;
    // Positive control: v1's retrieval orders by its weights written as
    // literals -- in its own migration and in the copy re-created here, which
    // is pinned to it byte for byte but for one predicate. Nothing else may.
    const v1Candidates = functionDefinition(limitFirstMigration, 'get_ranked_feed_candidates');
    expect(orderByClauses(v1Candidates).some((clause) => weightedTerm.test(clause))).toBe(true);
    const v1Copy = functionDefinition(migration, 'get_ranked_feed_candidates');
    expect(orderByClauses(v1Copy).some((clause) => weightedTerm.test(clause))).toBe(true);

    const clauses = orderByClauses(migration.replace(v1Copy, ''));
    expect(clauses.length).toBeGreaterThan(20);
    for (const clause of clauses) {
      expect(clause).not.toMatch(weightedTerm);
    }
  });

  it('scores viewers, positions, formats and assignments', () => {
    const viewers = functionDefinition(migration, 'feed_scorecard_viewers');
    expect(listEntries(viewers, 'RETURNS TABLE (').slice(0, 12)).toEqual([
      'algorithm_version_id uuid',
      'algorithm_label text',
      'experiment_variant_id uuid',
      'variant_key text',
      'viewers bigint',
      'sessions bigint',
      'sessions_per_viewer double precision',
      'd1_return_rate double precision',
      'd7_return_rate double precision',
      'meaningful_creation_7d_rate double precision',
      'rendered_per_viewer double precision',
      'meaningful_per_viewer double precision',
    ]);
    expect(viewers).toContain('FROM public.feed_viewer_daily AS daily');
    expect(viewers).toContain('next_day.day_date = viewer_days.day_date + 1');
    expect(viewers).toContain('week_later.day_date = viewer_days.day_date + 7');
    expect(viewers).toContain('bool_or(day_returns.day_date < v_window_end - 1) AS d1_eligible');
    expect(viewers).toContain('bool_or(day_returns.day_date < v_window_end - 7) AS d7_eligible');
    // Generations settle as 'succeeded'; 'completed' alone matched none.
    expect(viewers).toContain("AND generations.status IN ('succeeded', 'completed')");
    expect(migration).not.toContain("generations.status = 'completed'");
    expect(viewers).toContain("AND generations.created_at < per_viewer.viewer_first_served_at + interval '7 days'");

    const positions = functionDefinition(migration, 'feed_scorecard_positions');
    expect(listEntries(positions, 'RETURNS TABLE (').slice(4)).toEqual([
      'position_bucket text',
      'served bigint',
      'rendered bigint',
      'meaningful bigint',
      'quick_skips bigint',
    ]);
    expect(positions).toContain("(ARRAY['1-3', '4-6', '7-12', '13+'])[windowed.bucket_rank]");
    expect(positions).toContain('WHEN facts.position < 3 THEN 1');

    const formats = functionDefinition(migration, 'feed_scorecard_formats');
    expect(listEntries(formats, 'RETURNS TABLE (').slice(4)).toEqual([
      'category text',
      'rendered bigint',
      'meaningful bigint',
      'quick_skips bigint',
      'attention_ms bigint',
      'video_half_completions bigint',
    ]);
    expect(formats).toContain('CASE WHEN facts.rendered_at IS NOT NULL THEN facts.dwell_ms_max ELSE 0 END AS attention');

    const assignments = functionDefinition(migration, 'feed_experiment_assignment_counts');
    expect(listEntries(assignments, 'RETURNS TABLE (')).toEqual([
      'experiment_id uuid',
      'experiment_key text',
      'variant_id uuid',
      'variant_key text',
      'algorithm_version_id uuid',
      'allocation_basis_points integer',
      'assigned_viewers bigint',
      'exposed_viewers bigint',
    ]);
    expect(assignments).toContain("RAISE EXCEPTION 'Feed experiment does not exist';");

    for (const definition of [viewers, positions, formats]) {
      expect(definition).toMatch(/p_days IS NULL OR p_days < 1 OR p_days > (30|90)/);
      expect(definition).toContain("versions.algorithm_key || '-v' || versions.version::text");
    }
  });

  it('drafts a version at the next number from three JSON objects', () => {
    const draft = functionDefinition(migration, 'create_feed_algorithm_version_draft');
    expect(draft).toContain('RETURNS jsonb');
    for (const argument of ['p_weights', 'p_retrieval_config', 'p_diversity_config']) {
      expect(draft).toContain(`IF ${argument} IS NULL OR jsonb_typeof(${argument}) <> 'object' THEN`);
    }
    expect(draft).toContain('SELECT coalesce(max(versions.version), 0) + 1 INTO v_version');
    expect(draft).toContain("    'draft',\n");
    expect(draft).toContain("hashtextextended('create_feed_algorithm_version_draft:' || v_algorithm_key, 0)");
    for (const key of ['id', 'algorithm_key', 'version', 'status']) {
      expect(draft).toContain(`'${key}', `);
    }
  });

  it('gives the embeddings and safety-label jobs validated, bounded RPCs', () => {
    const pending = functionDefinition(migration, 'list_posts_pending_embedding');
    expect(pending).toContain('RETURNS TABLE (post_id uuid, updated_at timestamptz)');
    expect(pending).toContain("OR embeddings.embedding_model <> 'gte-small'");
    expect(pending).toContain('OR posts.updated_at > embeddings.updated_at');
    expect(pending).toContain("AND posts.review_status = 'visible'");
    // Never-embedded posts first: a save or share moves posts.updated_at, and
    // those re-listed posts (skipped by their hash) must not crowd them out.
    expect(pending).toContain('ORDER BY (embeddings.post_id IS NULL) DESC, posts.updated_at DESC, posts.id DESC\n  LIMIT p_limit;');

    const replace = functionDefinition(migration, 'replace_feed_semantic_clusters');
    expect(replace).toContain("RAISE EXCEPTION 'Semantic cluster centroids must be arrays of 384 numbers';");
    expect(replace).toContain("RAISE EXCEPTION 'Semantic cluster ids must be unique';");
    expect(replace.indexOf('DELETE FROM public.feed_semantic_clusters AS clusters'))
      .toBeLessThan(replace.indexOf('INSERT INTO public.feed_semantic_clusters ('));
    expect(replace).toContain("(cluster.value->'centroid')::text::extensions.vector(384)");

    const assign = functionDefinition(migration, 'assign_post_semantic_clusters');
    expect(assign).toContain('jsonb_array_length(p_assignments) > 10000');
    expect(assign).toContain('AND embeddings.cluster_id IS DISTINCT FROM requested.requested_cluster_id;');

    const mark = functionDefinition(migration, 'mark_post_near_duplicates');
    expect(mark).toContain("RAISE EXCEPTION 'A post cannot be a near-duplicate of itself';");
    expect(mark).toContain("RAISE EXCEPTION 'A near-duplicate''s canonical post cannot itself be a near-duplicate';");
    expect(mark).toContain('AND canonical.canonical_post_id IS NOT NULL');

    const labels = functionDefinition(migration, 'upsert_account_labels');
    expect(labels).toContain('ON CONFLICT (user_id, label) DO UPDATE');
    expect(labels).toContain("NOT IN ('nsfw_account', 'negative_feedback_account', 'spam_account')");
    const expired = functionDefinition(migration, 'delete_expired_account_labels');
    expect(expired).toContain('p_as_of timestamptz DEFAULT now()');
    expect(expired).toContain('WHERE labels.expires_at <= p_as_of;');

    // A duplicate whose canonical left the feed is released, as the candidate
    // RPC already treats it.
    const orphaned = functionDefinition(migration, 'clear_orphaned_near_duplicate_marks');
    expect(orphaned).toContain('p_limit integer DEFAULT 1000');
    expect(orphaned).toContain("RAISE EXCEPTION 'Orphaned near-duplicate limit must be between 1 and 10000';");
    expect(orphaned).toContain(
      '      AND NOT EXISTS (\n'
        + '        SELECT 1\n'
        + '        FROM public.posts AS canonical_posts\n'
        + '        WHERE canonical_posts.id = duplicates.canonical_post_id\n'
        + "          AND canonical_posts.visibility = 'public'\n"
        + '          AND canonical_posts.archived_at IS NULL\n'
        + "          AND canonical_posts.review_status = 'visible'\n"
        + '      )\n',
    );
    expect(orphaned).toContain('    LIMIT p_limit\n');
    expect(orphaned).toContain('  SET canonical_post_id = NULL,\n      near_duplicate_similarity = NULL\n');

    for (const definition of [pending, replace, assign, mark, labels, expired, orphaned]) {
      expect(definition).toContain('RAISE EXCEPTION');
    }
  });

  it('re-creates v1 with its interest pool walking only the weights it can match, nothing else changed', () => {
    const original = functionDefinition(limitFirstMigration, 'get_ranked_feed_candidates');
    expect(functionDefinition(migration, 'get_ranked_feed_candidates')).toBe(insertAfter(
      original,
      '      WHERE p_viewer_user_id IS NOT NULL\n        AND w.user_id = p_viewer_user_id\n        AND w.weight > 0\n',
      "        AND w.dimension_type IN ('category', 'media_type', 'source_tool', 'creator')\n",
    ));
    // Those are exactly the dimensions its lateral scan can match: a
    // semantic_cluster or resource_kind row would match no post and scan on to
    // the end of the catalog.
    const pool = original.slice(original.indexOf('  interest_pool AS ('), original.indexOf('  trending_pool AS ('));
    expect(pool).toContain('FROM public.user_interest_weights AS w\n      JOIN LATERAL (');
    expect([...pool.matchAll(/\(w\.dimension_type = '([a-z_]+)'/g)].map((match) => match[1]))
      .toEqual(['category', 'media_type', 'source_tool', 'creator']);

    // v2 and v3 probe the weights once per eligible post instead of walking
    // them, so a new dimension adds no scan there; they stay as they are.
    for (const [sql, name] of [[v2Migration, 'get_ranked_feed_candidates_v2'], [v3Migration, 'get_ranked_feed_candidates_v3']]) {
      const definition = functionDefinition(sql, name);
      const interestPool = definition.slice(definition.indexOf('  interest_pool AS ('), definition.indexOf('\n  ),', definition.indexOf('  interest_pool AS (')));
      expect(interestPool, name).toContain('FROM eligible AS e');
      expect(interestPool, name).not.toContain('JOIN LATERAL');
      expect(interestPool, name).toContain('FROM public.user_interest_weights AS interest\n        WHERE interest.user_id = p_viewer_user_id');
    }
  });

  it('can be applied twice', () => {
    const topLevel = migration.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$feed_v4_[a-z]+\$[\s\S]*?\$feed_v4_[a-z]+\$/g, '');
    for (const statement of topLevel.match(/CREATE (TABLE|INDEX) [^\n]+/g) ?? []) {
      expect(statement).toContain('IF NOT EXISTS');
    }
    for (const statement of topLevel.match(/ADD COLUMN [^\n]+/g) ?? []) {
      expect(statement).toContain('IF NOT EXISTS');
    }
    for (const statement of topLevel.match(/CREATE POLICY "[^"]+"/g) ?? []) {
      expect(topLevel).toContain(`DROP POLICY IF EXISTS ${statement.slice('CREATE POLICY '.length)}`);
    }
    expect(topLevel).not.toMatch(/CREATE FUNCTION/);
  });
});
