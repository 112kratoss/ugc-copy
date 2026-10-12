import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { resolveFeedExperimentAssignment } from '@/lib/feed-experiments';
import {
  filterFeedVisibility,
  normalizeFeedVisibilityThresholds,
  type FeedViewerRelations,
  type FeedVisibilityCandidate,
  type FeedVisibilityThresholds,
} from '@/lib/feed-visibility';
import { loadBlockedCreatorIds } from '@/lib/moderation-service';
import type {
  ShowcaseCategory,
  ShowcaseFeedItem,
  ShowcaseFeedPage,
  ShowcaseResourceFilter,
  ShowcaseUnlockFilter,
} from '@/lib/showcase';
import {
  DEFAULT_SEEN_REPEAT_PENALTY,
  SHOWCASE_FEED_ALGORITHM_VERSION,
  SHOWCASE_FEED_CANDIDATE_LIMIT,
  SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT,
  SHOWCASE_FEED_FALLBACK_ALGORITHM_VERSION,
  buildFallbackRankedFeedFeatures,
  buildRecommendationContext,
  decodeRankedFeedCursor,
  encodeRankedFeedCursor,
  explainRankedFeedScore,
  normalizeRankedFeedDiversityConfig,
  normalizeRankedFeedFeatureRow,
  normalizeRankedFeedScoreWeights,
  rankAndDiversifyShowcaseItems,
  scoreRankedFeedFeatures,
  type RankedFeedDiversityConfig,
  type RankedFeedFeatureRow,
  type RankedFeedScoreWeights,
  type RankedShowcaseItem,
} from '@/lib/showcase-feed-ranking';

type RankedCandidateRpcRow = Record<string, unknown>;

type FeedSessionRow = {
  id: string;
  viewer_user_id: string | null;
  anonymous_key_hash: string | null;
  algorithm_version_id: string;
  created_at: string;
  expires_at: string;
};

type FeedSessionItemRow = {
  id: string | number;
  post_id: string;
  position: number;
  candidate_source: string;
  final_score: number;
  score_components: Record<string, unknown> | null;
};

type ActiveAlgorithmRow = {
  id: string;
  algorithm_key: string;
  version: number;
  weights: Record<string, unknown>;
  retrieval_config: Record<string, unknown>;
  diversity_config: Record<string, unknown>;
};

export type RankedFeedRetrievalConfig = {
  candidateRpc: 'v1' | 'v2' | 'v3' | 'v4';
  followingLimit: number;
  interestLimit: number;
  trendingLimit: number;
  recentLimit: number;
  explorationLimit: number;
  seenLookbackDays: number;
  seenPenalty: number;
  creatorPriorCap: number;
  explorationConfidence: number;
  // v3 retrieval (`get_ranked_feed_candidates_v3`); only the v3 call reads them.
  coldLimit: number;
  coldMaxAgeHours: number;
  /** Authors with fewer rendered deliveries than this in 30 days feed the cold pool. */
  coldImpressionThreshold: number;
  /** Bounds every pool: cost, not freshness. */
  maxAgeDays: number;
  servedLookbackHours: number;
  trendingPerAuthorCap: number;
  /** creator_quality for a creator with no stats row yet. */
  creatorPriorMean: number;
  sessionItemLimit: number;
  // v4 retrieval (`get_ranked_feed_candidates_v4`); only the v4 call reads them.
  /** The taste-vector pool's size; 0 switches it off. */
  semanticLimit: number;
  /** A semantic candidate's minimum cosine similarity to the taste vector. */
  semanticMinSimilarity: number;
  /** How far back the viewer's saves, remixes and meaningful views form the taste vector. */
  tasteLookbackDays: number;
  /** The newest engaged posts averaged into the taste vector. */
  tasteLimit: number;
  /** Keep a near-duplicate out of every pool but `following`. */
  excludeNearDuplicates: boolean;
  /** Keep a labelled account out of every pool but `following`. */
  excludeLabelledAccounts: boolean;
  /** The visibility stage's recommendation-only thresholds; 1 = off. */
  visibilityThresholds: FeedVisibilityThresholds;
};

/**
 * v4 returns every v3 column, so everything keyed on the v3 columns (the
 * recommendation-level visibility rules, the cold reservation, the persisted
 * components) holds for v4 too.
 */
function returnsV3Columns(candidateRpc: RankedFeedRetrievalConfig['candidateRpc']) {
  return candidateRpc === 'v3' || candidateRpc === 'v4';
}

type ActiveAlgorithmConfig = ActiveAlgorithmRow & {
  algorithmVersion: string;
  candidateLimit: number;
  eligibleItemLimit: number;
  scoreWeights: RankedFeedScoreWeights;
  diversityConfig: RankedFeedDiversityConfig;
  retrieval: RankedFeedRetrievalConfig;
};

const FEED_SESSION_REUSE_TTL_MS = 2 * 60 * 1000;
const FEED_SESSION_EXPIRY_MS = 2 * 60 * 60 * 1000;
const FEED_HYDRATION_BATCH_SIZE = 60;
const FEED_RANDOM_SEED_MODULUS = 2_147_483_647;
const FEED_SHARED_SEED_BUCKET_MS = 10 * 60 * 1000;
const COLD_CANDIDATE_RESERVED_PLACES = 10;

export type RankedFeedFilters = {
  category: ShowcaseCategory;
  toolSlug: string | null;
  unlockFilter: ShowcaseUnlockFilter;
  resourceFilter: ShowcaseResourceFilter;
};

function scoreComponents(
  entry: RankedShowcaseItem,
  candidateRpc: RankedFeedRetrievalConfig['candidateRpc'],
) {
  const { features } = entry;
  return {
    interest_match: features.interestMatch,
    creator_affinity: features.creatorAffinity,
    smoothed_usefulness: features.smoothedUsefulness,
    freshness: features.freshness,
    relevant_trend: features.relevantTrend,
    exploration_bonus: features.explorationBonus,
    quick_skip_risk: features.quickSkipRisk,
    negative_feedback_risk: features.negativeFeedbackRisk,
    engagement_depth: features.engagementDepth,
    attention_seconds_norm: features.attentionSecondsNorm,
    creator_quality: features.creatorQuality,
    exploration_ucb: features.explorationUcb,
    seen_recently: features.seenRecently,
    semantic_cluster: features.semanticCluster ?? null,
    // v3 RPC columns, under the names normalizeRankedFeedFeatureRow reads, so
    // a continuation page judges visibility at the level the session was
    // ranked at (is_following) and the cold-start draws can be replayed from
    // the session seed. Only the v3 and v4 RPCs return them: for a v1 or v2
    // ranking they would be the normalizer's defaults, stored as if measured.
    ...(returnsV3Columns(candidateRpc) ? {
      is_following: features.isFollowing === true,
      served_recently: features.servedRecently === true,
      author_rendered_30d: features.authorRendered30d ?? null,
      post_rendered_30d: features.postRendered30d ?? 0,
      post_meaningful_30d: features.postMeaningful30d ?? 0,
      post_age_hours: features.postAgeHours ?? null,
      reports_7d: features.reports7d ?? 0,
      sources: features.sources ?? [features.candidateSource],
    } : {}),
    // v4 RPC columns, on the same rule: only the v4 RPC measures them.
    ...(candidateRpc === 'v4' ? {
      semantic_similarity: features.semanticSimilarity ?? 0,
      taste_available: features.tasteAvailable === true,
    } : {}),
    // How the score was reached, under one key: featureRowFromSessionItem
    // spreads these components back into a feature row, and nesting keeps a
    // score part from ever being read as a feature.
    ranking: explainRankedFeedScore(entry),
  };
}

