import { describe, expect, it } from 'vitest';

import {
  buildFallbackRankedFeedFeatures,
  decodeRankedFeedCursor,
  encodeRankedFeedCursor,
  normalizeRankedFeedDiversityConfig,
  normalizeRankedFeedScoreWeights,
  rankAndDiversifyShowcaseItems,
  scoreRankedFeedFeatures,
  type RankedFeedFeatureRow,
} from '@/lib/showcase-feed-ranking';
import type { ShowcaseFeedItem } from '@/lib/showcase';

function createItem(id: string, overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: `https://example.com/${id}.jpg`,
    mediaKind: 'image',
    model: 'manual',
    title: id,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    createdAt: '2026-07-11T05:00:00.000Z',
    creator: { id: `creator-${id}`, username: id, name: id, avatar: null },
    sourceKind: 'manual',
    sourceTool: null,
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

function features(postId: string, overrides: Partial<RankedFeedFeatureRow> = {}): RankedFeedFeatureRow {
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
    candidateSource: 'fresh',
    ...overrides,
  };
}

describe('showcase feed ranking', () => {
  it('weights useful positive signals while strongly penalizing negative feedback', () => {
    const relevant = scoreRankedFeedFeatures(features('relevant', {
      interestMatch: 1,
      smoothedUsefulness: 1,
      freshness: 1,
    }));
    const negative = scoreRankedFeedFeatures(features('negative', {
      interestMatch: 1,
      smoothedUsefulness: 1,
      freshness: 1,
      negativeFeedbackRisk: 1,
    }));

    expect(relevant).toBeGreaterThan(0.6);
    expect(negative).toBeLessThan(0);
  });

  it('gives underexposed fresh posts an exploration path without raw-count dominance', () => {
    const now = new Date('2026-07-11T06:00:00.000Z');
    const fresh = buildFallbackRankedFeedFeatures(createItem('fresh'), now);
    const established = buildFallbackRankedFeedFeatures(createItem('established', {
      saveCount: 100,
      remixCount: 30,
      createdAt: '2026-06-01T00:00:00.000Z',
    }), now);

    expect(fresh.explorationBonus).toBeGreaterThan(established.explorationBonus);
    expect(established.smoothedUsefulness).toBeGreaterThan(fresh.smoothedUsefulness);
  });

  it('prevents adjacent posts and early-page domination by one creator when alternatives exist', () => {
    const sharedCreator = { id: 'creator-a', username: 'a', name: 'A', avatar: null };
    const items = [
      createItem('a-1', { creator: sharedCreator }),
      createItem('a-2', { creator: sharedCreator }),
      createItem('a-3', { creator: sharedCreator }),
      createItem('b-1'),
      createItem('c-1'),
    ];
    const ranked = rankAndDiversifyShowcaseItems({
      items,
      featureRows: items.map((item, index) => features(item.id, { interestMatch: 1 - index * 0.1 })),
    });

    expect(ranked[0].item.id).toBe('a-1');
    expect(ranked[1].item.creator.id).not.toBe('creator-a');
    expect(ranked.slice(0, 4).filter((entry) => entry.item.creator.id === 'creator-a')).toHaveLength(2);
  });

  it('applies database score and diversity configuration with safe defaults', () => {
    const weights = normalizeRankedFeedScoreWeights({
      interest_match: 0,
      freshness: 2,
      negative_feedback_risk: -3,
    });
    const diversity = normalizeRankedFeedDiversityConfig({
      max_creator_per_20: 4,
      exploration_per_10: 2,
      max_paid_share: 0.3,
    });

    expect(scoreRankedFeedFeatures(features('fresh', { freshness: 1 }), weights)).toBe(2);
    expect(weights.creatorAffinity).toBe(0.15);
    expect(diversity).toMatchObject({
      maxCreatorPer20: 4,
      explorationPer10: 2,
      maxPaidShare: 0.3,
    });
  });

  it('treats the creator cap as a rolling per-20 limit instead of a lifetime cap', () => {
    const sharedCreator = { id: 'creator-a', username: 'a', name: 'A', avatar: null };
    const creatorItems = Array.from({ length: 5 }, (_, index) => (
      createItem(`a-${index}`, { creator: sharedCreator })
    ));
    const alternatives = Array.from({ length: 25 }, (_, index) => createItem(`other-${index}`));
    const items = [...creatorItems, ...alternatives];
    const ranked = rankAndDiversifyShowcaseItems({
      items,
      featureRows: items.map((entry) => features(entry.id, {
        interestMatch: entry.creator.id === 'creator-a' ? 1 : 0.5,
      })),
    });

    expect(ranked.slice(0, 20).filter((entry) => entry.item.creator.id === 'creator-a')).toHaveLength(2);
    expect(ranked.slice(20).some((entry) => entry.item.creator.id === 'creator-a')).toBe(true);
  });

  it('round trips stable opaque cursors and rejects malformed values', () => {
    const encoded = encodeRankedFeedCursor({ sessionId: 'session-1', position: 24 });
    expect(decodeRankedFeedCursor(encoded)).toEqual({ sessionId: 'session-1', position: 24 });
    expect(decodeRankedFeedCursor('not-a-cursor')).toBeNull();
  });
});
