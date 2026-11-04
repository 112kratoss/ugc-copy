import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendInfo, logBackendWarning } from '@/lib/backend-logger';
import { buildGenerationReferenceCopyPath } from '@/lib/post-resource-bundles-server';
import {
  isRecipeCopySweepDeletionEnabled,
  planRecipeFileSweep,
  RECIPE_COPY_SWEEP_BATCH_LIMIT,
  RECIPE_COPY_SWEEP_GRACE_MS,
  RECIPE_COPY_SWEEP_RESTORE_LIMIT,
  RECIPE_COPY_SWEEP_RESTORE_WINDOW_MS,
  RECIPE_COPY_SWEEP_SCAN_LIMIT,
  RECIPE_IMPORT_QUIET_MS,
  RECIPE_IMPORT_RESTORE_MARGIN_MS,
  RECIPE_IMPORT_USE_RETENTION_MS,
  recipeImportSourceCopy,
  type RecipeFileSweepDeletion,
} from '@/lib/recipe-copy-sweep-policy';
import { parseGenerationReferenceCopyPath, RECIPE_FILES_BUCKET } from '@/lib/recipe-file-paths';
import { getCanonicalStoredMediaLocation } from '@/lib/storage-ownership';

/**
 * The recipe-copy-sweep job: removes the copies of creations' saved inputs and
 * the run starts' imports of them that nothing names any more
 * (`recipe-copy-sweep-policy.ts` holds the rule, the migration
 * `20261103232038_recipe_copy_sweep.sql` the reads).
 *
 * A run, in order:
 * 1. Looks at up to 200 of the copies it removed in the past two weeks, least
 *    recently looked at first, and copies back any that something names again
 *    (`list_swept_recipe_copies_named_again`): from the saved input it was made
 *    of, or where that is gone, from a buyer's import of it that survives. A
 *    save that found a copy at its path (the path is fixed by the input, so it
 *    copies nothing again) just before this removed it writes its recipe after.
 * 2. Drops ledger rows past those two weeks, and import uses past a week.
 * 3. Reads the candidates (`list_recipe_file_sweep_candidates`): it walks each
 *    bucket a page on from where the last run stopped, and hands back the files
 *    in the two folders older than the grace period that nothing names, and for
 *    an import, that no run start used in the last six hours. The rule is
 *    applied to them again here (`planRecipeFileSweep`).
 * 4. With `RECIPE_COPY_SWEEP_DELETE=true` only: records each in the ledger,
 *    then removes it. Without it the run reports what it would remove.
 * 5. Puts back any import removed in this run that a run start used since the
 *    read (each start records its use before it touches the file,
 *    `recordRecipeImportUse`), from the copy it was made of.
 *
 * Idempotent: a file already gone counts as such, a ledger row is written again
 * in place, and the next run reads everything afresh.
 */

const GENERATION_INPUTS_BUCKET = 'generation_inputs';
const LEDGER_TABLE = 'recipe_file_sweep_deletions';
const IMPORT_USES_TABLE = 'recipe_import_uses';
const SAMPLE_SIZE = 5;

export interface RecipeCopySweepSummary {
  /** `report` when removal is off, or when this run could not read what it removed before. */
  mode: 'delete' | 'report';
  restoreReadFailed: boolean;
  /** Objects this run read, of both buckets. */
  scanned: number;
  /** Files in the two folders among them. */
  examined: number;
  /** Files left in place, for whichever reason. */
  kept: number;
  keptTooRecent: number;
  keptNamed: number;
  keptImportInUse: number;
  /** Candidates the rule refused, and candidates the batch bound left for a later run. */
  refused: number;
  deferred: number;
  batchLimitReached: boolean;
  /** Report mode: what a deleting run would remove now. */
  wouldDelete: number;
  sample: string[];
  deletedCopies: number;
  deletedImports: number;
  /** Asked to remove, and already gone. */
  alreadyGone: number;
  failed: number;
  restoredCopies: number;
  restoredImports: number;
  restoreFailed: number;
  /** A removed copy named again with nothing left to copy it back from. */
  restoreUnavailable: number;
  ledgerPruned: number;
}