function featureRowFromSessionItem(row: FeedSessionItemRow): RankedFeedFeatureRow {
  return normalizeRankedFeedFeatureRow({
    post_id: row.post_id,
    candidate_source: row.candidate_source,
    ...(row.score_components ?? {}),
  }) ?? {
    postId: row.post_id,
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
  };
}

function attachRecommendations(
  ranked: RankedShowcaseItem[],
  deliveryIdsByPosition: Map<number, string>,
  startPosition = 0,
  algorithmVersion = SHOWCASE_FEED_ALGORITHM_VERSION,
) {
  return ranked.map((entry, index) => {
    const position = startPosition + index;
    const deliveryId = deliveryIdsByPosition.get(position);
    if (!deliveryId) return entry.item;
    return {
      ...entry.item,
      recommendation: buildRecommendationContext({
        deliveryId,
        features: entry.features,
        position,
        algorithmVersion,
      }),
    };
  });
}

function uniqueCreatorIds(items: ShowcaseFeedItem[]) {
  return Array.from(new Set(
    items.map((item) => item.creator.id).filter((id): id is string => Boolean(id)),
  ));
}

/** Creators the viewer follows, as the candidate rows report it (`is_following`). */
function followedCreatorIds(
  items: ShowcaseFeedItem[],
  isFollowing: (postId: string) => boolean,
) {
  return new Set(uniqueCreatorIds(items.filter((item) => isFollowing(item.id))));
}

/**
 * The viewer's relations to a set of candidates, read together: blocks in
 * either direction, active not-interested and hide-creator feedback, and the
 * posts the viewer reported. This read skips reports a moderator dismissed;
 * filing a report also writes the reporter's not-interested row
 * (`post-report-service.ts`), which keeps hiding the post regardless.
 * A signed-out viewer has none of these to load. Any failed read returns null,
 * which the visibility stage treats as "nothing can be cleared" — the same
 * fail-closed rule as the feedback filter this replaced.
 */
async function loadViewerRelations({
  followingCreatorIds,
  items,
  serviceClient,
  viewerUserId,
}: {
  followingCreatorIds: Set<string>;
  items: ShowcaseFeedItem[];
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}): Promise<FeedViewerRelations | null> {
  const relations: FeedViewerRelations = {
    viewerUserId,
    followingCreatorIds,
    blockedCreatorIds: new Set(),
    hiddenPostIds: new Set(),
    hiddenCreatorIds: new Set(),
    reportedPostIds: new Set(),
  };
  if (!viewerUserId || items.length === 0) return relations;

  const postIds = items.map((item) => item.id);
  const creatorIds = uniqueCreatorIds(items);
  try {
    const [postFeedback, creatorFeedback, reports, blockedCreatorIds] = await Promise.all([
      serviceClient
        .from('feed_user_post_feedback')
        .select('post_id')
        .eq('user_id', viewerUserId)
        .eq('is_active', true)
        .in('post_id', postIds),
      creatorIds.length
        ? serviceClient
          .from('feed_user_creator_feedback')
          .select('creator_user_id')
          .eq('user_id', viewerUserId)
          .eq('is_active', true)
          .in('creator_user_id', creatorIds)
        : Promise.resolve({ data: [], error: null }),
      serviceClient
        .from('post_reports')
        .select('post_id')
        .eq('reporter_user_id', viewerUserId)
        .neq('status', 'dismissed')
        .in('post_id', postIds),
      // Throws on a failed read, which lands in the catch below.
      loadBlockedCreatorIds({ adminSupabase: serviceClient, creatorIds, viewerUserId }),
    ]);
    const readError = postFeedback.error ?? creatorFeedback.error ?? reports.error;
    if (readError) throw readError;

    relations.blockedCreatorIds = blockedCreatorIds;
    for (const row of postFeedback.data ?? []) relations.hiddenPostIds.add(String(row.post_id));
    for (const row of creatorFeedback.data ?? []) relations.hiddenCreatorIds.add(String(row.creator_user_id));
    for (const row of reports.data ?? []) relations.reportedPostIds.add(String(row.post_id));
    return relations;
  } catch (error) {
    logBackendError('error_loading_feed_viewer_relations', { error });
    return null;
  }
}

/**
 * `creator_feed_stats.negative_feedback_rate` per candidate creator, for the
 * recommendation-only creator rule. Read only when the version configures
 * that rule (a threshold of 1 can never be exceeded), from the 30-day window
 * the candidate RPC reads creator exposure and quality from. A creator with
 * no stats row, or with fewer rendered deliveries than the cold-start
 * exposure threshold, has no evidence yet and is never dropped: a report
 * counts two negatives, so at the 0.08 threshold one open report sinks any
 * creator rendered fewer than 8 times, and those are the authors the cold
 * pool and slot exist to surface. Null when the read fails: the rule cannot
 * be evaluated, so nothing is cleared.
 */
async function loadCreatorNegativeFeedbackRates({
  items,
  minimumRenderedCount,
  serviceClient,
  thresholds,
}: {
  items: ShowcaseFeedItem[];
  /** The retrieval config's cold impression threshold. */
  minimumRenderedCount: number;
  serviceClient: SupabaseClient;
  thresholds: FeedVisibilityThresholds;
}): Promise<Map<string, number> | null> {
  const rates = new Map<string, number>();
  const creatorIds = uniqueCreatorIds(items);
  if (thresholds.recommendationMaxCreatorNegativeRate >= 1 || creatorIds.length === 0) return rates;

  try {
    const { data, error } = await serviceClient
      .from('creator_feed_stats')
      .select('creator_user_id, negative_feedback_rate, rendered_count')
      .eq('window_key', '30d')
      .in('creator_user_id', creatorIds);
    if (error) throw error;
    for (const row of data ?? []) {
      const rate = Number(row.negative_feedback_rate);
      const rendered = Number(row.rendered_count);
      if (!Number.isFinite(rendered) || rendered < minimumRenderedCount) continue;
      if (Number.isFinite(rate)) rates.set(String(row.creator_user_id), rate);
    }
    return rates;
  } catch (error) {
    logBackendError('error_loading_feed_creator_negative_feedback_rates', { error });
    return null;
  }
}

