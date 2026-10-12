import { describe, expect, it } from 'vitest';

import { mulberry32 } from '@/lib/feed-thompson';
import {
  assignToNearestCluster,
  clusterEmbeddings,
  cosineSimilarity,
  normalizeEmbedding,
  pairNearDuplicates,
  semanticClusterCount,
  staleNearDuplicateMarks,
  type NearDuplicatePost,
} from '@/lib/feed-semantic-clusters';

const DIMENSIONS = 384;

/** A unit basis direction with deterministic noise of the given size. */
function noisy(axis: number, noise: number, random: () => number) {
  return Array.from({ length: DIMENSIONS }, (_, index) => (index === axis ? 1 : 0) + (random() - 0.5) * noise);
}

/** Three tight blobs around three orthogonal directions, eight posts each. */
function threeBlobs(seed = 7) {
  const random = mulberry32(seed);
  return [0, 1, 2].flatMap((blob) => Array.from({ length: 8 }, (_, index) => ({
    postId: `blob${blob}-post${index}`,
    embedding: noisy(blob * 100, 0.05, random),
    blob,
  })));
}

describe('semanticClusterCount', () => {
  it('is clamp(round(n / 8), 2, 50), never more than n', () => {
    expect(semanticClusterCount(0)).toBe(0);
    expect(semanticClusterCount(1)).toBe(1);
    expect(semanticClusterCount(16)).toBe(2);
    expect(semanticClusterCount(20)).toBe(3);
    expect(semanticClusterCount(24)).toBe(3);
    expect(semanticClusterCount(400)).toBe(50);
    expect(semanticClusterCount(5_000)).toBe(50);
  });
});

