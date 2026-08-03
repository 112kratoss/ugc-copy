// No `server-only` marker: the ops backfill imports this the same way it
// imports media-preview-repair. The service-role grant is the boundary.
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import {
  extractUploadsPathsFromWorkflowSettings,
  LEGACY_GUARD_SCAN_LIMIT,
} from '@/lib/media-upload-staging-paths';

export {
  extractUploadsPathsFromWorkflowSettings,
  LEGACY_GUARD_SCAN_LIMIT,
} from '@/lib/media-upload-staging-paths';

import {
  buildLegacyGenerationInputMedia,
  persistGenerationInputMedia,
  type GenerationInputMediaItem,
  type PersistGenerationInputCandidate,
} from '@/lib/generation-input-media';

/**
 * Heals generations whose durable input media never persisted.
 *
 * `persistGenerationInputMedia` catches per-candidate failures and only logs, so
 * a transient error leaves a generation with zero `generation_input_media` rows
 * while its `workflow_settings` still name the staged `uploads/` paths. Three
 * read paths then fall back to `buildLegacyGenerationInputMedia` and serve those
 * staging objects directly -- the owner inputs view, remix source, and
 * paid-bundle recipe inputs -- which makes the staged objects load-bearing and
 * puts them on a collision course with the reclaim sweep.
 *
 * This module supplies both halves of the fix: the set of paths the sweep must
 * refuse to reclaim, and the repair that shrinks that set to nothing.
 */

const GENERATION_INPUT_MEDIA_TABLE = 'generation_input_media';
const REPAIRS_TABLE = 'generation_input_media_repairs';
const GENERATION_INPUTS_BUCKET = 'generation_inputs';
const SELECTION_RPC = 'list_generations_missing_durable_input_media';

/** Matches MAX_PREVIEW_ATTEMPTS: a few tries, then a terminal state. */
export const MAX_INPUT_REPAIR_ATTEMPTS = 3;

/**
 * Small on purpose. Repair downloads and re-uploads real media, and it shares
 * the reclaim job's 300-second budget -- the same reasoning behind the rendition
 * sweep's batch of five. The backlog drains over consecutive daily runs.
 */
export const INPUT_REPAIR_BATCH_SIZE = 5;

/**
 * A generation that started moments ago may still be inside its own persist
 * call. Repairing it would race that write and risk duplicate rows, so anything
 * this recent is left alone.
 */
export const REPAIR_MIN_AGE_MS = 60 * 60 * 1000;

export type LegacyGenerationRow = {
  id: string;
  user_id: string;
  category: string | null;
  model: string | null;
  workflow_settings: Record<string, unknown> | null;
  attempt_count: number;
};

export type InputRepairSummary = {
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  /**
   * Generations left holding a half-set because their rollback could not delete
   * the rows. Their staged files are unprotected (the selection RPC excludes a
   * generation that has rows) but still load-bearing, so the caller must not
   * reclaim anything this run.
   */
  rollbackFailures: string[];
};

async function selectLegacyGenerations(
  client: SupabaseClient,
  params: { limit: number; maxAttempts: number | null; createdBefore: Date },
): Promise<LegacyGenerationRow[]> {
  const { data, error } = await client.rpc(SELECTION_RPC, {
    p_limit: params.limit,
    p_max_attempts: params.maxAttempts,
    p_created_before: params.createdBefore.toISOString(),
  });

  if (error) {
    throw new Error(error.message ?? 'Failed to list generations missing durable input media.');
  }

  return (data ?? []) as LegacyGenerationRow[];
}

/**
 * Staged paths the reclaim sweep must not delete.
 *
 * Returns `null` when the answer cannot be trusted -- the RPC failed, or the
 * scan hit its ceiling and may be truncated. Callers treat `null` as "skip
 * reclaiming entirely this run": deleting on an unproven answer is the one
 * outcome with no recovery.
 *
 * The attempt cap is deliberately not applied. A generation repair has given up
 * on still reads its staged files, so it stays protected permanently.
 */
export async function listProtectedUploadPaths(
  client: SupabaseClient,
  options: { now?: Date } = {},
): Promise<Set<string> | null> {
  const now = options.now ?? new Date();

  let rows: LegacyGenerationRow[];
  try {
    rows = await selectLegacyGenerations(client, {
      limit: LEGACY_GUARD_SCAN_LIMIT,
      maxAttempts: null,
      createdBefore: now,
    });
  } catch (error) {
    logBackendError('failed_to_list_protected_upload_paths', { error });
    return null;
  }

  if (rows.length >= LEGACY_GUARD_SCAN_LIMIT) {
    logBackendWarning('protected_upload_path_scan_truncated', { limit: LEGACY_GUARD_SCAN_LIMIT });
    return null;
  }

  const protectedPaths = new Set<string>();
  for (const row of rows) {
    for (const storagePath of extractUploadsPathsFromWorkflowSettings(row.workflow_settings)) {
      protectedPaths.add(storagePath);
    }
  }

  return protectedPaths;
}

