import { describe, expect, it } from 'vitest';

import { mulberry32, sampleBeta } from '@/lib/feed-thompson';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import {
  DEFAULT_RANKED_FEED_DIVERSITY_CONFIG,
  FOR_YOU_RULES_V3_DIVERSITY_CONFIG,
  FOR_YOU_RULES_V3_RETRIEVAL_CONFIG,
  FOR_YOU_RULES_V3_WEIGHTS,
  authorDiversityMultiplier,
  buildFallbackRankedFeedFeatures,
  buildRecommendationContext,
  explainRankedFeedScore,
  normalizeRankedFeedDiversityConfig,
  normalizeRankedFeedFeatureRow,
  normalizeRankedFeedScoreWeights,
  offsetRankedFeedScore,
  rankAndDiversifyShowcaseItems,
  rankedFeedMultipliersActive,
  scoreRankedFeedFeatures,
  type RankedFeedFeatureRow,
  type RankedShowcaseItem,
} from '@/lib/showcase-feed-ranking';

// ---------------------------------------------------------------------------
// v1/v2 parity: a config without the v3 keys must rank exactly as before v3.
// The expected arrays were produced by the ranking module as it stood at
// 31634288, before v3, from this same fixture — do not regenerate them from
// the current code.
// ---------------------------------------------------------------------------

const PARITY_NOW = new Date('2026-07-28T12:00:00.000Z');

// The seeded rows (docs/research/magicbooklet-feed-ranking-analysis-2026-10-11.md §3.1).
const V1_WEIGHTS_JSON = {
  interest_match: 0.35, creator_affinity: 0.15, smoothed_usefulness: 0.15, freshness: 0.15,
  relevant_trend: 0.10, exploration_bonus: 0.10, quick_skip_risk: -0.35, negative_feedback_risk: -0.80,
};
const V1_DIVERSITY_JSON = {
  max_creator_per_20: 2, max_semantic_cluster_per_20: 3, exploration_per_10: 1, max_paid_share: 0.20,
};
const V2_WEIGHTS_JSON = {
  interest_match: 0.26, creator_affinity: 0.12, smoothed_usefulness: 0.10, engagement_depth: 0.24,
  attention_seconds_norm: 0.08, freshness: 0.12, relevant_trend: 0.06, creator_quality: 0.06,
  exploration_ucb: 0.10, exploration_bonus: 0.0, quick_skip_risk: -0.30, negative_feedback_risk: -0.80,
};
const V2_DIVERSITY_JSON = {
  max_creator_per_20: 2, max_semantic_cluster_per_20: 3, exploration_per_10: 1, max_paid_share: 0.20,
};
const V2_SEEN_PENALTY = 0.2;

function parityItem(
  id: string,
  creatorId: string,
  createdAt: string,
  extra: { saveCount?: number; remixCount?: number; paid?: boolean } = {},
): ShowcaseFeedItem {
  return {
    id,
    title: id,
    createdAt,
    saveCount: extra.saveCount ?? 0,
    remixCount: extra.remixCount ?? 0,
    creator: { id: creatorId, username: creatorId || 'anonymous', name: creatorId, avatar: null },
    asset: extra.paid ? { accessMode: 'paid' } : null,
  } as unknown as ShowcaseFeedItem;
}

// Eighteen candidates: four creators repeat, two items have no feature row
// (fallback features), one has no creator id, three are repeats, two are paid,
// three share a semantic cluster, one is net-negative, and two tie exactly.
const PARITY_ITEMS: ShowcaseFeedItem[] = [
  parityItem('p01', 'creator-a', '2026-07-27T08:00:00.000Z'),
  parityItem('p02', 'creator-a', '2026-07-26T08:00:00.000Z'),
  parityItem('p03', 'creator-a', '2026-07-20T08:00:00.000Z'),
  parityItem('p04', 'creator-a', '2026-07-15T08:00:00.000Z'),
  parityItem('p05', 'creator-b', '2026-07-28T06:00:00.000Z'),
  parityItem('p06', 'creator-b', '2026-07-28T01:00:00.000Z'),
  parityItem('p07', 'creator-b', '2026-07-22T10:00:00.000Z'),
  parityItem('p08', 'creator-c', '2026-07-21T10:00:00.000Z', { paid: true }),
  parityItem('p09', 'creator-c', '2026-07-18T10:00:00.000Z'),
  parityItem('p10', 'creator-d', '2026-07-24T10:00:00.000Z', { paid: true }),
  parityItem('p11', 'creator-e', '2026-07-27T20:00:00.000Z'),
  parityItem('p12', 'creator-f', '2026-07-25T10:00:00.000Z'),
  parityItem('p13', 'creator-g', '2026-07-28T09:00:00.000Z'),
  parityItem('p14', 'creator-d', '2026-07-12T10:00:00.000Z'),
  parityItem('p15', 'creator-h', '2026-07-28T10:00:00.000Z', { saveCount: 1 }),
  parityItem('p16', 'creator-a', '2026-07-01T10:00:00.000Z', { saveCount: 20, remixCount: 10 }),
  parityItem('p17', 'creator-e', '2026-07-25T10:00:00.000Z'),
  parityItem('p18', '', '2026-07-26T10:00:00.000Z'),
];