describe('normalizeEmbedding and cosineSimilarity', () => {
  it('normalises to unit length and refuses vectors with no direction', () => {
    const unit = normalizeEmbedding([3, 4]);
    expect(unit?.[0]).toBeCloseTo(0.6, 12);
    expect(unit?.[1]).toBeCloseTo(0.8, 12);
    expect(normalizeEmbedding([0, 0])).toBeNull();
    expect(normalizeEmbedding([1, Number.NaN])).toBeNull();
    expect(normalizeEmbedding([])).toBeNull();
  });

  it('compares directions, not lengths', () => {
    expect(cosineSimilarity([1, 0], [5, 0])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 2])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe('clusterEmbeddings', () => {
  it('finds three planted blobs, one cluster each, with K from the formula', () => {
    const blobs = threeBlobs();

    const result = clusterEmbeddings(blobs);

    expect(result.clusters).toHaveLength(3);
    const clusterOf = new Map(result.assignments.map((entry) => [entry.postId, entry.clusterId]));
    for (const blob of [0, 1, 2]) {
      const ids = new Set(blobs.filter((post) => post.blob === blob).map((post) => clusterOf.get(post.postId)));
      expect(ids.size).toBe(1);
    }
    expect(new Set(clusterOf.values()).size).toBe(3);
    expect(result.clusters.map((cluster) => cluster.memberCount)).toEqual([8, 8, 8]);
    expect(result.clusters.map((cluster) => cluster.clusterId)).toEqual([0, 1, 2]);
    // Each centroid is a unit vector pointing at its blob's direction.
    for (const cluster of result.clusters) {
      const norm = Math.hypot(...cluster.centroid);
      expect(norm).toBeCloseTo(1, 9);
      expect(Math.max(...[0, 100, 200].map((axis) => cluster.centroid[axis]))).toBeGreaterThan(0.95);
    }
    expect(result.iterations).toBeLessThanOrEqual(10);
  });

  it('is deterministic, whatever order the embeddings arrive in', () => {
    const blobs = threeBlobs(11);
    const first = clusterEmbeddings(blobs);
    const again = clusterEmbeddings(blobs);
    const shuffled = clusterEmbeddings([...blobs].reverse());

    expect(again).toEqual(first);
    expect(shuffled).toEqual(first);
  });

  it('keeps the previous run\'s cluster ids, so interest weights keep their meaning', () => {
    const blobs = threeBlobs(3);
    const first = clusterEmbeddings(blobs);
    // Renumber the stored clusters: a re-run must keep these ids, not 0–2.
    const renumbered = first.clusters.map((cluster, index) => ({ ...cluster, clusterId: [7, 3, 11][index] }));

    const second = clusterEmbeddings(blobs, { previous: renumbered });

    expect(second.clusters.map((cluster) => cluster.clusterId)).toEqual([3, 7, 11]);
    const before = new Map(first.assignments.map((entry) => [entry.postId, entry.clusterId]));
    for (const entry of second.assignments) {
      expect(entry.clusterId).toBe([7, 3, 11][first.clusters.findIndex((cluster) => cluster.clusterId === before.get(entry.postId))]);
    }
  });

  it('gives clusters beyond the previous ones the lowest unused ids', () => {
    const blobs = threeBlobs(5);
    const one = clusterEmbeddings(blobs, { k: 1 });
    const previous = [{ ...one.clusters[0], clusterId: 1 }];

    const three = clusterEmbeddings(blobs, { k: 3, previous });

    expect(three.clusters.map((cluster) => cluster.clusterId)).toEqual([0, 1, 2]);
  });

  it('skips malformed vectors and returns nothing for nothing', () => {
    expect(clusterEmbeddings([])).toEqual({ clusters: [], assignments: [], iterations: 0 });
    const result = clusterEmbeddings([
      { postId: 'a', embedding: [1, 0, 0] },
      { postId: 'b', embedding: [0, 0, 0] },
      { postId: 'c', embedding: [1, 0] },
      { postId: 'd', embedding: [0, 1, 0] },
    ], { k: 2 });
    expect(result.assignments.map((entry) => entry.postId)).toEqual(['a', 'd']);
    expect(result.clusters).toHaveLength(2);
  });
});

describe('assignToNearestCluster', () => {
  it('puts a new post in the cluster it is closest to', () => {
    const clusters = [
      { clusterId: 4, centroid: [1, 0, 0] },
      { clusterId: 9, centroid: [0, 1, 0] },
    ];
    expect(assignToNearestCluster([
      { postId: 'x', embedding: [0.9, 0.1, 0] },
      { postId: 'y', embedding: [0.2, 0.7, 0.1] },
      { postId: 'malformed', embedding: [1, 0] },
    ], clusters)).toEqual([
      { postId: 'x', clusterId: 4 },
      { postId: 'y', clusterId: 9 },
    ]);
    expect(assignToNearestCluster([{ postId: 'x', embedding: [1, 0, 0] }], [])).toEqual([]);
  });
});

describe('pairNearDuplicates', () => {
  const post = (postId: string, day: number, canonicalPostId: string | null = null): NearDuplicatePost => ({
    postId,
    createdAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    canonicalPostId,
  });

  it('makes the newer post of a pair a duplicate of the older', () => {
    expect(pairNearDuplicates({
      queries: [{ postId: 'new', matches: [{ postId: 'old', similarity: 0.97 }] }],
      posts: [post('old', 1), post('new', 5)],
    })).toEqual([{ postId: 'new', canonicalPostId: 'old', similarity: 0.97 }]);
  });

  it('credits the oldest post of a family, never a duplicate: no chains', () => {
    // b matches a, c matches b only: c still points at a.
    expect(pairNearDuplicates({
      queries: [
        { postId: 'b', matches: [{ postId: 'a', similarity: 0.96 }] },
        { postId: 'c', matches: [{ postId: 'b', similarity: 0.99 }] },
      ],
      posts: [post('c', 9), post('a', 1), post('b', 4)],
    })).toEqual([
      { postId: 'b', canonicalPostId: 'a', similarity: 0.96 },
      { postId: 'c', canonicalPostId: 'a', similarity: 0.99 },
    ]);
  });

  it('follows a stored duplicate to its canonical', () => {
    expect(pairNearDuplicates({
      queries: [{ postId: 'fresh', matches: [{ postId: 'dup', similarity: 0.98 }] }],
      posts: [post('dup', 3, 'origin'), post('fresh', 8)],
    })).toEqual([{ postId: 'fresh', canonicalPostId: 'origin', similarity: 0.98 }]);
  });

  it('marks an existing newer post when an older one is embedded late', () => {
    expect(pairNearDuplicates({
      queries: [{ postId: 'backfilled-old', matches: [{ postId: 'existing-new', similarity: 0.96 }] }],
      posts: [post('backfilled-old', 1), post('existing-new', 7)],
    })).toEqual([{ postId: 'existing-new', canonicalPostId: 'backfilled-old', similarity: 0.96 }]);
  });

  it('never marks a post that is a canonical for others, and keeps every stored mark', () => {
    expect(pairNearDuplicates({
      queries: [
        { postId: 'canonical', matches: [{ postId: 'older', similarity: 0.99 }] },
        { postId: 'already-dup', matches: [{ postId: 'older', similarity: 0.99 }] },
      ],
      posts: [post('older', 1), post('canonical', 5), post('already-dup', 6, 'somewhere-else')],
      canonicalIds: new Set(['canonical']),
    })).toEqual([]);
  });

  it('ignores pairs below the threshold, self-matches and posts it was not told about', () => {
    expect(pairNearDuplicates({
      queries: [{
        postId: 'q',
        matches: [
          { postId: 'q', similarity: 1 },
          { postId: 'similar', similarity: 0.949 },
          { postId: 'unknown', similarity: 0.99 },
          { postId: 'broken', similarity: Number.NaN },
        ],
      }],
      posts: [post('similar', 1), post('broken', 1), post('q', 5)],
    })).toEqual([]);
  });

  it('clears a stored mark only when the post now matches nothing at the threshold', () => {
    expect(staleNearDuplicateMarks({
      queries: [
        { postId: 'edited', matches: [{ postId: 'edited', similarity: 1 }, { postId: 'other', similarity: 0.8 }] },
        { postId: 'still-dup', matches: [{ postId: 'origin', similarity: 0.97 }] },
        { postId: 'never-marked', matches: [] },
      ],
      posts: [post('edited', 5, 'origin'), post('still-dup', 6, 'origin'), post('never-marked', 7)],
    })).toEqual(['edited']);
  });

  it('breaks equal ages by id and keeps the best similarity to the chosen canonical', () => {
    expect(pairNearDuplicates({
      queries: [
        { postId: 'z', matches: [{ postId: 'b', similarity: 0.95 }, { postId: 'a', similarity: 0.96 }] },
        { postId: 'b', matches: [{ postId: 'z', similarity: 0.97 }] },
      ],
      posts: [post('a', 1), post('b', 1), post('z', 3)],
    })).toEqual([
      // a and b share a day, so a ranks older by id. b's only neighbour is the
      // newer z, so b stays unmarked; z's older neighbours are a and b, and a
      // is the older root.
      { postId: 'z', canonicalPostId: 'a', similarity: 0.96 },
    ]);
  });
});
