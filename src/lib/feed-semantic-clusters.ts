/**
 * Content understanding for the feed (v4): k-means over the posts' `gte-small`
 * text embeddings, and the near-duplicate pairing that canonicalises reposts.
 * Pure and deterministic — the `feed-embeddings` job reads the vectors, calls
 * these, and writes what they return — so both are tested without a database.
 *
 * Vectors are compared by cosine similarity on unit-normalised copies, so a
 * dot product is a cosine and a centroid is the normalised mean of its members
 * (spherical k-means).
 */

import { mulberry32 } from '@/lib/feed-thompson';

/** Below this many embeddings there is nothing worth clustering. */
export const SEMANTIC_CLUSTER_MIN_EMBEDDINGS = 20;
/** The newest embeddings clustered per run. */
export const SEMANTIC_CLUSTER_MAX_EMBEDDINGS = 5_000;
export const SEMANTIC_CLUSTER_ITERATIONS = 10;
export const SEMANTIC_CLUSTER_MIN_COUNT = 2;
export const SEMANTIC_CLUSTER_MAX_COUNT = 50;
/** One fixed seed: the same embeddings always cluster the same way. */
export const SEMANTIC_CLUSTER_SEED = 20_261_012;
/** Cosine similarity at or above which the newer of two posts is a duplicate. */
export const NEAR_DUPLICATE_SIMILARITY_THRESHOLD = 0.95;

export type SemanticClusterInput = { postId: string; embedding: readonly number[] };

export type SemanticCluster = {
  clusterId: number;
  centroid: number[];
  memberCount: number;
};

export type SemanticClustering = {
  clusters: SemanticCluster[];
  assignments: Array<{ postId: string; clusterId: number }>;
  iterations: number;
};

/** `K = clamp(round(n / 8), 2, 50)`, never more clusters than embeddings. */
export function semanticClusterCount(embeddingCount: number) {
  if (!Number.isFinite(embeddingCount) || embeddingCount < 1) return 0;
  const k = Math.min(
    SEMANTIC_CLUSTER_MAX_COUNT,
    Math.max(SEMANTIC_CLUSTER_MIN_COUNT, Math.round(embeddingCount / 8)),
  );
  return Math.min(k, Math.floor(embeddingCount));
}

/** A unit-length copy, or null for a vector that is empty, non-finite or all zeros. */
export function normalizeEmbedding(vector: readonly number[]): number[] | null {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  let norm = 0;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    norm += value * value;
  }
  if (!(norm > 0)) return null;
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

function dot(left: readonly number[], right: readonly number[]) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

/** Cosine similarity of two vectors of the same length; 0 when either has no direction. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length) return 0;
  const a = normalizeEmbedding(left);
  const b = normalizeEmbedding(right);
  return a && b ? dot(a, b) : 0;
}

/** The index of the most similar centroid; ties go to the first. */
function nearestCentroid(vector: readonly number[], centroids: ReadonlyArray<readonly number[]>) {
  let best = 0;
  let bestSimilarity = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < centroids.length; index += 1) {
    const similarity = dot(vector, centroids[index]);
    if (similarity > bestSimilarity) {
      best = index;
      bestSimilarity = similarity;
    }
  }
  return { index: best, similarity: bestSimilarity };
}

/** The cluster each vector is closest to, by the same rule `clusterEmbeddings` assigns with. */
export function assignToNearestCluster(
  inputs: readonly SemanticClusterInput[],
  clusters: ReadonlyArray<Pick<SemanticCluster, 'clusterId' | 'centroid'>>,
): Array<{ postId: string; clusterId: number }> {
  const centroids: number[][] = [];
  const ids: number[] = [];
  const dimensions = clusters.find((cluster) => cluster.centroid.length > 0)?.centroid.length ?? 0;
  for (const cluster of [...clusters].sort((left, right) => left.clusterId - right.clusterId)) {
    const centroid = cluster.centroid.length === dimensions ? normalizeEmbedding(cluster.centroid) : null;
    if (centroid) {
      centroids.push(centroid);
      ids.push(cluster.clusterId);
    }
  }
  if (centroids.length === 0) return [];
  return inputs.flatMap((input) => {
    const vector = input.embedding.length === dimensions ? normalizeEmbedding(input.embedding) : null;
    return vector ? [{ postId: input.postId, clusterId: ids[nearestCentroid(vector, centroids).index] }] : [];
  });
}

/**
 * Spherical k-means with deterministic k-means++ seeding.
 *
 * - Input order does not matter: vectors are sorted by post id first, and the
 *   seed is fixed, so the same embeddings always give the same clusters.
 * - `previous` warm-starts the run: those centroids (the largest first) keep
 *   their cluster ids, so a re-clustering moves clusters rather than
 *   renumbering them, and an interest weight learned on `c7` still means the
 *   same thing an hour later. New clusters take the lowest unused ids.
 * - A cluster that loses every member keeps its centroid and reports 0.
 */