/**
 * Active `account_labels` per candidate creator, for the recommendation-level
 * `labelled_account` rule. Read for a v4 ranking only, the version whose RPC
 * already keeps a labelled author out of every pool but `following`: this is
 * defence in depth for what reaches the stage another way (a recent top-up
 * post) or after the ranking (a continuation page served once the label was
 * written). Null when the read fails: the rule cannot be evaluated, so nothing
 * is cleared, as with the other relation reads.
 */
async function loadAuthorLabels({
  candidateRpc,
  items,
  serviceClient,
}: {
  candidateRpc: RankedFeedRetrievalConfig['candidateRpc'];
  items: ShowcaseFeedItem[];
  serviceClient: SupabaseClient;
}): Promise<Map<string, string[]> | null> {
  const labels = new Map<string, string[]>();
  const creatorIds = uniqueCreatorIds(items);
  if (candidateRpc !== 'v4' || creatorIds.length === 0) return labels;

  try {
    const { data, error } = await serviceClient
      .from('account_labels')
      .select('user_id, label')
      .in('user_id', creatorIds)
      .gt('expires_at', new Date().toISOString());
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ user_id: unknown; label: unknown }>) {
      if (typeof row.user_id !== 'string' || typeof row.label !== 'string') continue;
      labels.set(row.user_id, [...(labels.get(row.user_id) ?? []), row.label]);
    }
    return labels;
  } catch (error) {
    logBackendError('error_loading_feed_author_labels', { error });
    return null;
  }
}

function authorLabelsFor(item: ShowcaseFeedItem, labels: Map<string, string[]>) {
  return item.creator.id ? labels.get(item.creator.id) ?? [] : [];
}

/**
 * A hydrated item as the visibility stage sees it. Hydration only returns
 * public, unarchived posts whose review status is visible
 * (`fetchPostRowsByIds`/`fetchPostRows` and `resolvePostRowsToFeedItems` in
 * `showcase-feed.ts`), and feed items do not carry those columns, so the
 * candidate states the values hydration enforced; left undefined, every post
 * would drop as `post_not_public`.
 */
function visibilityCandidate(
  item: ShowcaseFeedItem,
  negativeFeedbackRisk: number | null,
  creatorNegativeFeedbackRate: number | null,
  authorLabels: string[],
): FeedVisibilityCandidate & { item: ShowcaseFeedItem } {
  return {
    item,
    postId: item.id,
    creatorId: item.creator.id || null,
    visibility: item.visibility ?? 'public',
    archivedAt: null,
    reviewStatus: 'visible',
    isNsfw: item.isNsfw === true,
    negativeFeedbackRisk,
    creatorNegativeFeedbackRate,
    authorLabels,
  };
}

function buildPage({
  algorithmVersion = SHOWCASE_FEED_ALGORITHM_VERSION,
  feedSessionId = null,
  hasMore,
  items,
  limit,
  nextCursor,
  offset,
}: {
  algorithmVersion?: string;
  feedSessionId?: string | null;
  hasMore: boolean;
  items: ShowcaseFeedItem[];
  limit: number;
  nextCursor: string | null;
  offset: number;
}): ShowcaseFeedPage {
  return {
    items,
    feedSessionId,
    algorithmVersion,
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      nextCursor,
      limit,
      offset,
    },
  };
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function boundedFraction(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

// For the v3 keys a JSON null is a missing key, as in the ranking module's
// diversity config: `Number(null)` is 0, which would switch a pool or a
// window off rather than leave it at its default.
function optionalBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  return boundedInteger(value ?? undefined, fallback, minimum, maximum);
}

function optionalBoundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

// A v4 switch is on unless the version says false; a string or a number is no answer.
function optionalBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Retrieval is configuration-driven from v2 onward. v1 hard-coded its pool
 * sizes in SQL and ignored these values, which is why a re-weighted variant
 * could not change what was actually retrieved. The v3 keys default to the
 * v3 RPC's own parameter defaults and bounds, and the two recommendation-only
 * visibility thresholds default to off, so a v1 or v2 row reads exactly as
 * before. Those thresholds are read for the v3 and v4 RPCs only: they alone
 * return `is_following`, and without it every creator, followed or not, would
 * be judged at the recommendations level. The v4 keys likewise default to the
 * v4 RPC's own parameter defaults and bounds, and only the v4 call reads them.
 */
export function normalizeRetrievalConfig(
  config: Record<string, unknown> | null | undefined,
): RankedFeedRetrievalConfig {
  const retrieval = config ?? {};
  const candidateRpc: RankedFeedRetrievalConfig['candidateRpc'] = retrieval.candidate_rpc === 'v4'
    ? 'v4'
    : retrieval.candidate_rpc === 'v3'
      ? 'v3'
      : retrieval.candidate_rpc === 'v2' ? 'v2' : 'v1';
  return {
    candidateRpc,
    followingLimit: boundedInteger(retrieval.following_limit, 100, 0, 500),
    interestLimit: boundedInteger(retrieval.interest_limit, 150, 0, 500),
    trendingLimit: boundedInteger(retrieval.trending_limit, 100, 0, 500),
    recentLimit: boundedInteger(retrieval.recent_limit, 150, 0, 500),
    explorationLimit: boundedInteger(retrieval.exploration_limit, 100, 0, 500),
    seenLookbackDays: boundedInteger(retrieval.seen_lookback_days, 14, 0, 365),
    seenPenalty: boundedFraction(retrieval.seen_penalty, DEFAULT_SEEN_REPEAT_PENALTY),
    creatorPriorCap: boundedFraction(retrieval.creator_prior_cap, 0.15),
    explorationConfidence: (() => {
      const parsed = Number(retrieval.exploration_confidence);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? parsed : 1.5;
    })(),
    coldLimit: optionalBoundedInteger(retrieval.cold_limit, 50, 0, 500),
    coldMaxAgeHours: optionalBoundedInteger(retrieval.cold_max_age_hours, 168, 0, 8760),
    coldImpressionThreshold: optionalBoundedInteger(retrieval.cold_impression_threshold, 60, 0, 100_000),
    maxAgeDays: optionalBoundedInteger(retrieval.max_age_days, 365, 1, 3650),
    servedLookbackHours: optionalBoundedInteger(retrieval.served_lookback_hours, 6, 0, 8760),
    trendingPerAuthorCap: optionalBoundedInteger(retrieval.trending_per_author_cap, 5, 1, 50),
    creatorPriorMean: boundedFraction(retrieval.creator_prior_mean ?? undefined, 0.15),
    sessionItemLimit: boundedInteger(
      retrieval.session_item_limit,
      SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT,
      1,
      SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT,
    ),
    semanticLimit: optionalBoundedInteger(retrieval.semantic_limit, 150, 0, 500),
    semanticMinSimilarity: optionalBoundedNumber(retrieval.semantic_min_similarity, 0, -1, 1),
    tasteLookbackDays: optionalBoundedInteger(retrieval.taste_lookback_days, 90, 1, 365),
    tasteLimit: optionalBoundedInteger(retrieval.taste_limit, 50, 1, 200),
    excludeNearDuplicates: optionalBoolean(retrieval.exclude_near_duplicates, true),
    excludeLabelledAccounts: optionalBoolean(retrieval.exclude_labelled_accounts, true),
    visibilityThresholds: normalizeFeedVisibilityThresholds(returnsV3Columns(candidateRpc) ? retrieval : null),
  };
}

