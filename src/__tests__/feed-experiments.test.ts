import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  FEED_EXPERIMENT_BASIS_POINTS,
  hashViewerToBasisPoints,
  resolveFeedExperimentAssignment,
  selectExperimentVariant,
  type FeedExperimentDefinition,
} from '@/lib/feed-experiments';

function experiment(overrides: Partial<FeedExperimentDefinition> = {}): FeedExperimentDefinition {
  return {
    id: 'experiment-1',
    experimentKey: 'for-you-v2',
    assignmentSalt: 'salt-1',
    trafficBasisPoints: FEED_EXPERIMENT_BASIS_POINTS,
    variants: [
      { id: 'variant-control', variantKey: 'control', algorithmVersionId: 'algo-v1', allocationBasisPoints: 5000 },
      { id: 'variant-treatment', variantKey: 'treatment', algorithmVersionId: 'algo-v2', allocationBasisPoints: 5000 },
    ],
    ...overrides,
  };
}

describe('deterministic experiment bucketing', () => {
  it('is stable for a viewer and bounded to the basis-point space', () => {
    const first = hashViewerToBasisPoints('viewer-1', 'salt-1');
    const second = hashViewerToBasisPoints('viewer-1', 'salt-1');

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(FEED_EXPERIMENT_BASIS_POINTS);
  });

  it('decorrelates viewers across experiments via the per-experiment salt', () => {
    // A viewer in the control arm of one experiment must not be systematically
    // in the control arm of the next, or any readout spanning both is biased.
    const viewers = Array.from({ length: 200 }, (_, index) => `viewer-${index}`);
    const agreements = viewers.filter((viewer) => (
      (hashViewerToBasisPoints(viewer, 'salt-a:variant') < 5000)
      === (hashViewerToBasisPoints(viewer, 'salt-b:variant') < 5000)
    )).length;

    expect(agreements).toBeGreaterThan(60);
    expect(agreements).toBeLessThan(140);
  });

  it('splits an even A/A allocation without a systematic tilt', () => {
    const control = Array.from({ length: 400 }, (_, index) => (
      selectExperimentVariant(experiment(), `viewer-${index}`)?.variantKey
    )).filter((key) => key === 'control').length;

    expect(control).toBeGreaterThan(150);
    expect(control).toBeLessThan(250);
  });

  it('enrolls only the configured share of traffic', () => {
    const partial = experiment({ trafficBasisPoints: 1000 });
    const enrolled = Array.from({ length: 500 }, (_, index) => (
      selectExperimentVariant(partial, `viewer-${index}`)
    )).filter(Boolean).length;

    expect(enrolled).toBeGreaterThan(10);
    expect(enrolled).toBeLessThan(120);
  });

  it('keeps a viewer in the same variant when traffic is later widened', () => {
    // Enrollment and variant selection are independent draws precisely so that
    // ramping traffic cannot reshuffle viewers already in an arm.
    const viewers = Array.from({ length: 300 }, (_, index) => `viewer-${index}`);
    const narrow = experiment({ trafficBasisPoints: 2000 });
    const wide = experiment({ trafficBasisPoints: 8000 });

    for (const viewer of viewers) {
      const before = selectExperimentVariant(narrow, viewer);
      if (!before) continue;
      expect(selectExperimentVariant(wide, viewer)?.variantKey).toBe(before.variantKey);
    }
  });

  it('returns no variant when the experiment is drained or has no variants', () => {
    expect(selectExperimentVariant(experiment({ trafficBasisPoints: 0 }), 'viewer-1')).toBeNull();
    expect(selectExperimentVariant(experiment({ variants: [] }), 'viewer-1')).toBeNull();
  });
});

function createClient({
  experimentRow,
  existingAssignment = null,
  insertError = null,
  racedAssignment = null,
}: {
  experimentRow: Record<string, unknown> | null;
  existingAssignment?: Record<string, unknown> | null;
  insertError?: unknown;
  racedAssignment?: Record<string, unknown> | null;
}) {
  const inserts: Array<Record<string, unknown>> = [];
  let assignmentReads = 0;
  const from = vi.fn((table: string) => {
    if (table === 'feed_experiments') {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'or', 'order', 'limit']) {
        query[method] = vi.fn(() => query);
      }
      query.maybeSingle = vi.fn(async () => ({ data: experimentRow, error: null }));
      return query;
    }
    if (table === 'feed_experiment_assignments') {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq']) {
        query[method] = vi.fn(() => query);
      }
      query.insert = vi.fn((payload: Record<string, unknown>) => {
        inserts.push(payload);
        const inserted: Record<string, unknown> = {
          select: vi.fn(() => inserted),
          maybeSingle: vi.fn(async () => ({
            data: insertError ? null : { id: 77 },
            error: insertError,
          })),
        };
        return inserted;
      });
      query.maybeSingle = vi.fn(async () => {
        assignmentReads += 1;
        return {
          data: assignmentReads === 1 ? existingAssignment : racedAssignment,
          error: null,
        };
      });
      return query;
    }
    throw new Error(`Unexpected table ${table}`);
  });

  return { client: { from } as unknown as SupabaseClient, inserts };
}