type CandidateRead = {
  readAt?: string;
  scanned?: number;
  examined?: number;
  tooRecent?: number;
  named?: number;
  importsInUse?: number;
  unnamed?: number;
  candidates?: unknown;
};

type NamedAgainRow = {
  object_name: string;
  input_id: string | null;
  input_user_id: string | null;
  input_role: string | null;
  input_sort_order: number | null;
  input_storage_path: string | null;
  input_media_type: string | null;
  surviving_import: string | null;
};

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  return candidate.status === 409
    || candidate.statusCode === '409'
    || candidate.statusCode === 409
    || (typeof candidate.message === 'string' && /already exists|duplicate/i.test(candidate.message));
}

async function copyInto(
  client: SupabaseClient,
  source: { bucket: string; filePath: string },
  target: { bucket: string; filePath: string },
): Promise<boolean> {
  try {
    const { error } = await client.storage
      .from(source.bucket)
      .copy(source.filePath, target.filePath, { destinationBucket: target.bucket });
    return !error || isAlreadyExistsError(error);
  } catch {
    return false;
  }
}

async function forgetDeletion(client: SupabaseClient, bucketId: string, objectName: string): Promise<void> {
  const { error } = await client.from(LEDGER_TABLE).delete().eq('bucket_id', bucketId).eq('object_name', objectName);
  if (error) logBackendWarning('recipe_copy_sweep_ledger_forget_failed', { error });
}

/** Where a removed copy named again is copied back from: its saved input, or a surviving import of it. */
function restoreSourceOf(row: NamedAgainRow): { bucket: string; filePath: string } | null {
  const copy = parseGenerationReferenceCopyPath(row.object_name);
  if (!copy) return null;
  if (row.input_id && row.input_storage_path && row.input_media_type) {
    // The copy's path is fixed by its input: only the row that builds exactly this path is its source.
    const rebuilt = buildGenerationReferenceCopyPath(copy.ownerUserId, copy.generationId, {
      id: row.input_id,
      role: row.input_role ?? '',
      sort_order: row.input_sort_order ?? 0,
      storage_path: row.input_storage_path,
      media_type: row.input_media_type as 'image' | 'video' | 'audio',
    });
    const source = getCanonicalStoredMediaLocation(row.input_storage_path);
    if (source && rebuilt === row.object_name) return source;
  }
  // An import of the copy is a byte-for-byte copy of it (`importGenerationReferenceCopy`).
  if (row.surviving_import && recipeImportSourceCopy(row.surviving_import) === row.object_name) {
    return { bucket: GENERATION_INPUTS_BUCKET, filePath: row.surviving_import };
  }
  return null;
}

/** Step 1: a removed copy something names again goes back. */
async function restoreCopiesNamedAgain(client: SupabaseClient, nowMs: number) {
  const result = { restored: 0, failed: 0, unavailable: 0 };
  const { data, error } = await client.rpc('list_swept_recipe_copies_named_again', {
    p_deleted_since: new Date(nowMs - RECIPE_COPY_SWEEP_RESTORE_WINDOW_MS).toISOString(),
    p_limit: RECIPE_COPY_SWEEP_RESTORE_LIMIT,
  });
  if (error) throw new Error(`Could not read swept recipe copies named again: ${error.message}`);

  for (const row of (data ?? []) as NamedAgainRow[]) {
    const source = restoreSourceOf(row);
    if (!source) {
      result.unavailable += 1;
      logBackendError('recipe_copy_sweep_restore_unavailable', { objectName: row.object_name });
      continue;
    }
    if (await copyInto(client, source, { bucket: RECIPE_FILES_BUCKET, filePath: row.object_name })) {
      result.restored += 1;
      logBackendWarning('recipe_copy_sweep_copy_restored', { objectName: row.object_name, from: source.bucket });
      await forgetDeletion(client, RECIPE_FILES_BUCKET, row.object_name);
    } else {
      result.failed += 1;
      logBackendError('recipe_copy_sweep_restore_failed', { objectName: row.object_name });
    }
  }
  return result;
}