function normalizeAlgorithmConfig(row: ActiveAlgorithmRow): ActiveAlgorithmConfig {
  const retrieval = normalizeRetrievalConfig(row.retrieval_config);
  return {
    ...row,
    algorithmVersion: `${row.algorithm_key}-v${row.version}`,
    candidateLimit: boundedInteger(
      row.retrieval_config?.candidate_limit,
      SHOWCASE_FEED_CANDIDATE_LIMIT,
      1,
      SHOWCASE_FEED_CANDIDATE_LIMIT,
    ),
    eligibleItemLimit: retrieval.sessionItemLimit,
    scoreWeights: normalizeRankedFeedScoreWeights(row.weights),
    diversityConfig: normalizeRankedFeedDiversityConfig(row.diversity_config),
    retrieval,
  };
}

async function getAlgorithmVersion(
  serviceClient: SupabaseClient,
  id?: string,
) {
  let query = serviceClient
    .from('feed_algorithm_versions')
    .select('id, algorithm_key, version, weights, retrieval_config, diversity_config');
  query = id
    ? query.eq('id', id)
    : query.eq('algorithm_key', 'for-you-rules').eq('status', 'active');
  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;
  return normalizeAlgorithmConfig(data as ActiveAlgorithmRow);
}

/**
 * An assigned variant's algorithm outranks the active one. If the assignment
 * points at a version that no longer loads, fall back to active rather than
 * failing the request — but drop the assignment id with it, so no delivery is
 * ever attributed to an arm it was not actually served.
 */
async function resolveAlgorithmForViewer({
  anonymousKeyHash,
  serviceClient,
  viewerUserId,
}: {
  anonymousKeyHash: string | null;
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}) {
  // The active algorithm and experiment definition are independent reads.
  // Most requests have no running experiment, so serializing these added a
  // complete PostgREST round trip to every personalized page.
  const [assignment, active] = await Promise.all([
    resolveFeedExperimentAssignment({
      anonymousKeyHash,
      serviceClient,
      viewerUserId,
    }).catch(() => null),
    getAlgorithmVersion(serviceClient),
  ]);

  if (assignment) {
    const assigned = active?.id === assignment.variant.algorithmVersionId
      ? active
      : await getAlgorithmVersion(serviceClient, assignment.variant.algorithmVersionId);
    if (assigned) {
      return {
        algorithm: assigned,
        experimentAssignmentId: assignment.assignmentId,
        experimentId: assignment.experimentId,
        experimentVariantId: assignment.variant.id,
      };
    }
  }

  return {
    algorithm: active,
    experimentAssignmentId: null,
    experimentId: null,
    experimentVariantId: null,
  };
}

async function loadPersistedPage({
  anonymousKeyHash,
  cursorValue,
  hydratePostIds,
  limit,
  preloadedAlgorithm = null,
  preloadedSession = null,
  serviceClient,
  viewerUserId,
  onPhaseTiming,
}: {
  anonymousKeyHash: string | null;
  cursorValue: string;
  hydratePostIds: (postIds: string[]) => Promise<ShowcaseFeedItem[]>;
  limit: number;
  preloadedAlgorithm?: ActiveAlgorithmConfig | null;
  preloadedSession?: FeedSessionRow | null;
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
  onPhaseTiming?: (phase: string, durationMs: number) => void;
}): Promise<ShowcaseFeedPage | null> {
  const timed = async <T>(phase: string, work: () => PromiseLike<T>): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      onPhaseTiming?.(phase, performance.now() - startedAt);
    }
  };
  const cursor = decodeRankedFeedCursor(cursorValue);
  if (!cursor) return null;

  let session = preloadedSession;
  let sessionError: unknown = null;
  if (!session || session.id !== cursor.sessionId) {
    const result = await serviceClient
      .from('feed_sessions')
      .select('id, viewer_user_id, anonymous_key_hash, algorithm_version_id, created_at, expires_at')
      .eq('id', cursor.sessionId)
      .maybeSingle();
    session = result.data as FeedSessionRow | null;
    sessionError = result.error;
  }
  const expectedAnonymousKeyHash = viewerUserId ? null : anonymousKeyHash;
  const expiresAt = session ? Date.parse(session.expires_at) : Number.NaN;
  if (
    sessionError
    || !session
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
    || session.viewer_user_id !== viewerUserId
    || session.anonymous_key_hash !== expectedAnonymousKeyHash
  ) {
    return null;
  }

  const algorithm = preloadedAlgorithm?.id === session.algorithm_version_id
    ? preloadedAlgorithm
    : await getAlgorithmVersion(serviceClient, session.algorithm_version_id);
  if (!algorithm) return null;

  const scanBatchSize = Math.max(24, Math.min(FEED_HYDRATION_BATCH_SIZE, limit * 2));
  const eligibleRows: Array<{
    item: ShowcaseFeedItem;
    row: FeedSessionItemRow;
  }> = [];
  let nextScanPosition = cursor.position;
  let scannedRows = 0;
  let exhausted = false;
  let hydrationHasGaps = false;

  while (
    eligibleRows.length < limit + 1
    && scannedRows < SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT
    && !exhausted
  ) {
    const batchLimit = Math.min(
      scanBatchSize,
      SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT - scannedRows,
    );
    const { data, error } = await timed('session_items', () => serviceClient
      .from('feed_session_items')
      .select('id, post_id, position, candidate_source, final_score, score_components')
      .eq('session_id', session.id)
      .gte('position', nextScanPosition)
      .order('position', { ascending: true })
      .limit(batchLimit));
    if (error) return null;

    const rows = (data ?? []) as FeedSessionItemRow[];
    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    scannedRows += rows.length;
    nextScanPosition = rows[rows.length - 1].position + 1;
    exhausted = rows.length < batchLimit;

    // Hydrate only enough rows to fill the page plus its lookahead. If edits,
    // moderation or feedback remove candidates, consume the rest of this scan
    // batch together, preserving the bounded fallback and cursor semantics.
    let hydrationOffset = 0;
    while (hydrationOffset < rows.length && eligibleRows.length < limit + 1) {
      const hydrationCount = hydrationOffset === 0 && !hydrationHasGaps
        ? limit + 1 - eligibleRows.length
        : rows.length - hydrationOffset;
      const hydrationRows = rows.slice(hydrationOffset, hydrationOffset + hydrationCount);
      hydrationOffset += hydrationRows.length;
      const hydrated = await timed('session_hydration', () =>
        hydratePostIds(hydrationRows.map((row) => row.post_id)));
      const persistedFeatures = new Map(
        hydrationRows.map((row) => [row.post_id, featureRowFromSessionItem(row)]),
      );
      const [relations, authorLabels] = await timed('session_feedback', () => Promise.all([
        loadViewerRelations({
          followingCreatorIds: followedCreatorIds(
            hydrated,
            (postId) => persistedFeatures.get(postId)?.isFollowing === true,
          ),
          items: hydrated,
          serviceClient,
          viewerUserId,
        }),
        loadAuthorLabels({
          candidateRpc: algorithm.retrieval.candidateRpc,
          items: hydrated,
          serviceClient,
        }),
      ]));
      if (!relations || !authorLabels) return null;
      // The session holds only posts that cleared the visibility stage when it
      // was ranked; this re-applies it for whatever changed since (a block, a
      // hide, a report, a take-down, a v4 account label). The persisted risk
      // and follow state keep the recommendation-only rules where ranking left
      // them, and the creator rate is not read again: every post here already
      // passed that rule.
      const visibleItems = filterFeedVisibility(
        hydrated.map((item) => visibilityCandidate(
          item,
          persistedFeatures.get(item.id)?.negativeFeedbackRisk ?? null,
          null,
          authorLabelsFor(item, authorLabels),
        )),
        relations,
        algorithm.retrieval.visibilityThresholds,
      ).kept.map((candidate) => candidate.item);
      hydrationHasGaps ||= visibleItems.length < hydrationRows.length;

      const itemById = new Map(visibleItems.map((item) => [item.id, item]));
      for (const row of hydrationRows) {
        const hydratedItem = itemById.get(row.post_id);
        if (hydratedItem) eligibleRows.push({ item: hydratedItem, row });
        if (eligibleRows.length >= limit + 1) break;
      }
    }
  }

  const pageRows = eligibleRows.slice(0, limit);
  const hasMore = eligibleRows.length > limit;
  const nextPosition = pageRows.at(-1)?.row.position === undefined
    ? null
    : (pageRows.at(-1)?.row.position as number) + 1;

  // Page one was marked served atomically when this session was created. A
  // short-lived session reuse is therefore a read of the same exposure, not a
  // new exposure. Rewriting the session, its items, and duplicate delivery
  // facts here added three database waits to the hottest authenticated path;
  // the fact-template read alone reached 2.6s in production. Continuation
  // pages still mint their own facts below because those positions have not
  // previously been exposed.
  if (cursor.position > 0) {
    const servedAt = new Date().toISOString();
    const telemetryWrites: Array<PromiseLike<unknown> | Promise<unknown>> = [
      serviceClient
        .from('feed_sessions')
        .update({ last_accessed_at: servedAt })
        .eq('id', session.id),
    ];
    if (pageRows.length > 0) {
      telemetryWrites.push(serviceClient
        .from('feed_session_items')
        .update({ served_at: servedAt })
        .in('id', pageRows.map(({ row }) => row.id)));
      telemetryWrites.push(recordServedDeliveryFacts(
        serviceClient,
        session.id,
        pageRows.map(({ item, row }) => ({
          deliveryId: row.id,
          postId: row.post_id,
          creatorUserId: item.creator.id || null,
          row,
        })),
      ));
    }
    await Promise.all(telemetryWrites);
  }

  return buildPage({
    algorithmVersion: algorithm.algorithmVersion,
    feedSessionId: session.id,
    hasMore,
    items: pageRows.map(({ item, row }) => ({
      ...item,
      recommendation: buildRecommendationContext({
        deliveryId: String(row.id),
        features: featureRowFromSessionItem(row),
        position: row.position,
        algorithmVersion: algorithm.algorithmVersion,
      }),
    })),
    limit,
    nextCursor: hasMore && nextPosition !== null
      ? encodeRankedFeedCursor({ sessionId: session.id, position: nextPosition })
      : null,
    offset: cursor.position,
  });
}

