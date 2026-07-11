import type {
  ShowcaseFeedCandidateSource,
  ShowcaseFeedItem,
  ShowcaseRecommendationContext,
} from '@/lib/showcase';

export const SHOWCASE_FEED_ALGORITHM_VERSION = 'for-you-rules-v1';
export const SHOWCASE_FEED_FALLBACK_ALGORITHM_VERSION = 'recent-fallback-v1';
export const SHOWCASE_FEED_CANDIDATE_LIMIT = 300;
export const SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT = 60;

export type RankedFeedScoreWeights = {
  interestMatch: number;
  creatorAffinity: number;
  smoothedUsefulness: number;
  freshness: number;
  relevantTrend: number;
  explorationBonus: number;
  quickSkipRisk: number;
  negativeFeedbackRisk: number;
};

export type RankedFeedDiversityConfig = {
  maxCreatorPer20: number;
  maxSemanticClusterPer20: number;
  explorationPer10: number;
  maxPaidShare: number;
};

export type RankedFeedFeatureRow = {
  postId: string;
  interestMatch: number;
  creatorAffinity: number;
  smoothedUsefulness: number;
  freshness: number;
  relevantTrend: number;
  explorationBonus: number;
  quickSkipRisk: number;
  negativeFeedbackRisk: number;
  candidateSource: ShowcaseFeedCandidateSource;
  semanticCluster?: string | null;
};

export type RankedShowcaseItem = {
  item: ShowcaseFeedItem;
  features: RankedFeedFeatureRow;
  score: number;
};

export const DEFAULT_RANKED_FEED_SCORE_WEIGHTS: RankedFeedScoreWeights = {
  interestMatch: 0.35,
  creatorAffinity: 0.15,
  smoothedUsefulness: 0.15,
  freshness: 0.15,
  relevantTrend: 0.10,
  explorationBonus: 0.10,
  quickSkipRisk: -0.35,
  negativeFeedbackRisk: -0.80,
};

export const DEFAULT_RANKED_FEED_DIVERSITY_CONFIG: RankedFeedDiversityConfig = {
  maxCreatorPer20: 2,
  maxSemanticClusterPer20: 3,
  explorationPer10: 1,
  maxPaidShare: 0.2,
};

