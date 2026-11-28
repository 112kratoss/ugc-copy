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
    commentCount: 0,
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

  // Owner's report, 2026-11-28: a pull to refresh on Explore brought back the
  // same posts in the same order. His lane held 49 posts and he had seen 47 of
  // them, so every ranking was the seen tier in score order: the same page.
  describe('repeats, once the reader has seen the catalog', () => {
    const SEEN_YESTERDAY = '2026-11-27T04:00:00.000Z';
    const posts = Array.from({ length: 12 }, (_, index) => createItem(`post-${String(index).padStart(2, '0')}`));
    // post-00 scores highest, post-11 lowest.
    const rank = (lastSeenAt: Map<string, string>) => rankAndDiversifyShowcaseItems({
      items: posts,
      featureRows: posts.map((post, index) => features(post.id, {
        interestMatch: 1 - index * 0.05,
        seenRecently: true,
        lastSeenAt: lastSeenAt.get(post.id) ?? SEEN_YESTERDAY,
      })),
    }).map((entry) => entry.item.id);

    it('leads the next ranking with other posts once the top of this one has been seen', () => {
      const seenAt = new Map<string, string>();
      const first = rank(seenAt);
      // The reader looks at the first screen, then pulls to refresh.
      first.slice(0, 4).forEach((id) => seenAt.set(id, '2026-11-28T03:57:01.265Z'));
      const second = rank(seenAt);

      expect(second.slice(0, 4).filter((id) => first.slice(0, 4).includes(id))).toEqual([]);
      // What was just seen is the last thing shown again.
      expect(second.slice(-4).sort()).toEqual(first.slice(0, 4).sort());
    });

    it('goes round the whole catalog before a post comes back', () => {
      const seenAt = new Map<string, string>();
      const shown: string[] = [];
      for (let pull = 0; pull < 3; pull += 1) {
        const page = rank(seenAt).slice(0, 4);
        shown.push(...page);
        page.forEach((id) => seenAt.set(id, `2026-11-28T03:5${pull}:00.000Z`));
      }

      expect(new Set(shown).size).toBe(12);
    });

    // His lane again: one creator held 36 of the 49 posts and another 8. The
    // fatigue rules look for another creator after each post, and found the
    // same few every time, however recently he had seen them.
    it('keeps the fatigue rules from bringing back a repeat the reader has only just seen', () => {
      const big = { id: 'creator-big', username: 'big', name: 'Big', avatar: null };
      const small = { id: 'creator-small', username: 'small', name: 'Small', avatar: null };
      const lane = [
        ...Array.from({ length: 40 }, (_, index) => createItem(`big-${String(index).padStart(2, '0')}`, { creator: big })),
        ...Array.from({ length: 3 }, (_, index) => createItem(`small-${index}`, { creator: small })),
      ];
      const seenAt = new Map<string, string>();
      const rankLane = () => rankAndDiversifyShowcaseItems({
        items: lane,
        featureRows: lane.map((post, index) => features(post.id, {
          interestMatch: 1 - index * 0.01,
          seenRecently: true,
          lastSeenAt: seenAt.get(post.id) ?? SEEN_YESTERDAY,
        })),
      }).map((entry) => entry.item.id);

      let previous: string[] = [];
      for (let pull = 0; pull < 4; pull += 1) {
        const screen = rankLane().slice(0, 6);
        expect(screen.filter((id) => previous.includes(id)), `pull ${pull}`).toEqual([]);
        screen.forEach((id) => seenAt.set(id, `2026-11-28T03:5${pull}:00.000Z`));
        previous = screen;
      }
    });

    it('still spreads creators among the repeats seen longest ago', () => {
      const shared = { id: 'creator-a', username: 'a', name: 'A', avatar: null };
      const lane = [
        createItem('a-1', { creator: shared }),
        createItem('a-2', { creator: shared }),
        createItem('b-1'),
        createItem('c-1'),
      ];
      const ranked = rankAndDiversifyShowcaseItems({
        items: lane,
        featureRows: lane.map((post, index) => features(post.id, {
          seenRecently: true,
          lastSeenAt: `2026-11-2${index}T00:00:00.000Z`,
        })),
      }).map((entry) => entry.item.id);

      // Least recently seen first, with the second post of one creator moved back a place.
      expect(ranked).toEqual(['a-1', 'b-1', 'a-2', 'c-1']);
    });

    it('orders repeats seen at the same moment by score, and reads the times as times', () => {
      const ranked = rankAndDiversifyShowcaseItems({
        items: posts.slice(0, 4),
        featureRows: [
          features('post-00', { interestMatch: 0.2, seenRecently: true, lastSeenAt: '2026-11-28T03:54:39.714+00:00' }),
          features('post-01', { interestMatch: 0.9, seenRecently: true, lastSeenAt: '2026-11-28T03:54:39.714+00:00' }),
          // Earlier than the two above, though it sorts after them as text.
          features('post-02', { interestMatch: 0.1, seenRecently: true, lastSeenAt: '2026-11-28T03:54:39.7+00:00' }),
          // Seen, the time unknown: taken as seen longest ago.
          features('post-03', { interestMatch: 0.1, seenRecently: true, lastSeenAt: null }),
        ],
      }).map((entry) => entry.item.id);

      expect(ranked).toEqual(['post-03', 'post-02', 'post-01', 'post-00']);
    });

    it('still places every unseen post above every repeat', () => {
      const ranked = rankAndDiversifyShowcaseItems({
        items: posts.slice(0, 3),
        featureRows: [
          features('post-00', { interestMatch: 1, seenRecently: true, lastSeenAt: '2026-11-01T00:00:00.000Z' }),
          features('post-01', { interestMatch: 0.1 }),
          features('post-02', { interestMatch: 1, seenRecently: true, lastSeenAt: '2026-11-20T00:00:00.000Z' }),
        ],
      }).map((entry) => entry.item.id);

      expect(ranked).toEqual(['post-01', 'post-00', 'post-02']);
    });
  });

  it('round trips stable opaque cursors and rejects malformed values', () => {
    const encoded = encodeRankedFeedCursor({ sessionId: 'session-1', position: 24 });
    expect(decodeRankedFeedCursor(encoded)).toEqual({ sessionId: 'session-1', position: 24 });
    expect(decodeRankedFeedCursor('not-a-cursor')).toBeNull();
  });
});
