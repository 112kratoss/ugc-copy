import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEED_VISIBILITY_THRESHOLDS,
  evaluateFeedVisibility,
  filterFeedVisibility,
  normalizeFeedVisibilityThresholds,
  type FeedViewerRelations,
  type FeedVisibilityCandidate,
} from '@/lib/feed-visibility';
import { FOR_YOU_RULES_V3_RETRIEVAL_CONFIG } from '@/lib/showcase-feed-ranking';

function candidate(overrides: Partial<FeedVisibilityCandidate> = {}): FeedVisibilityCandidate {
  return {
    postId: 'post-1',
    creatorId: 'creator-1',
    visibility: 'public',
    archivedAt: null,
    reviewStatus: 'visible',
    isNsfw: false,
    negativeFeedbackRisk: 0.01,
    creatorNegativeFeedbackRate: 0.01,
    authorLabels: [],
    ...overrides,
  };
}

function relations(overrides: Partial<FeedViewerRelations> = {}): FeedViewerRelations {
  return {
    viewerUserId: 'viewer-1',
    followingCreatorIds: new Set(),
    blockedCreatorIds: new Set(),
    hiddenPostIds: new Set(),
    hiddenCreatorIds: new Set(),
    reportedPostIds: new Set(),
    ...overrides,
  };
}

const V3_THRESHOLDS = normalizeFeedVisibilityThresholds(FOR_YOU_RULES_V3_RETRIEVAL_CONFIG);

describe('evaluateFeedVisibility', () => {
  it('shows an ordinary public post and judges it by whether the creator is followed', () => {
    expect(evaluateFeedVisibility(candidate(), relations())).toEqual({
      action: 'show',
      reason: null,
      level: 'recommendations',
    });
    expect(evaluateFeedVisibility(candidate(), relations({ followingCreatorIds: new Set(['creator-1']) })))
      .toEqual({ action: 'show', reason: null, level: 'home' });
  });

  it.each([
    ['post_not_public', candidate({ visibility: 'unlisted' }), relations()],
    ['post_not_public', candidate({ visibility: null }), relations()],
    ['post_archived', candidate({ archivedAt: '2026-10-01T00:00:00.000Z' }), relations()],
    ['post_not_visible', candidate({ reviewStatus: 'flagged' }), relations()],
    ['self_post', candidate({ creatorId: 'viewer-1' }), relations()],
    ['blocked', candidate(), relations({ blockedCreatorIds: new Set(['creator-1']) })],
    ['hidden_post', candidate(), relations({ hiddenPostIds: new Set(['post-1']) })],
    ['hidden_creator', candidate(), relations({ hiddenCreatorIds: new Set(['creator-1']) })],
    ['reported_by_viewer', candidate(), relations({ reportedPostIds: new Set(['post-1']) })],
    ['nsfw', candidate({ isNsfw: true }), relations()],
  ] as const)('drops with %s', (reason, post, viewer) => {
    expect(evaluateFeedVisibility(post, viewer, V3_THRESHOLDS)).toMatchObject({ action: 'drop', reason });
  });

  it('lets the first rule in order name the reason', () => {
    const everything = candidate({
      creatorId: 'viewer-1',
      reviewStatus: 'hidden',
      isNsfw: true,
      negativeFeedbackRisk: 0.9,
    });
    const viewer = relations({
      blockedCreatorIds: new Set(['viewer-1']),
      hiddenPostIds: new Set(['post-1']),
      reportedPostIds: new Set(['post-1']),
    });

    expect(evaluateFeedVisibility(everything, viewer, V3_THRESHOLDS).reason).toBe('post_not_visible');
    expect(evaluateFeedVisibility({ ...everything, reviewStatus: 'visible' }, viewer, V3_THRESHOLDS).reason)
      .toBe('self_post');
    expect(evaluateFeedVisibility(
      candidate({ isNsfw: true, negativeFeedbackRisk: 0.9 }),
      relations({ hiddenCreatorIds: new Set(['creator-1']), reportedPostIds: new Set(['post-1']) }),
      V3_THRESHOLDS,
    ).reason).toBe('hidden_creator');
    expect(evaluateFeedVisibility(
      candidate({ isNsfw: true, negativeFeedbackRisk: 0.9, creatorNegativeFeedbackRate: 0.5 }),
      relations(),
      V3_THRESHOLDS,
    ).reason).toBe('nsfw');
    expect(evaluateFeedVisibility(
      candidate({ negativeFeedbackRisk: 0.9, creatorNegativeFeedbackRate: 0.5 }),
      relations(),
      V3_THRESHOLDS,
    ).reason).toBe('creator_negative_feedback');
  });

  it('drops a labelled account from recommendations only, whatever the label', () => {
    for (const label of ['nsfw_account', 'negative_feedback_account', 'spam_account']) {
      const labelled = candidate({ authorLabels: [label] });

      expect(evaluateFeedVisibility(labelled, relations(), V3_THRESHOLDS)).toEqual({
        action: 'drop',
        reason: 'labelled_account',
        level: 'recommendations',
      });
      // A follower chose the account; the label does not take it away.
      expect(evaluateFeedVisibility(
        labelled,
        relations({ followingCreatorIds: new Set(['creator-1']) }),
        V3_THRESHOLDS,
      )).toEqual({ action: 'show', reason: null, level: 'home' });
    }
    // At the default thresholds too: the label rule has no threshold to switch off.
    expect(evaluateFeedVisibility(candidate({ authorLabels: ['spam_account'] }), relations()).reason)
      .toBe('labelled_account');
  });

  it('judges the label after NSFW and before the creator and post rates', () => {
    expect(evaluateFeedVisibility(
      candidate({ isNsfw: true, authorLabels: ['nsfw_account'] }),
      relations(),
      V3_THRESHOLDS,
    ).reason).toBe('nsfw');
    expect(evaluateFeedVisibility(
      candidate({ authorLabels: ['negative_feedback_account'], negativeFeedbackRisk: 0.9, creatorNegativeFeedbackRate: 0.5 }),
      relations(),
      V3_THRESHOLDS,
    ).reason).toBe('labelled_account');
  });

  it('drops NSFW at the home level too', () => {
    expect(evaluateFeedVisibility(
      candidate({ isNsfw: true }),
      relations({ followingCreatorIds: new Set(['creator-1']) }),
    )).toEqual({ action: 'drop', reason: 'nsfw', level: 'home' });
  });

  it('applies the negative-feedback rules to recommendations only', () => {
    const risky = candidate({ negativeFeedbackRisk: 0.2 });
    const riskyCreator = candidate({ creatorNegativeFeedbackRate: 0.1 });
    const follower = relations({ followingCreatorIds: new Set(['creator-1']) });

    expect(evaluateFeedVisibility(risky, relations(), V3_THRESHOLDS)).toEqual({
      action: 'drop',
      reason: 'post_negative_feedback',
      level: 'recommendations',
    });
    expect(evaluateFeedVisibility(riskyCreator, relations(), V3_THRESHOLDS)).toEqual({
      action: 'drop',
      reason: 'creator_negative_feedback',
      level: 'recommendations',
    });
    expect(evaluateFeedVisibility(risky, follower, V3_THRESHOLDS)).toEqual({ action: 'show', reason: null, level: 'home' });
    expect(evaluateFeedVisibility(riskyCreator, follower, V3_THRESHOLDS))
      .toEqual({ action: 'show', reason: null, level: 'home' });
  });

  it('drops only above the threshold, and treats a missing rate as no evidence', () => {
    expect(evaluateFeedVisibility(candidate({ negativeFeedbackRisk: 0.12 }), relations(), V3_THRESHOLDS).action)
      .toBe('show');
    expect(evaluateFeedVisibility(
      candidate({ negativeFeedbackRisk: null, creatorNegativeFeedbackRate: null }),
      relations(),
      V3_THRESHOLDS,
    ).action).toBe('show');
  });

  it('keeps both negative-feedback rules off at the default thresholds', () => {
    expect(DEFAULT_FEED_VISIBILITY_THRESHOLDS).toEqual({
      recommendationMaxPostNegativeRisk: 1,
      recommendationMaxCreatorNegativeRate: 1,
    });
    expect(evaluateFeedVisibility(
      candidate({ negativeFeedbackRisk: 1, creatorNegativeFeedbackRate: 1 }),
      relations(),
    ).action).toBe('show');
  });

  it('fails closed when the viewer relations could not be read', () => {
    expect(evaluateFeedVisibility(candidate(), null, V3_THRESHOLDS)).toEqual({
      action: 'drop',
      reason: 'not_evaluated',
      level: 'recommendations',
    });
    expect(evaluateFeedVisibility(candidate({ visibility: 'unlisted' }), null).reason).toBe('not_evaluated');
  });

  it('never treats a signed-out viewer as the author of a post without a creator', () => {
    expect(evaluateFeedVisibility(
      candidate({ creatorId: null }),
      relations({ viewerUserId: null }),
    ).action).toBe('show');
  });
});