export async function hasRepairableLegacyGenerations(
  client: SupabaseClient,
  options: { now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  try {
    const rows = await selectLegacyGenerations(client, {
      limit: 1,
      maxAttempts: MAX_INPUT_REPAIR_ATTEMPTS,
      createdBefore: new Date(now.getTime() - REPAIR_MIN_AGE_MS),
    });
    return rows.length > 0;
  } catch (error) {
    logBackendError('failed_to_check_repairable_legacy_generations', { error });
    return false;
  }
}

/**
 * Turn what the legacy view renders into what persist should store.
 *
 * Reusing the legacy builder rather than re-deriving candidates from
 * `workflow_settings` is the whole point: the read paths flip to durable rows the
 * moment one exists, so persisting anything narrower than what legacy renders
 * would *degrade* the view. Building from the same source makes them equal by
 * construction.
 */
export function toRepairCandidates(
  items: GenerationInputMediaItem[],
): PersistGenerationInputCandidate[] {
  return items.map((item) => {
    // Drop the marker the legacy builder stamps on: these rows are durable now.
    const metadata = { ...(item.metadata ?? {}) };
    delete metadata.legacy;
    const sourceUrl = typeof metadata.sourceUrl === 'string' ? metadata.sourceUrl : null;

    return {
      mediaType: item.mediaType,
      role: item.role as PersistGenerationInputCandidate['role'],
      label: item.label,
      sourceStoragePath: item.storagePath,
      sourceUrl,
      sourceGenerationId: item.sourceGenerationId,
      sortOrder: item.sortOrder,
      metadata,
    };
  });
}

type SourceGenerationRow = {
  id: string;
  user_id: string;
  output_url: string | null;
};

/**
 * Give source-generation references a concrete path to copy.
 *
 * Legacy renders these by looking up the source generation's output; persist
 * skips them because they carry neither a path nor a URL. Left alone they would
 * vanish from the view the moment durable rows exist. Same-owner sources resolve
 * to the source output; a cross-user source cannot be copied into this user's
 * bucket at all, which is why it ends the repair rather than half-completing it.
 */
async function resolveSourceGenerationPaths(
  client: SupabaseClient,
  params: { candidates: PersistGenerationInputCandidate[]; ownerUserId: string },
): Promise<{ ok: true; candidates: PersistGenerationInputCandidate[] } | { ok: false; reason: string }> {
  const pendingIds = Array.from(new Set(
    params.candidates
      .filter((candidate) => !candidate.sourceStoragePath && !candidate.sourceUrl && candidate.sourceGenerationId)
      .map((candidate) => candidate.sourceGenerationId as string),
  ));

  if (pendingIds.length === 0) {
    return { ok: true, candidates: params.candidates };
  }

  const { data, error } = await client
    .from('generations')
    .select('id, user_id, output_url')
    .in('id', pendingIds);

  if (error) {
    return { ok: false, reason: 'source_generation_lookup_failed' };
  }

  const sources = new Map((data ?? []).map((row) => [(row as SourceGenerationRow).id, row as SourceGenerationRow]));

  const resolved: PersistGenerationInputCandidate[] = [];
  for (const candidate of params.candidates) {
    if (candidate.sourceStoragePath || candidate.sourceUrl || !candidate.sourceGenerationId) {
      resolved.push(candidate);
      continue;
    }

    const source = sources.get(candidate.sourceGenerationId);
    if (!source?.output_url) {
      return { ok: false, reason: 'source_generation_output_missing' };
    }

    if (source.user_id !== params.ownerUserId) {
      return { ok: false, reason: 'cross_user_source_reference' };
    }

    resolved.push({ ...candidate, sourceStoragePath: source.output_url });
  }

  return { ok: true, candidates: resolved };
}

/**
 * Paths that must end up persisted for the repair to count as complete.
 *
 * Only storage-backed candidates gate completion. A dead remote URL renders
 * broken in legacy mode too, so failing to copy one is not a regression and must
 * not pin a generation in the repair queue forever.
 */
function getRequiredSourcePaths(candidates: PersistGenerationInputCandidate[]): {
  paths: string[];
  candidateCount: number;
} {
  const backed = candidates
    .map((candidate) => candidate.sourceStoragePath)
    .filter((storagePath): storagePath is string => Boolean(storagePath));

  // Both numbers matter. Two candidates can share one source path -- the same
  // picked file used as an element and as the start frame -- and persist writes
  // a row per candidate. Checking only the distinct paths would let one written
  // row satisfy both, so a half-persisted set would read as complete and the
  // read paths would flip to durable with a tile missing.
  return { paths: Array.from(new Set(backed)), candidateCount: backed.length };
}

async function loadPersistedSourcePaths(
  client: SupabaseClient,
  generationId: string,
): Promise<{ rowCount: number; sourcePaths: Set<string> }> {
  const { data, error } = await client
    .from(GENERATION_INPUT_MEDIA_TABLE)
    .select('id, metadata')
    .eq('generation_id', generationId);

  if (error) {
    throw new Error(error.message ?? 'Failed to read persisted generation input media.');
  }

  const rows = (data ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>;
  const sourcePaths = new Set<string>();
  for (const row of rows) {
    const sourceStoragePath = row.metadata?.sourceStoragePath;
    if (typeof sourceStoragePath === 'string' && sourceStoragePath) {
      sourcePaths.add(sourceStoragePath);
    }
  }

  return { rowCount: rows.length, sourcePaths };
}

/**
 * Undo a partial persist.
 *
 * Rows first, then objects, and never the reverse: the read paths key on
 * `rows.length > 0`, so deleting the rows is what restores the intact legacy
 * fallback, and account-deletion retention throws on a row whose object is
 * missing. An orphaned object left behind by a failed second step is harmless --
 * persist uploads with `upsert: true`, so the retry overwrites it.
 */
async function rollbackPartialRepair(
  client: SupabaseClient,
  params: { generationId: string; ownerUserId: string },
): Promise<{ ok: boolean }> {
  const deleteRows = async () => client
    .from(GENERATION_INPUT_MEDIA_TABLE)
    .delete()
    .eq('generation_id', params.generationId);

  let { error } = await deleteRows();
  if (error) {
    ({ error } = await deleteRows());
  }

  if (error) {
    // A surviving half-set is worse than no repair, and actively dangerous: the
    // generation now has rows, so the selection RPC's NOT EXISTS excludes it and
    // the guard stops protecting its staged paths -- while those staged bytes
    // are the only remaining copy of the inputs that failed to persist. The
    // caller has to stop this run's reclaim rather than delete them.
    logBackendError('failed_to_roll_back_partial_generation_input_repair', {
      error,
      generationId: params.generationId,
    });
    return { ok: false };
  }

  const prefix = `${params.ownerUserId}/${params.generationId}`;
  const listed = await client.storage.from(GENERATION_INPUTS_BUCKET).list(prefix);
  if (listed.error || !listed.data?.length) {
    return { ok: true };
  }

  const removal = await client.storage
    .from(GENERATION_INPUTS_BUCKET)
    .remove(listed.data.map((object) => `${prefix}/${object.name}`));
  if (removal.error) {
    // Harmless: persist uploads with upsert, so a retry overwrites these.
    logBackendWarning('failed_to_remove_rolled_back_generation_input_objects', {
      error: removal.error,
      generationId: params.generationId,
    });
  }

  return { ok: true };
}

async function recordRepairAttempt(
  client: SupabaseClient,
  params: { generationId: string; attemptCount: number; error: string | null; repaired: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await client
    .from(REPAIRS_TABLE)
    .upsert({
      generation_id: params.generationId,
      attempt_count: params.attemptCount + 1,
      last_attempted_at: now,
      last_error: params.error,
      repaired_at: params.repaired ? now : null,
    }, { onConflict: 'generation_id' });

  if (error) {
    logBackendWarning('failed_to_record_generation_input_repair_attempt', {
      error,
      generationId: params.generationId,
    });
  }
}

export type RepairDependencies = {
  buildLegacyGenerationInputMedia?: typeof buildLegacyGenerationInputMedia;
  persistGenerationInputMedia?: typeof persistGenerationInputMedia;
};

/**
 * Repair a batch of generations whose durable input media is missing.
 *
 * Each generation is all-or-nothing: it ends with either a complete durable set
 * or the untouched legacy fallback, never a half-set that would silently drop
 * reference tiles from the view.
 */
export async function repairMissingGenerationInputMedia(
  client: SupabaseClient,
  options: { now?: Date; batchSize?: number; dependencies?: RepairDependencies } = {},
): Promise<InputRepairSummary> {
  const now = options.now ?? new Date();
  const buildLegacy = options.dependencies?.buildLegacyGenerationInputMedia ?? buildLegacyGenerationInputMedia;
  const persist = options.dependencies?.persistGenerationInputMedia ?? persistGenerationInputMedia;
  const summary: InputRepairSummary = {
    attempted: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    rollbackFailures: [],
  };

  let generations: LegacyGenerationRow[];
  try {
    generations = await selectLegacyGenerations(client, {
      limit: Math.max(1, Math.min(options.batchSize ?? INPUT_REPAIR_BATCH_SIZE, 50)),
      maxAttempts: MAX_INPUT_REPAIR_ATTEMPTS,
      createdBefore: new Date(now.getTime() - REPAIR_MIN_AGE_MS),
    });
  } catch (error) {
    logBackendError('failed_to_select_generations_for_input_media_repair', { error });
    return summary;
  }

  for (const generation of generations) {
    // Re-check the cap in JS as well as in SQL, mirroring the preview sweep:
    // the predicate and the guard should never be able to disagree.
    if (generation.attempt_count >= MAX_INPUT_REPAIR_ATTEMPTS) {
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;

    try {
      const existing = await loadPersistedSourcePaths(client, generation.id);
      if (existing.rowCount > 0) {
        // Something wrote rows between selection and now. Never delete rows this
        // repair did not create.
        summary.skipped += 1;
        summary.attempted -= 1;
        continue;
      }

      const legacyItems = await buildLegacy({
        supabase: client,
        generationId: generation.id,
        ownerUserId: generation.user_id,
        category: generation.category,
        workflowSettings: generation.workflow_settings ?? {},
        urlMode: 'none',
      });

      if (legacyItems.length === 0) {
        // The guard still protects this generation's staged paths; there is just
        // nothing durable to build from. Counting it as an attempt keeps it from
        // being reselected forever.
        summary.failed += 1;
        await recordRepairAttempt(client, {
          generationId: generation.id,
          attemptCount: generation.attempt_count,
          error: 'no_legacy_input_media_items',
          repaired: false,
        });
        continue;
      }

      const resolution = await resolveSourceGenerationPaths(client, {
        candidates: toRepairCandidates(legacyItems),
        ownerUserId: generation.user_id,
      });

      if (!resolution.ok) {
        summary.failed += 1;
        await recordRepairAttempt(client, {
          generationId: generation.id,
          attemptCount: generation.attempt_count,
          error: resolution.reason,
          repaired: false,
        });
        continue;
      }

      const required = getRequiredSourcePaths(resolution.candidates);

      await persist({
        supabase: client,
        generationId: generation.id,
        userId: generation.user_id,
        candidates: resolution.candidates,
      });

      const persisted = await loadPersistedSourcePaths(client, generation.id);
      const missing = required.paths.filter((storagePath) => !persisted.sourcePaths.has(storagePath));
      // A run that persisted nothing at all is a failure even when nothing was
      // strictly required -- otherwise the LIKE keeps reselecting it forever.
      const complete = persisted.rowCount > 0
        && missing.length === 0
        && persisted.rowCount >= required.candidateCount;

      if (complete) {
        summary.completed += 1;
        await recordRepairAttempt(client, {
          generationId: generation.id,
          attemptCount: generation.attempt_count,
          error: null,
          repaired: true,
        });
        continue;
      }

      const rolledBack = await rollbackPartialRepair(client, {
        generationId: generation.id,
        ownerUserId: generation.user_id,
      });
      if (!rolledBack.ok) {
        summary.rollbackFailures.push(generation.id);
      }
      summary.failed += 1;
      await recordRepairAttempt(client, {
        generationId: generation.id,
        attemptCount: generation.attempt_count,
        error: persisted.rowCount === 0
          ? 'persist_wrote_no_rows'
          : missing.length > 0
            ? `missing_durable_media_for_${missing.length}_sources`
            : `persisted_${persisted.rowCount}_of_${required.candidateCount}_candidates`,
        repaired: false,
      });
    } catch (error) {
      logBackendError('failed_to_repair_generation_input_media', { error, generationId: generation.id });
      summary.failed += 1;
      const rolledBack = await rollbackPartialRepair(client, {
        generationId: generation.id,
        ownerUserId: generation.user_id,
      });
      if (!rolledBack.ok) {
        summary.rollbackFailures.push(generation.id);
      }
      await recordRepairAttempt(client, {
        generationId: generation.id,
        attemptCount: generation.attempt_count,
        error: error instanceof Error ? error.message.slice(0, 500) : 'repair_failed',
        repaired: false,
      });
    }
  }

  return summary;
}
