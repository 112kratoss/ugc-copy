/**
 * Whether a For You candidate may be shown at all, decided apart from where it
 * ranks (X's visibility filtering, `docs/research/x-algorithm-analysis-2026-10-11.md`
 * §8). Pure: the caller loads the post fields and the viewer's relations once
 * per request and passes them in.
 *
 * - Rules run in a fixed order and the first drop wins, so every dropped post
 *   carries exactly one reason code.
 * - A post from a creator the viewer follows is judged at the `home` level;
 *   everything else at the stricter `recommendations` level, which adds the two
 *   negative-feedback rules.
 * - Fail closed: when the viewer's relations could not be read (`null`), no
 *   post can be cleared, so every post drops as `not_evaluated`.
 * - NSFW drops at both levels. X lets followers see it behind a blur; For You
 *   never shows NSFW, and that product decision is unchanged.
 */

export type FeedVisibilityLevel = 'home' | 'recommendations';

export type FeedVisibilityReason =
  | 'post_not_public'
  | 'post_archived'
  | 'post_not_visible'
  | 'self_post'
  | 'blocked'
  | 'hidden_post'
  | 'hidden_creator'
  | 'reported_by_viewer'
  | 'nsfw'
  | 'creator_negative_feedback'
  | 'post_negative_feedback'
  | 'not_evaluated';

export type FeedVisibilityCandidate = {
  postId: string;
  creatorId: string | null;
  /** `posts.visibility`; anything but `public` drops. */
  visibility: string | null;
  archivedAt: string | null;
  /** `posts.review_status`; anything but `visible` drops. */
  reviewStatus: string | null;
  isNsfw: boolean;
  /** The ranking feature in [0, 1]; null = no evidence, never drops. */
  negativeFeedbackRisk: number | null;
  /** `creator_feed_stats.negative_feedback_rate`; null = no evidence, never drops. */
  creatorNegativeFeedbackRate: number | null;
};

export type FeedViewerRelations = {
  viewerUserId: string | null;
  followingCreatorIds: Set<string>;
  blockedCreatorIds: Set<string>;
  hiddenPostIds: Set<string>;
  hiddenCreatorIds: Set<string>;
  reportedPostIds: Set<string>;
};

export type FeedVisibilityThresholds = {
  /** Drop a recommendation whose post risk is above this. 1 = off. */
  recommendationMaxPostNegativeRisk: number;
  /** Drop a recommendation whose creator's negative rate is above this. 1 = off. */
  recommendationMaxCreatorNegativeRate: number;
};

export type FeedVisibilityDecision = {
  action: 'show' | 'drop';
  reason: FeedVisibilityReason | null;
  level: FeedVisibilityLevel;
};

// Both rates live in [0, 1], so a threshold of 1 can never be exceeded.
export const DEFAULT_FEED_VISIBILITY_THRESHOLDS: FeedVisibilityThresholds = {
  recommendationMaxPostNegativeRisk: 1,
  recommendationMaxCreatorNegativeRate: 1,
};

