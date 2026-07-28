import 'server-only';

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

export const FEED_EXPERIMENT_BASIS_POINTS = 10_000;
const FEED_EXPERIMENT_ASSIGNMENT_TTL_DAYS = 90;

export type FeedExperimentVariant = {
  id: string;
  variantKey: string;
  algorithmVersionId: string;
  allocationBasisPoints: number;
};

export type FeedExperimentDefinition = {
  id: string;
  experimentKey: string;
  assignmentSalt: string;
  trafficBasisPoints: number;
  variants: FeedExperimentVariant[];
};

export type FeedExperimentAssignment = {
  experimentId: string;
  assignmentId: number;
  variant: FeedExperimentVariant;
};

/**
 * Deterministic bucketing in [0, 10000).
 *
 * The salt is per-experiment so that a viewer who lands in the control group of
 * one experiment is not systematically in the control group of the next — a
 * shared hash space would correlate every experiment's assignments and quietly
 * bias any readout that spans two of them.
 */
export function hashViewerToBasisPoints(viewerKey: string, salt: string) {
  const digest = createHash('sha256').update(`${salt}:${viewerKey}`).digest();
  return digest.readUInt32BE(0) % FEED_EXPERIMENT_BASIS_POINTS;
}

/**
 * Two independent draws: whether the viewer is in the experiment at all, then
 * which variant. Using one draw for both would tie a variant's allocation to
 * the enrollment threshold, so changing traffic would reshuffle existing
 * viewers between variants mid-run.
 */
export function selectExperimentVariant(
  experiment: FeedExperimentDefinition,
  viewerKey: string,
): FeedExperimentVariant | null {
  if (experiment.trafficBasisPoints <= 0 || experiment.variants.length === 0) return null;

  const enrollmentBucket = hashViewerToBasisPoints(viewerKey, `${experiment.assignmentSalt}:enroll`);
  if (enrollmentBucket >= experiment.trafficBasisPoints) return null;

  const totalAllocation = experiment.variants.reduce(
    (total, variant) => total + Math.max(0, variant.allocationBasisPoints),
    0,
  );
  if (totalAllocation <= 0) return null;

  const variantBucket = hashViewerToBasisPoints(
    viewerKey,
    `${experiment.assignmentSalt}:variant`,
  ) % totalAllocation;

  let cursor = 0;
  for (const variant of experiment.variants) {
    cursor += Math.max(0, variant.allocationBasisPoints);
    if (variantBucket < cursor) return variant;
  }
  return experiment.variants.at(-1) ?? null;
}

function normalizeExperiment(row: Record<string, unknown>): FeedExperimentDefinition | null {
  const id = typeof row.id === 'string' ? row.id : null;
  const experimentKey = typeof row.experiment_key === 'string' ? row.experiment_key : null;
  const assignmentSalt = typeof row.assignment_salt === 'string' ? row.assignment_salt : null;
  const trafficBasisPoints = Number(row.traffic_basis_points);
  if (!id || !experimentKey || !assignmentSalt || !Number.isInteger(trafficBasisPoints)) return null;

  const variants = (Array.isArray(row.feed_experiment_variants) ? row.feed_experiment_variants : [])
    .map((value) => {
      const variant = value as Record<string, unknown>;
      const variantId = typeof variant.id === 'string' ? variant.id : null;
      const variantKey = typeof variant.variant_key === 'string' ? variant.variant_key : null;
      const algorithmVersionId = typeof variant.algorithm_version_id === 'string'
        ? variant.algorithm_version_id
        : null;
      const allocationBasisPoints = Number(variant.allocation_basis_points);
      if (!variantId || !variantKey || !algorithmVersionId || !Number.isInteger(allocationBasisPoints)) {
        return null;
      }
      return { id: variantId, variantKey, algorithmVersionId, allocationBasisPoints };
    })
    .filter((variant): variant is FeedExperimentVariant => Boolean(variant))
    // Stable order keeps bucket boundaries fixed across requests; ordering by
    // anything mutable would migrate viewers between variants on a rename.
    .sort((left, right) => left.variantKey.localeCompare(right.variantKey));

  return { id, experimentKey, assignmentSalt, trafficBasisPoints, variants };
}