/** Step 5: an import removed in this run that a run start used since the read goes back. */
async function restoreImportsInUse(
  client: SupabaseClient,
  removedImports: readonly string[],
  readAtMs: number,
) {
  const result = { restored: 0, failed: 0 };
  if (removedImports.length === 0) return result;
  // Asked in the request body: two hundred paths make too long a query string.
  const { data, error } = await client.rpc('list_recipe_imports_used_since', {
    p_object_names: removedImports,
    p_since: new Date(readAtMs - RECIPE_IMPORT_RESTORE_MARGIN_MS).toISOString(),
  });
  // Unread, every removed import is taken for one in use.
  const used = error
    ? new Set(removedImports)
    : new Set(((data ?? []) as unknown[]).map((row) => (
      typeof row === 'string' ? row : (row as { list_recipe_imports_used_since?: string } | null)?.list_recipe_imports_used_since ?? ''
    )));
  if (error) logBackendWarning('recipe_copy_sweep_import_uses_unread', { error });

  for (const name of removedImports) {
    if (!used.has(name)) continue;
    const copyName = recipeImportSourceCopy(name);
    const restored = copyName
      && await copyInto(
        client,
        { bucket: RECIPE_FILES_BUCKET, filePath: copyName },
        { bucket: GENERATION_INPUTS_BUCKET, filePath: name },
      );
    if (restored) {
      result.restored += 1;
      logBackendWarning('recipe_copy_sweep_import_restored', { objectName: name });
      await forgetDeletion(client, GENERATION_INPUTS_BUCKET, name);
    } else {
      result.failed += 1;
      logBackendError('recipe_copy_sweep_import_restore_failed', { objectName: name });
    }
  }
  return result;
}

async function removeObjects(client: SupabaseClient, bucketId: string, names: string[]) {
  if (names.length === 0) return { deleted: [] as string[], failed: 0 };
  try {
    const { data, error } = await client.storage.from(bucketId).remove(names);
    if (error) {
      logBackendError('recipe_copy_sweep_remove_failed', { bucketId, count: names.length, error });
      return { deleted: [] as string[], failed: names.length };
    }
    const removed = new Set(((data ?? []) as Array<{ name?: string | null }>).flatMap((row) => (row.name ? [row.name] : [])));
    return { deleted: names.filter((name) => removed.has(name)), failed: 0 };
  } catch (error) {
    logBackendError('recipe_copy_sweep_remove_failed', { bucketId, count: names.length, error });
    return { deleted: [] as string[], failed: names.length };
  }
}

async function pruneOlderThan(client: SupabaseClient, table: string, column: string, beforeMs: number, event: string) {
  const pruned = await client.from(table).delete({ count: 'exact' }).lt(column, new Date(beforeMs).toISOString());
  if (pruned.error) {
    logBackendWarning(event, { error: pruned.error });
    return 0;
  }
  return pruned.count ?? 0;
}

