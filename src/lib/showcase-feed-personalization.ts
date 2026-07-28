import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveFeedExperimentAssignment } from '@/lib/feed-experiments';
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
  buildRecommendationContext,
  decodeRankedFeedCursor,
  encodeRankedFeedCursor,
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

type RankedFeedRetrievalConfig = {
  candidateRpc: 'v1' | 'v2';
  followingLimit: number;
  interestLimit: number;
  trendingLimit: number;
  recentLimit: number;
  explorationLimit: number;
  seenLookbackDays: number;
  seenPenalty: number;
  creatorPriorCap: number;
  explorationConfidence: number;
};

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

export type RankedFeedFilters = {
  category: ShowcaseCategory;
  toolSlug: string | null;
  unlockFilter: ShowcaseUnlockFilter;
  resourceFilter: ShowcaseResourceFilter;
};

function scoreComponents(features: RankedFeedFeatureRow) {
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

async function filterActiveViewerFeedback({
  items,
  serviceClient,
  viewerUserId,
}: {
  items: ShowcaseFeedItem[];
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}): Promise<ShowcaseFeedItem[] | null> {
  if (!viewerUserId || items.length === 0) return items;

  const creatorIds = Array.from(new Set(
    items.map((item) => item.creator.id).filter((id): id is string => Boolean(id)),
  ));
  const [postFeedback, creatorFeedback] = await Promise.all([
    serviceClient
      .from('feed_user_post_feedback')
      .select('post_id')
      .eq('user_id', viewerUserId)
      .eq('is_active', true)
      .in('post_id', items.map((item) => item.id)),
    creatorIds.length
      ? serviceClient
        .from('feed_user_creator_feedback')
        .select('creator_user_id')
        .eq('user_id', viewerUserId)
        .eq('is_active', true)
        .in('creator_user_id', creatorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (postFeedback.error || creatorFeedback.error) return null;

  const hiddenPostIds = new Set(
    (postFeedback.data ?? []).map((row) => String(row.post_id)),
  );
  const hiddenCreatorIds = new Set(
    (creatorFeedback.data ?? []).map((row) => String(row.creator_user_id)),
  );
  return items.filter((item) => (
    !hiddenPostIds.has(item.id)
    && (!item.creator.id || !hiddenCreatorIds.has(item.creator.id))
  ));
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

/**
 * Retrieval is configuration-driven from v2 onward. v1 hard-coded its pool
 * sizes in SQL and ignored these values, which is why a re-weighted variant
 * could not change what was actually retrieved.
 */
function normalizeRetrievalConfig(
  config: Record<string, unknown> | null | undefined,
): RankedFeedRetrievalConfig {
  const retrieval = config ?? {};
  return {
    candidateRpc: retrieval.candidate_rpc === 'v2' ? 'v2' : 'v1',
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
  };
}

function normalizeAlgorithmConfig(row: ActiveAlgorithmRow): ActiveAlgorithmConfig {
  return {
    ...row,
    algorithmVersion: `${row.algorithm_key}-v${row.version}`,
    candidateLimit: boundedInteger(
      row.retrieval_config?.candidate_limit,
      SHOWCASE_FEED_CANDIDATE_LIMIT,
      1,
      SHOWCASE_FEED_CANDIDATE_LIMIT,
    ),
    eligibleItemLimit: boundedInteger(
      row.retrieval_config?.session_item_limit,
      SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT,
      1,
      SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT,
    ),
    scoreWeights: normalizeRankedFeedScoreWeights(row.weights),
    diversityConfig: normalizeRankedFeedDiversityConfig(row.diversity_config),
    retrieval: normalizeRetrievalConfig(row.retrieval_config),
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
  const assignment = await resolveFeedExperimentAssignment({
    anonymousKeyHash,
    serviceClient,
    viewerUserId,
  }).catch(() => null);

  if (assignment) {
    const assigned = await getAlgorithmVersion(serviceClient, assignment.variant.algorithmVersionId);
    if (assigned) {
      return {
        algorithm: assigned,
        experimentAssignmentId: assignment.assignmentId,
        experimentId: assignment.experimentId,
        experimentVariantId: assignment.variant.id,
      };
    }
  }

  const active = await getAlgorithmVersion(serviceClient);
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
  serviceClient,
  viewerUserId,
}: {
  anonymousKeyHash: string | null;
  cursorValue: string;
  hydratePostIds: (postIds: string[]) => Promise<ShowcaseFeedItem[]>;
  limit: number;
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}): Promise<ShowcaseFeedPage | null> {
  const cursor = decodeRankedFeedCursor(cursorValue);
  if (!cursor) return null;

  const { data: sessionData, error: sessionError } = await serviceClient
    .from('feed_sessions')
    .select('id, viewer_user_id, anonymous_key_hash, algorithm_version_id, created_at, expires_at')
    .eq('id', cursor.sessionId)
    .maybeSingle();
  const session = sessionData as FeedSessionRow | null;
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

  const algorithm = await getAlgorithmVersion(serviceClient, session.algorithm_version_id);
  if (!algorithm) return null;

  const scanBatchSize = Math.max(24, Math.min(FEED_HYDRATION_BATCH_SIZE, limit * 2));
  const eligibleRows: Array<{
    item: ShowcaseFeedItem;
    row: FeedSessionItemRow;
  }> = [];
  let nextScanPosition = cursor.position;
  let scannedRows = 0;
  let exhausted = false;

  while (
    eligibleRows.length < limit + 1
    && scannedRows < SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT
    && !exhausted
  ) {
    const batchLimit = Math.min(
      scanBatchSize,
      SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT - scannedRows,
    );
    const { data, error } = await serviceClient
      .from('feed_session_items')
      .select('id, post_id, position, candidate_source, final_score, score_components')
      .eq('session_id', session.id)
      .gte('position', nextScanPosition)
      .order('position', { ascending: true })
      .limit(batchLimit);
    if (error) return null;

    const rows = (data ?? []) as FeedSessionItemRow[];
    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    scannedRows += rows.length;
    nextScanPosition = rows[rows.length - 1].position + 1;
    exhausted = rows.length < batchLimit;

    const hydrated = await hydratePostIds(rows.map((row) => row.post_id));
    const feedbackFiltered = await filterActiveViewerFeedback({
      items: hydrated,
      serviceClient,
      viewerUserId,
    });
    if (!feedbackFiltered) return null;

    const itemById = new Map(feedbackFiltered.map((item) => [item.id, item]));
    for (const row of rows) {
      const hydratedItem = itemById.get(row.post_id);
      if (hydratedItem) eligibleRows.push({ item: hydratedItem, row });
      if (eligibleRows.length >= limit + 1) break;
    }
  }

  const pageRows = eligibleRows.slice(0, limit);
  const hasMore = eligibleRows.length > limit;
  const nextPosition = pageRows.at(-1)?.row.position === undefined
    ? null
    : (pageRows.at(-1)?.row.position as number) + 1;

  await serviceClient
    .from('feed_sessions')
    .update({ last_accessed_at: new Date().toISOString() })
    .eq('id', session.id);
  if (pageRows.length > 0) {
    await serviceClient
      .from('feed_session_items')
      .update({ served_at: new Date().toISOString() })
      .in('id', pageRows.map(({ row }) => row.id));
    await markDeliveryFactsServed(serviceClient, pageRows.map(({ row }) => row.id));
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
  experimentAssignmentId,
  experimentId,
  experimentVariantId,
  filters,
  ranked,
  serviceClient,
  viewerUserId,
}: {
  algorithmVersionId: string;
  anonymousKeyHash: string | null;
  experimentAssignmentId: number | null;
  experimentId: string | null;
  experimentVariantId: string | null;
  filters: RankedFeedFilters;
  ranked: RankedShowcaseItem[];
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}) {
  if ((!viewerUserId && !anonymousKeyHash) || ranked.length === 0) return null;

  const now = new Date();

  const { data: sessionData, error: sessionError } = await serviceClient
    .from('feed_sessions')
    .insert({
      viewer_user_id: viewerUserId,
      anonymous_key_hash: viewerUserId ? null : anonymousKeyHash,
      surface: 'showcase',
      mode: 'for-you',
      filters,
      algorithm_version_id: algorithmVersionId,
      experiment_assignment_id: experimentAssignmentId,
      random_seed: Math.floor(Math.random() * 2_147_483_647),
      expires_at: new Date(now.getTime() + FEED_SESSION_EXPIRY_MS).toISOString(),
    })
    .select('id')
    .single();
  if (sessionError || !sessionData?.id) return null;

  const sessionId = String(sessionData.id);
  const rows = ranked.map((entry, position) => ({
    session_id: sessionId,
    post_id: entry.item.id,
    position,
    candidate_source: entry.features.candidateSource,
    final_score: entry.score,
    score_components: scoreComponents(entry.features),
    is_exploration: entry.features.candidateSource === 'exploration',
  }));
  const { data: itemData, error: itemError } = await serviceClient
    .from('feed_session_items')
    .insert(rows)
    .select('id, position');
  if (itemError) {
    await serviceClient.from('feed_sessions').delete().eq('id', sessionId);
    return null;
  }

  // Durable exposure facts mirror the session items but survive session
  // pruning; outcome columns are filled by database triggers as events arrive.
  const factRows = ((itemData ?? []) as Array<{ id: string | number; position: number }>)
    .flatMap((row) => {
      const entry = ranked[row.position];
      if (!entry) return [];
      return [{
        delivery_id: row.id,
        session_id: sessionId,
        algorithm_version_id: algorithmVersionId,
        experiment_assignment_id: experimentAssignmentId,
        experiment_id: experimentId,
        experiment_variant_id: experimentVariantId,
        viewer_user_id: viewerUserId,
        anonymous_key_hash: viewerUserId ? null : anonymousKeyHash,
        post_id: entry.item.id,
        creator_user_id: entry.item.creator.id || null,
        position: row.position,
        candidate_source: entry.features.candidateSource,
        is_exploration: entry.features.candidateSource === 'exploration',
        // UCB slot selection is deterministic in v2. Conditional on the
        // ranking context, the logged policy propensity is therefore 1 or 0;
        // a future stochastic policy must replace this with its draw
        // probability before inverse-propensity training is enabled.
        exploration_propensity: entry.features.candidateSource === 'exploration' ? 1 : 0,
        final_score: entry.score,
        score_components: scoreComponents(entry.features),
        surface: 'showcase',
        mode: 'for-you',
        ranked_at: now.toISOString(),
      }];
    });
  const { error: factError } = await serviceClient
    .from('feed_delivery_facts')
    .insert(factRows);
  if (factError) {
    await serviceClient.from('feed_sessions').delete().eq('id', sessionId);
    return null;
  }

  return {
    sessionId,
    deliveryIdsByPosition: new Map(
      ((itemData ?? []) as Array<{ id: string | number; position: number }>)
        .map((row) => [row.position, String(row.id)]),
    ),
  };
}

/**
 * Write-once serve marker: served_at is the denominator for qualified-view
 * rates, so it must record the first time a delivery was actually returned in
 * a page, and never move afterwards.
 */
async function markDeliveryFactsServed(
  serviceClient: SupabaseClient,
  deliveryIds: Array<string | number>,
) {
  if (deliveryIds.length === 0) return;
  await serviceClient
    .from('feed_delivery_facts')
    .update({ served_at: new Date().toISOString() })
    .in('delivery_id', deliveryIds)
    .is('served_at', null);
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
  const rpcCategory = category === 'all' || category === 'image' || category === 'video' || category === 'text'
    ? null
    : category;
  const asOf = new Date().toISOString();
  const { retrieval } = algorithm;
  const { data, error } = retrieval.candidateRpc === 'v2'
    ? await serviceClient.rpc('get_ranked_feed_candidates_v2', {
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
    })
    : await serviceClient.rpc('get_ranked_feed_candidates', {
      p_viewer_user_id: viewerUserId,
      p_category: rpcCategory,
      p_limit: algorithm.candidateLimit,
      p_as_of: asOf,
    });
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
  algorithmVersionId,
  anonymousKeyHash,
  experimentAssignmentId,
  filters,
  serviceClient,
  viewerUserId,
}: {
  algorithmVersionId: string;
  anonymousKeyHash: string | null;
  experimentAssignmentId: number | null;
  filters: RankedFeedFilters;
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}) {
  if (!viewerUserId && !anonymousKeyHash) return null;

  const now = new Date();
  let query = serviceClient
    .from('feed_sessions')
    .select('id')
    .eq('surface', 'showcase')
    .eq('mode', 'for-you')
    .eq('algorithm_version_id', algorithmVersionId)
    .contains('filters', filters)
    .gt('expires_at', now.toISOString())
    .gte('created_at', new Date(now.getTime() - FEED_SESSION_REUSE_TTL_MS).toISOString());
  query = experimentAssignmentId === null
    ? query.is('experiment_assignment_id', null)
    : query.eq('experiment_assignment_id', experimentAssignmentId);
  query = viewerUserId
    ? query.eq('viewer_user_id', viewerUserId).is('anonymous_key_hash', null)
    : query.is('viewer_user_id', null).eq('anonymous_key_hash', anonymousKeyHash);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.id) return null;
  return String(data.id);
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
}): Promise<ShowcaseFeedPage> {
  if (cursor) {
    const persisted = await loadPersistedPage({
      anonymousKeyHash,
      cursorValue: cursor,
      hydratePostIds,
      limit,
      serviceClient,
      viewerUserId,
    });
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

  const {
    algorithm,
    experimentAssignmentId,
    experimentId,
    experimentVariantId,
  } = await resolveAlgorithmForViewer({
    anonymousKeyHash,
    serviceClient,
    viewerUserId,
  });
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
    const reusableSessionId = await findReusableSession({
      algorithmVersionId: algorithm.id,
      anonymousKeyHash,
      experimentAssignmentId,
      filters,
      serviceClient,
      viewerUserId,
    });
    if (reusableSessionId) {
      const reused = await loadPersistedPage({
        anonymousKeyHash,
        cursorValue: encodeRankedFeedCursor({ sessionId: reusableSessionId, position: 0 }),
        hydratePostIds,
        limit,
        serviceClient,
        viewerUserId,
      });
      if (reused) return reused;
    }
  }

  const featureRows = await loadCandidateFeatures({
    algorithm,
    anonymousKeyHash,
    category: filters.category,
    serviceClient,
    viewerUserId,
  });
  // Hydration is budgeted, so the pre-sort must already respect the seen tier;
  // otherwise repeats consume the budget and never reach the reranker as the
  // last resort they are meant to be.
  const configuredFeatureRows = featureRows
    ? [...featureRows].sort((left, right) => (
      Number(left.seenRecently) - Number(right.seenRecently)
      || scoreRankedFeedFeatures(right, algorithm.scoreWeights)
      - scoreRankedFeedFeatures(left, algorithm.scoreWeights)
    ))
    : null;
  const hydratedFeatureItems = configuredFeatureRows?.length
    ? await hydrateEligibleCandidates({
      eligibleItemLimit: algorithm.eligibleItemLimit,
      featureRows: configuredFeatureRows,
      hydratePostIds,
    })
    : [];
  const fallbackTarget = algorithm.eligibleItemLimit - hydratedFeatureItems.length;
  const filteredFallbackItems = fallbackTarget > 0
    ? await fallbackItems(algorithm.eligibleItemLimit)
    : [];
  const feedbackFilteredCandidateItems = await filterActiveViewerFeedback({
    items: mergeUniqueFeedItems(hydratedFeatureItems, filteredFallbackItems),
    serviceClient,
    viewerUserId,
  });
  const candidateItems = (feedbackFilteredCandidateItems ?? [])
    .slice(0, algorithm.eligibleItemLimit);
  const ranked = rankAndDiversifyShowcaseItems({
    items: candidateItems,
    featureRows: configuredFeatureRows ?? [],
    scoreWeights: algorithm.scoreWeights,
    diversityConfig: algorithm.diversityConfig,
    seenPenalty: algorithm.retrieval.seenPenalty,
  }).slice(0, algorithm.eligibleItemLimit);
  const persisted = await persistRankedSession({
    algorithmVersionId: algorithm.id,
    anonymousKeyHash,
    experimentAssignmentId,
    experimentId,
    experimentVariantId,
    filters,
    ranked,
    serviceClient,
    viewerUserId,
  });
  const pageEntries = ranked.slice(offset, offset + limit);
  const hasMore = Boolean(persisted && ranked.length > offset + limit);
  if (persisted && pageEntries.length > 0) {
    await markDeliveryFactsServed(
      serviceClient,
      pageEntries
        .map((_, index) => persisted.deliveryIdsByPosition.get(offset + index))
        .filter((id): id is string => Boolean(id)),
    );
  }
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
