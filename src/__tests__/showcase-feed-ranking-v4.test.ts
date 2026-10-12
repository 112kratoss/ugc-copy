import { describe, expect, it } from 'vitest';

import { normalizeRetrievalConfig } from '@/lib/showcase-feed-personalization';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import {
  DEFAULT_RANKED_FEED_SCORE_WEIGHTS,
  FOR_YOU_RULES_V3_DIVERSITY_CONFIG,
  FOR_YOU_RULES_V3_RETRIEVAL_CONFIG,
  FOR_YOU_RULES_V3_WEIGHTS,
  FOR_YOU_RULES_V4_DIVERSITY_CONFIG,
  FOR_YOU_RULES_V4_RETRIEVAL_CONFIG,
  FOR_YOU_RULES_V4_WEIGHTS,
  buildFallbackRankedFeedFeatures,
  buildRecommendationContext,
  normalizeRankedFeedDiversityConfig,
  normalizeRankedFeedFeatureRow,
  normalizeRankedFeedScoreWeights,
  offsetRankedFeedScore,
  rankAndDiversifyShowcaseItems,
  scoreRankedFeedFeatures,
  type RankedFeedFeatureRow,
} from '@/lib/showcase-feed-ranking';

/** `max_creator_per_20` → `maxCreatorPer20`: the stored key as the normalizers name it. */
function camelCaseKeys(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase()),
    entry,
  ]));
}

function features(overrides: Partial<RankedFeedFeatureRow> & { postId: string }): RankedFeedFeatureRow {
  return {
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
    ...overrides,
  };
}

function item(id: string, creatorId = `creator-${id}`): ShowcaseFeedItem {
  return {
    id,
    title: id,
    createdAt: '2026-10-10T00:00:00.000Z',
    saveCount: 0,
    remixCount: 0,
    creator: { id: creatorId, username: creatorId, name: creatorId, avatar: null },
    asset: null,
  } as unknown as ShowcaseFeedItem;
}

describe('for-you-rules v4 seeded row', () => {
  // Hard-coded from docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md
  // §2.10, the same JSON the migration test pins the seeded row to.
  it('exports the version JSON exactly as the plan seeds it', () => {
    expect(FOR_YOU_RULES_V4_WEIGHTS).toEqual({
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
    });
    expect(FOR_YOU_RULES_V4_RETRIEVAL_CONFIG).toEqual({
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
    });
    expect(FOR_YOU_RULES_V4_DIVERSITY_CONFIG).toEqual(FOR_YOU_RULES_V3_DIVERSITY_CONFIG);
  });

  it('changes only the stated keys from v3', () => {
    const changed = (v3: Record<string, unknown>, v4: Record<string, unknown>) => Object.keys(v4)
      .filter((key) => v3[key] !== v4[key])
      .sort();
    expect(changed(FOR_YOU_RULES_V3_WEIGHTS, FOR_YOU_RULES_V4_WEIGHTS)).toEqual(['interest_match', 'semantic_similarity']);
    expect(changed(FOR_YOU_RULES_V3_RETRIEVAL_CONFIG, FOR_YOU_RULES_V4_RETRIEVAL_CONFIG)).toEqual([
      'candidate_rpc',
      'exclude_labelled_accounts',
      'exclude_near_duplicates',
      'semantic_limit',
      'semantic_min_similarity',
      'taste_limit',
      'taste_lookback_days',
    ]);
    // The diversity row is unchanged: the cluster cap finally has clusters to act on.
    expect(FOR_YOU_RULES_V4_DIVERSITY_CONFIG.max_semantic_cluster_per_20).toBe(3);
  });

  // toEqual in both directions: no key is clamped or dropped, and the
  // normalizer reads nothing the seeded row leaves to a default.
  it('reads every weight at its seeded value', () => {
    expect(normalizeRankedFeedScoreWeights(FOR_YOU_RULES_V4_WEIGHTS)).toEqual(camelCaseKeys(FOR_YOU_RULES_V4_WEIGHTS));
  });

  it('reads every retrieval_config key at its seeded value', () => {
    const { visibilityThresholds, ...retrieval } = normalizeRetrievalConfig(FOR_YOU_RULES_V4_RETRIEVAL_CONFIG);
    expect({ ...retrieval, ...visibilityThresholds }).toEqual(camelCaseKeys(FOR_YOU_RULES_V4_RETRIEVAL_CONFIG));
  });

  it('reads every diversity_config key at its seeded value', () => {
    expect(normalizeRankedFeedDiversityConfig(FOR_YOU_RULES_V4_DIVERSITY_CONFIG))
      .toEqual(camelCaseKeys(FOR_YOU_RULES_V4_DIVERSITY_CONFIG));
  });
});