export async function sweepRecipeFileCopies(
  client: SupabaseClient,
  options: { now?: Date; deleteEnabled?: boolean; limit?: number } = {},
): Promise<RecipeCopySweepSummary> {
  const nowMs = (options.now ?? new Date()).getTime();
  const deleteEnabled = options.deleteEnabled ?? isRecipeCopySweepDeletionEnabled();
  const limit = Math.max(1, Math.min(options.limit ?? RECIPE_COPY_SWEEP_BATCH_LIMIT, RECIPE_COPY_SWEEP_BATCH_LIMIT));

  // A removal recorded by an earlier deleting run is watched whatever this run's mode. A read that
  // fails is logged and the run goes on, removing nothing: a bad batch never jams the job, and no file
  // is removed while what was removed cannot be watched.
  let restoredCopies = { restored: 0, failed: 0, unavailable: 0 };
  let restoreReadFailed = false;
  try {
    restoredCopies = await restoreCopiesNamedAgain(client, nowMs);
  } catch (error) {
    restoreReadFailed = true;
    logBackendError('recipe_copy_sweep_restore_read_failed', { error });
  }

  const ledgerPruned = await pruneOlderThan(
    client, LEDGER_TABLE, 'deleted_at', nowMs - RECIPE_COPY_SWEEP_RESTORE_WINDOW_MS, 'recipe_copy_sweep_ledger_prune_failed',
  );
  await pruneOlderThan(
    client, IMPORT_USES_TABLE, 'used_at', nowMs - RECIPE_IMPORT_USE_RETENTION_MS, 'recipe_copy_sweep_import_uses_prune_failed',
  );

  const { data, error } = await client.rpc('list_recipe_file_sweep_candidates', {
    p_created_before: new Date(nowMs - RECIPE_COPY_SWEEP_GRACE_MS).toISOString(),
    p_imports_quiet_since: new Date(nowMs - RECIPE_IMPORT_QUIET_MS).toISOString(),
    p_limit: limit,
    p_scan_limit: RECIPE_COPY_SWEEP_SCAN_LIMIT,
  });
  if (error) throw new Error(`Could not read recipe file sweep candidates: ${error.message}`);
  const read = (data ?? {}) as CandidateRead;
  // The database's own time of the read: a use recorded after it is one the read could not see.
  const readAtMs = typeof read.readAt === 'string' && Number.isFinite(Date.parse(read.readAt))
    ? Date.parse(read.readAt)
    : nowMs;
  const plan = planRecipeFileSweep(read.candidates, { nowMs, limit });
  const examined = count(read.examined);

  const summary: RecipeCopySweepSummary = {
    mode: deleteEnabled && !restoreReadFailed ? 'delete' : 'report',
    restoreReadFailed,
    scanned: count(read.scanned),
    examined,
    kept: examined,
    keptTooRecent: count(read.tooRecent),
    keptNamed: count(read.named),
    keptImportInUse: count(read.importsInUse),
    refused: plan.refused,
    deferred: plan.deferred,
    batchLimitReached: plan.deferred > 0
      || count(read.unnamed) > (Array.isArray(read.candidates) ? read.candidates.length : 0),
    wouldDelete: 0,
    sample: plan.deletions.slice(0, SAMPLE_SIZE).map((deletion) => `${deletion.bucketId}/${deletion.name}`),
    deletedCopies: 0,
    deletedImports: 0,
    alreadyGone: 0,
    failed: 0,
    restoredCopies: restoredCopies.restored,
    restoredImports: 0,
    restoreFailed: restoredCopies.failed,
    restoreUnavailable: restoredCopies.unavailable,
    ledgerPruned,
  };

  if (summary.mode === 'report') {
    summary.wouldDelete = plan.deletions.length;
    logBackendInfo('recipe_copy_sweep_report', { ...summary });
    return summary;
  }
  if (plan.deletions.length === 0) {
    logBackendInfo('recipe_copy_sweep_completed', { ...summary });
    return summary;
  }

  // The ledger first: a copy removed and then named again is found through it.
  const { error: ledgerError } = await client.from(LEDGER_TABLE).upsert(
    plan.deletions.map((deletion) => ({
      bucket_id: deletion.bucketId,
      object_name: deletion.name,
      deleted_at: new Date(nowMs).toISOString(),
      checked_at: null,
    })),
    { onConflict: 'bucket_id,object_name' },
  );
  if (ledgerError) throw new Error(`Could not record the recipe files to remove: ${ledgerError.message}`);

  const byBucket = new Map<string, RecipeFileSweepDeletion[]>();
  for (const deletion of plan.deletions) {
    byBucket.set(deletion.bucketId, [...(byBucket.get(deletion.bucketId) ?? []), deletion]);
  }
  const removedImports: string[] = [];
  for (const [bucketId, deletions] of byBucket) {
    const names = deletions.map((deletion) => deletion.name);
    const removed = await removeObjects(client, bucketId, names);
    summary.failed += removed.failed;
    if (removed.failed > 0) continue;
    summary.alreadyGone += names.length - removed.deleted.length;
    for (const deletion of deletions) {
      // Watched whether or not this removal is what took it: some Storage clients omit the results.
      if (deletion.kind === 'import') removedImports.push(deletion.name);
      if (!removed.deleted.includes(deletion.name)) continue;
      if (deletion.kind === 'copy') {
        summary.deletedCopies += 1;
      } else {
        summary.deletedImports += 1;
      }
    }
  }
  summary.kept = examined - summary.deletedCopies - summary.deletedImports - summary.alreadyGone;

  const restoredImports = await restoreImportsInUse(client, removedImports, readAtMs);
  summary.restoredImports = restoredImports.restored;
  summary.restoreFailed += restoredImports.failed;

  logBackendInfo('recipe_copy_sweep_completed', { ...summary });
  return summary;
}
