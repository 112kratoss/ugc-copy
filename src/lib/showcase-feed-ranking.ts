import { mulberry32, sampleBeta } from '@/lib/feed-thompson';
import type {
  ShowcaseFeedCandidateSource,
  ShowcaseFeedItem,
  ShowcaseRecommendationContext,
} from '@/lib/showcase';

export const SHOWCASE_FEED_ALGORITHM_VERSION = 'for-you-rules-v1';
export const SHOWCASE_FEED_FALLBACK_ALGORITHM_VERSION = 'recent-fallback-v1';
export const SHOWCASE_FEED_CANDIDATE_LIMIT = 300;
export const SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT = 60;
/** Score multiplier for an already-seen post, used only as a fallback. */
export const DEFAULT_SEEN_REPEAT_PENALTY = 0.2;
/** X's net-negative sink constant (`xai-value-model/scoring.rs:160-169`). */
const NET_NEGATIVE_OFFSET = 0.001;

/**
 * The `for-you-rules` v3 row as seeded (plan
 * `docs/plans/feed-algorithm-v3-x-adoption-2026-10-11.md` §2.7), in the stored
 * snake_case JSON. The migration test pins the seeded row to these objects.
 */
export const FOR_YOU_RULES_V3_WEIGHTS = {
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
} as const;

export const FOR_YOU_RULES_V3_RETRIEVAL_CONFIG = {
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
} as const;

export const FOR_YOU_RULES_V3_DIVERSITY_CONFIG = {
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
} as const;

export type RankedFeedScoreWeights = {
  interestMatch: number;
  creatorAffinity: number;
  smoothedUsefulness: number;
  freshness: number;
  relevantTrend: number;
  explorationBonus: number;
  quickSkipRisk: number;
  negativeFeedbackRisk: number;
  /** v2: format-aware watch/attention depth. */
  engagementDepth: number;
  attentionSecondsNorm: number;
  /** v2: creator quality prior, capped upstream in SQL. */
  creatorQuality: number;
  /** v2: Bayesian UCB replacing v1's lowest-impressions exploration bonus. */
  explorationUcb: number;
};

export type RankedFeedDiversityConfig = {
  maxCreatorPer20: number;
  maxSemanticClusterPer20: number;
  explorationPer10: number;
  maxPaidShare: number;
  /**
   * v3: X's author-diversity decay. The k-th same-creator post below the
   * creator's best is multiplied by `(1 − floor)·decay^k + floor`. Either key
   * at 1 switches it off.
   */
  authorDecay: number;
  authorDecayFloor: number;
  /** v3: multiplier for a creator the viewer does not follow. 1 = off. */
  outOfNetworkMultiplier: number;
  /** v3: multiplier for a post served to the viewer recently but never seen. 1 = off. */
  servedPenalty: number;
  /** v3: 1-based rank the Thompson-sampled cold-start pick is lifted to. 0 = off. */
  coldStartSlotRank: number;
  coldStartMaxAgeHours: number;
  /** Authors with fewer rendered deliveries than this in 30 days are cold. */
  coldStartImpressionThreshold: number;
  /** Beta prior over a post's meaningful-engagement rate: mean and strength. */
  coldStartPriorMean: number;
  coldStartPriorStrength: number;
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
  engagementDepth: number;
  attentionSecondsNorm: number;
  creatorQuality: number;
  explorationUcb: number;
  /** True when this viewer already had a qualified impression of the post. */
  seenRecently: boolean;
  lastSeenAt: string | null;
  candidateSource: ShowcaseFeedCandidateSource;
  semanticCluster?: string | null;
  // v3 RPC columns. Optional so rows built before v3 still type-check; a
  // missing value reads as the default noted on each.
  /** The viewer follows the creator. Missing = false. */
  isFollowing?: boolean;
  /** Served to this viewer within the served lookback (seen or not). Missing = false. */
  servedRecently?: boolean;
  /** The creator's rendered deliveries in 30 days; null = unknown, never cold-start eligible. */
  authorRendered30d?: number | null;
  /** The post's rendered and meaningful deliveries in 30 days. Missing = 0. */
  postRendered30d?: number;
  postMeaningful30d?: number;
  /** Null = unknown, never cold-start eligible. */
  postAgeHours?: number | null;
  /** Reports on the post in the last 7 days. Missing = 0. */
  reports7d?: number;
  /** Every pool that retrieved the post, by dedup priority. Missing = [candidateSource]. */
  sources?: ShowcaseFeedCandidateSource[];
};

