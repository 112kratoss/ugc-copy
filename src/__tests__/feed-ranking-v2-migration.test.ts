import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260728170000_feed_ranking_v2.sql',
), 'utf8');

describe('feed ranking v2 migration', () => {
  it('ships v2 as shadow so the live feed cannot shift on deploy', () => {
    expect(migration).toContain("'for-you-rules',\n  2,\n  'shadow'");
    expect(migration).not.toMatch(/UPDATE public\.feed_algorithm_versions[\s\S]*status\s*=\s*'active'/);
    // v1's own retrieval function must remain untouched by this migration.
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_ranked_feed_candidates\(/);
  });

  it('gives v2 retrieval real configuration instead of hard-coded pools', () => {
    expect(migration).toContain('p_following_limit integer');
    expect(migration).toContain('p_interest_limit integer');
    expect(migration).toContain('p_trending_limit integer');
    expect(migration).toContain('p_recent_limit integer');
    expect(migration).toContain('p_exploration_limit integer');
    expect(migration).toContain("'candidate_rpc', 'v2'");

    // The defining property of the v2 contract: no weighted pre-ranking and no
    // global truncation before the caller scores.
    const v2Start = migration.indexOf('CREATE OR REPLACE FUNCTION public.get_ranked_feed_candidates_v2');
    const v2Body = migration.slice(v2Start, migration.indexOf('$$;', v2Start));
    expect(v2Body).not.toMatch(/0\.35::double precision \* /);
    expect(v2Body).not.toMatch(/LIMIT p_limit/);
  });

  it('collects seen history once per request and returns it for both identities', () => {
    expect(migration).toContain('WITH seen AS MATERIALIZED');
    expect(migration).toContain("WHERE events.event_type = 'impression'");
    expect(migration).toContain('p_viewer_user_id IS NOT NULL AND events.viewer_user_id = p_viewer_user_id');
    expect(migration).toContain('events.anonymous_key_hash = p_anonymous_key_hash');
    expect(migration).toContain('seen_recently boolean');
    expect(migration).toContain('last_seen_at timestamptz');
    // Every pool prefers unseen rows.
    expect(migration.match(/ORDER BY e\.seen_recently ASC/g) ?? []).toHaveLength(5);
  });

  it('defines the meaningful-engagement reward once and excludes unrendered deliveries', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.is_meaningful_feed_engagement');
    expect(migration).toContain("p_category = 'video' AND coalesce(p_media_progress_max, 0) >= 0.5");
    expect(migration).toContain("coalesce(p_category, '') <> 'video' AND coalesce(p_dwell_ms_max, 0) >= 3000");
    expect(migration).toContain('p_saved_at IS NOT NULL');
    expect(migration).toContain('p_purchased_at IS NOT NULL');
    // Reward counting is always gated on a rendered delivery.
    expect(migration).toContain('WHERE facts.rendered_at IS NOT NULL\n          AND public.is_meaningful_feed_engagement');
  });

  it('computes engagement depth per format with honest denominators', () => {
    expect(migration).toContain("WHEN rollup.category = 'video' THEN least(");
    expect(migration).toContain('rollup.video_half_completion_count::double precision + 1.5');
    expect(migration).toContain('rollup.video_start_count::double precision + 6.0');
    // A rendered video delivery counts as a start, so instant swipes land in
    // the denominator.
    expect(migration).toContain("WHERE facts.rendered_at IS NOT NULL AND posts.category = 'video'");
    // Quick-skip rate is measured against rendered deliveries, not impressions.
    expect(migration).toContain('coalesce(stats_7d.quick_skip_delivery_count, 0)::double precision + 1.0');
    expect(migration).toContain('coalesce(stats_7d.rendered_count, 0)::double precision + 8.0');
  });

  it('explores by posterior optimism rather than lowest exposure', () => {
    expect(migration).toContain('Beta(successes + 1, failures + 1)');
    expect(migration).toContain('p_exploration_confidence * sqrt(');
    expect(migration).toContain('posterior.alpha / (posterior.alpha + posterior.beta)');
    expect(migration).toContain('ORDER BY e.seen_recently ASC, scores.exploration_ucb DESC');
  });

  it('caps the creator prior so it cannot compound into a rich-get-richer loop', () => {
    expect(migration).toContain('p_creator_prior_cap double precision DEFAULT 0.15');
    expect(migration).toContain('least(p_creator_prior_cap, coalesce(creator_stats.quality_rate, 0.0::double precision))');
    expect(migration).toContain("'creator_quality', 0.06");
    // The prior must stay a separate capped feature, never blended into the
    // post's own evidence: smoothed_usefulness reads post stats and nothing else.
    expect(migration).toContain(
      'coalesce(stats_7d.usefulness_score, 0.08::double precision) AS smoothed_usefulness',
    );
    expect(migration.match(/creator_stats\.quality_rate/g) ?? []).toHaveLength(1);
  });

  it('feeds creation and onboarding signals into interests in post-space values', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.normalize_feed_interest_category');
    expect(migration).toContain("WHEN 'motion' THEN 'video'");
    expect(migration).toContain('weighted_creations AS (');
    expect(migration).toContain('FROM public.generations AS generations');
    expect(migration).toContain("generations.status = 'completed'");
    expect(migration).toContain('LEFT JOIN public.template_runs AS runs ON runs.id = generations.template_run_id');
    expect(migration).toContain('onboarding_seeds AS (');
    expect(migration).toContain('FROM public.mobile_onboarding_states AS states');
    // Creators with no feed activity must still be refreshed, which is the
    // cold-start case that matters most.
    expect(migration).toContain('SELECT generations.user_id\n      FROM public.generations AS generations');
    // Session pruning clears session_item_id after two days. Interests must use
    // the immutable delivery fact key to preserve the 90-day decay window.
    expect(migration).toContain('AND events.delivery_fact_id IS NOT NULL');
    const interestStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.refresh_user_interest_weights',
    );
    const interestBody = migration.slice(interestStart);
    expect(interestBody).not.toContain('events.session_item_id IS NOT NULL');
  });

  it('seeds the onboarding goal without ever lowering real behavioural signal', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.seed_user_interest_from_onboarding_goal');
    expect(migration).toContain('SET weight = greatest(weights.weight, EXCLUDED.weight)');
  });

  it('keeps every new surface locked to the service role', () => {
    expect(migration).toContain('ALTER TABLE public.creator_feed_stats ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('"No client access to creator_feed_stats"');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_ranked_feed_candidates_v2(');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.seed_user_interest_from_onboarding_goal(');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.refresh_creator_feed_stats(timestamptz, integer)');
  });
});