function clampUnit(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function asTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function finiteConfigNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function normalizeRankedFeedScoreWeights(
  value: Record<string, unknown> | null | undefined,
): RankedFeedScoreWeights {
  const weights = value ?? {};
  return {
    interestMatch: finiteConfigNumber(weights.interest_match, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.interestMatch, -10, 10),
    creatorAffinity: finiteConfigNumber(weights.creator_affinity, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.creatorAffinity, -10, 10),
    smoothedUsefulness: finiteConfigNumber(weights.smoothed_usefulness, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.smoothedUsefulness, -10, 10),
    freshness: finiteConfigNumber(weights.freshness, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.freshness, -10, 10),
    relevantTrend: finiteConfigNumber(weights.relevant_trend, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.relevantTrend, -10, 10),
    explorationBonus: finiteConfigNumber(weights.exploration_bonus, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.explorationBonus, -10, 10),
    quickSkipRisk: finiteConfigNumber(weights.quick_skip_risk, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.quickSkipRisk, -10, 10),
    negativeFeedbackRisk: finiteConfigNumber(weights.negative_feedback_risk, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.negativeFeedbackRisk, -10, 10),
  };
}

export function normalizeRankedFeedDiversityConfig(
  value: Record<string, unknown> | null | undefined,
): RankedFeedDiversityConfig {
  const config = value ?? {};
  return {
    maxCreatorPer20: Math.round(finiteConfigNumber(
      config.max_creator_per_20,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.maxCreatorPer20,
      1,
      20,
    )),
    maxSemanticClusterPer20: Math.round(finiteConfigNumber(
      config.max_semantic_cluster_per_20,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.maxSemanticClusterPer20,
      1,
      20,
    )),
    explorationPer10: Math.round(finiteConfigNumber(
      config.exploration_per_10,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.explorationPer10,
      0,
      10,
    )),
    maxPaidShare: finiteConfigNumber(
      config.max_paid_share,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.maxPaidShare,
      0,
      1,
    ),
  };
}

export function scoreRankedFeedFeatures(
  features: RankedFeedFeatureRow,
  weights: RankedFeedScoreWeights = DEFAULT_RANKED_FEED_SCORE_WEIGHTS,
) {
  return (
    weights.interestMatch * clampUnit(features.interestMatch)
    + weights.creatorAffinity * clampUnit(features.creatorAffinity)
    + weights.smoothedUsefulness * clampUnit(features.smoothedUsefulness)
    + weights.freshness * clampUnit(features.freshness)
    + weights.relevantTrend * clampUnit(features.relevantTrend)
    + weights.explorationBonus * clampUnit(features.explorationBonus)
    + weights.quickSkipRisk * clampUnit(features.quickSkipRisk)
    + weights.negativeFeedbackRisk * clampUnit(features.negativeFeedbackRisk)
  );
}

function fallbackFreshness(createdAt: string, now: Date) {
  const ageHours = Math.max(0, (now.getTime() - asTimestamp(createdAt)) / 3_600_000);
  return Math.pow(2, -ageHours / 72);
}

export function buildFallbackRankedFeedFeatures(
  item: ShowcaseFeedItem,
  now = new Date(),
): RankedFeedFeatureRow {
  const saves = Math.max(0, item.saveCount);
  const remixes = Math.max(0, item.remixCount);
  const weightedActions = saves + (remixes * 2.5);
  const usefulness = 1 - Math.exp(-weightedActions / 20);
  const trend = 1 - Math.exp(-weightedActions / 35);
  const isUnderexposed = saves + remixes < 3;

  return {
    postId: item.id,
    interestMatch: 0,
    creatorAffinity: 0,
    smoothedUsefulness: usefulness,
    freshness: fallbackFreshness(item.createdAt, now),
    relevantTrend: trend,
    explorationBonus: isUnderexposed ? 0.75 : 0.1,
    quickSkipRisk: 0,
    negativeFeedbackRisk: 0,
    candidateSource: isUnderexposed ? 'exploration' : trend > 0.45 ? 'trending' : 'fresh',
  };
}

export function normalizeRankedFeedFeatureRow(value: Record<string, unknown>): RankedFeedFeatureRow | null {
  const postId = typeof value.post_id === 'string'
    ? value.post_id
    : typeof value.postId === 'string'
      ? value.postId
      : null;
  if (!postId) return null;

  const source = typeof value.candidate_source === 'string'
    ? value.candidate_source
    : typeof value.candidateSource === 'string'
      ? value.candidateSource
      : 'fresh';
  const normalizedSource = source === 'interest' ? 'affinity' : source === 'recent' ? 'fresh' : source;
  const candidateSource: ShowcaseFeedCandidateSource = (
    normalizedSource === 'affinity'
    || normalizedSource === 'following'
    || normalizedSource === 'fresh'
    || normalizedSource === 'trending'
    || normalizedSource === 'exploration'
    || normalizedSource === 'semantic'
  ) ? normalizedSource : 'fresh';
  const numberValue = (snake: string, camel: string) => Number(value[snake] ?? value[camel] ?? 0);

  return {
    postId,
    interestMatch: clampUnit(numberValue('interest_match', 'interestMatch')),
    creatorAffinity: clampUnit(numberValue('creator_affinity', 'creatorAffinity')),
    smoothedUsefulness: clampUnit(numberValue('smoothed_usefulness', 'smoothedUsefulness')),
    freshness: clampUnit(numberValue('freshness', 'freshness')),
    relevantTrend: clampUnit(numberValue('relevant_trend', 'relevantTrend')),
    explorationBonus: clampUnit(numberValue('exploration_bonus', 'explorationBonus')),
    quickSkipRisk: clampUnit(numberValue('quick_skip_risk', 'quickSkipRisk')),
    negativeFeedbackRisk: clampUnit(numberValue('negative_feedback_risk', 'negativeFeedbackRisk')),
    candidateSource,
    semanticCluster: typeof value.semantic_cluster === 'string'
      ? value.semantic_cluster
      : typeof value.semanticCluster === 'string'
        ? value.semanticCluster
        : null,
  };
}

function sourceReason(source: ShowcaseFeedCandidateSource) {
  switch (source) {
    case 'following':
      return 'From a creator you follow';
    case 'affinity':
      return 'Matches what you save and create';
    case 'semantic':
      return 'Similar to posts you found useful';
    case 'trending':
      return 'Popular with creators now';
    case 'exploration':
      return 'Discover a new creator';
    default:
      return 'Fresh from the community';
  }
}

function canSelectWithoutFatigue(
  candidate: RankedShowcaseItem,
  selected: RankedShowcaseItem[],
  diversityConfig: RankedFeedDiversityConfig,
) {
  const creatorId = candidate.item.creator.id;
  const previousCreatorId = selected.at(-1)?.item.creator.id;
  if (creatorId && previousCreatorId === creatorId) return false;

  const rollingCreatorWindow = selected.slice(-19);
  if (
    creatorId
    && rollingCreatorWindow.filter((entry) => entry.item.creator.id === creatorId).length
      >= diversityConfig.maxCreatorPer20
  ) return false;

  const semanticCluster = candidate.features.semanticCluster;
  if (
    semanticCluster
    && rollingCreatorWindow.filter((entry) => entry.features.semanticCluster === semanticCluster).length
      >= diversityConfig.maxSemanticClusterPer20
  ) return false;

  if (candidate.item.asset?.accessMode === 'paid') {
    const paidInWindow = rollingCreatorWindow.filter((entry) => entry.item.asset?.accessMode === 'paid').length;
    const maxPaidPer20 = Math.max(1, Math.floor(20 * diversityConfig.maxPaidShare));
    if (diversityConfig.maxPaidShare <= 0 || paidInWindow >= maxPaidPer20) return false;
  }
  return true;
}

function mustSelectExploration(
  selected: RankedShowcaseItem[],
  diversityConfig: RankedFeedDiversityConfig,
) {
  if (diversityConfig.explorationPer10 <= 0) return false;
  const block = selected.slice(Math.floor(selected.length / 10) * 10);
  const explorationCount = block.filter((entry) => entry.features.candidateSource === 'exploration').length;
  const slotsRemaining = 10 - block.length;
  return diversityConfig.explorationPer10 - explorationCount >= slotsRemaining;
}

/**
 * Greedy final-stage reranker. The constraints are intentionally soft: when
 * inventory is small, relevant posts are still returned instead of producing
 * an empty or artificially short feed.
 */
export function rankAndDiversifyShowcaseItems({
  featureRows,
  items,
  now = new Date(),
  scoreWeights = DEFAULT_RANKED_FEED_SCORE_WEIGHTS,
  diversityConfig = DEFAULT_RANKED_FEED_DIVERSITY_CONFIG,
}: {
  featureRows: RankedFeedFeatureRow[];
  items: ShowcaseFeedItem[];
  now?: Date;
  scoreWeights?: RankedFeedScoreWeights;
  diversityConfig?: RankedFeedDiversityConfig;
}): RankedShowcaseItem[] {
  const featuresByPostId = new Map(featureRows.map((row) => [row.postId, row]));
  const remaining = items
    .map((item) => {
      const features = featuresByPostId.get(item.id) ?? buildFallbackRankedFeedFeatures(item, now);
      return { item, features, score: scoreRankedFeedFeatures(features, scoreWeights) };
    })
    .sort((left, right) => (
      right.score - left.score
      || right.item.createdAt.localeCompare(left.item.createdAt)
      || right.item.id.localeCompare(left.item.id)
    ));
  const selected: RankedShowcaseItem[] = [];

  while (remaining.length > 0) {
    const requireExploration = mustSelectExploration(selected, diversityConfig);
    let nextIndex = remaining.findIndex((candidate) => (
      (!requireExploration || candidate.features.candidateSource === 'exploration')
      && canSelectWithoutFatigue(candidate, selected, diversityConfig)
    ));
    if (nextIndex < 0 && requireExploration) {
      nextIndex = remaining.findIndex((candidate) => (
        canSelectWithoutFatigue(candidate, selected, diversityConfig)
      ));
    }
    if (nextIndex < 0) nextIndex = 0;

    const [next] = remaining.splice(nextIndex, 1);
    selected.push(next);
  }

  return selected;
}

export function buildRecommendationContext({
  deliveryId,
  features,
  position,
  algorithmVersion = SHOWCASE_FEED_ALGORITHM_VERSION,
}: {
  deliveryId: string;
  features: RankedFeedFeatureRow;
  position: number;
  algorithmVersion?: string;
}): ShowcaseRecommendationContext {
  return {
    deliveryId,
    position,
    reason: sourceReason(features.candidateSource),
    algorithmVersion,
    candidateSource: features.candidateSource,
  };
}

export type RankedFeedCursor = {
  sessionId: string;
  position: number;
};

export function encodeRankedFeedCursor(cursor: RankedFeedCursor) {
  return Buffer.from(JSON.stringify({ s: cursor.sessionId, p: cursor.position }), 'utf8').toString('base64url');
}

export function decodeRankedFeedCursor(value: string | null | undefined): RankedFeedCursor | null {
  if (!value || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.s !== 'string' || !Number.isInteger(parsed.p) || Number(parsed.p) < 0) return null;
    return { sessionId: parsed.s, position: Number(parsed.p) };
  } catch {
    return null;
  }
}