/** How one item's `score` was reached; persisted with the delivery facts. */
export type RankedFeedScoreComponents = {
  /** Σ w·clamp01(f). */
  base: number;
  /** After the net-negative offset; equal to `base` when no multiplier is configured. */
  offset: number;
  /** The repeat multiplier, when the post was seen; otherwise null. */
  seenPenalty: number | null;
  /** The served-not-seen multiplier, when it applied; otherwise null. */
  servedPenalty: number | null;
  /** 1 when the viewer follows the creator. */
  oonMultiplier: number;
  /** k = same-creator posts ranked above before the decay. */
  authorDecay: { k: number; multiplier: number };
  /** Set on every eligible post when the cold-start slot is on; null otherwise. */
  coldStart: { theta: number; picked: boolean; lifted: boolean } | null;
};

export type RankedShowcaseItem = {
  item: ShowcaseFeedItem;
  features: RankedFeedFeatureRow;
  score: number;
  components: RankedFeedScoreComponents;
};

// Defaults stay exactly at v1: a missing weight key must never silently
// activate a v2 feature on the live algorithm.
export const DEFAULT_RANKED_FEED_SCORE_WEIGHTS: RankedFeedScoreWeights = {
  interestMatch: 0.35,
  creatorAffinity: 0.15,
  smoothedUsefulness: 0.15,
  freshness: 0.15,
  relevantTrend: 0.10,
  explorationBonus: 0.10,
  quickSkipRisk: -0.35,
  negativeFeedbackRisk: -0.80,
  engagementDepth: 0,
  attentionSecondsNorm: 0,
  creatorQuality: 0,
  explorationUcb: 0,
};

// The v3 keys default to off (multipliers 1, slot rank 0), so a version row
// without them ranks exactly as it did before v3.
export const DEFAULT_RANKED_FEED_DIVERSITY_CONFIG: RankedFeedDiversityConfig = {
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
};

const RANKED_FEED_CANDIDATE_SOURCES: ReadonlySet<string> = new Set<ShowcaseFeedCandidateSource>([
  'affinity',
  'following',
  'fresh',
  'trending',
  'exploration',
  'semantic',
  'cold',
]);

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

// For the v3 keys a JSON null is a missing key: `Number(null)` is 0, which
// would switch a kill switch on rather than leave it off.
function optionalConfigNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  return finiteConfigNumber(value ?? undefined, fallback, minimum, maximum);
}

function openUnitConfigNumber(value: unknown, fallback: number) {
  const parsed = optionalConfigNumber(value, fallback, 0, 1);
  return parsed > 0 && parsed < 1 ? parsed : fallback;
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
    engagementDepth: finiteConfigNumber(weights.engagement_depth, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.engagementDepth, -10, 10),
    attentionSecondsNorm: finiteConfigNumber(weights.attention_seconds_norm, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.attentionSecondsNorm, -10, 10),
    creatorQuality: finiteConfigNumber(weights.creator_quality, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.creatorQuality, -10, 10),
    explorationUcb: finiteConfigNumber(weights.exploration_ucb, DEFAULT_RANKED_FEED_SCORE_WEIGHTS.explorationUcb, -10, 10),
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
    authorDecay: optionalConfigNumber(
      config.author_decay,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.authorDecay,
      0,
      1,
    ),
    authorDecayFloor: optionalConfigNumber(
      config.author_decay_floor,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.authorDecayFloor,
      0,
      1,
    ),
    outOfNetworkMultiplier: optionalConfigNumber(
      config.out_of_network_multiplier,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.outOfNetworkMultiplier,
      0,
      1,
    ),
    servedPenalty: optionalConfigNumber(
      config.served_penalty,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.servedPenalty,
      0,
      1,
    ),
    coldStartSlotRank: Math.round(optionalConfigNumber(
      config.cold_start_slot_rank,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.coldStartSlotRank,
      0,
      SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT,
    )),
    coldStartMaxAgeHours: optionalConfigNumber(
      config.cold_start_max_age_hours,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.coldStartMaxAgeHours,
      1,
      8760,
    ),
    coldStartImpressionThreshold: optionalConfigNumber(
      config.cold_start_impression_threshold,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.coldStartImpressionThreshold,
      0,
      100_000,
    ),
    coldStartPriorMean: openUnitConfigNumber(
      config.cold_start_prior_mean,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.coldStartPriorMean,
    ),
    coldStartPriorStrength: optionalConfigNumber(
      config.cold_start_prior_strength,
      DEFAULT_RANKED_FEED_DIVERSITY_CONFIG.coldStartPriorStrength,
      1,
      1000,
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
    + weights.engagementDepth * clampUnit(features.engagementDepth)
    + weights.attentionSecondsNorm * clampUnit(features.attentionSecondsNorm)
    + weights.creatorQuality * clampUnit(features.creatorQuality)
    + weights.explorationUcb * clampUnit(features.explorationUcb)
  );
}

