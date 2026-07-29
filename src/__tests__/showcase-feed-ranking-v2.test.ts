import { describe, expect, it } from 'vitest';

import type { ShowcaseFeedItem } from '@/lib/showcase';
import {
  DEFAULT_RANKED_FEED_SCORE_WEIGHTS,
  DEFAULT_SEEN_REPEAT_PENALTY,
  normalizeRankedFeedFeatureRow,
  normalizeRankedFeedScoreWeights,
  rankAndDiversifyShowcaseItems,
  scoreRankedFeedFeatures,
  type RankedFeedFeatureRow,
} from '@/lib/showcase-feed-ranking';

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
    createdAt: '2026-07-01T00:00:00.000Z',
    saveCount: 0,
    remixCount: 0,
    creator: { id: creatorId, username: creatorId, displayName: creatorId, avatarUrl: null },
  } as unknown as ShowcaseFeedItem;
}

describe('v2 score weights', () => {
  it('leaves v2 features inert unless a version explicitly weights them', () => {
    expect(DEFAULT_RANKED_FEED_SCORE_WEIGHTS.engagementDepth).toBe(0);
    expect(DEFAULT_RANKED_FEED_SCORE_WEIGHTS.creatorQuality).toBe(0);
    expect(DEFAULT_RANKED_FEED_SCORE_WEIGHTS.explorationUcb).toBe(0);

    const deepWatch = features({ postId: 'a', engagementDepth: 1, attentionSecondsNorm: 1 });
    expect(scoreRankedFeedFeatures(deepWatch)).toBe(0);
  });

  it('reads the v2 weight keys from a stored algorithm version', () => {
    const weights = normalizeRankedFeedScoreWeights({
      engagement_depth: 0.24,
      attention_seconds_norm: 0.08,
      creator_quality: 0.06,
      exploration_ucb: 0.1,
    });

    expect(weights.engagementDepth).toBe(0.24);
    expect(weights.attentionSecondsNorm).toBe(0.08);
    expect(weights.creatorQuality).toBe(0.06);
    expect(weights.explorationUcb).toBe(0.1);
    // Unspecified keys must keep their v1 values rather than collapsing to 0.
    expect(weights.negativeFeedbackRisk).toBe(-0.8);
  });

  it('lets watch depth outweigh raw freshness under v2 weights', () => {
    const v2 = normalizeRankedFeedScoreWeights({
      freshness: 0.12,
      engagement_depth: 0.24,
    });
    const watched = scoreRankedFeedFeatures(features({ postId: 'a', engagementDepth: 0.9 }), v2);
    const brandNew = scoreRankedFeedFeatures(features({ postId: 'b', freshness: 1 }), v2);

    expect(watched).toBeGreaterThan(brandNew);
  });
});

describe('normalizeRankedFeedFeatureRow v2 fields', () => {
  it('reads seen flags and v2 features from snake_case RPC rows', () => {
    const row = normalizeRankedFeedFeatureRow({
      post_id: 'post-1',
      engagement_depth: 0.8,
      attention_seconds_norm: 0.5,
      creator_quality: 0.15,
      exploration_ucb: 0.93,
      seen_recently: true,
      last_seen_at: '2026-07-20T00:00:00.000Z',
      candidate_source: 'exploration',
    });

    expect(row).toMatchObject({
      postId: 'post-1',
      engagementDepth: 0.8,
      attentionSecondsNorm: 0.5,
      creatorQuality: 0.15,
      explorationUcb: 0.93,
      seenRecently: true,
      lastSeenAt: '2026-07-20T00:00:00.000Z',
      candidateSource: 'exploration',
    });
  });

  it('treats a missing seen flag as unseen rather than truthy', () => {
    const row = normalizeRankedFeedFeatureRow({ post_id: 'post-2' });
    expect(row?.seenRecently).toBe(false);
    expect(row?.lastSeenAt).toBeNull();
  });
});

describe('strict unseen-first reranking', () => {
  const weights = normalizeRankedFeedScoreWeights({ interest_match: 1 });

  it('ranks every unseen post above a far stronger repeat', () => {
    const ranked = rankAndDiversifyShowcaseItems({
      items: [item('seen-great'), item('unseen-weak')],
      featureRows: [
        features({ postId: 'seen-great', interestMatch: 1, seenRecently: true, lastSeenAt: '2026-07-20T00:00:00.000Z' }),
        features({ postId: 'unseen-weak', interestMatch: 0.01 }),
      ],
      scoreWeights: weights,
    });

    expect(ranked.map((entry) => entry.item.id)).toEqual(['unseen-weak', 'seen-great']);
  });

  it('applies the repeat penalty to the surfaced score so fallbacks are visible', () => {
    const ranked = rankAndDiversifyShowcaseItems({
      items: [item('seen')],
      featureRows: [features({ postId: 'seen', interestMatch: 1, seenRecently: true })],
      scoreWeights: weights,
      seenPenalty: 0.2,
    });

    expect(ranked[0].score).toBeCloseTo(0.2, 10);
  });

  it('orders repeats least-recently-seen first once unseen inventory is gone', () => {
    const ranked = rankAndDiversifyShowcaseItems({
      items: [item('recent-repeat'), item('stale-repeat')],
      featureRows: [
        features({ postId: 'recent-repeat', interestMatch: 0.5, seenRecently: true, lastSeenAt: '2026-07-27T00:00:00.000Z' }),
        features({ postId: 'stale-repeat', interestMatch: 0.5, seenRecently: true, lastSeenAt: '2026-07-01T00:00:00.000Z' }),
      ],
      scoreWeights: weights,
    });

    expect(ranked.map((entry) => entry.item.id)).toEqual(['stale-repeat', 'recent-repeat']);
  });

  it('prefers a diversity-fatigued unseen post over a repeat', () => {
    // Same creator three times: the third unseen post violates the
    // back-to-back rule, but a repeat is still the worse answer.
    const ranked = rankAndDiversifyShowcaseItems({
      items: [
        item('unseen-a', 'creator-1'),
        item('unseen-b', 'creator-1'),
        item('unseen-c', 'creator-1'),
        item('seen-x', 'creator-2'),
      ],
      featureRows: [
        features({ postId: 'unseen-a', interestMatch: 0.9 }),
        features({ postId: 'unseen-b', interestMatch: 0.8 }),
        features({ postId: 'unseen-c', interestMatch: 0.7 }),
        features({ postId: 'seen-x', interestMatch: 1, seenRecently: true }),
      ],
      scoreWeights: weights,
    });

    expect(ranked.at(-1)?.item.id).toBe('seen-x');
    expect(ranked.slice(0, 3).every((entry) => !entry.features.seenRecently)).toBe(true);
  });

  it('keeps the default penalty when none is configured', () => {
    expect(DEFAULT_SEEN_REPEAT_PENALTY).toBe(0.2);
  });
});