// v2-shaped RPC rows (snake_case, no v3 columns); p15 and p16 have none.
const PARITY_RPC_ROWS: Array<Record<string, unknown>> = [
  { post_id: 'p01', candidate_source: 'following', interest_match: 0.9, creator_affinity: 0.75, smoothed_usefulness: 0.12, freshness: 0.6, relevant_trend: 0.2, exploration_bonus: 0.05, quick_skip_risk: 0.1, negative_feedback_risk: 0.01, engagement_depth: 0.5, attention_seconds_norm: 0.3, creator_quality: 0.15, exploration_ucb: 0.4 },
  { post_id: 'p02', candidate_source: 'following', interest_match: 0.8, creator_affinity: 0.75, smoothed_usefulness: 0.1, freshness: 0.55, relevant_trend: 0.1, exploration_bonus: 0.05, quick_skip_risk: 0.12, negative_feedback_risk: 0.01, engagement_depth: 0.45, attention_seconds_norm: 0.2, creator_quality: 0.15, exploration_ucb: 0.35 },
  { post_id: 'p03', candidate_source: 'interest', interest_match: 0.85, creator_affinity: 0.75, smoothed_usefulness: 0.2, freshness: 0.3, relevant_trend: 0.3, exploration_bonus: 0.02, quick_skip_risk: 0.05, negative_feedback_risk: 0.01, engagement_depth: 0.7, attention_seconds_norm: 0.6, creator_quality: 0.15, exploration_ucb: 0.3, seen_recently: true, last_seen_at: '2026-07-20T00:00:00.000Z' },
  { post_id: 'p04', candidate_source: 'trending', interest_match: 0.3, creator_affinity: 0.75, smoothed_usefulness: 0.18, freshness: 0.3, relevant_trend: 0.9, exploration_bonus: 0.01, quick_skip_risk: 0.2, negative_feedback_risk: 0.02, engagement_depth: 0.6, attention_seconds_norm: 0.5, creator_quality: 0.15, exploration_ucb: 0.25 },
  { post_id: 'p05', candidate_source: 'recent', interest_match: 0.2, creator_affinity: 0, smoothed_usefulness: 0.08, freshness: 1, relevant_trend: 0, exploration_bonus: 0.1, quick_skip_risk: 0.25, negative_feedback_risk: 0.01, engagement_depth: 0.25, attention_seconds_norm: 0, creator_quality: 0.1, exploration_ucb: 0.9 },
  { post_id: 'p06', candidate_source: 'exploration', interest_match: 0.1, creator_affinity: 0, smoothed_usefulness: 0.08, freshness: 0.7, relevant_trend: 0, exploration_bonus: 0.9, quick_skip_risk: 0.25, negative_feedback_risk: 0.01, engagement_depth: 0.25, attention_seconds_norm: 0, creator_quality: 0.1, exploration_ucb: 0.95 },
  { post_id: 'p07', candidate_source: 'semantic', interest_match: 0.6, creator_affinity: 0.1, smoothed_usefulness: 0.11, freshness: 0.4, relevant_trend: 0.15, exploration_bonus: 0.05, quick_skip_risk: 0.15, negative_feedback_risk: 0.03, engagement_depth: 0.4, attention_seconds_norm: 0.2, creator_quality: 0.1, exploration_ucb: 0.5, semantic_cluster: 'cluster-x' },
  { post_id: 'p08', candidate_source: 'affinity', interest_match: 0.7, creator_affinity: 0.2, smoothed_usefulness: 0.25, freshness: 0.35, relevant_trend: 0.4, exploration_bonus: 0.03, quick_skip_risk: 0.1, negative_feedback_risk: 0.02, engagement_depth: 0.55, attention_seconds_norm: 0.4, creator_quality: 0.12, exploration_ucb: 0.45, semantic_cluster: 'cluster-x' },
  { post_id: 'p09', candidate_source: 'exploration', interest_match: 0.4, creator_affinity: 0.2, smoothed_usefulness: 0.09, freshness: 0.2, relevant_trend: 0.05, exploration_bonus: 0.8, quick_skip_risk: 0.2, negative_feedback_risk: 0.01, engagement_depth: 0.3, attention_seconds_norm: 0.1, creator_quality: 0.12, exploration_ucb: 0.85, seen_recently: true, last_seen_at: '2026-07-25T00:00:00.000Z' },
  { post_id: 'p10', candidate_source: 'trending', interest_match: 0.45, creator_affinity: 0, smoothed_usefulness: 0.3, freshness: 0.45, relevant_trend: 0.7, exploration_bonus: 0.02, quick_skip_risk: 0.1, negative_feedback_risk: 0.01, engagement_depth: 0.65, attention_seconds_norm: 0.55, creator_quality: 0.14, exploration_ucb: 0.3 },
  { post_id: 'p11', candidate_source: 'fresh', interest_match: 0.3, creator_affinity: 0, smoothed_usefulness: 0.02, freshness: 0.9, relevant_trend: 0, exploration_bonus: 0.2, quick_skip_risk: 0.8, negative_feedback_risk: 0.9, engagement_depth: 0.1, attention_seconds_norm: 0, creator_quality: 0.05, exploration_ucb: 0.2 },
  { post_id: 'p12', candidate_source: 'mystery', interest_match: 0.5, creator_affinity: 0, smoothed_usefulness: 0.1, freshness: 0.5, relevant_trend: 0.1, exploration_bonus: 0.1, quick_skip_risk: 0.2, negative_feedback_risk: 0.01, engagement_depth: 0.35, attention_seconds_norm: 0.1, creator_quality: 0.1, exploration_ucb: 0.55, semantic_cluster: 'cluster-x' },
  { post_id: 'p13', candidate_source: 'exploration', interest_match: 0.15, creator_affinity: 0, smoothed_usefulness: 0.08, freshness: 0.95, relevant_trend: 0, exploration_bonus: 0.7, quick_skip_risk: 0.25, negative_feedback_risk: 0.01, engagement_depth: 0.25, attention_seconds_norm: 0, creator_quality: 0.08, exploration_ucb: 0.6 },
  { post_id: 'p14', candidate_source: 'following', interest_match: 0.95, creator_affinity: 0.75, smoothed_usefulness: 0.22, freshness: 0.1, relevant_trend: 0.2, exploration_bonus: 0.01, quick_skip_risk: 0.05, negative_feedback_risk: 0.01, engagement_depth: 0.8, attention_seconds_norm: 0.7, creator_quality: 0.14, exploration_ucb: 0.2, seen_recently: true, last_seen_at: '2026-07-22T00:00:00.000Z' },
  { post_id: 'p17', candidate_source: 'mystery', interest_match: 0.5, creator_affinity: 0, smoothed_usefulness: 0.1, freshness: 0.5, relevant_trend: 0.1, exploration_bonus: 0.1, quick_skip_risk: 0.2, negative_feedback_risk: 0.01, engagement_depth: 0.35, attention_seconds_norm: 0.1, creator_quality: 0.1, exploration_ucb: 0.55, semantic_cluster: 'cluster-x' },
  { post_id: 'p18', candidate_source: 'fresh', interest_match: 0.55, creator_affinity: 0, smoothed_usefulness: 0.1, freshness: 0.65, relevant_trend: 0.05, exploration_bonus: 0.15, quick_skip_risk: 0.2, negative_feedback_risk: 0.01, engagement_depth: 0.3, attention_seconds_norm: 0.1, creator_quality: 0.1, exploration_ucb: 0.5 },
];

const EXPECTED_V1: Array<[string, number]> = [
  ['p01', 0.5175],
  ['p08', 0.35699999999999993],
  ['p02', 0.455],
  ['p10', 0.29900000000000004],
  ['p18', 0.24700000000000005],
  ['p07', 0.24500000000000002],
  ['p15', 0.23227181197193206],
  ['p17', 0.20700000000000002],
  ['p13', 0.18149999999999997],
  ['p05', 0.1465],
  ['p11', -0.7370000000000001],
  ['p04', 0.2945],
  ['p16', 0.21683219351438565],
  ['p12', 0.20700000000000002],
  ['p06', 0.1465],
  ['p14', 0.09770000000000001],
  ['p09', 0.0441],
  ['p03', 0.09829999999999998],
];

const EXPECTED_V2: Array<[string, number]> = [
  ['p01', 0.5750000000000001],
  ['p08', 0.4672],
  ['p02', 0.5040000000000001],
  ['p10', 0.4434],
  ['p07', 0.3350000000000001],
  ['p18', 0.30200000000000005],
  ['p17', 0.29100000000000004],
  ['p15', 0.27427869556821954],
  ['p05', 0.253],
  ['p13', 0.20279999999999998],
  ['p11', -0.725],
  ['p04', 0.418],
  ['p12', 0.29100000000000004],
  ['p16', 0.2431028002353371],
  ['p06', 0.196],
  ['p14', 0.12728000000000003],
  ['p09', 0.05364],
  ['p03', 0.12340000000000002],
];

function rankParityFixture(
  weightsJson: Record<string, unknown>,
  diversityJson: Record<string, unknown>,
  seenPenalty?: number,
) {
  const featureRows = PARITY_RPC_ROWS
    .map(normalizeRankedFeedFeatureRow)
    .filter((row): row is RankedFeedFeatureRow => Boolean(row));
  return rankAndDiversifyShowcaseItems({
    items: PARITY_ITEMS,
    featureRows,
    now: PARITY_NOW,
    scoreWeights: normalizeRankedFeedScoreWeights(weightsJson),
    diversityConfig: normalizeRankedFeedDiversityConfig(diversityJson),
    ...(seenPenalty === undefined ? {} : { seenPenalty }),
  }).map((entry): [string, number] => [entry.item.id, entry.score]);
}