describe('semantic_similarity weight', () => {
  it('defaults to 0, so no earlier version weighs a taste vector', () => {
    expect(DEFAULT_RANKED_FEED_SCORE_WEIGHTS.semanticSimilarity).toBe(0);
    expect(normalizeRankedFeedScoreWeights({}).semanticSimilarity).toBe(0);
    expect(normalizeRankedFeedScoreWeights({ semantic_similarity: 11 }).semanticSimilarity).toBe(0);
    expect(normalizeRankedFeedScoreWeights({ semantic_similarity: 'x' }).semanticSimilarity).toBe(0);
    expect(scoreRankedFeedFeatures(features({ postId: 'a', semanticSimilarity: 1 }))).toBe(0);
  });

  it('adds weight × clamp01(similarity) to the linear score', () => {
    const weights = normalizeRankedFeedScoreWeights(FOR_YOU_RULES_V4_WEIGHTS);
    const plain = features({ postId: 'a', interestMatch: 0.5, freshness: 0.4 });
    const base = scoreRankedFeedFeatures(plain, weights);

    expect(scoreRankedFeedFeatures({ ...plain, semanticSimilarity: 0.5 }, weights)).toBeCloseTo(base + 0.07, 12);
    // Clamped to [0, 1] like every other feature; a row without it reads 0.
    expect(scoreRankedFeedFeatures({ ...plain, semanticSimilarity: 3 }, weights)).toBeCloseTo(base + 0.14, 12);
    expect(scoreRankedFeedFeatures({ ...plain, semanticSimilarity: -1 }, weights)).toBe(base);
    expect(scoreRankedFeedFeatures({ ...plain, semanticSimilarity: Number.NaN }, weights)).toBe(base);
  });

  it('counts the weight in the net-negative offset\'s positive total', () => {
    const weights = normalizeRankedFeedScoreWeights(FOR_YOU_RULES_V4_WEIGHTS);
    // Σ|negative| = 2.8; Σ positive = 1.18 with the 0.14 semantic weight (v3's 1.12 − 0.08 + 0.14).
    expect(offsetRankedFeedScore(-1, weights)).toBeCloseTo(((-1 + 2.8) / (2.8 + 1.18)) * 0.001, 15);
  });

  it('ranks a post closer to the viewer\'s taste above an otherwise equal one', () => {
    const ranked = rankAndDiversifyShowcaseItems({
      items: [item('far'), item('close')],
      featureRows: [
        features({ postId: 'far', interestMatch: 0.5, semanticSimilarity: 0.1 }),
        features({ postId: 'close', interestMatch: 0.5, semanticSimilarity: 0.9, candidateSource: 'semantic' }),
      ],
      scoreWeights: normalizeRankedFeedScoreWeights(FOR_YOU_RULES_V4_WEIGHTS),
      diversityConfig: normalizeRankedFeedDiversityConfig(FOR_YOU_RULES_V4_DIVERSITY_CONFIG),
    });

    expect(ranked.map((entry) => entry.item.id)).toEqual(['close', 'far']);
  });
});

describe('normalizeRankedFeedFeatureRow v4 columns', () => {
  it('reads semantic_similarity, semantic_cluster and taste_available', () => {
    expect(normalizeRankedFeedFeatureRow({
      post_id: 'post-1',
      candidate_source: 'semantic',
      semantic_similarity: 0.62,
      semantic_cluster: 'c12',
      taste_available: true,
    })).toMatchObject({
      candidateSource: 'semantic',
      semanticSimilarity: 0.62,
      semanticCluster: 'c12',
      tasteAvailable: true,
      sources: ['semantic'],
    });
  });

  it('defaults every v4 column when a pre-v4 row lacks it, and clamps the similarity', () => {
    expect(normalizeRankedFeedFeatureRow({ post_id: 'post-2' })).toMatchObject({
      semanticSimilarity: 0,
      semanticCluster: null,
      tasteAvailable: false,
    });
    expect(normalizeRankedFeedFeatureRow({ post_id: 'post-3', semantic_similarity: 1.7, taste_available: 'true' }))
      .toMatchObject({ semanticSimilarity: 1, tasteAvailable: false });
    expect(normalizeRankedFeedFeatureRow({ post_id: 'post-4', semantic_similarity: -0.4, semantic_cluster: null }))
      .toMatchObject({ semanticSimilarity: 0, semanticCluster: null });
  });

  it('reads back the camelCase names a persisted row may carry', () => {
    expect(normalizeRankedFeedFeatureRow({ postId: 'post-5', semanticSimilarity: 0.3, tasteAvailable: true }))
      .toMatchObject({ semanticSimilarity: 0.3, tasteAvailable: true });
  });

  it('gives a fallback row no taste', () => {
    expect(buildFallbackRankedFeedFeatures(item('top-up'), new Date('2026-10-12T00:00:00.000Z'))).toMatchObject({
      semanticSimilarity: 0,
      tasteAvailable: false,
    });
  });
});

describe('semantic source reason', () => {
  it('tells the viewer the post is close to what they saved', () => {
    expect(buildRecommendationContext({
      deliveryId: '7',
      features: features({ postId: 'a', candidateSource: 'semantic' }),
      position: 0,
      algorithmVersion: 'for-you-rules-v4',
    })).toEqual({
      deliveryId: '7',
      position: 0,
      reason: 'Close to what you saved',
      algorithmVersion: 'for-you-rules-v4',
      candidateSource: 'semantic',
    });
  });
});

describe('semantic cluster diversity', () => {
  it('lets max_semantic_cluster_per_20 cap a cluster now that clusters exist', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id));
    const featureRows = items.map((entry, index) => features({
      postId: entry.id,
      interestMatch: 1 - index * 0.1,
      semanticCluster: index < 4 ? 'c1' : 'c2',
    }));
    const ranked = rankAndDiversifyShowcaseItems({
      items,
      featureRows,
      scoreWeights: normalizeRankedFeedScoreWeights({ interest_match: 1 }),
      diversityConfig: normalizeRankedFeedDiversityConfig({ ...FOR_YOU_RULES_V4_DIVERSITY_CONFIG, exploration_per_10: 0 }),
    });

    // Three from c1, then the c2 post before c1's fourth.
    expect(ranked.map((entry) => entry.item.id)).toEqual(['a', 'b', 'c', 'e', 'd']);
  });
});