async function persistRankedSession({
  algorithmVersionId,
  anonymousKeyHash,
  candidateRpc,
  experimentAssignmentId,
  experimentId,
  experimentVariantId,
  filters,
  limit,
  offset,
  randomSeed,
  ranked,
  serviceClient,
  viewerUserId,
}: {
  algorithmVersionId: string;
  anonymousKeyHash: string | null;
  /** The RPC `ranked` was retrieved with; only v3 rows carry the v3 columns. */
  candidateRpc: RankedFeedRetrievalConfig['candidateRpc'];
  experimentAssignmentId: number | null;
  experimentId: string | null;
  experimentVariantId: string | null;
  filters: RankedFeedFilters;
  /** The slice this request will actually return; only it gets delivery facts. */
  limit: number;
  offset: number;
  /** The seed `ranked` was ranked with, so the session replays exactly. */
  randomSeed: number;
  ranked: RankedShowcaseItem[];
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}) {
  if ((!viewerUserId && !anonymousKeyHash) || ranked.length === 0) return null;

  const now = new Date();
  const { data, error } = await serviceClient.rpc('persist_ranked_feed_session', {
    p_session: {
      viewer_user_id: viewerUserId,
      anonymous_key_hash: viewerUserId ? null : anonymousKeyHash,
      filters,
      algorithm_version_id: algorithmVersionId,
      random_seed: randomSeed,
      expires_at: new Date(now.getTime() + FEED_SESSION_EXPIRY_MS).toISOString(),
      served_at: now.toISOString(),
    },
    p_items: ranked.map((entry) => ({
      post_id: entry.item.id,
      creator_user_id: entry.item.creator.id || null,
      candidate_source: entry.features.candidateSource,
      final_score: entry.score,
      score_components: scoreComponents(entry, candidateRpc),
    })),
    p_experiment: {
      assignment_id: experimentAssignmentId,
      experiment_id: experimentId,
      variant_id: experimentVariantId,
    },
    p_offset: offset,
    p_limit: limit,
  });
  // All three writes commit together. On error the database rolls everything
  // back; return the existing unpersisted-page fallback without a cursor.
  if (error || !data?.session_id || !Array.isArray(data.deliveries)) return null;
  return {
    sessionId: String(data.session_id),
    deliveryIdsByPosition: new Map(
      (data.deliveries as Array<{ id: string; position: number }>)
        .map((row) => [row.position, row.id]),
    ),
  };
}

/**
 * Mint delivery facts for a continuation page as it is served.
 *
 * Facts used to be written for every ranked candidate up front, so a later page
 * only had to stamp `served_at`. They are now created per served slice, which
 * means a cursor page has to create its own.
 *
 * Every dimension a fact needs beyond the session item is constant across the
 * session, so the session's first fact — written when page one was served — is
 * the template. That avoids widening `feed_sessions` just to carry experiment
 * columns to a path that already has a row holding them.
 *
 * `delivery_id` is the primary key and this ignores duplicates, so re-requesting
 * the same cursor page cannot double-write or move `served_at`: the marker stays
 * write-once, which matters because it is the denominator for qualified-view
 * rates.
 *
 * Facts are telemetry. A failure here must never fail the page, so everything is
 * swallowed and the caller is not told.
 */