function unitConfigNumber(value: unknown, fallback: number) {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

/** Reads the two thresholds from a version's `retrieval_config` JSON. */
export function normalizeFeedVisibilityThresholds(
  value: Record<string, unknown> | null | undefined,
): FeedVisibilityThresholds {
  const config = value ?? {};
  return {
    recommendationMaxPostNegativeRisk: unitConfigNumber(
      config.recommendation_max_post_negative_risk,
      DEFAULT_FEED_VISIBILITY_THRESHOLDS.recommendationMaxPostNegativeRisk,
    ),
    recommendationMaxCreatorNegativeRate: unitConfigNumber(
      config.recommendation_max_creator_negative_rate,
      DEFAULT_FEED_VISIBILITY_THRESHOLDS.recommendationMaxCreatorNegativeRate,
    ),
  };
}

function exceeds(value: number | null, threshold: number) {
  return value !== null && Number.isFinite(value) && value > threshold;
}

type FeedVisibilityRule = {
  reason: Exclude<FeedVisibilityReason, 'not_evaluated'>;
  /** Rules without a level apply at both. */
  level?: FeedVisibilityLevel;
  drops: (
    candidate: FeedVisibilityCandidate,
    relations: FeedViewerRelations,
    thresholds: FeedVisibilityThresholds,
  ) => boolean;
};

// Order is the contract: the first rule that drops names the reason.
const FEED_VISIBILITY_RULES: readonly FeedVisibilityRule[] = [
  { reason: 'post_not_public', drops: (candidate) => candidate.visibility !== 'public' },
  { reason: 'post_archived', drops: (candidate) => candidate.archivedAt !== null },
  { reason: 'post_not_visible', drops: (candidate) => candidate.reviewStatus !== 'visible' },
  {
    reason: 'self_post',
    drops: (candidate, relations) => (
      relations.viewerUserId !== null && candidate.creatorId === relations.viewerUserId
    ),
  },
  {
    reason: 'blocked',
    drops: (candidate, relations) => (
      candidate.creatorId !== null && relations.blockedCreatorIds.has(candidate.creatorId)
    ),
  },
  { reason: 'hidden_post', drops: (candidate, relations) => relations.hiddenPostIds.has(candidate.postId) },
  {
    reason: 'hidden_creator',
    drops: (candidate, relations) => (
      candidate.creatorId !== null && relations.hiddenCreatorIds.has(candidate.creatorId)
    ),
  },
  {
    reason: 'reported_by_viewer',
    drops: (candidate, relations) => relations.reportedPostIds.has(candidate.postId),
  },
  { reason: 'nsfw', drops: (candidate) => candidate.isNsfw },
  {
    reason: 'creator_negative_feedback',
    level: 'recommendations',
    drops: (candidate, _relations, thresholds) => exceeds(
      candidate.creatorNegativeFeedbackRate,
      thresholds.recommendationMaxCreatorNegativeRate,
    ),
  },
  {
    reason: 'post_negative_feedback',
    level: 'recommendations',
    drops: (candidate, _relations, thresholds) => exceeds(
      candidate.negativeFeedbackRisk,
      thresholds.recommendationMaxPostNegativeRisk,
    ),
  },
];

export function evaluateFeedVisibility(
  candidate: FeedVisibilityCandidate,
  relations: FeedViewerRelations | null,
  thresholds: FeedVisibilityThresholds = DEFAULT_FEED_VISIBILITY_THRESHOLDS,
): FeedVisibilityDecision {
  // Without relations nobody can say whether the creator is followed, so the
  // level is the stricter one, and nothing is cleared.
  if (relations === null) {
    return { action: 'drop', reason: 'not_evaluated', level: 'recommendations' };
  }

  const level: FeedVisibilityLevel = candidate.creatorId !== null
    && relations.followingCreatorIds.has(candidate.creatorId)
    ? 'home'
    : 'recommendations';
  for (const rule of FEED_VISIBILITY_RULES) {
    if (rule.level && rule.level !== level) continue;
    if (rule.drops(candidate, relations, thresholds)) {
      return { action: 'drop', reason: rule.reason, level };
    }
  }
  return { action: 'show', reason: null, level };
}

export function filterFeedVisibility<T extends FeedVisibilityCandidate>(
  items: T[],
  relations: FeedViewerRelations | null,
  thresholds: FeedVisibilityThresholds = DEFAULT_FEED_VISIBILITY_THRESHOLDS,
): { kept: T[]; dropped: Array<{ postId: string; reason: FeedVisibilityReason }> } {
  const kept: T[] = [];
  const dropped: Array<{ postId: string; reason: FeedVisibilityReason }> = [];
  for (const item of items) {
    const decision = evaluateFeedVisibility(item, relations, thresholds);
    if (decision.action === 'show') {
      kept.push(item);
    } else {
      dropped.push({ postId: item.postId, reason: decision.reason ?? 'not_evaluated' });
    }
  }
  return { kept, dropped };
}