/**
 * True when any v3 multiplier can change a score. Only then is the
 * net-negative offset applied, so v1 and v2 scores stay exactly as they were.
 */
export function rankedFeedMultipliersActive(diversityConfig: RankedFeedDiversityConfig) {
  return diversityConfig.authorDecay < 1
    || diversityConfig.outOfNetworkMultiplier < 1
    || diversityConfig.servedPenalty < 1
    || diversityConfig.coldStartSlotRank > 0;
}

/**
 * X's net-negative sink (`xai-value-model/scoring.rs:160-169`). Every
 * net-positive score maps to at least 0.001; a net-negative one maps into
 * [0, 0.001·N/T), keeping its order among the other negatives. Applied before
 * any multiplier: every score is then non-negative, so a multiplier below 1
 * can only lower a score — without it ×0.75 would lift −0.4 to −0.3.
 */
export function offsetRankedFeedScore(base: number, weights: RankedFeedScoreWeights) {
  if (base >= 0) return base + NET_NEGATIVE_OFFSET;
  let negativeTotal = 0;
  let positiveTotal = 0;
  for (const weight of Object.values(weights)) {
    if (weight < 0) negativeTotal -= weight;
    else positiveTotal += weight;
  }
  const total = negativeTotal + positiveTotal;
  if (total <= 0) return 0;
  return Math.max(0, (base + negativeTotal) / total) * NET_NEGATIVE_OFFSET;
}

/**
 * X's author-diversity multiplier (`xai-value-model/scoring.rs:182-203`):
 * `(1 − floor)·decay^k + floor`, where k counts the same creator's posts ranked
 * above. Exactly 1 whenever it cannot bite, so a disabled decay never perturbs
 * a score in its last bit.
 */
export function authorDiversityMultiplier(k: number, decay: number, floor: number) {
  if (k <= 0 || decay >= 1 || floor >= 1) return 1;
  return (1 - floor) * Math.pow(decay, k) + floor;
}

function ageHoursAt(createdAt: string, now: Date) {
  return Math.max(0, (now.getTime() - asTimestamp(createdAt)) / 3_600_000);
}

function fallbackFreshness(createdAt: string, now: Date) {
  const ageHours = ageHoursAt(createdAt, now);
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
  const candidateSource: ShowcaseFeedCandidateSource = isUnderexposed
    ? 'exploration'
    : trend > 0.45 ? 'trending' : 'fresh';

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
    engagementDepth: 0.25,
    attentionSecondsNorm: 0,
    creatorQuality: 0,
    // No delivery history, so the posterior is at its most uncertain — the
    // same optimism the SQL UCB assigns an unexposed post.
    explorationUcb: isUnderexposed ? 0.9 : 0.5,
    // Fallback items arrive outside ranked retrieval, so no seen evidence
    // exists; treating them as unseen keeps them ahead of known repeats.
    seenRecently: false,
    lastSeenAt: null,
    candidateSource,
    // Outside ranked retrieval nothing is known about the viewer's relation to
    // the creator or the author's exposure, so a fallback post is never a
    // cold-start pick.
    isFollowing: false,
    servedRecently: false,
    authorRendered30d: null,
    postRendered30d: 0,
    postMeaningful30d: 0,
    postAgeHours: ageHoursAt(item.createdAt, now),
    reports7d: 0,
    sources: [candidateSource],
  };
}

// Legacy pool labels map onto current ones; unknown labels become `fresh`.
function normalizeCandidateSource(value: unknown): ShowcaseFeedCandidateSource {
  const source = value === 'interest' ? 'affinity' : value === 'recent' ? 'fresh' : value;
  return typeof source === 'string' && RANKED_FEED_CANDIDATE_SOURCES.has(source)
    ? source as ShowcaseFeedCandidateSource
    : 'fresh';
}

