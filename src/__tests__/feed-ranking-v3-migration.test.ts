import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationNames = fs.readdirSync(migrationsDirectory);

function readMigration(suffix: string): string {
  const name = migrationNames.find((candidate) => candidate.endsWith(suffix));
  expect(name, `${suffix} is missing`).toBeDefined();
  return fs.readFileSync(path.join(migrationsDirectory, name as string), 'utf8');
}

const migration = readMigration('_feed_ranking_v3_x_adoption.sql');
const personalizationMigration = readMigration('_feed_personalization_system.sql');
const v2Migration = readMigration('_feed_ranking_v2.sql');
const starvationFreeMigration = readMigration('_feed_ranking_v2_starvation_free_refresh.sql');

/** The full `CREATE OR REPLACE FUNCTION public.<name>(` statement, through its closing `$$;`. */
function functionDefinition(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + '\n$$;'.length);
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

type SeedValue = number | string;

/** Key/value pairs of each jsonb_build_object(...) in the v3 seed statement. */
function seededV3Row(): {
  weights: Record<string, SeedValue>;
  retrievalConfig: Record<string, SeedValue>;
  diversityConfig: Record<string, SeedValue>;
} {
  const insertStart = migration.indexOf('INSERT INTO public.feed_algorithm_versions (');
  const insertEnd = migration.indexOf('ON CONFLICT (algorithm_key, version) DO NOTHING;', insertStart);
  expect(insertStart).toBeGreaterThanOrEqual(0);
  expect(insertEnd).toBeGreaterThan(insertStart);
  const insert = migration.slice(insertStart, insertEnd);

  const objects = insert.split('jsonb_build_object(').slice(1).map((chunk) => {
    const body = chunk.slice(0, chunk.indexOf('\n  )'));
    const entries: Record<string, SeedValue> = {};
    for (const entry of body.matchAll(/'([a-z0-9_]+)',\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?))/g)) {
      entries[entry[1]] = entry[2] !== undefined ? entry[2] : Number(entry[3]);
    }
    return entries;
  });
  expect(objects).toHaveLength(3);
  return { weights: objects[0], retrievalConfig: objects[1], diversityConfig: objects[2] };
}