async function recordServedDeliveryFacts(
  serviceClient: SupabaseClient,
  sessionId: string,
  served: Array<{ deliveryId: string | number; postId: string; creatorUserId: string | null; row: FeedSessionItemRow }>,
) {
  if (served.length === 0) return;

  try {
    const { data: templateData } = await serviceClient
      .from('feed_delivery_facts')
      .select(
        'algorithm_version_id, experiment_assignment_id, experiment_id, experiment_variant_id, viewer_user_id, anonymous_key_hash, surface, mode, ranked_at',
      )
      .eq('session_id', sessionId)
      .limit(1)
      .maybeSingle();
    if (!templateData) return;

    const template = templateData as Record<string, unknown>;
    const servedAt = new Date().toISOString();
    await serviceClient
      .from('feed_delivery_facts')
      .upsert(
        served.map(({ deliveryId, postId, creatorUserId, row }) => ({
          delivery_id: deliveryId,
          session_id: sessionId,
          algorithm_version_id: template.algorithm_version_id,
          experiment_assignment_id: template.experiment_assignment_id,
          experiment_id: template.experiment_id,
          experiment_variant_id: template.experiment_variant_id,
          viewer_user_id: template.viewer_user_id,
          anonymous_key_hash: template.anonymous_key_hash,
          post_id: postId,
          creator_user_id: creatorUserId,
          position: row.position,
          candidate_source: row.candidate_source,
          is_exploration: row.candidate_source === 'exploration',
          exploration_propensity: row.candidate_source === 'exploration' ? 1 : 0,
          final_score: row.final_score,
          score_components: row.score_components,
          surface: template.surface,
          mode: template.mode,
          ranked_at: template.ranked_at,
          served_at: servedAt,
        })),
        { onConflict: 'delivery_id', ignoreDuplicates: true },
      );
  } catch {
    // Intentionally silent; see the note above.
  }
}

async function loadCandidateFeatures({
  algorithm,
  anonymousKeyHash,
  category,
  serviceClient,
  viewerUserId,
}: {
  algorithm: ActiveAlgorithmConfig;
  anonymousKeyHash: string | null;
  category: ShowcaseCategory;
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}) {
  const rpcCategory = category === 'all' || category === 'media' || category === 'image' || category === 'video' || category === 'text'
    ? null
    : category;
  const asOf = new Date().toISOString();
  const { retrieval } = algorithm;
  // v3 takes every v2 parameter, plus its own; v4 takes every v3 parameter, plus its own.
  const poolParameters = {
    p_viewer_user_id: viewerUserId,
    // Anonymous viewers get seen suppression too; without the hash their
    // repeat history is invisible and the feed loops for exactly the
    // audience least likely to tolerate it.
    p_anonymous_key_hash: viewerUserId ? null : anonymousKeyHash,
    p_category: rpcCategory,
    p_following_limit: retrieval.followingLimit,
    p_interest_limit: retrieval.interestLimit,
    p_trending_limit: retrieval.trendingLimit,
    p_recent_limit: retrieval.recentLimit,
    p_exploration_limit: retrieval.explorationLimit,
    p_seen_lookback_days: retrieval.seenLookbackDays,
    p_creator_prior_cap: retrieval.creatorPriorCap,
    p_exploration_confidence: retrieval.explorationConfidence,
    p_as_of: asOf,
  };
  const v3Parameters = {
    ...poolParameters,
    p_cold_limit: retrieval.coldLimit,
    p_cold_max_age_hours: retrieval.coldMaxAgeHours,
    p_cold_impression_threshold: retrieval.coldImpressionThreshold,
    p_max_age_days: retrieval.maxAgeDays,
    p_served_lookback_hours: retrieval.servedLookbackHours,
    p_trending_per_author_cap: retrieval.trendingPerAuthorCap,
    p_creator_prior_mean: retrieval.creatorPriorMean,
  };
  const candidateRequest = (() => {
    switch (retrieval.candidateRpc) {
      case 'v4':
        return serviceClient.rpc('get_ranked_feed_candidates_v4', {
          ...v3Parameters,
          p_semantic_limit: retrieval.semanticLimit,
          p_semantic_min_similarity: retrieval.semanticMinSimilarity,
          p_taste_lookback_days: retrieval.tasteLookbackDays,
          p_taste_limit: retrieval.tasteLimit,
          p_exclude_near_duplicates: retrieval.excludeNearDuplicates,
          p_exclude_labelled_accounts: retrieval.excludeLabelledAccounts,
        });
      case 'v3':
        return serviceClient.rpc('get_ranked_feed_candidates_v3', v3Parameters);
      case 'v2':
        return serviceClient.rpc('get_ranked_feed_candidates_v2', poolParameters);
      default:
        return serviceClient.rpc('get_ranked_feed_candidates', {
          p_viewer_user_id: viewerUserId,
          p_category: rpcCategory,
          p_limit: algorithm.candidateLimit,
          p_as_of: asOf,
        });
    }
  })();
  const { data, error } = await candidateRequest;
  if (error) return null;
  return ((data ?? []) as RankedCandidateRpcRow[])
    .map(normalizeRankedFeedFeatureRow)
    .filter((row): row is RankedFeedFeatureRow => Boolean(row));
}

async function hydrateEligibleCandidates({
  eligibleItemLimit,
  featureRows,
  hydratePostIds,
}: {
  eligibleItemLimit: number;
  featureRows: RankedFeedFeatureRow[];
  hydratePostIds: (postIds: string[]) => Promise<ShowcaseFeedItem[]>;
}) {
  const eligibleItems: ShowcaseFeedItem[] = [];
  const seenIds = new Set<string>();

  let index = 0;
  while (index < featureRows.length && eligibleItems.length < eligibleItemLimit) {
    const batchSize = Math.min(
      FEED_HYDRATION_BATCH_SIZE,
      eligibleItemLimit - eligibleItems.length,
    );
    const batch = featureRows.slice(index, index + batchSize);
    index += batch.length;
    const hydrated = await hydratePostIds(batch.map((row) => row.postId));
    for (const item of hydrated) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      eligibleItems.push(item);
      if (eligibleItems.length >= eligibleItemLimit) break;
    }
  }

  return eligibleItems;
}

