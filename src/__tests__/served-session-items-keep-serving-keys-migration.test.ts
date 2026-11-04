import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeRankedFeedFeatureRow } from '@/lib/showcase-feed-ranking';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261104141149_served_session_items_keep_serving_keys.sql',
);
const PREVIOUS_PATH = path.join(process.cwd(), 'supabase/migrations/20260922054500_atomic_feed_session.sql');

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

/**
 * pgTAP (feed_session_served_components.test.sql) asserts what each row holds.
 * This pins that the function is otherwise the one it replaces, and that the
 * two keys a served item keeps are all that serving reads from it again.
 */
describe('served session items keep only their serving keys', () => {
  const sql = code(readFileSync(MIGRATION_PATH, 'utf8'));
  const previous = code(readFileSync(PREVIOUS_PATH, 'utf8'));

  it('changes the two score_components expressions and nothing else', () => {
    const body = (text: string) => text.slice(
      text.indexOf('CREATE OR REPLACE FUNCTION public.persist_ranked_feed_session(') === -1
        ? text.indexOf('CREATE FUNCTION public.persist_ranked_feed_session(')
        : text.indexOf('CREATE OR REPLACE FUNCTION public.persist_ranked_feed_session('),
      text.indexOf('REVOKE ALL ON FUNCTION public.persist_ranked_feed_session('),
    ).replace(/^CREATE (OR REPLACE )?FUNCTION/, 'FUNCTION');
    const servedItem = "CASE WHEN ordinality - 1 >= p_offset AND ordinality - 1 < p_offset::bigint + p_limit THEN jsonb_strip_nulls(jsonb_build_object( 'negative_feedback_risk', entry->'score_components'->'negative_feedback_risk', 'is_following', entry->'score_components'->'is_following' )) ELSE entry->'score_components' END,";
    expect(body(sql)).toContain(servedItem);
    expect(body(sql)).toContain("i.final_score, p_items->i.position->'score_components', 'showcase', 'for-you',");
    expect(
      body(sql)
        .replace(servedItem, "entry->'score_components',")
        .replace("p_items->i.position->'score_components'", 'i.score_components'),
    ).toBe(body(previous));
  });

  it('stays the caller\'s privileges, for the service role alone', () => {
    expect(sql).toContain('SECURITY INVOKER SET search_path = public, pg_temp');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.persist_ranked_feed_session(jsonb, jsonb, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.persist_ranked_feed_session(jsonb, jsonb, jsonb, integer, integer) TO service_role;');
  });

  it('keeps every feature serving reads from a served item: risk and follow state', () => {
    const full = {
      post_id: 'post-1',
      candidate_source: 'trending',
      interest_match: 0.4,
      freshness: 0.7,
      negative_feedback_risk: 0.06,
      is_following: true,
      sources: ['trending', 'recent'],
      ranking: { base: 0.4 },
    };
    const kept = normalizeRankedFeedFeatureRow({
      post_id: full.post_id,
      candidate_source: full.candidate_source,
      negative_feedback_risk: full.negative_feedback_risk,
      is_following: full.is_following,
    });
    const whole = normalizeRankedFeedFeatureRow(full);
    expect(kept?.negativeFeedbackRisk).toBe(whole?.negativeFeedbackRisk);
    expect(kept?.isFollowing).toBe(whole?.isFollowing);
    // The recommendation context reads the source from its own column.
    expect(kept?.candidateSource).toBe(whole?.candidateSource);
  });
});