const runningExperimentRow = {
  id: 'experiment-1',
  experiment_key: 'for-you-v2',
  assignment_salt: 'salt-1',
  traffic_basis_points: 10_000,
  starts_at: null,
  ends_at: null,
  feed_experiment_variants: [
    { id: 'variant-control', variant_key: 'control', algorithm_version_id: 'algo-v1', allocation_basis_points: 5000 },
    { id: 'variant-treatment', variant_key: 'treatment', algorithm_version_id: 'algo-v2', allocation_basis_points: 5000 },
  ],
};

describe('resolveFeedExperimentAssignment', () => {
  it('persists a new assignment and returns its variant', async () => {
    const db = createClient({ experimentRow: runningExperimentRow });

    const assignment = await resolveFeedExperimentAssignment({
      anonymousKeyHash: null,
      serviceClient: db.client,
      viewerUserId: 'viewer-1',
    });

    expect(assignment?.assignmentId).toBe(77);
    expect(assignment?.variant.algorithmVersionId).toMatch(/^algo-v[12]$/);
    expect(db.inserts[0]).toMatchObject({
      experiment_id: 'experiment-1',
      viewer_user_id: 'viewer-1',
      anonymous_key_hash: null,
    });
  });

  it('honours a stored assignment over a fresh hash', async () => {
    // Allocations can be edited mid-run; moving an enrolled viewer would
    // contaminate both arms.
    const db = createClient({
      experimentRow: runningExperimentRow,
      existingAssignment: { id: 12, variant_id: 'variant-treatment' },
    });

    const assignment = await resolveFeedExperimentAssignment({
      anonymousKeyHash: null,
      serviceClient: db.client,
      viewerUserId: 'viewer-1',
    });

    expect(assignment).toMatchObject({
      assignmentId: 12,
      variant: { variantKey: 'treatment', algorithmVersionId: 'algo-v2' },
    });
    expect(db.inserts).toHaveLength(0);
  });

  it('assigns anonymous viewers by their key hash', async () => {
    const db = createClient({ experimentRow: runningExperimentRow });

    const assignment = await resolveFeedExperimentAssignment({
      anonymousKeyHash: 'a'.repeat(64),
      serviceClient: db.client,
      viewerUserId: null,
    });

    expect(assignment).not.toBeNull();
    expect(db.inserts[0]).toMatchObject({
      viewer_user_id: null,
      anonymous_key_hash: 'a'.repeat(64),
    });
  });

  it('reloads the durable winner when the assignment insert races', async () => {
    const selected = selectExperimentVariant(experiment(), 'viewer-1');
    expect(selected).not.toBeNull();
    const db = createClient({
      experimentRow: runningExperimentRow,
      insertError: { code: '23505' },
      racedAssignment: { id: 78, variant_id: selected?.id },
    });

    const assignment = await resolveFeedExperimentAssignment({
      anonymousKeyHash: null,
      serviceClient: db.client,
      viewerUserId: 'viewer-1',
    });

    expect(assignment).toMatchObject({
      assignmentId: 78,
      variant: { id: selected?.id },
    });
  });

  it('falls back to the active algorithm when assignment persistence fails', async () => {
    const db = createClient({
      experimentRow: runningExperimentRow,
      insertError: { code: '57014' },
    });

    await expect(resolveFeedExperimentAssignment({
      anonymousKeyHash: null,
      serviceClient: db.client,
      viewerUserId: 'viewer-1',
    })).resolves.toBeNull();
  });

  it('returns null when no experiment is running or no viewer identity exists', async () => {
    const noExperiment = createClient({ experimentRow: null });
    await expect(resolveFeedExperimentAssignment({
      anonymousKeyHash: null,
      serviceClient: noExperiment.client,
      viewerUserId: 'viewer-1',
    })).resolves.toBeNull();

    const noViewer = createClient({ experimentRow: runningExperimentRow });
    await expect(resolveFeedExperimentAssignment({
      anonymousKeyHash: null,
      serviceClient: noViewer.client,
      viewerUserId: null,
    })).resolves.toBeNull();
  });
});