export function normalizeRankedFeedFeatureRow(value: Record<string, unknown>): RankedFeedFeatureRow | null {
  const postId = typeof value.post_id === 'string'
    ? value.post_id
    : typeof value.postId === 'string'
      ? value.postId
      : null;
  if (!postId) return null;

  const candidateSource = normalizeCandidateSource(typeof value.candidate_source === 'string'
    ? value.candidate_source
    : typeof value.candidateSource === 'string'
      ? value.candidateSource
      : 'fresh');
  const numberValue = (snake: string, camel: string) => Number(value[snake] ?? value[camel] ?? 0);
  // v3 counts and ages: null when the column is absent (a pre-v3 RPC) or malformed.
  const optionalNumber = (snake: string, camel: string) => {
    const raw = value[snake] ?? value[camel];
    if (raw === null || raw === undefined || raw === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const optionalCount = (snake: string, camel: string) => {
    const parsed = optionalNumber(snake, camel);
    return parsed !== null && parsed >= 0 ? parsed : null;
  };
  const postAgeHours = optionalNumber('post_age_hours', 'postAgeHours');
  const sources: ShowcaseFeedCandidateSource[] = [candidateSource];
  if (Array.isArray(value.sources)) {
    for (const source of value.sources.map(normalizeCandidateSource)) {
      if (!sources.includes(source)) sources.push(source);
    }
  }

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
    engagementDepth: clampUnit(numberValue('engagement_depth', 'engagementDepth')),
    attentionSecondsNorm: clampUnit(numberValue('attention_seconds_norm', 'attentionSecondsNorm')),
    creatorQuality: clampUnit(numberValue('creator_quality', 'creatorQuality')),
    explorationUcb: clampUnit(numberValue('exploration_ucb', 'explorationUcb')),
    seenRecently: value.seen_recently === true || value.seenRecently === true,
    lastSeenAt: typeof value.last_seen_at === 'string'
      ? value.last_seen_at
      : typeof value.lastSeenAt === 'string'
        ? value.lastSeenAt
        : null,
    candidateSource,
    semanticCluster: typeof value.semantic_cluster === 'string'
      ? value.semantic_cluster
      : typeof value.semanticCluster === 'string'
        ? value.semanticCluster
        : null,
    isFollowing: value.is_following === true || value.isFollowing === true,
    servedRecently: value.served_recently === true || value.servedRecently === true,
    authorRendered30d: optionalCount('author_rendered_30d', 'authorRendered30d'),
    postRendered30d: optionalCount('post_rendered_30d', 'postRendered30d') ?? 0,
    postMeaningful30d: optionalCount('post_meaningful_30d', 'postMeaningful30d') ?? 0,
    // A post stamped a moment after the RPC's as-of time is brand new, not unknown.
    postAgeHours: postAgeHours === null ? null : Math.max(0, postAgeHours),
    reports7d: optionalCount('reports_7d', 'reports7d') ?? 0,
    sources,
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
    case 'cold':
      return 'New from the community';
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

function compareRankedCandidates(left: RankedShowcaseItem, right: RankedShowcaseItem) {
  return (
    Number(left.features.seenRecently) - Number(right.features.seenRecently)
    || right.score - left.score
    // Among repeats, the least recently seen is the least stale.
    || (left.features.lastSeenAt ?? '').localeCompare(right.features.lastSeenAt ?? '')
    || right.item.createdAt.localeCompare(left.item.createdAt)
    || right.item.id.localeCompare(left.item.id)
  );
}

/**
 * X's author decay over the list as ranked so far (`ordered` arrives sorted).
 * k is counted once, in that pre-decay order, and the list is re-sorted only
 * after every multiplier is in — as `vm-ranker` does over its candidate pool.
 */
function applyAuthorDecay(ordered: RankedShowcaseItem[], diversityConfig: RankedFeedDiversityConfig) {
  const postsAboveByCreator = new Map<string, number>();
  let decayed = false;
  for (const entry of ordered) {
    const creatorId = entry.item.creator.id;
    const k = creatorId ? postsAboveByCreator.get(creatorId) ?? 0 : 0;
    if (creatorId) postsAboveByCreator.set(creatorId, k + 1);
    const multiplier = authorDiversityMultiplier(k, diversityConfig.authorDecay, diversityConfig.authorDecayFloor);
    entry.components.authorDecay = { k, multiplier };
    if (multiplier !== 1) {
      entry.score *= multiplier;
      decayed = true;
    }
  }
  if (decayed) ordered.sort(compareRankedCandidates);
}

function isColdStartEligible(features: RankedFeedFeatureRow, diversityConfig: RankedFeedDiversityConfig) {
  const ageHours = features.postAgeHours;
  const authorRendered = features.authorRendered30d;
  return !features.seenRecently
    && typeof ageHours === 'number'
    && Number.isFinite(ageHours)
    && ageHours <= diversityConfig.coldStartMaxAgeHours
    // Unknown exposure (null) is never treated as no exposure.
    && typeof authorRendered === 'number'
    && Number.isFinite(authorRendered)
    && authorRendered < diversityConfig.coldStartImpressionThreshold;
}

function nonNegativeCount(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * One Thompson-sampled cold-start slot per ranking (X's
 * `author_cold_start.rs`). Every eligible post draws θ ~ Beta(α0 + m, β0 + r − m)
 * over its 30-day meaningful (m) and rendered (r) deliveries, in ranked order
 * from the session seed. Of the two highest θ the higher-scored post is the
 * pick; it moves up to the slot only when it sits below it, and nothing else
 * is reordered.
 */
function applyColdStartSlot(
  selected: RankedShowcaseItem[],
  diversityConfig: RankedFeedDiversityConfig,
  seed: number,
) {
  if (diversityConfig.coldStartSlotRank <= 0) return;
  const priorAlpha = diversityConfig.coldStartPriorMean * diversityConfig.coldStartPriorStrength;
  const priorBeta = (1 - diversityConfig.coldStartPriorMean) * diversityConfig.coldStartPriorStrength;
  if (!(priorAlpha > 0) || !(priorBeta > 0)) return;

  const random = mulberry32(seed);
  const draws: Array<{ entry: RankedShowcaseItem; index: number; theta: number }> = [];
  selected.forEach((entry, index) => {
    if (!isColdStartEligible(entry.features, diversityConfig)) return;
    const meaningful = nonNegativeCount(entry.features.postMeaningful30d);
    const rendered = nonNegativeCount(entry.features.postRendered30d);
    const theta = sampleBeta(priorAlpha + meaningful, priorBeta + Math.max(0, rendered - meaningful), random);
    entry.components.coldStart = { theta, picked: false, lifted: false };
    draws.push({ entry, index, theta });
  });
  if (draws.length === 0) return;

  // Highest θ first; a tie keeps the ranked order.
  draws.sort((left, right) => right.theta - left.theta || left.index - right.index);
  const [first, second] = draws;
  const pick = second && second.entry.score > first.entry.score ? second : first;
  const slotIndex = diversityConfig.coldStartSlotRank - 1;
  const lifted = pick.index > slotIndex;
  pick.entry.components.coldStart = { theta: pick.theta, picked: true, lifted };
  if (lifted) {
    selected.splice(pick.index, 1);
    selected.splice(slotIndex, 0, pick.entry);
  }
}

/**
 * Greedy final-stage reranker. The constraints are intentionally soft: when
 * inventory is small, relevant posts are still returned instead of producing
 * an empty or artificially short feed.
 *
 * Seen posts are handled as a hard tier rather than a soft penalty. A post the
 * viewer already saw is only ever selected once no unseen candidate remains at
 * all — diversity fatigue is not enough of a reason to serve a repeat — and its
 * score is multiplied by `seenPenalty` so the fallback ordering still reflects
 * how weak a choice it is. Repeats are the fastest way to make a small-catalog
 * feed feel dead, so the tier boundary is deliberately not negotiable.
 *
 * v3 adds X's post-scoring adjustments around that greedy pass, in this order:
 * the net-negative offset (only when a multiplier is configured), the served
 * penalty for a post served but never seen, the out-of-network discount, the
 * author decay with a re-sort, and after the greedy pass one Thompson-sampled
 * cold-start slot. Each is off at its default, and a version row without the
 * v3 keys ranks exactly as before.
 */
export function rankAndDiversifyShowcaseItems({
  featureRows,
  items,
  now = new Date(),
  scoreWeights = DEFAULT_RANKED_FEED_SCORE_WEIGHTS,
  diversityConfig = DEFAULT_RANKED_FEED_DIVERSITY_CONFIG,
  seenPenalty = DEFAULT_SEEN_REPEAT_PENALTY,
  seed = 0,
}: {
  featureRows: RankedFeedFeatureRow[];
  items: ShowcaseFeedItem[];
  now?: Date;
  scoreWeights?: RankedFeedScoreWeights;
  diversityConfig?: RankedFeedDiversityConfig;
  seenPenalty?: number;
  /** The session's `random_seed`: the cold-start draws replay exactly from it. */
  seed?: number;
}): RankedShowcaseItem[] {
  // A config built before v3 lacks the new keys; they read as off.
  const config: RankedFeedDiversityConfig = { ...DEFAULT_RANKED_FEED_DIVERSITY_CONFIG, ...diversityConfig };
  const offsetScores = rankedFeedMultipliersActive(config);
  const featuresByPostId = new Map(featureRows.map((row) => [row.postId, row]));
  const remaining = items
    .map((item): RankedShowcaseItem => {
      const features = featuresByPostId.get(item.id) ?? buildFallbackRankedFeedFeatures(item, now);
      const base = scoreRankedFeedFeatures(features, scoreWeights);
      const offset = offsetScores ? offsetRankedFeedScore(base, scoreWeights) : base;
      // A repeat keeps the hard tier and its penalty; a post that was only
      // served (paged past, never seen) takes the lighter served penalty.
      const servedOnly = !features.seenRecently && features.servedRecently === true;
      const oonMultiplier = features.isFollowing === true ? 1 : config.outOfNetworkMultiplier;
      let score = offset;
      if (features.seenRecently) score *= seenPenalty;
      else if (servedOnly) score *= config.servedPenalty;
      score *= oonMultiplier;
      return {
        item,
        features,
        score,
        components: {
          base,
          offset,
          seenPenalty: features.seenRecently ? seenPenalty : null,
          servedPenalty: servedOnly ? config.servedPenalty : null,
          oonMultiplier,
          authorDecay: { k: 0, multiplier: 1 },
          coldStart: null,
        },
      };
    })
    .sort(compareRankedCandidates);
  applyAuthorDecay(remaining, config);
  const selected: RankedShowcaseItem[] = [];

  while (remaining.length > 0) {
    const requireExploration = mustSelectExploration(selected, config);
    const unseenRemains = remaining.some((candidate) => !candidate.features.seenRecently);
    const withinSeenTier = (candidate: RankedShowcaseItem) => (
      !unseenRemains || !candidate.features.seenRecently
    );
    const findCandidate = (predicate: (candidate: RankedShowcaseItem) => boolean) => (
      remaining.findIndex((candidate) => withinSeenTier(candidate) && predicate(candidate))
    );

    let nextIndex = requireExploration
      ? findCandidate((candidate) => (
        candidate.features.candidateSource === 'exploration'
        && canSelectWithoutFatigue(candidate, selected, config)
      ))
      : -1;
    if (nextIndex < 0) {
      nextIndex = findCandidate((candidate) => (
        canSelectWithoutFatigue(candidate, selected, config)
      ));
    }
    // Relax diversity before the seen tier: a fatigued unseen post still beats
    // a repeat.
    if (nextIndex < 0) nextIndex = findCandidate(() => true);
    if (nextIndex < 0) nextIndex = 0;

    const [next] = remaining.splice(nextIndex, 1);
    selected.push(next);
  }

  applyColdStartSlot(selected, config, seed);
  return selected;
}

/**
 * How one ranked item's score was reached, as a fresh JSON-safe object for
 * `score_components`. `seenPenalty`/`servedPenalty` are the multipliers that
 * applied (at most one is set); `coldStart` is null unless the post was
 * eligible for the cold-start slot.
 */
export function explainRankedFeedScore(entry: Pick<RankedShowcaseItem, 'components'>): RankedFeedScoreComponents {
  const { components } = entry;
  return {
    base: components.base,
    offset: components.offset,
    seenPenalty: components.seenPenalty,
    servedPenalty: components.servedPenalty,
    oonMultiplier: components.oonMultiplier,
    authorDecay: { ...components.authorDecay },
    coldStart: components.coldStart ? { ...components.coldStart } : null,
  };
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