async function findReusableSession({
  anonymousKeyHash,
  filters,
  scope,
  serviceClient,
  viewerUserId,
}: {
  anonymousKeyHash: string | null;
  filters: RankedFeedFilters;
  scope?: { algorithmVersionId: string; experimentAssignmentId: number | null };
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}) {
  if (!viewerUserId && !anonymousKeyHash) return null;

  const now = new Date();
  let query = serviceClient
    .from('feed_sessions')
    .select('id, viewer_user_id, anonymous_key_hash, algorithm_version_id, experiment_assignment_id, created_at, expires_at')
    .eq('surface', 'showcase')
    .eq('mode', 'for-you')
    .contains('filters', filters)
    .gt('expires_at', now.toISOString())
    .gte('created_at', new Date(now.getTime() - FEED_SESSION_REUSE_TTL_MS).toISOString());
  if (scope) {
    query = query.eq('algorithm_version_id', scope.algorithmVersionId);
    query = scope.experimentAssignmentId === null
      ? query.is('experiment_assignment_id', null)
      : query.eq('experiment_assignment_id', scope.experimentAssignmentId);
  }
  query = viewerUserId
    ? query.eq('viewer_user_id', viewerUserId).is('anonymous_key_hash', null)
    : query.is('viewer_user_id', null).eq('anonymous_key_hash', anonymousKeyHash);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.id) return null;
  return data as FeedSessionRow & { experiment_assignment_id: number | null };
}

/**
 * Hydration keeps only the first `limit` rows of the pre-sort, and a
 * cold-pool post (new, from an author with almost no exposure) scores near the
 * bottom almost by definition: past the cut, the cold-start slot would have
 * nothing left to draw from. So a sixth of the cut, at most 10 places, goes to
 * the highest-ranked rows the cold pool retrieved. A cold row below the cut
 * takes the place of the lowest-ranked other row inside it, which moves to
 * just below the cut, first in line should hydration lose a row. A repeat, or
 * a post served recently and passed over, never takes a place: neither can be
 * the cold-start pick.
 */
function reserveColdCandidateRows(rows: RankedFeedFeatureRow[], limit: number) {
  const places = Math.min(COLD_CANDIDATE_RESERVED_PLACES, Math.floor(limit / 6));
  if (rows.length <= limit || places <= 0) return rows;
  const reservable = (row: RankedFeedFeatureRow) => (
    !row.seenRecently
    && row.servedRecently !== true
    && (row.sources ?? [row.candidateSource]).includes('cold')
  );
  const inside = rows.slice(0, limit);
  const below = rows.slice(limit);
  const promoted = below
    .filter(reservable)
    .slice(0, Math.max(0, places - inside.filter(reservable).length));
  if (promoted.length === 0) return rows;

  // A sixth of the cut leaves far more other rows inside it than places.
  const demoted: RankedFeedFeatureRow[] = [];
  for (let index = inside.length - 1; index >= 0 && demoted.length < promoted.length; index -= 1) {
    if (!reservable(inside[index])) demoted.unshift(inside[index]);
  }
  const promotedRows = new Set(promoted);
  const demotedRows = new Set(demoted);
  return [
    ...inside.filter((row) => !demotedRows.has(row)),
    ...promoted,
    ...demoted,
    ...below.filter((row) => !promotedRows.has(row)),
  ];
}

/**
 * The seed the cold-start draws come from. A ranking a cursor can resume keeps
 * a random seed, persisted with its session. A ranking no cursor resumes is
 * run again for every page: the identityless bootstrap (cached, never
 * persisted) and every offset > 0 ranking. Those share one seed per 10-minute
 * bucket, so the next page is cut from the order the last one was. With a
 * fresh seed the next ranking's slot could hold a different post, above the
 * cut where it is never shown, and the previous pick could come round again.
 */
function rankingSeed({ identityless, offset }: { identityless: boolean; offset: number }) {
  if (!identityless && offset === 0) return Math.floor(Math.random() * FEED_RANDOM_SEED_MODULUS);
  return Math.floor(Date.now() / FEED_SHARED_SEED_BUCKET_MS) % FEED_RANDOM_SEED_MODULUS;
}

function mergeUniqueFeedItems(
  primaryItems: ShowcaseFeedItem[],
  fallbackItems: ShowcaseFeedItem[],
) {
  const itemsById = new Map<string, ShowcaseFeedItem>();
  for (const item of [...primaryItems, ...fallbackItems]) {
    if (!itemsById.has(item.id)) itemsById.set(item.id, item);
  }
  return Array.from(itemsById.values());
}