describe('filterFeedVisibility', () => {
  it('keeps the shown items in order and records one reason per dropped post', () => {
    const items = [
      { ...candidate({ postId: 'a' }), rank: 1 },
      { ...candidate({ postId: 'b', creatorId: 'blocked-creator' }), rank: 2 },
      { ...candidate({ postId: 'c', isNsfw: true }), rank: 3 },
      { ...candidate({ postId: 'd' }), rank: 4 },
    ];
    const result = filterFeedVisibility(
      items,
      relations({ blockedCreatorIds: new Set(['blocked-creator']) }),
      V3_THRESHOLDS,
    );

    expect(result.kept.map((item) => item.rank)).toEqual([1, 4]);
    expect(result.dropped).toEqual([
      { postId: 'b', reason: 'blocked' },
      { postId: 'c', reason: 'nsfw' },
    ]);
  });

  it('drops every item as not_evaluated without relations', () => {
    const result = filterFeedVisibility([candidate({ postId: 'a' }), candidate({ postId: 'b' })], null);

    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([
      { postId: 'a', reason: 'not_evaluated' },
      { postId: 'b', reason: 'not_evaluated' },
    ]);
  });
});

describe('normalizeFeedVisibilityThresholds', () => {
  it('reads the v3 retrieval keys and falls back to off for anything out of range', () => {
    expect(V3_THRESHOLDS).toEqual({
      recommendationMaxPostNegativeRisk: 0.12,
      recommendationMaxCreatorNegativeRate: 0.08,
    });
    expect(normalizeFeedVisibilityThresholds({
      recommendation_max_post_negative_risk: 2,
      recommendation_max_creator_negative_rate: null,
    })).toEqual(DEFAULT_FEED_VISIBILITY_THRESHOLDS);
    expect(normalizeFeedVisibilityThresholds(null)).toEqual(DEFAULT_FEED_VISIBILITY_THRESHOLDS);
  });
});