describe('v1 and v2 rank byte-for-byte as before v3', () => {
  it('reproduces the v1 order and every score', () => {
    const ranked = rankParityFixture(V1_WEIGHTS_JSON, V1_DIVERSITY_JSON);
    expect(ranked).toEqual(EXPECTED_V1);
    expect(JSON.stringify(ranked)).toBe(JSON.stringify(EXPECTED_V1));
  });

  it('reproduces the v2 order and every score', () => {
    const ranked = rankParityFixture(V2_WEIGHTS_JSON, V2_DIVERSITY_JSON, V2_SEEN_PENALTY);
    expect(ranked).toEqual(EXPECTED_V2);
    expect(JSON.stringify(ranked)).toBe(JSON.stringify(EXPECTED_V2));
  });

  it('reproduces v1 from the code defaults alone', () => {
    const ranked = rankAndDiversifyShowcaseItems({
      items: PARITY_ITEMS,
      featureRows: PARITY_RPC_ROWS
        .map(normalizeRankedFeedFeatureRow)
        .filter((row): row is RankedFeedFeatureRow => Boolean(row)),
      now: PARITY_NOW,
    });
    expect(ranked.map((entry) => [entry.item.id, entry.score])).toEqual(EXPECTED_V1);
  });

  it('reproduces v2 when every v3 key is set to its kill-switch value', () => {
    const ranked = rankParityFixture(V2_WEIGHTS_JSON, {
      ...V2_DIVERSITY_JSON,
      author_decay: 1,
      author_decay_floor: 0.25,
      out_of_network_multiplier: 1,
      served_penalty: 1,
      cold_start_slot_rank: 0,
    }, V2_SEEN_PENALTY);
    expect(ranked).toEqual(EXPECTED_V2);
  });

  it('keeps the v2 multipliers off, so offset equals base and no decay or slot applies', () => {
    const featureRows = PARITY_RPC_ROWS
      .map(normalizeRankedFeedFeatureRow)
      .filter((row): row is RankedFeedFeatureRow => Boolean(row));
    const ranked = rankAndDiversifyShowcaseItems({
      items: PARITY_ITEMS,
      featureRows,
      now: PARITY_NOW,
      scoreWeights: normalizeRankedFeedScoreWeights(V2_WEIGHTS_JSON),
      diversityConfig: normalizeRankedFeedDiversityConfig(V2_DIVERSITY_JSON),
    });

    for (const entry of ranked) {
      const components = explainRankedFeedScore(entry);
      expect(components.offset).toBe(components.base);
      expect(components.oonMultiplier).toBe(1);
      expect(components.authorDecay.multiplier).toBe(1);
      expect(components.servedPenalty).toBeNull();
      expect(components.coldStart).toBeNull();
      expect(components.seenPenalty).toBe(entry.features.seenRecently ? V2_SEEN_PENALTY : null);
    }
  });
});

// ---------------------------------------------------------------------------
// v3 parity: the v3 row must rank exactly as before v4. The same eighteen
// candidates as v3-shaped RPC rows: creators a and d are followed, b, e, f and
// g are cold, p05 was served and passed over, p11 is reported, and p18's
// author exposure is unknown. The expected array was produced by the ranking
// module as it stood at f06fb7b4, before v4, from this fixture — do not
// regenerate it from the current code.
// ---------------------------------------------------------------------------

const V3_PARITY_SEED = 20261012;

const V3_PARITY_COLUMNS: Record<string, Record<string, unknown>> = {
  p01: { is_following: true, served_recently: false, author_rendered_30d: 400, post_rendered_30d: 90, post_meaningful_30d: 20, post_age_hours: 28, reports_7d: 0, sources: ['following', 'affinity'] },
  p02: { is_following: true, served_recently: false, author_rendered_30d: 400, post_rendered_30d: 70, post_meaningful_30d: 9, post_age_hours: 52, reports_7d: 0, sources: ['following'] },
  p03: { is_following: true, served_recently: true, author_rendered_30d: 400, post_rendered_30d: 150, post_meaningful_30d: 30, post_age_hours: 196, reports_7d: 0, sources: ['affinity', 'following'] },
  p04: { is_following: true, served_recently: false, author_rendered_30d: 400, post_rendered_30d: 200, post_meaningful_30d: 25, post_age_hours: 316, reports_7d: 0, sources: ['trending', 'following'] },
  p05: { is_following: false, served_recently: true, author_rendered_30d: 24, post_rendered_30d: 3, post_meaningful_30d: 0, post_age_hours: 6, reports_7d: 0, sources: ['fresh', 'cold'] },
  p06: { is_following: false, served_recently: false, author_rendered_30d: 24, post_rendered_30d: 1, post_meaningful_30d: 1, post_age_hours: 11, reports_7d: 0, sources: ['exploration', 'cold'] },
  p07: { is_following: false, served_recently: false, author_rendered_30d: 24, post_rendered_30d: 12, post_meaningful_30d: 2, post_age_hours: 146, reports_7d: 0, sources: ['semantic', 'cold'] },
  p08: { is_following: false, served_recently: false, author_rendered_30d: 180, post_rendered_30d: 60, post_meaningful_30d: 12, post_age_hours: 170, reports_7d: 0, sources: ['affinity'] },
  p09: { is_following: false, served_recently: false, author_rendered_30d: 180, post_rendered_30d: 40, post_meaningful_30d: 3, post_age_hours: 242, reports_7d: 0, sources: ['exploration'] },
  p10: { is_following: true, served_recently: false, author_rendered_30d: 75, post_rendered_30d: 45, post_meaningful_30d: 9, post_age_hours: 98, reports_7d: 0, sources: ['trending', 'following'] },
  p11: { is_following: false, served_recently: false, author_rendered_30d: 30, post_rendered_30d: 10, post_meaningful_30d: 0, post_age_hours: 16, reports_7d: 2, sources: ['fresh', 'cold'] },
  p12: { is_following: false, served_recently: false, author_rendered_30d: 0, post_rendered_30d: 0, post_meaningful_30d: 0, post_age_hours: 74, reports_7d: 0, sources: ['mystery', 'cold'] },
  p13: { is_following: false, served_recently: false, author_rendered_30d: 5, post_rendered_30d: 2, post_meaningful_30d: 1, post_age_hours: 3, reports_7d: 0, sources: ['exploration', 'cold'] },
  p14: { is_following: true, served_recently: false, author_rendered_30d: 75, post_rendered_30d: 300, post_meaningful_30d: 40, post_age_hours: 386, reports_7d: 0, sources: ['following'] },
  p17: { is_following: false, served_recently: false, author_rendered_30d: 30, post_rendered_30d: 8, post_meaningful_30d: 2, post_age_hours: 74, reports_7d: 0, sources: ['mystery'] },
  p18: { is_following: false, served_recently: false, author_rendered_30d: null, post_rendered_30d: 5, post_meaningful_30d: 1, post_age_hours: 50, reports_7d: 0, sources: ['fresh'] },
};

const EXPECTED_V3: Array<[string, number]> = [
  ['p01', 0.535],
  ['p10', 0.4194],
  ['p08', 0.3128999999999999],
  ['p02', 0.290625],
  ['p15', 0.20313152855066993],
  ['p17', 0.195],
  ['p18', 0.20250000000000007],
  ['p07', 0.20100000000000007],
  ['p04', 0.16843750000000002],
  ['p13', 0.13409999999999997],
  ['p06', 0.08109374999999999],
  ['p11', 0.00006421396683673469],
  ['p05', 0.037406249999999995],
  ['p12', 0.195],
  ['p16', 0.06537447966398917],
  ['p14', 0.073675],
  ['p09', 0.022425000000000007],
  ['p03', 0.03420000000000001],
];