export async function getPersonalizedShowcaseFeedPage({
  anonymousKeyHash,
  cursor,
  fallbackItems,
  filters,
  hydratePostIds,
  limit,
  offset,
  serviceClient,
  viewerUserId,
  onPhaseTiming,
}: {
  anonymousKeyHash: string | null;
  cursor: string | null;
  fallbackItems: (target: number) => Promise<ShowcaseFeedItem[]>;
  filters: RankedFeedFilters;
  hydratePostIds: (postIds: string[]) => Promise<ShowcaseFeedItem[]>;
  limit: number;
  offset: number;
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
  onPhaseTiming?: (phase: string, durationMs: number) => void;
}): Promise<ShowcaseFeedPage> {
  const timed = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      onPhaseTiming?.(phase, performance.now() - startedAt);
    }
  };
  if (cursor) {
    const persisted = await timed('cursor_load', () => loadPersistedPage({
      onPhaseTiming,
      anonymousKeyHash,
      cursorValue: cursor,
      hydratePostIds,
      limit,
      serviceClient,
      viewerUserId,
    }));
    if (persisted) return persisted;

    // A continuation token is a request for one immutable session. If it is
    // malformed, expired, or belongs to another viewer, never turn it into a
    // fresh session with unrelated results.
    return buildPage({
      hasMore: false,
      items: [],
      limit,
      nextCursor: null,
      offset,
    });
  }

  // The latest viewer/filter-matching session can be read while the algorithm
  // and experiment resolve. Never use it until both scope fields match below.
  const [resolvedAlgorithm, candidateSession] = await Promise.all([
    timed('algorithm', () => resolveAlgorithmForViewer({
      anonymousKeyHash,
      serviceClient,
      viewerUserId,
    })),
    offset === 0
      ? timed('session_reuse', () => findReusableSession({
        anonymousKeyHash,
        filters,
        serviceClient,
        viewerUserId,
      }))
      : Promise.resolve(null),
  ]);
  const {
    algorithm,
    experimentAssignmentId,
    experimentId,
    experimentVariantId,
  } = resolvedAlgorithm;
  if (!algorithm) {
    const fallback = await fallbackItems(Math.min(
      SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT,
      Math.max(limit, offset + limit),
    ));
    return buildPage({
      algorithmVersion: SHOWCASE_FEED_FALLBACK_ALGORITHM_VERSION,
      feedSessionId: null,
      hasMore: false,
      items: fallback.slice(offset, offset + limit),
      limit,
      nextCursor: null,
      offset,
    });
  }

  if (offset === 0) {
    // A newer session may belong to another algorithm or experiment. Retain
    // the exact scoped lookup in that case so an older valid session wins.
    const reusableSession = candidateSession
      && (candidateSession.algorithm_version_id !== algorithm.id
        || candidateSession.experiment_assignment_id !== experimentAssignmentId)
      ? await timed('session_reuse_fallback', () => findReusableSession({
        scope: { algorithmVersionId: algorithm.id, experimentAssignmentId },
        anonymousKeyHash,
        filters,
        serviceClient,
        viewerUserId,
      }))
      : candidateSession;
    if (reusableSession) {
      const reused = await timed('session_page', () => loadPersistedPage({
        onPhaseTiming,
        anonymousKeyHash,
        cursorValue: encodeRankedFeedCursor({ sessionId: reusableSession.id, position: 0 }),
        hydratePostIds,
        limit,
        preloadedAlgorithm: algorithm,
        preloadedSession: reusableSession,
        serviceClient,
        viewerUserId,
      }));
      if (reused) return reused;
    }
  }

  const featureRows = await timed('candidate_rpc', () => loadCandidateFeatures({
    algorithm,
    anonymousKeyHash,
    category: filters.category,
    serviceClient,
    viewerUserId,
  }));
  // Hydration is budgeted, so the pre-sort must already respect the seen tier;
  // otherwise repeats consume the budget and never reach the reranker as the
  // last resort they are meant to be.
  const sortedFeatureRows = featureRows
    ? [...featureRows].sort((left, right) => (
      Number(left.seenRecently) - Number(right.seenRecently)
      || scoreRankedFeedFeatures(right, algorithm.scoreWeights)
      - scoreRankedFeedFeatures(left, algorithm.scoreWeights)
    ))
    : null;
  // Only the v3 and v4 RPCs have a cold pool to keep places for.
  const configuredFeatureRows = sortedFeatureRows && returnsV3Columns(algorithm.retrieval.candidateRpc)
    ? reserveColdCandidateRows(sortedFeatureRows, algorithm.eligibleItemLimit)
    : sortedFeatureRows;
  const hydratedFeatureItems = configuredFeatureRows?.length
    ? await timed('hydration', () => hydrateEligibleCandidates({
      eligibleItemLimit: algorithm.eligibleItemLimit,
      featureRows: configuredFeatureRows,
      hydratePostIds,
    }))
    : [];
  const fallbackTarget = algorithm.eligibleItemLimit - hydratedFeatureItems.length;
  const filteredFallbackItems = fallbackTarget > 0
    ? await timed('fallback', () => fallbackItems(algorithm.eligibleItemLimit))
    : [];
  const mergedCandidateItems = mergeUniqueFeedItems(hydratedFeatureItems, filteredFallbackItems);
  const featureRowsByPostId = new Map(
    (configuredFeatureRows ?? []).map((row) => [row.postId, row]),
  );
  const { visibilityThresholds } = algorithm.retrieval;
  const [relations, creatorNegativeFeedbackRates, authorLabels] = await timed('feedback', () => Promise.all([
    loadViewerRelations({
      followingCreatorIds: followedCreatorIds(
        mergedCandidateItems,
        (postId) => featureRowsByPostId.get(postId)?.isFollowing === true,
      ),
      items: mergedCandidateItems,
      serviceClient,
      viewerUserId,
    }),
    loadCreatorNegativeFeedbackRates({
      items: mergedCandidateItems,
      minimumRenderedCount: algorithm.retrieval.coldImpressionThreshold,
      serviceClient,
      thresholds: visibilityThresholds,
    }),
    loadAuthorLabels({
      candidateRpc: algorithm.retrieval.candidateRpc,
      items: mergedCandidateItems,
      serviceClient,
    }),
  ]));
  // The visibility stage runs before scoring, so a blocked, hidden or
  // reported post never takes a session slot or a delivery fact. If any
  // read failed nothing can be cleared, and every candidate drops.
  const candidateItems = filterFeedVisibility(
    mergedCandidateItems.map((item) => visibilityCandidate(
      item,
      featureRowsByPostId.get(item.id)?.negativeFeedbackRisk ?? null,
      item.creator.id ? creatorNegativeFeedbackRates?.get(item.creator.id) ?? null : null,
      authorLabels ? authorLabelsFor(item, authorLabels) : [],
    )),
    creatorNegativeFeedbackRates && authorLabels ? relations : null,
    visibilityThresholds,
  ).kept
    .map((candidate) => candidate.item)
    .slice(0, algorithm.eligibleItemLimit);
  const now = new Date();
  // Recent top-up posts arrive outside ranked retrieval. They are scored from
  // the same synthetic features as before; `sources` records the pool they
  // actually came from.
  const topUpFeatureRows = candidateItems
    .filter((item) => !featureRowsByPostId.has(item.id))
    .map((item): RankedFeedFeatureRow => ({
      ...buildFallbackRankedFeedFeatures(item, now),
      sources: ['fresh'],
    }));
  // Drawn before ranking and persisted with the session: the cold-start slot's
  // Thompson draws replay exactly from it.
  const randomSeed = rankingSeed({ identityless: !viewerUserId && !anonymousKeyHash, offset });
  const rankingStartedAt = performance.now();
  const ranked = rankAndDiversifyShowcaseItems({
    items: candidateItems,
    featureRows: [...(configuredFeatureRows ?? []), ...topUpFeatureRows],
    now,
    scoreWeights: algorithm.scoreWeights,
    diversityConfig: algorithm.diversityConfig,
    seenPenalty: algorithm.retrieval.seenPenalty,
    seed: randomSeed,
  }).slice(0, algorithm.eligibleItemLimit);
  onPhaseTiming?.('ranking', performance.now() - rankingStartedAt);
  const persisted = await timed('persistence', () => persistRankedSession({
    algorithmVersionId: algorithm.id,
    anonymousKeyHash,
    candidateRpc: algorithm.retrieval.candidateRpc,
    experimentAssignmentId,
    experimentId,
    experimentVariantId,
    filters,
    limit,
    offset,
    randomSeed,
    ranked,
    serviceClient,
    viewerUserId,
  }));
  const pageEntries = ranked.slice(offset, offset + limit);
  // Whether more content exists is a fact about the ranked pool, not about whether
  // we managed to persist a session. Only `nextCursor` needs a session, because only
  // a cursor promises to resume *this* ranking; `nextOffset` paging does not.
  //
  // Coupling the two dead-ended the signed-out home feed at exactly one page: it is
  // rendered without request headers so the page stays statically cacheable, which
  // leaves it with no anonymous key, which skips persistence — and that silently
  // turned "we could not open a session" into "there is nothing more to show".
  const hasMore = ranked.length > offset + limit;
  // Nothing to stamp: persistRankedSession created facts for exactly this slice
  // with served_at already set, because a fact now exists only because the
  // delivery was served.
  const items = persisted
    ? attachRecommendations(
      pageEntries,
      persisted.deliveryIdsByPosition,
      offset,
      algorithm.algorithmVersion,
    )
    : pageEntries.map((entry) => entry.item);
  const nextCursor = hasMore && persisted
    ? encodeRankedFeedCursor({ sessionId: persisted.sessionId, position: offset + pageEntries.length })
    : null;

  return buildPage({
    algorithmVersion: algorithm.algorithmVersion,
    feedSessionId: persisted?.sessionId ?? null,
    hasMore,
    items,
    limit,
    nextCursor,
    offset,
  });
}