export function clusterEmbeddings(
  inputs: readonly SemanticClusterInput[],
  options: {
    k?: number;
    iterations?: number;
    seed?: number;
    previous?: ReadonlyArray<Pick<SemanticCluster, 'clusterId' | 'centroid' | 'memberCount'>>;
  } = {},
): SemanticClustering {
  const dimensions = inputs.find((input) => input.embedding.length > 0)?.embedding.length ?? 0;
  const points: Array<{ postId: string; vector: number[] }> = [];
  const seen = new Set<string>();
  for (const input of [...inputs].sort((left, right) => left.postId.localeCompare(right.postId))) {
    if (seen.has(input.postId) || input.embedding.length !== dimensions) continue;
    const vector = normalizeEmbedding(input.embedding);
    if (!vector) continue;
    seen.add(input.postId);
    points.push({ postId: input.postId, vector });
  }

  const k = Math.min(points.length, Math.max(0, Math.floor(options.k ?? semanticClusterCount(points.length))));
  if (k === 0) return { clusters: [], assignments: [], iterations: 0 };

  // Warm start: the previous run's biggest clusters, keeping their ids.
  const centroids: number[][] = [];
  const clusterIds: number[] = [];
  const previous = [...(options.previous ?? [])]
    .sort((left, right) => right.memberCount - left.memberCount || left.clusterId - right.clusterId);
  for (const cluster of previous) {
    if (centroids.length >= k) break;
    if (!Number.isInteger(cluster.clusterId) || cluster.clusterId < 0 || clusterIds.includes(cluster.clusterId)) continue;
    const centroid = cluster.centroid.length === dimensions ? normalizeEmbedding(cluster.centroid) : null;
    if (!centroid) continue;
    centroids.push(centroid);
    clusterIds.push(cluster.clusterId);
  }

  // k-means++ for the rest: each next seed is drawn with probability ∝ the
  // squared cosine distance to the nearest seed so far.
  const random = mulberry32(options.seed ?? SEMANTIC_CLUSTER_SEED);
  const chosen = new Set<number>();
  if (centroids.length === 0) {
    const first = Math.min(points.length - 1, Math.floor(random() * points.length));
    chosen.add(first);
    centroids.push([...points[first].vector]);
  }
  while (centroids.length < k) {
    const weights = points.map((point, index) => {
      if (chosen.has(index)) return 0;
      const distance = Math.max(0, 1 - nearestCentroid(point.vector, centroids).similarity);
      return distance * distance;
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let pick = -1;
    if (total > 0) {
      let target = random() * total;
      for (let index = 0; index < weights.length; index += 1) {
        target -= weights[index];
        if (weights[index] > 0 && target <= 0) {
          pick = index;
          break;
        }
      }
      if (pick < 0) pick = weights.findLastIndex((weight) => weight > 0);
    }
    // Every remaining point sits on a seed already: take the next unchosen one.
    if (pick < 0) pick = points.findIndex((_point, index) => !chosen.has(index));
    if (pick < 0) break;
    chosen.add(pick);
    centroids.push([...points[pick].vector]);
  }
  while (clusterIds.length < centroids.length) {
    let id = 0;
    while (clusterIds.includes(id)) id += 1;
    clusterIds.push(id);
  }

  let assignment = points.map((point) => nearestCentroid(point.vector, centroids).index);
  let iterations = 0;
  const maxIterations = Math.max(0, Math.floor(options.iterations ?? SEMANTIC_CLUSTER_ITERATIONS));
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    iterations = iteration + 1;
    const sums = centroids.map(() => new Array<number>(dimensions).fill(0));
    const counts = centroids.map(() => 0);
    points.forEach((point, index) => {
      const cluster = assignment[index];
      counts[cluster] += 1;
      const sum = sums[cluster];
      for (let dimension = 0; dimension < dimensions; dimension += 1) sum[dimension] += point.vector[dimension];
    });
    for (let cluster = 0; cluster < centroids.length; cluster += 1) {
      const mean = counts[cluster] > 0 ? normalizeEmbedding(sums[cluster]) : null;
      if (mean) centroids[cluster] = mean;
    }
    const next = points.map((point) => nearestCentroid(point.vector, centroids).index);
    const changed = next.some((cluster, index) => cluster !== assignment[index]);
    assignment = next;
    if (!changed) break;
  }

  const memberCounts = centroids.map(() => 0);
  for (const cluster of assignment) memberCounts[cluster] += 1;
  const clusters = centroids
    .map((centroid, index) => ({ clusterId: clusterIds[index], centroid, memberCount: memberCounts[index] }))
    .sort((left, right) => left.clusterId - right.clusterId);
  return {
    clusters,
    assignments: points.map((point, index) => ({ postId: point.postId, clusterId: clusterIds[assignment[index]] })),
    iterations,
  };
}

export type NearDuplicateQuery = {
  /** A post embedded (or re-embedded) since the last run. */
  postId: string;
  /** What `match_post_content_embeddings` returned for its embedding. */
  matches: ReadonlyArray<{ postId: string; similarity: number }>;
};

export type NearDuplicatePost = {
  postId: string;
  createdAt: string;
  /** The stored `canonical_post_id`: set when the post is already a duplicate. */
  canonicalPostId: string | null;
};

export type NearDuplicateMark = {
  postId: string;
  canonicalPostId: string;
  similarity: number;
};

/**
 * Which posts become near-duplicates, and of what.
 *
 * Every pair at or above the threshold joins one family, and the oldest post
 * (`created_at`, then id) is the family's canonical. A family is one level
 * deep — no chains: a duplicate always points at a canonical, never at another
 * duplicate, so a post that matches a stored duplicate is credited to that
 * duplicate's canonical. A post that is already a canonical for others is
 * never marked, and a post already marked keeps its mark. Pairs involving a
 * post the caller did not describe (in `posts`) are ignored.
 */
export function pairNearDuplicates({
  queries,
  posts,
  canonicalIds = new Set<string>(),
  threshold = NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
}: {
  queries: readonly NearDuplicateQuery[];
  posts: readonly NearDuplicatePost[];
  /** Posts some stored duplicate already points at. */
  canonicalIds?: ReadonlySet<string>;
  threshold?: number;
}): NearDuplicateMark[] {
  const byId = new Map(posts.map((post) => [post.postId, post]));
  const order = [...posts].sort((left, right) => (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.postId.localeCompare(right.postId)
  ));
  const rank = new Map(order.map((post, index) => [post.postId, index]));

  const neighbours = new Map<string, Map<string, number>>();
  const link = (from: string, to: string, similarity: number) => {
    const edges = neighbours.get(from) ?? new Map<string, number>();
    edges.set(to, Math.max(edges.get(to) ?? Number.NEGATIVE_INFINITY, similarity));
    neighbours.set(from, edges);
  };
  for (const query of queries) {
    if (!byId.has(query.postId)) continue;
    for (const match of query.matches) {
      if (
        match.postId === query.postId
        || !byId.has(match.postId)
        || !Number.isFinite(match.similarity)
        || match.similarity < threshold
      ) continue;
      const similarity = Math.min(1, match.similarity);
      link(query.postId, match.postId, similarity);
      link(match.postId, query.postId, similarity);
    }
  }

  const markedCanonical = new Map<string, string>();
  const canonicals = new Set(canonicalIds);
  /** The canonical a post's family hangs from: one hop through stored or new marks. */
  const rootOf = (postId: string) => {
    let root = postId;
    const visited = new Set<string>();
    for (;;) {
      if (visited.has(root)) return root;
      visited.add(root);
      const next = markedCanonical.get(root) ?? byId.get(root)?.canonicalPostId ?? null;
      if (!next || next === root) return root;
      root = next;
    }
  };
  // A canonical outside `posts` predates everything here: it ranks first.
  const rankOf = (postId: string) => rank.get(postId) ?? -1;

  const marks: NearDuplicateMark[] = [];
  for (const post of order) {
    if (post.canonicalPostId || canonicals.has(post.postId)) continue;
    let best: { root: string; similarity: number } | null = null;
    for (const [neighbour, similarity] of neighbours.get(post.postId) ?? []) {
      if (rankOf(neighbour) >= rankOf(post.postId)) continue;
      const root = rootOf(neighbour);
      if (root === post.postId) continue;
      if (
        !best
        || rankOf(root) < rankOf(best.root)
        || (rankOf(root) === rankOf(best.root) && (root < best.root || (root === best.root && similarity > best.similarity)))
      ) {
        best = { root, similarity };
      }
    }
    if (!best) continue;
    markedCanonical.set(post.postId, best.root);
    canonicals.add(best.root);
    marks.push({ postId: post.postId, canonicalPostId: best.root, similarity: best.similarity });
  }
  return marks.sort((left, right) => left.postId.localeCompare(right.postId));
}

/**
 * Freshly (re)embedded posts that carry a stored duplicate mark but no longer
 * match any other post at the threshold — an edit took them out of their
 * family, or their canonical left the feed — so their mark is cleared.
 */
export function staleNearDuplicateMarks({
  queries,
  posts,
  threshold = NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
}: {
  queries: readonly NearDuplicateQuery[];
  posts: readonly NearDuplicatePost[];
  threshold?: number;
}): string[] {
  const stored = new Map(posts.map((post) => [post.postId, post.canonicalPostId]));
  return queries
    .filter((query) => (
      Boolean(stored.get(query.postId))
      && !query.matches.some((match) => (
        match.postId !== query.postId && Number.isFinite(match.similarity) && match.similarity >= threshold
      ))
    ))
    .map((query) => query.postId)
    .sort();
}