function rankV3ParityFixture(extraColumns: Record<string, unknown> = {}) {
  const featureRows = PARITY_RPC_ROWS
    .map((row) => normalizeRankedFeedFeatureRow({
      ...row,
      ...V3_PARITY_COLUMNS[row.post_id as string],
      ...extraColumns,
    }))
    .filter((row): row is RankedFeedFeatureRow => Boolean(row));
  return rankAndDiversifyShowcaseItems({
    items: PARITY_ITEMS,
    featureRows,
    now: PARITY_NOW,
    scoreWeights: normalizeRankedFeedScoreWeights(FOR_YOU_RULES_V3_WEIGHTS),
    diversityConfig: normalizeRankedFeedDiversityConfig(FOR_YOU_RULES_V3_DIVERSITY_CONFIG),
    seenPenalty: FOR_YOU_RULES_V3_RETRIEVAL_CONFIG.seen_penalty,
    seed: V3_PARITY_SEED,
  });
}

describe('v3 ranks byte-for-byte as before v4', () => {
  it('reproduces the v3 order and every score', () => {
    const ranked = rankV3ParityFixture().map((entry): [string, number] => [entry.item.id, entry.score]);
    expect(ranked).toEqual(EXPECTED_V3);
    expect(JSON.stringify(ranked)).toBe(JSON.stringify(EXPECTED_V3));
  });

  it('exercises every v3 adjustment, so the parity means something', () => {
    const ranked = rankV3ParityFixture();
    const byId = new Map(ranked.map((entry) => [entry.item.id, explainRankedFeedScore(entry)]));
    expect(byId.get('p08')?.oonMultiplier).toBe(0.75);
    expect(byId.get('p02')?.authorDecay).toEqual({ k: 1, multiplier: 0.625 });
    expect(byId.get('p05')?.servedPenalty).toBe(0.5);
    expect(byId.get('p03')?.seenPenalty).toBe(0.2);
    expect(byId.get('p11')?.base).toBeLessThan(0);
    expect(byId.get('p17')?.coldStart).toMatchObject({ picked: true, lifted: true });
  });

  it('ignores v4 columns on the rows while semantic_similarity carries no weight', () => {
    const ranked = rankV3ParityFixture({ semantic_similarity: 0.9, taste_available: true })
      .map((entry): [string, number] => [entry.item.id, entry.score]);
    expect(JSON.stringify(ranked)).toBe(JSON.stringify(EXPECTED_V3));
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('v3 diversity config', () => {
  it('normalizes an empty config to the pre-v3 defaults with every v3 key off', () => {
    const config = normalizeRankedFeedDiversityConfig({});

    expect(config).toEqual(DEFAULT_RANKED_FEED_DIVERSITY_CONFIG);
    expect(config).toEqual({
      maxCreatorPer20: 2,
      maxSemanticClusterPer20: 3,
      explorationPer10: 1,
      maxPaidShare: 0.2,
      authorDecay: 1,
      authorDecayFloor: 1,
      outOfNetworkMultiplier: 1,
      servedPenalty: 1,
      coldStartSlotRank: 0,
      coldStartMaxAgeHours: 168,
      coldStartImpressionThreshold: 60,
      coldStartPriorMean: 0.15,
      coldStartPriorStrength: 50,
    });
    expect(normalizeRankedFeedDiversityConfig(null)).toEqual(DEFAULT_RANKED_FEED_DIVERSITY_CONFIG);
    expect(rankedFeedMultipliersActive(config)).toBe(false);
  });

  it('reads every key of the seeded v3 row', () => {
    const config = normalizeRankedFeedDiversityConfig(FOR_YOU_RULES_V3_DIVERSITY_CONFIG);

    expect(config).toEqual({
      maxCreatorPer20: 3,
      maxSemanticClusterPer20: 3,
      explorationPer10: 1,
      maxPaidShare: 0.2,
      authorDecay: 0.5,
      authorDecayFloor: 0.25,
      outOfNetworkMultiplier: 0.75,
      servedPenalty: 0.5,
      coldStartSlotRank: 6,
      coldStartMaxAgeHours: 168,
      coldStartImpressionThreshold: 60,
      coldStartPriorMean: 0.15,
      coldStartPriorStrength: 50,
    });
    expect(rankedFeedMultipliersActive(config)).toBe(true);
  });

  it('falls back to the default for any value outside its bounds, and treats null as missing', () => {
    expect(normalizeRankedFeedDiversityConfig({
      author_decay: 1.5,
      author_decay_floor: -0.1,
      out_of_network_multiplier: null,
      served_penalty: 'half',
      cold_start_slot_rank: 61,
      cold_start_max_age_hours: 0,
      cold_start_impression_threshold: 100_001,
      cold_start_prior_mean: 1,
      cold_start_prior_strength: 0.5,
    })).toEqual(DEFAULT_RANKED_FEED_DIVERSITY_CONFIG);
    expect(normalizeRankedFeedDiversityConfig({ cold_start_prior_mean: 0 }).coldStartPriorMean).toBe(0.15);
    expect(normalizeRankedFeedDiversityConfig({ cold_start_slot_rank: 5.6 }).coldStartSlotRank).toBe(6);
    expect(normalizeRankedFeedDiversityConfig({ author_decay: 0, out_of_network_multiplier: 0 })).toMatchObject({
      authorDecay: 0,
      outOfNetworkMultiplier: 0,
    });
  });

  it('switches the offset on for each multiplier alone', () => {
    const on = (json: Record<string, unknown>) => rankedFeedMultipliersActive(normalizeRankedFeedDiversityConfig(json));

    expect(on({ author_decay: 0.9 })).toBe(true);
    expect(on({ out_of_network_multiplier: 0.9 })).toBe(true);
    expect(on({ served_penalty: 0.9 })).toBe(true);
    expect(on({ cold_start_slot_rank: 1 })).toBe(true);
    expect(on({ author_decay_floor: 0.25, cold_start_max_age_hours: 2 })).toBe(false);
  });
});

describe('v3 seeded row', () => {
  it('exports the version JSON exactly as the plan seeds it', () => {
    expect(FOR_YOU_RULES_V3_WEIGHTS).toEqual({
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
    });
    expect(FOR_YOU_RULES_V3_RETRIEVAL_CONFIG).toEqual({
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
    });
    expect(FOR_YOU_RULES_V3_DIVERSITY_CONFIG).toEqual({
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
    });
  });

  it('accepts every v3 weight within the normalizer bounds', () => {
    expect(normalizeRankedFeedScoreWeights(FOR_YOU_RULES_V3_WEIGHTS)).toEqual({
      interestMatch: 0.24,
      creatorAffinity: 0.12,
      smoothedUsefulness: 0.10,
      freshness: 0.12,
      relevantTrend: 0.08,
      explorationBonus: 0,
      quickSkipRisk: -0.30,
      negativeFeedbackRisk: -2.5,
      engagementDepth: 0.22,
      attentionSecondsNorm: 0.08,
      creatorQuality: 0.06,
      explorationUcb: 0.10,
      // v4's key, absent from the v3 row, reads as 0.
      semanticSimilarity: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Feature rows
// ---------------------------------------------------------------------------

describe('normalizeRankedFeedFeatureRow v3 columns', () => {
  it('reads the v3 RPC columns', () => {
    const row = normalizeRankedFeedFeatureRow({
      post_id: 'post-1',
      candidate_source: 'cold',
      is_following: true,
      served_recently: true,
      author_rendered_30d: 12,
      post_rendered_30d: 9,
      post_meaningful_30d: 2,
      post_age_hours: 3.5,
      reports_7d: 1,
      sources: ['cold', 'interest', 'recent', 'cold'],
    });

    expect(row).toMatchObject({
      postId: 'post-1',
      candidateSource: 'cold',
      isFollowing: true,
      servedRecently: true,
      authorRendered30d: 12,
      postRendered30d: 9,
      postMeaningful30d: 2,
      postAgeHours: 3.5,
      reports7d: 1,
      sources: ['cold', 'affinity', 'fresh'],
    });
  });

  it('defaults every v3 column when a pre-v3 RPC row lacks it', () => {
    const row = normalizeRankedFeedFeatureRow({ post_id: 'post-2', candidate_source: 'trending' });

    expect(row).toMatchObject({
      isFollowing: false,
      servedRecently: false,
      authorRendered30d: null,
      postRendered30d: 0,
      postMeaningful30d: 0,
      postAgeHours: null,
      reports7d: 0,
      sources: ['trending'],
    });
  });

  it('reads malformed counts as unknown rather than as zero exposure', () => {
    const row = normalizeRankedFeedFeatureRow({
      post_id: 'post-3',
      author_rendered_30d: -4,
      post_rendered_30d: 'many',
      post_age_hours: -0.2,
      is_following: 'true',
    });

    expect(row?.authorRendered30d).toBeNull();
    expect(row?.postRendered30d).toBe(0);
    expect(row?.postAgeHours).toBe(0);
    expect(row?.isFollowing).toBe(false);
  });

  it('still turns unknown labels into fresh, in the source and in the source list', () => {
    const row = normalizeRankedFeedFeatureRow({
      post_id: 'post-4',
      candidate_source: 'mystery',
      sources: ['mystery', 'following'],
    });

    expect(row?.candidateSource).toBe('fresh');
    expect(row?.sources).toEqual(['fresh', 'following']);
  });

  it('keeps the candidate source first in the source list', () => {
    const row = normalizeRankedFeedFeatureRow({
      post_id: 'post-5',
      candidate_source: 'following',
      sources: ['trending'],
    });
    expect(row?.sources).toEqual(['following', 'trending']);
  });

  it('gives the cold pool its own reason text', () => {
    const features = normalizeRankedFeedFeatureRow({ post_id: 'post-6', candidate_source: 'cold' });
    expect(buildRecommendationContext({ deliveryId: '1', features: features!, position: 0 })).toMatchObject({
      reason: 'New from the community',
      candidateSource: 'cold',
    });
  });

  it('marks fallback rows as unknown exposure, so they are never a cold-start pick', () => {
    const item = parityItem('fallback', 'creator-z', '2026-07-28T09:00:00.000Z');
    expect(buildFallbackRankedFeedFeatures(item, PARITY_NOW)).toMatchObject({
      isFollowing: false,
      servedRecently: false,
      authorRendered30d: null,
      postAgeHours: 3,
      sources: ['exploration'],
    });
  });
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const V3_WEIGHTS = normalizeRankedFeedScoreWeights(FOR_YOU_RULES_V3_WEIGHTS);

function v3Diversity(overrides: Record<string, unknown> = {}) {
  return normalizeRankedFeedDiversityConfig({ ...FOR_YOU_RULES_V3_DIVERSITY_CONFIG, ...overrides });
}

function item(id: string, creatorId: string, createdAt = '2026-10-10T00:00:00.000Z') {
  return parityItem(id, creatorId, createdAt);
}

function row(postId: string, overrides: Partial<RankedFeedFeatureRow> = {}): RankedFeedFeatureRow {
  return {
    postId,
    interestMatch: 0,
    creatorAffinity: 0,
    smoothedUsefulness: 0,
    freshness: 0,
    relevantTrend: 0,
    explorationBonus: 0,
    quickSkipRisk: 0,
    negativeFeedbackRisk: 0,
    engagementDepth: 0,
    attentionSecondsNorm: 0,
    creatorQuality: 0,
    explorationUcb: 0,
    seenRecently: false,
    lastSeenAt: null,
    candidateSource: 'fresh',
    isFollowing: true,
    servedRecently: false,
    authorRendered30d: 1000,
    postRendered30d: 0,
    postMeaningful30d: 0,
    postAgeHours: 500,
    reports7d: 0,
    ...overrides,
  };
}

function byId(ranked: RankedShowcaseItem[], id: string) {
  const entry = ranked.find((candidate) => candidate.item.id === id);
  if (!entry) throw new Error(`missing ${id}`);
  return entry;
}

describe('author-diversity decay', () => {
  it('pins X\'s multiplier table for decay 0.5 and floor 0.25', () => {
    expect([0, 1, 2, 3].map((k) => authorDiversityMultiplier(k, 0.5, 0.25))).toEqual([1, 0.625, 0.4375, 0.34375]);
    expect(authorDiversityMultiplier(4, 0.5, 0.25)).toBe(0.296875);
    expect(authorDiversityMultiplier(3, 1, 0.25)).toBe(1);
    expect(authorDiversityMultiplier(3, 0.5, 1)).toBe(1);
  });

  it('counts same-creator posts ranked above and multiplies each score', () => {
    const items = [
      item('a-0', 'creator-a', '2026-10-10T04:00:00.000Z'),
      item('a-1', 'creator-a', '2026-10-10T03:00:00.000Z'),
      item('a-2', 'creator-a', '2026-10-10T02:00:00.000Z'),
      item('a-3', 'creator-a', '2026-10-10T01:00:00.000Z'),
    ];
    const ranked = rankAndDiversifyShowcaseItems({
      items,
      featureRows: items.map((entry) => row(entry.id, { interestMatch: 1 })),
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity({ max_creator_per_20: 20, cold_start_slot_rank: 0 }),
    });
    const offset = 0.24 + 0.001;

    expect(ranked.map((entry) => explainRankedFeedScore(entry).authorDecay)).toEqual([
      { k: 0, multiplier: 1 },
      { k: 1, multiplier: 0.625 },
      { k: 2, multiplier: 0.4375 },
      { k: 3, multiplier: 0.34375 },
    ]);
    expect(ranked.map((entry) => entry.score)).toEqual([
      offset,
      offset * 0.625,
      offset * 0.4375,
      offset * 0.34375,
    ]);
  });

  it('re-sorts after the decay, so a creator\'s second post can fall below other creators', () => {
    const items = [item('a-1', 'creator-a'), item('a-2', 'creator-a'), item('b-1', 'creator-b'), item('c-1', 'creator-c')];
    const featureRows = [
      row('a-1', { interestMatch: 1, freshness: 1 }),
      row('a-2', { interestMatch: 1, freshness: 0.25 }),
      row('b-1', { interestMatch: 0.9 }),
      row('c-1', { interestMatch: 0.8 }),
    ];
    const rank = (authorDecay: number) => rankAndDiversifyShowcaseItems({
      items,
      featureRows,
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity({
        author_decay: authorDecay,
        max_creator_per_20: 20,
        cold_start_slot_rank: 0,
      }),
    }).map((entry) => entry.item.id);

    // Without the decay a-2 is only held back by the back-to-back rule.
    expect(rank(1)).toEqual(['a-1', 'b-1', 'a-2', 'c-1']);
    expect(rank(0.5)).toEqual(['a-1', 'b-1', 'c-1', 'a-2']);
  });
});

describe('out-of-network discount', () => {
  it('multiplies posts from creators the viewer does not follow', () => {
    const items = [item('followed', 'creator-f'), item('stranger', 'creator-s')];
    const featureRows = [
      row('followed', { interestMatch: 0.45, isFollowing: true }),
      row('stranger', { interestMatch: 0.5, isFollowing: false }),
    ];
    const rank = (multiplier: number) => rankAndDiversifyShowcaseItems({
      items,
      featureRows,
      scoreWeights: V3_WEIGHTS,
      diversityConfig: normalizeRankedFeedDiversityConfig({ out_of_network_multiplier: multiplier }),
    });

    const off = rank(1);
    expect(off.map((entry) => entry.item.id)).toEqual(['stranger', 'followed']);
    expect(byId(off, 'stranger').score).toBe(0.24 * 0.5);

    const on = rank(0.75);
    expect(on.map((entry) => entry.item.id)).toEqual(['followed', 'stranger']);
    expect(byId(on, 'stranger').score).toBe((0.24 * 0.5 + 0.001) * 0.75);
    expect(byId(on, 'followed').score).toBe(0.24 * 0.45 + 0.001);
    expect(explainRankedFeedScore(byId(on, 'stranger')).oonMultiplier).toBe(0.75);
    expect(explainRankedFeedScore(byId(on, 'followed')).oonMultiplier).toBe(1);
  });

  it('treats a row without the follow column as out of network', () => {
    const legacy = row('legacy', { interestMatch: 0.5 });
    delete legacy.isFollowing;
    const ranked = rankAndDiversifyShowcaseItems({
      items: [item('legacy', 'creator-l')],
      featureRows: [legacy],
      scoreWeights: V3_WEIGHTS,
      diversityConfig: normalizeRankedFeedDiversityConfig({ out_of_network_multiplier: 0.75 }),
    });
    expect(explainRankedFeedScore(ranked[0]).oonMultiplier).toBe(0.75);
  });
});

describe('served penalty', () => {
  it('applies only to a post served but not seen; a seen post takes the seen penalty alone', () => {
    const items = [item('plain', 'creator-p'), item('served', 'creator-v'), item('seen', 'creator-s')];
    const ranked = rankAndDiversifyShowcaseItems({
      items,
      featureRows: [
        row('plain', { interestMatch: 0.5 }),
        row('served', { interestMatch: 0.5, servedRecently: true }),
        row('seen', { interestMatch: 0.5, servedRecently: true, seenRecently: true, lastSeenAt: '2026-10-09T00:00:00.000Z' }),
      ],
      scoreWeights: V3_WEIGHTS,
      diversityConfig: normalizeRankedFeedDiversityConfig({ served_penalty: 0.5 }),
      seenPenalty: 0.2,
    });
    const offset = 0.24 * 0.5 + 0.001;

    expect(ranked.map((entry) => entry.item.id)).toEqual(['plain', 'served', 'seen']);
    expect(byId(ranked, 'plain').score).toBe(offset);
    expect(byId(ranked, 'served').score).toBe(offset * 0.5);
    expect(byId(ranked, 'seen').score).toBe(offset * 0.2);
    expect(explainRankedFeedScore(byId(ranked, 'plain'))).toMatchObject({ seenPenalty: null, servedPenalty: null });
    expect(explainRankedFeedScore(byId(ranked, 'served'))).toMatchObject({ seenPenalty: null, servedPenalty: 0.5 });
    expect(explainRankedFeedScore(byId(ranked, 'seen'))).toMatchObject({ seenPenalty: 0.2, servedPenalty: null });
  });

  it('keeps a served post in the unseen tier, above any repeat', () => {
    const ranked = rankAndDiversifyShowcaseItems({
      items: [item('seen-strong', 'creator-a'), item('served-weak', 'creator-b')],
      featureRows: [
        row('seen-strong', { interestMatch: 1, seenRecently: true }),
        row('served-weak', { interestMatch: 0.05, servedRecently: true }),
      ],
      scoreWeights: V3_WEIGHTS,
      diversityConfig: normalizeRankedFeedDiversityConfig({ served_penalty: 0.01 }),
    });
    expect(ranked.map((entry) => entry.item.id)).toEqual(['served-weak', 'seen-strong']);
  });
});

describe('net-negative offset', () => {
  it('maps net-positive scores to at least 0.001 and net-negative ones into [0, 0.001·N/T)', () => {
    // v3: N = 0.30 + 2.5, T = N + 1.12.
    expect(offsetRankedFeedScore(0, V3_WEIGHTS)).toBe(0.001);
    expect(offsetRankedFeedScore(0.3, V3_WEIGHTS)).toBe(0.3 + 0.001);
    expect(offsetRankedFeedScore(-2.8, V3_WEIGHTS)).toBeCloseTo(0, 12);
    expect(offsetRankedFeedScore(-1.4, V3_WEIGHTS)).toBeCloseTo((1.4 / 3.92) * 0.001, 12);
    expect(offsetRankedFeedScore(-1e-9, V3_WEIGHTS)).toBeLessThan(0.001 * (2.8 / 3.92));
  });

  it('sinks a net-negative post below every net-positive one, even after the decay nears its 0.25 floor', () => {
    const creatorPosts = Array.from({ length: 6 }, (_, index) => (
      item(`a-${index}`, 'creator-a', `2026-10-10T0${9 - index}:00:00.000Z`)
    ));
    const negative = item('reported', 'creator-z');
    const ranked = rankAndDiversifyShowcaseItems({
      items: [...creatorPosts, negative],
      featureRows: [
        ...creatorPosts.map((entry) => row(entry.id, { interestMatch: 1, engagementDepth: 0.5, isFollowing: false })),
        // Followed, never decayed: the strongest a net-negative post can be.
        row('reported', { interestMatch: 1, freshness: 1, engagementDepth: 1, negativeFeedbackRisk: 0.5, isFollowing: true }),
      ],
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity({ max_creator_per_20: 20, cold_start_slot_rank: 0 }),
    });
    const sunk = byId(ranked, 'reported');
    const positives = ranked.filter((entry) => entry.item.id !== 'reported');

    expect(explainRankedFeedScore(sunk).base).toBeLessThan(0);
    expect(sunk.score).toBeGreaterThanOrEqual(0);
    expect(sunk.score).toBeLessThan(0.001);
    expect(explainRankedFeedScore(positives.at(-1)!).authorDecay).toEqual({ k: 5, multiplier: 0.2734375 });
    for (const entry of positives) expect(entry.score).toBeGreaterThan(sunk.score);
  });

  it('is not applied while every multiplier is off', () => {
    const ranked = rankAndDiversifyShowcaseItems({
      items: [item('negative', 'creator-n')],
      featureRows: [row('negative', { negativeFeedbackRisk: 0.5 })],
      scoreWeights: V3_WEIGHTS,
    });
    expect(ranked[0].score).toBe(scoreRankedFeedFeatures(ranked[0].features, V3_WEIGHTS));
    expect(ranked[0].score).toBe(-1.25);
  });
});

describe('cold-start slot', () => {
  // Eight established posts from followed creators, then three cold posts
  // from new, unfollowed creators that rank at the bottom on score alone.
  const established = Array.from({ length: 8 }, (_, index) => item(`est-${index}`, `creator-est-${index}`));
  const coldItems = [item('cold-a', 'creator-new-a'), item('cold-b', 'creator-new-b'), item('cold-c', 'creator-new-c')];
  const coldRows = [
    ...established.map((entry, index) => row(entry.id, { interestMatch: 0.9 - index * 0.05 })),
    row('cold-a', { interestMatch: 0.2, isFollowing: false, candidateSource: 'cold', authorRendered30d: 0, postAgeHours: 5 }),
    row('cold-b', {
      interestMatch: 0.15,
      isFollowing: false,
      candidateSource: 'cold',
      authorRendered30d: 10,
      postAgeHours: 30,
      postRendered30d: 20,
      postMeaningful30d: 8,
    }),
    row('cold-c', {
      interestMatch: 0.1,
      isFollowing: false,
      candidateSource: 'cold',
      authorRendered30d: 59,
      postAgeHours: 168,
      postRendered30d: 40,
      postMeaningful30d: 1,
    }),
  ];
  const rankCold = (seed: number, overrides: Record<string, unknown> = {}) => rankAndDiversifyShowcaseItems({
    items: [...established, ...coldItems],
    featureRows: coldRows,
    scoreWeights: V3_WEIGHTS,
    diversityConfig: v3Diversity(overrides),
    seed,
  });

  it('draws θ ~ Beta(7.5 + m, 42.5 + r − m) for each eligible post, in ranked order, from the seed', () => {
    // Slot rank 60 can never lift in an 11-post list: the order is the pre-lift one.
    const ranked = rankCold(7, { cold_start_slot_rank: 60 });
    const eligible = ranked.filter((entry) => explainRankedFeedScore(entry).coldStart !== null);
    const random = mulberry32(7);

    expect(eligible.map((entry) => entry.item.id)).toEqual(['cold-a', 'cold-b', 'cold-c']);
    expect(eligible.map((entry) => explainRankedFeedScore(entry).coldStart?.theta)).toEqual([
      sampleBeta(7.5, 42.5, random),
      sampleBeta(7.5 + 8, 42.5 + 12, random),
      sampleBeta(7.5 + 1, 42.5 + 39, random),
    ]);
  });

  // Seed 7 draws θ in the order b > a > c: cold-b has the best θ, but of the
  // top two cold-a scores higher, so cold-a is the pick. Seed 2 draws b > c > a.
  it.each([
    [7, 'cold-a'],
    [2, 'cold-b'],
  ])('with seed %i lifts exactly one pick (%s), the higher score of the top two θ, and moves nothing else', (seed, pickId) => {
    const ranked = rankCold(seed);
    const preLift = rankCold(seed, { cold_start_slot_rank: 60 });
    const draws = preLift
      .map((entry, index) => ({ entry, index, theta: explainRankedFeedScore(entry).coldStart?.theta ?? null }))
      .filter((draw): draw is { entry: RankedShowcaseItem; index: number; theta: number } => draw.theta !== null)
      .sort((left, right) => right.theta - left.theta || left.index - right.index);
    const [first, second] = draws;
    const expectedPick = second.entry.score > first.entry.score ? second.entry : first.entry;

    expect(expectedPick.item.id).toBe(pickId);
    const lifted = ranked.filter((entry) => explainRankedFeedScore(entry).coldStart?.lifted);
    expect(lifted.map((entry) => entry.item.id)).toEqual([pickId]);
    expect(ranked.filter((entry) => explainRankedFeedScore(entry).coldStart?.picked)).toHaveLength(1);
    expect(ranked.findIndex((entry) => entry.item.id === pickId)).toBe(5);

    const withoutPick = (entries: RankedShowcaseItem[]) => entries
      .map((entry) => entry.item.id)
      .filter((id) => id !== pickId);
    expect(withoutPick(ranked)).toEqual(withoutPick(preLift));
    const scores = (entries: RankedShowcaseItem[]) => entries.map((entry) => entry.score).sort((a, b) => a - b);
    expect(scores(ranked)).toEqual(scores(preLift));

    // The same seed replays the same draws and the same pick.
    const coldStarts = (entries: RankedShowcaseItem[]) => entries
      .map((entry) => [entry.item.id, explainRankedFeedScore(entry).coldStart]);
    expect(coldStarts(rankCold(seed))).toEqual(coldStarts(ranked));
  });

  it('does not move a pick that already sits at or above the slot', () => {
    // A followed cold author whose post ranks fourth (index 3) on score.
    const items = [item('cold-high', 'creator-new'), ...established.slice(0, 6)];
    const featureRows = [
      row('cold-high', { interestMatch: 0.77, candidateSource: 'cold', authorRendered30d: 3, postAgeHours: 2 }),
      ...established.slice(0, 6).map((entry, index) => row(entry.id, { interestMatch: 0.9 - index * 0.05 })),
    ];
    const rank = (slot: number) => rankAndDiversifyShowcaseItems({
      items,
      featureRows,
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity({ cold_start_slot_rank: slot }),
      seed: 11,
    }).map((entry) => ({ id: entry.item.id, score: entry.score, coldStart: explainRankedFeedScore(entry).coldStart }));
    const slotOff = rank(0).map(({ id, score }) => [id, score]);

    for (const slot of [6, 4]) {
      const ranked = rank(slot);
      expect(ranked[3]).toMatchObject({ id: 'cold-high', coldStart: { picked: true, lifted: false } });
      expect(ranked.map(({ id, score }) => [id, score])).toEqual(slotOff);
    }
    // One rank higher and it moves.
    expect(rank(3)[2]).toMatchObject({ id: 'cold-high', coldStart: { picked: true, lifted: true } });
  });

  it('lifts nothing when no post is eligible', () => {
    const items = [...established, ...['seen', 'served', 'unknown-author', 'too-old', 'exposed-author', 'unknown-age']
      .map((id) => item(id, `creator-${id}`))];
    const ineligible = {
      interestMatch: 0.1,
      isFollowing: false,
      authorRendered30d: 0,
      postAgeHours: 1,
    };
    const featureRows = [
      ...established.map((entry, index) => row(entry.id, { interestMatch: 0.9 - index * 0.05 })),
      row('seen', { ...ineligible, seenRecently: true }),
      row('served', { ...ineligible, servedRecently: true }),
      row('unknown-author', { ...ineligible, authorRendered30d: null }),
      row('too-old', { ...ineligible, postAgeHours: 168.5 }),
      row('exposed-author', { ...ineligible, authorRendered30d: 60 }),
      row('unknown-age', { ...ineligible, postAgeHours: null }),
    ];
    const rank = (slot: number) => rankAndDiversifyShowcaseItems({
      items,
      featureRows,
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity({ cold_start_slot_rank: slot }),
      seed: 7,
    });

    const ranked = rank(6);
    expect(ranked.every((entry) => explainRankedFeedScore(entry).coldStart === null)).toBe(true);
    expect(ranked.map((entry) => [entry.item.id, entry.score]))
      .toEqual(rank(0).map((entry) => [entry.item.id, entry.score]));
  });

  it('is off at slot rank 0', () => {
    const ranked = rankCold(7, { cold_start_slot_rank: 0 });
    expect(ranked.every((entry) => explainRankedFeedScore(entry).coldStart === null)).toBe(true);
    expect(ranked.slice(-3).map((entry) => entry.item.id)).toEqual(['cold-a', 'cold-b', 'cold-c']);
  });

  it('never picks a post served in the lookback and still unseen, as a quick skip leaves it', () => {
    // Without the served rule both cold posts draw, and of the top two θ the
    // skipped one scores higher even after its served penalty, so it would
    // come back at the slot in every new session.
    const items = [...established, item('skipped', 'creator-new-s'), item('unserved', 'creator-new-u')];
    const cold = { isFollowing: false, candidateSource: 'cold' as const, authorRendered30d: 0, postAgeHours: 5 };
    const ranked = rankAndDiversifyShowcaseItems({
      items,
      featureRows: [
        ...established.map((entry, index) => row(entry.id, { interestMatch: 0.9 - index * 0.05 })),
        row('skipped', { ...cold, interestMatch: 0.6, servedRecently: true }),
        row('unserved', { ...cold, interestMatch: 0.1 }),
      ],
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity(),
      seed: 7,
    });

    expect(explainRankedFeedScore(byId(ranked, 'skipped')).coldStart).toBeNull();
    expect(explainRankedFeedScore(byId(ranked, 'unserved')).coldStart).toMatchObject({ picked: true, lifted: true });
    expect(ranked.findIndex((entry) => entry.item.id === 'unserved')).toBe(5);
    expect(ranked.at(-1)?.item.id).toBe('skipped');
  });

  // The slot is placed by the greedy pass, so it cannot undo the pass's rules.
  const sameCreatorNeighbours = (ranked: RankedShowcaseItem[]) => ranked
    .filter((entry, index) => index > 0 && entry.item.creator.id === ranked[index - 1].item.creator.id)
    .length;

  it('takes the slot without leaving a same-creator pair where the pick was', () => {
    // Greedy alone: A B A B A B A C A A. Splicing C up to index 5 used to give
    // A B A B A C B A A A, joining two A posts where C had separated them.
    const posts = [
      ...Array.from({ length: 6 }, (_, index) => item(`a-${index}`, 'creator-a')),
      ...Array.from({ length: 3 }, (_, index) => item(`b-${index}`, 'creator-b')),
      item('cold', 'creator-new'),
    ];
    const featureRows = [
      ...Array.from({ length: 6 }, (_, index) => row(`a-${index}`, { interestMatch: 0.9 - index * 0.01 })),
      ...Array.from({ length: 3 }, (_, index) => row(`b-${index}`, { interestMatch: 0.6 - index * 0.01 })),
      row('cold', { interestMatch: 0.1, isFollowing: false, candidateSource: 'cold', authorRendered30d: 0, postAgeHours: 5 }),
    ];
    const rank = (slot: number) => rankAndDiversifyShowcaseItems({
      items: posts,
      featureRows,
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity({ max_creator_per_20: 20, author_decay: 1, cold_start_slot_rank: slot }),
      seed: 7,
    });

    const slotOff = rank(0);
    expect(slotOff.map((entry) => entry.item.id))
      .toEqual(['a-0', 'b-0', 'a-1', 'b-1', 'a-2', 'b-2', 'a-3', 'cold', 'a-4', 'a-5']);
    const ranked = rank(6);
    expect(ranked.map((entry) => entry.item.id))
      .toEqual(['a-0', 'b-0', 'a-1', 'b-1', 'a-2', 'cold', 'a-3', 'b-2', 'a-4', 'a-5']);
    expect(explainRankedFeedScore(byId(ranked, 'cold')).coldStart).toMatchObject({ picked: true, lifted: true });
    // Only the pair the pass could not avoid either way: two A posts left over.
    expect(sameCreatorNeighbours(slotOff)).toBe(1);
    expect(sameCreatorNeighbours(ranked)).toBe(1);
  });

  it('waits past the slot until the fatigue rules admit the pick', () => {
    // The cold author's older post ranks fifth (index 4), so the slot at index 5
    // would put the same creator back to back; the pick takes index 6.
    const posts = [...established, item('new-older', 'creator-new'), item('new-cold', 'creator-new')];
    const ranked = rankAndDiversifyShowcaseItems({
      items: posts,
      featureRows: [
        ...established.map((entry, index) => row(entry.id, { interestMatch: 0.9 - index * 0.05 })),
        row('new-older', { interestMatch: 0.72, authorRendered30d: 3, postAgeHours: 500 }),
        row('new-cold', { interestMatch: 0.1, candidateSource: 'cold', authorRendered30d: 3, postAgeHours: 2 }),
      ],
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity(),
      seed: 7,
    });

    expect(ranked.map((entry) => entry.item.id)).toEqual([
      'est-0', 'est-1', 'est-2', 'est-3', 'new-older', 'est-4', 'new-cold', 'est-5', 'est-6', 'est-7',
    ]);
    expect(explainRankedFeedScore(byId(ranked, 'new-cold')).coldStart).toMatchObject({ picked: true, lifted: true });
    expect(sameCreatorNeighbours(ranked)).toBe(0);
  });

  it('keeps a quota-forced exploration post in its block of 10, and never takes a position the quota claims', () => {
    // Greedy alone serves the exploration post last in block one (index 9) and
    // the cold post at the end. Splicing the cold post up to index 5 used to
    // push the exploration post to index 10, leaving block one without one.
    const posts = [
      ...Array.from({ length: 12 }, (_, index) => item(`est-${index}`, `creator-est-${index}`)),
      item('explore', 'creator-explore'),
      item('cold', 'creator-new'),
    ];
    const featureRows = [
      ...Array.from({ length: 12 }, (_, index) => row(`est-${index}`, { interestMatch: 0.9 - index * 0.02 })),
      row('explore', { interestMatch: 0.3, candidateSource: 'exploration' }),
      row('cold', { interestMatch: 0.1, isFollowing: false, candidateSource: 'cold', authorRendered30d: 0, postAgeHours: 5 }),
    ];
    const rank = (slot: number) => rankAndDiversifyShowcaseItems({
      items: posts,
      featureRows,
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity({ cold_start_slot_rank: slot }),
      seed: 7,
    }).map((entry) => entry.item.id);
    const established12 = Array.from({ length: 12 }, (_, index) => `est-${index}`);

    expect(rank(0)).toEqual([...established12.slice(0, 9), 'explore', ...established12.slice(9), 'cold']);
    expect(rank(6)).toEqual([
      ...established12.slice(0, 5), 'cold', ...established12.slice(5, 8), 'explore', ...established12.slice(8),
    ]);
    // A slot at rank 10 meets the quota's own position: the quota keeps it and
    // the pick takes the next one.
    expect(rank(10)).toEqual([...established12.slice(0, 9), 'explore', 'cold', ...established12.slice(9)]);
  });
});

describe('explainRankedFeedScore', () => {
  it('returns a fresh JSON-safe copy of every component', () => {
    const ranked = rankAndDiversifyShowcaseItems({
      items: [item('a', 'creator-a')],
      featureRows: [row('a', { interestMatch: 0.5, isFollowing: false, servedRecently: true })],
      scoreWeights: V3_WEIGHTS,
      diversityConfig: v3Diversity({ cold_start_slot_rank: 0 }),
    });
    const explained = explainRankedFeedScore(ranked[0]);

    expect(explained).toEqual({
      base: 0.24 * 0.5,
      offset: 0.24 * 0.5 + 0.001,
      seenPenalty: null,
      servedPenalty: 0.5,
      oonMultiplier: 0.75,
      authorDecay: { k: 0, multiplier: 1 },
      coldStart: null,
    });
    expect(ranked[0].score).toBe((0.24 * 0.5 + 0.001) * 0.5 * 0.75);
    expect(JSON.parse(JSON.stringify(explained))).toEqual(explained);
    explained.authorDecay.k = 9;
    expect(ranked[0].components.authorDecay.k).toBe(0);
  });
});