// Section 2.7 of docs/plans/feed-algorithm-v3-x-adoption-2026-10-11.md, verbatim.
const PLAN_V3_WEIGHTS = {
  interest_match: 0.24,
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
const PLAN_V3_RETRIEVAL_CONFIG = {
  candidate_rpc: 'v3',
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
};
const PLAN_V3_DIVERSITY_CONFIG = {
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

const v3Candidates = functionDefinition(migration, 'get_ranked_feed_candidates_v3');
const v2Candidates = functionDefinition(v2Migration, 'get_ranked_feed_candidates_v2');
const refreshCreator = functionDefinition(migration, 'refresh_creator_feed_stats');
const refreshPost = functionDefinition(migration, 'refresh_post_feed_stats');
const activate = functionDefinition(migration, 'activate_feed_algorithm_version');
const createExperiment = functionDefinition(migration, 'create_feed_experiment');
const setExperimentStatus = functionDefinition(migration, 'set_feed_experiment_status');
const scorecard = functionDefinition(migration, 'feed_algorithm_scorecard');

const NEW_FUNCTIONS = {
  get_ranked_feed_candidates_v3: [
    'uuid, text, text, integer, integer, integer, integer, integer, integer,',
    'double precision, double precision, timestamptz,',
    'integer, integer, integer, integer, integer, integer, double precision',
  ].join('\n  '),
  activate_feed_algorithm_version: 'uuid',
  create_feed_experiment: 'jsonb, jsonb',
  set_feed_experiment_status: 'uuid, text',
  feed_algorithm_scorecard: 'integer',
};

describe('feed ranking v3 migration', () => {
  it('ships v3 as shadow and activates nothing on deploy', () => {
    expect(migration).toContain("'for-you-rules',\n  3,\n  'shadow'");
    expect(migration).toContain(
      "'X-adoption: author-diversity decay, out-of-network discount, Thompson cold-start slot, cold pool, velocity trending, served-recently penalty, net-negative sink, visibility stage with recommendation-only rules, report-aware negatives.'",
    );
    expect(migration).toContain('ON CONFLICT (algorithm_key, version) DO NOTHING;');
    // Only the operator RPC may change a version's status, never the migration
    // itself: outside function bodies nothing updates the versions table.
    const topLevel = migration.replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(topLevel).not.toMatch(/UPDATE public\.feed_algorithm_versions/);
    // v1's and v2's retrieval functions are left alone.
    expect(migration).not.toMatch(/FUNCTION public\.get_ranked_feed_candidates\(/);
    expect(migration).not.toMatch(/FUNCTION public\.get_ranked_feed_candidates_v2\(/);
  });

  it('seeds exactly the configuration in section 2.7 of the plan', () => {
    const seeded = seededV3Row();
    expect(seeded.weights).toEqual(PLAN_V3_WEIGHTS);
    expect(seeded.retrievalConfig).toEqual(PLAN_V3_RETRIEVAL_CONFIG);
    expect(seeded.diversityConfig).toEqual(PLAN_V3_DIVERSITY_CONFIG);
  });

  it('defines every new function, and only invoker-secured ones', () => {
    for (const name of Object.keys(NEW_FUNCTIONS)) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
    }
    const definitions = [
      v3Candidates, refreshCreator, refreshPost, activate, createExperiment, setExperimentStatus, scorecard,
    ];
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(definitions.length);
    for (const definition of definitions) {
      expect(definition).toContain('SECURITY INVOKER\nSET search_path = public, pg_temp\nAS $$');
    }
    expect(migration).not.toContain('SECURITY DEFINER');
  });

  it('keeps every new function locked to the service role', () => {
    for (const [name, signature] of Object.entries(NEW_FUNCTIONS)) {
      const revoke = signature.includes('\n')
        ? `REVOKE ALL ON FUNCTION public.${name}(\n  ${signature}\n) FROM PUBLIC, anon, authenticated;`
        : `REVOKE ALL ON FUNCTION public.${name}(${signature})\n  FROM PUBLIC, anon, authenticated;`;
      const grant = signature.includes('\n')
        ? `GRANT EXECUTE ON FUNCTION public.${name}(\n  ${signature}\n) TO service_role;`
        : `GRANT EXECUTE ON FUNCTION public.${name}(${signature})\n  TO service_role;`;
      expect(migration).toContain(revoke);
      expect(migration).toContain(grant);
    }
    for (const name of ['refresh_creator_feed_stats', 'refresh_post_feed_stats']) {
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.${name}(timestamptz, integer)\n  FROM PUBLIC, anon, authenticated;`,
      );
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(timestamptz, integer)\n  TO service_role;`);
    }
  });

  it("extends v2's candidate signature and columns without reordering them", () => {
    const v2Parameters = listEntries(v2Candidates, 'get_ranked_feed_candidates_v2(');
    const v3Parameters = listEntries(v3Candidates, 'get_ranked_feed_candidates_v3(');
    expect(v2Parameters).toHaveLength(12);
    expect(v3Parameters.slice(0, 12)).toEqual(v2Parameters);
    expect(v3Parameters.slice(12)).toEqual([
      'p_cold_limit integer DEFAULT 50',
      'p_cold_max_age_hours integer DEFAULT 168',
      'p_cold_impression_threshold integer DEFAULT 60',
      'p_max_age_days integer DEFAULT 365',
      'p_served_lookback_hours integer DEFAULT 6',
      'p_trending_per_author_cap integer DEFAULT 5',
      'p_creator_prior_mean double precision DEFAULT 0.15',
    ]);

    const v2Columns = listEntries(v2Candidates, 'RETURNS TABLE (');
    const v3Columns = listEntries(v3Candidates, 'RETURNS TABLE (');
    expect(v2Columns).toHaveLength(16);
    expect(v3Columns.slice(0, 16)).toEqual(v2Columns);
    expect(v3Columns.slice(16)).toEqual([
      'served_recently boolean',
      'is_following boolean',
      'author_rendered_30d bigint',
      'post_rendered_30d bigint',
      'post_meaningful_30d bigint',
      'post_age_hours double precision',
      'reports_7d bigint',
      'sources text[]',
    ]);
  });

  it('rejects out-of-bounds parameters', () => {
    expect(v3Candidates).toContain('OR p_cold_limit IS NULL OR p_cold_limit < 0 OR p_cold_limit > 500');
    expect(v3Candidates).toContain("RAISE EXCEPTION 'Feed candidate pool limits must be between 0 and 500'");
    expect(v3Candidates).toContain('p_cold_max_age_hours < 0 OR p_cold_max_age_hours > 8760');
    expect(v3Candidates).toContain('p_served_lookback_hours < 0 OR p_served_lookback_hours > 8760');
    expect(v3Candidates).toContain('p_max_age_days < 1 OR p_max_age_days > 3650');
    expect(v3Candidates).toContain('p_trending_per_author_cap < 1');
    expect(v3Candidates).toContain('p_trending_per_author_cap > 50');
    expect(v3Candidates).toContain('p_creator_prior_mean < 0 OR p_creator_prior_mean > 1');
    expect(v3Candidates).toContain('p_cold_impression_threshold > 100000');
  });

  it('applies the safety exclusions in SQL, before ranking', () => {
    expect(v3Candidates).toContain('AND p.is_nsfw = false');
    expect(v3Candidates).toContain('AND p.created_at >= p_as_of - make_interval(days => p_max_age_days)');
    expect(v3Candidates).toContain('AND p.user_id IS DISTINCT FROM p_viewer_user_id');
    expect(v3Candidates).toContain(
      'WHERE blocks.blocker_user_id = p_viewer_user_id\n            AND blocks.blocked_user_id = p.user_id',
    );
    expect(v3Candidates).toContain(
      'WHERE blocks.blocker_user_id = p.user_id\n            AND blocks.blocked_user_id = p_viewer_user_id',
    );
    expect(v3Candidates).toContain(
      'WHERE reports.reporter_user_id = p_viewer_user_id\n            AND reports.post_id = p.id',
    );
    // v2's feedback predicates and seen join are kept.
    expect(v3Candidates).toContain('FROM public.feed_user_post_feedback AS post_feedback');
    expect(v3Candidates).toContain('FROM public.feed_user_creator_feedback AS creator_feedback');
    expect(v3Candidates).toContain('LEFT JOIN seen ON seen.post_id = p.id');
  });

  it('keeps served and seen apart, for both identities', () => {
    expect(v3Candidates).toContain('WITH seen AS MATERIALIZED');
    expect(v3Candidates).toContain('served AS MATERIALIZED');
    expect(v3Candidates).toContain('FROM public.feed_delivery_facts AS facts');
    expect(v3Candidates).toContain(
      'facts.served_at >= p_as_of - make_interval(hours => p_served_lookback_hours)',
    );
    expect(v3Candidates).toContain('p_viewer_user_id IS NOT NULL AND facts.viewer_user_id = p_viewer_user_id');
    expect(v3Candidates).toContain('facts.anonymous_key_hash = p_anonymous_key_hash');
    expect(v3Candidates).toContain('GROUP BY facts.post_id');
    expect(v3Candidates).toContain('(served.post_id IS NOT NULL) AS served_recently');
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS feed_delivery_facts_anonymous_served_idx\n'
        + '  ON public.feed_delivery_facts (anonymous_key_hash, served_at DESC)\n'
        + '  WHERE anonymous_key_hash IS NOT NULL;',
    );
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS feed_delivery_facts_viewer_served_idx\n'
        + '  ON public.feed_delivery_facts (viewer_user_id, served_at DESC)\n'
        + '  WHERE viewer_user_id IS NOT NULL;',
    );
  });

  it('retrieves from six prioritised pools, each preferring unseen posts', () => {
    const pools = [
      ['following', 1], ['cold', 2], ['affinity', 3], ['trending', 4], ['fresh', 5], ['exploration', 6],
    ] as const;
    for (const [source, priority] of pools) {
      expect(v3Candidates).toContain(`'${source}'::text AS source, ${priority} AS source_priority`);
    }
    expect(v3Candidates.match(/ORDER BY e\.seen_recently ASC/g) ?? []).toHaveLength(pools.length);

    expect(v3Candidates).toContain(
      'WHERE e.created_at >= p_as_of - make_interval(hours => p_cold_max_age_hours)\n'
        + '      AND coalesce(creator_stats.rendered_count, 0) < p_cold_impression_threshold',
    );
    expect(v3Candidates).toContain('LIMIT p_cold_limit');
  });

  it('ranks trending by projected velocity, capped per author', () => {
    // velocity = rate_24h * min(1, ln(1 + projected) / ln 101), lambda = ln 2 / 8,
    // projected = rendered_24h * (1 - exp(-24 lambda)) / (1 - exp(-lambda * max(age_h, 0.5))).
    expect(v3Candidates).toContain('coalesce(stats.meaningful_engagement_rate, 0.0::double precision)');
    expect(v3Candidates).toContain('ln(1.0::double precision + projection.projected_24h)');
    expect(v3Candidates).toContain('/ ln(101.0::double precision)');
    expect(v3Candidates).toContain(
      'exp(-(ln(2.0::double precision) / 8.0::double precision) * 24.0::double precision)',
    );
    expect(v3Candidates).toContain('0.5::double precision\n              )');
    expect(v3Candidates).toContain('PARTITION BY trend.creator_id\n          ORDER BY trend.velocity DESC');
    expect(v3Candidates).toContain('WHERE e.author_rank <= p_trending_per_author_cap');
    // The same velocity is the relevant_trend feature, clamped to [0, 1].
    expect(v3Candidates).toContain('coalesce(trend.velocity, 0.0::double precision)');
  });

  it('returns every source a post came from, the first as candidate_source', () => {
    expect(v3Candidates).toContain('(array_agg(pool.source ORDER BY pool.source_priority))[1] AS source');
    expect(v3Candidates).toContain('array_agg(pool.source ORDER BY pool.source_priority) AS sources');
    expect(v3Candidates).toContain('SELECT DISTINCT pooled.post_id, pooled.source, pooled.source_priority');
  });

  it('computes the v3 features', () => {
    // Reports come from post_reports and the denominator is rendered deliveries.
    expect(v3Candidates).toContain(
      '+ (2.0::double precision * coalesce(post_reports_7d.report_count, 0)::double precision)',
    );
    expect(v3Candidates).toContain(
      ') / (coalesce(stats_7d.rendered_count, 0)::double precision + 20.0::double precision)',
    );
    expect(v3Candidates).toContain("AND reports.status <> 'dismissed'");
    expect(v3Candidates).toContain("AND reports.created_at >= p_as_of - interval '7 days'");
    expect(v3Candidates).not.toContain('stats_7d.report_count');
    // An unmeasured creator gets the prior mean, not zero.
    expect(v3Candidates).toContain(
      'least(p_creator_prior_cap, coalesce(creator_stats.quality_rate, p_creator_prior_mean))',
    );
    expect(v3Candidates).toContain('coalesce(creator_stats.rendered_count, 0)::bigint AS author_rendered_30d');
    expect(v3Candidates).toContain('coalesce(scores.rendered_30d, 0)::bigint AS post_rendered_30d');
    expect(v3Candidates).toContain('coalesce(scores.meaningful_30d, 0)::bigint AS post_meaningful_30d');
    expect(v3Candidates).toContain('coalesce(stats.rendered_count, 0)::bigint AS rendered_30d');
    expect(v3Candidates).toContain('follow_state.is_following');
    expect(v3Candidates).toContain('coalesce(post_reports_7d.report_count, 0)::bigint AS reports_7d');
  });

  it('never orders by a literal ranking weight and never truncates globally', () => {
    const weightedTerm = /(?:^|[^\w.])\d+(?:\.\d+)?(?:::double precision)?\s*\*|\*\s*\d/;
    // Positive control: v1's retrieval, the anti-pattern this guards against,
    // orders by its weights written out as literals.
    const v1Candidates = functionDefinition(
      readMigration('_feed_ranking_limit_first_pools.sql'),
      'get_ranked_feed_candidates',
    );
    expect(orderByClauses(v1Candidates).some((clause) => weightedTerm.test(clause))).toBe(true);

    const clauses = orderByClauses(v3Candidates);
    // following, cold, interest, trending (window + pool), fresh, exploration,
    // and the two array_agg orderings in deduplication.
    expect(clauses).toHaveLength(9);
    for (const clause of clauses) {
      expect(clause).not.toMatch(weightedTerm);
    }
    const finalSelect = v3Candidates.slice(v3Candidates.indexOf('FROM deduplicated AS d'));
    expect(finalSelect).not.toContain('ORDER BY');
    expect(finalSelect).not.toContain('LIMIT');
    // Only the per-pool limits exist.
    expect(v3Candidates.match(/LIMIT p_[a-z_]+_limit/g)).toEqual([
      'LIMIT p_following_limit',
      'LIMIT p_cold_limit',
      'LIMIT p_interest_limit',
      'LIMIT p_trending_limit',
      'LIMIT p_recent_limit',
      'LIMIT p_exploration_limit',
    ]);
  });

  it('counts v1 stats by delivery fact and changes nothing else in the rollup', () => {
    const original = functionDefinition(personalizationMigration, 'refresh_post_feed_stats');
    expect(original.match(/session_item_id IS NOT NULL/g) ?? []).toHaveLength(2);
    expect(refreshPost).toBe(original.replaceAll('session_item_id IS NOT NULL', 'delivery_fact_id IS NOT NULL'));
    expect(refreshPost).toContain('AND recent_event.delivery_fact_id IS NOT NULL');
    expect(refreshPost).toContain('AND events.delivery_fact_id IS NOT NULL');
    expect(refreshPost).not.toContain('session_item_id');
  });

  it('adds creator negative feedback without touching candidate selection', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS negative_feedback_count bigint NOT NULL DEFAULT 0');
    expect(migration).toContain('CHECK (negative_feedback_count >= 0)');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS negative_feedback_rate double precision NOT NULL DEFAULT 0');
    expect(migration).toContain('negative_feedback_rate BETWEEN 0 AND 1');
    expect(migration).toContain("AND negative_feedback_rate <> 'NaN'::double precision");

    const candidateSelection = (definition: string) => {
      const start = definition.indexOf('WITH candidate_creators AS MATERIALIZED (');
      return definition.slice(start, definition.indexOf('rollup AS (', start));
    };
    const previous = functionDefinition(starvationFreeMigration, 'refresh_creator_feed_stats');
    expect(candidateSelection(refreshCreator)).toBe(candidateSelection(previous));
    expect(candidateSelection(refreshCreator)).toContain('ORDER BY min(existing.updated_at) ASC NULLS FIRST');

    expect(refreshCreator).toContain(
      'WHERE facts.not_interested_at IS NOT NULL\n          OR facts.hid_creator_at IS NOT NULL',
    );
    expect(refreshCreator).toContain('JOIN public.post_reports AS reports');
    expect(refreshCreator).toContain("AND reports.status <> 'dismissed'");
    expect(refreshCreator).toContain('+ 2 * coalesce(report_rollup.report_count, 0)');
    expect(refreshCreator).toContain('(scored.negative_feedback_count::double precision + 0.2)');
    expect(refreshCreator).toContain('/ (scored.rendered_count::double precision + 20.0)');
    expect(refreshCreator).toContain('negative_feedback_rate = EXCLUDED.negative_feedback_rate');
    // The quality rate is computed exactly as before.
    expect(refreshCreator).toContain('(scored.meaningful_engagement_count::double precision + 3.0)');
  });

  it('activates a version by retiring the active one first, in one transaction', () => {
    expect(activate).toContain('RETURNS jsonb');
    // A retired target is a rollback; only an already active one is refused.
    expect(activate).toContain("IF v_target.status NOT IN ('draft', 'shadow', 'retired') THEN");
    expect(activate).toContain("RAISE EXCEPTION 'Feed algorithm version is already active';");
    expect(activate).toContain('pg_advisory_xact_lock(');
    expect(activate).toContain('FOR UPDATE;');
    const retire = activate.indexOf("SET status = 'retired',\n      retired_at = v_now");
    // Clearing retired_at in the activating UPDATE is what lets a retired
    // version pass feed_algorithm_versions_lifecycle_check again.
    const promote = activate.indexOf(
      "SET status = 'active',\n      activated_at = v_now,\n      retired_at = NULL\n  WHERE versions.id = v_target.id;",
    );
    expect(retire).toBeGreaterThan(0);
    expect(promote).toBeGreaterThan(retire);
    expect(activate).toContain('WHERE versions.algorithm_key = v_target.algorithm_key\n    AND versions.status = \'active\'');
    for (const key of ['previous_active_id', 'activated_id', 'algorithm_key', 'version']) {
      expect(activate).toContain(`'${key}', `);
    }
  });

  it('creates experiments only with valid traffic, versions and a full allocation', () => {
    expect(createExperiment).toContain("v_status := coalesce(p_experiment->>'status', 'running');");
    expect(createExperiment).toContain('v_traffic < 1 OR v_traffic > 10000');
    expect(createExperiment).toContain('gen_random_uuid()::text');
    expect(createExperiment).toContain("v_starts_at := coalesce((p_experiment->>'starts_at')::timestamptz, v_now);");
    expect(createExperiment).toContain("v_version_status NOT IN ('active', 'shadow')");
    expect(createExperiment).toContain('IF v_allocation_total <> 10000 THEN');
    expect(createExperiment).toContain('INSERT INTO public.feed_experiment_variants (');
    expect(setExperimentStatus).toContain("p_status NOT IN ('paused', 'completed', 'cancelled', 'running')");
  });

  it('scores versions, variants and sources from served delivery facts', () => {
    expect(listEntries(scorecard, 'RETURNS TABLE (')).toEqual([
      'algorithm_version_id uuid',
      'algorithm_label text',
      'experiment_variant_id uuid',
      'variant_key text',
      'candidate_source text',
      'served bigint',
      'rendered bigint',
      'qualified bigint',
      'meaningful bigint',
      'quick_skips bigint',
      'negatives bigint',
      'saves bigint',
      'remix_starts bigint',
      'distinct_viewers bigint',
      'repeat_exposures bigint',
      'avg_position double precision',
    ]);
    expect(scorecard).toContain('IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN');
    expect(scorecard).toContain('WHERE facts.served_at >= now() - make_interval(days => p_days)');
    expect(scorecard).toContain('AND public.is_meaningful_feed_engagement(');
    expect(scorecard).toContain('OR facts.reported_at IS NOT NULL');
    expect(scorecard).toContain('coalesce(facts.viewer_user_id::text, facts.anonymous_key_hash) AS viewer_key');
    expect(scorecard).toContain("AND events.occurred_at >= facts.served_at - interval '14 days'");
    expect(scorecard).toContain('AND events.occurred_at < facts.served_at');
    expect(scorecard).toContain("versions.algorithm_key || '-v' || versions.version::text");
    // Per-source rows plus one all-sources row (candidate_source NULL) per
    // version and variant, whose distinct_viewers is the exact per-version count.
    const groupingSets = scorecard.slice(scorecard.indexOf('GROUP BY GROUPING SETS ('));
    expect(groupingSets.startsWith('GROUP BY GROUPING SETS (')).toBe(true);
    const sets = groupingSets
      .slice(0, groupingSets.indexOf('\n  )\n'))
      .split(/\n    \(/)
      .slice(1)
      .map((set) => set.replace(/\)[\s,]*$/, '').split(',').map((column) => column.trim()).filter(Boolean));
    expect(sets).toEqual([
      ['windowed.version_id', 'versions.algorithm_key', 'versions.version', 'windowed.variant_id',
        'variants.variant_key', 'windowed.source'],
      ['windowed.version_id', 'versions.algorithm_key', 'versions.version', 'windowed.variant_id',
        'variants.variant_key'],
    ]);
  });
});