async function loadRunningExperiment(
  serviceClient: SupabaseClient,
): Promise<FeedExperimentDefinition | null> {
  const now = new Date().toISOString();
  const { data, error } = await serviceClient
    .from('feed_experiments')
    .select('id, experiment_key, assignment_salt, traffic_basis_points, starts_at, ends_at, feed_experiment_variants(id, variant_key, algorithm_version_id, allocation_basis_points)')
    .eq('status', 'running')
    .or(`starts_at.is.null,starts_at.lte.${now}`)
    .or(`ends_at.is.null,ends_at.gte.${now}`)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeExperiment(data as Record<string, unknown>);
}

/**
 * Resolves this viewer's feed experiment assignment, persisting it so the
 * readout can join on a stored assignment rather than re-deriving a hash that
 * may have been computed under different traffic settings.
 *
 * Every failure path returns null, which means "serve the active algorithm".
 * Experimentation must never be able to take the feed down.
 */
export async function resolveFeedExperimentAssignment({
  anonymousKeyHash,
  serviceClient,
  viewerUserId,
}: {
  anonymousKeyHash: string | null;
  serviceClient: SupabaseClient;
  viewerUserId: string | null;
}): Promise<FeedExperimentAssignment | null> {
  const viewerKey = viewerUserId ?? (anonymousKeyHash ? `anon:${anonymousKeyHash}` : null);
  if (!viewerKey) return null;

  const experiment = await loadRunningExperiment(serviceClient);
  if (!experiment) return null;

  const existing = await serviceClient
    .from('feed_experiment_assignments')
    .select('id, variant_id')
    .eq('experiment_id', experiment.id)
    .eq(
      viewerUserId ? 'viewer_user_id' : 'anonymous_key_hash',
      viewerUserId ?? anonymousKeyHash,
    )
    .maybeSingle();
  if (existing.error) return null;

  if (existing.data) {
    // A stored assignment outranks a fresh hash: allocations can be edited
    // mid-experiment, and moving an enrolled viewer would contaminate both arms.
    const storedVariant = experiment.variants.find(
      (variant) => variant.id === String((existing.data as Record<string, unknown>).variant_id),
    );
    if (!storedVariant) return null;
    return {
      experimentId: experiment.id,
      assignmentId: Number((existing.data as Record<string, unknown>).id),
      variant: storedVariant,
    };
  }

  const variant = selectExperimentVariant(experiment, viewerKey);
  if (!variant) return null;

  const expiresAt = new Date(
    Date.now() + FEED_EXPERIMENT_ASSIGNMENT_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const inserted = await serviceClient
    .from('feed_experiment_assignments')
    .insert({
      experiment_id: experiment.id,
      variant_id: variant.id,
      viewer_user_id: viewerUserId,
      anonymous_key_hash: viewerUserId ? null : anonymousKeyHash,
      expires_at: expiresAt,
    })
    .select('id')
    .maybeSingle();

  if (!inserted.error && inserted.data) {
    return {
      experimentId: experiment.id,
      assignmentId: Number((inserted.data as Record<string, unknown>).id),
      variant,
    };
  }

  // A concurrent request can win the partial-unique-index race. Never serve an
  // experimental algorithm without durable attribution: reload the committed
  // winner and use its stored variant. Any other failure falls back to active.
  const raced = await serviceClient
    .from('feed_experiment_assignments')
    .select('id, variant_id')
    .eq('experiment_id', experiment.id)
    .eq(
      viewerUserId ? 'viewer_user_id' : 'anonymous_key_hash',
      viewerUserId ?? anonymousKeyHash,
    )
    .maybeSingle();
  if (raced.error || !raced.data) return null;

  const racedRow = raced.data as Record<string, unknown>;
  const racedVariant = experiment.variants.find(
    (candidate) => candidate.id === String(racedRow.variant_id),
  );
  if (!racedVariant) return null;

  return {
    experimentId: experiment.id,
    assignmentId: Number(racedRow.id),
    variant: racedVariant,
  };
}
