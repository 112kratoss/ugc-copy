import {
  parseGenerationReferenceCopyPath,
  parseRecipeImportPath,
  RECIPE_FILES_BUCKET,
  generationReferenceCopyFolder,
} from '@/lib/recipe-file-paths';

/**
 * The rule the recipe-copy-sweep job removes leftover recipe files by (owner,
 * 2026-11-04: "Leftover copied files are never cleaned up automatically… fix it").
 *
 * Two kinds of file, each in one exact folder (`src/lib/recipe-file-paths.ts`):
 * - a copy "Include creation references" made of a creation's saved input,
 *   `post_resource_files/<publisher>/generation-references/<generation>/<file>`;
 * - a run start's import of a bought recipe's copy,
 *   `generation_inputs/<buyer>/recipe-imports/<seller>/<generation>/<file>`.
 *
 * What nothing names is found in the database (`list_recipe_file_sweep_candidates`,
 * which reads every recipe, every revision of one, every kept generation input and
 * more). This module holds the part of the rule that does not need it, so it is
 * applied again to whatever the database hands back: the folder, the grace period
 * and the batch bound. Nothing outside the two folders, and nothing younger than
 * the grace period, is ever removed, whatever a read returns.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How old a file must be before it may go, counted from when it was written.
 *
 * Seven days. A refused or failed save leaves its copies where the next save of
 * that recipe finds them and copies nothing again (`copyGenerationReferenceFile`),
 * so they stay for a creator who comes back within the week to try again; a copy
 * a recipe ever named is named by that recipe's revision for as long as the
 * recipe exists, so the period only decides how long a copy nobody ever saved, or
 * one whose recipe is gone, lingers. The database refuses anything under a day.
 */
export const RECIPE_COPY_SWEEP_GRACE_MS = 7 * DAY_MS;

/**
 * An import stays while its buyer has started a run this recently: a run start
 * reuses an import already at its path and hands the provider a link to it that
 * lives an hour (`importGenerationReferenceCopy`). The database refuses under an hour.
 */
export const RECIPE_IMPORT_QUIET_MS = 2 * HOUR_MS;

/** At most this many files are removed in one run; the rest wait for the next. */
export const RECIPE_COPY_SWEEP_BATCH_LIMIT = 200;

/**
 * How long a removed copy is watched for a recipe naming it again: a save that
 * found the copy at its path just before the sweep removed it writes its recipe
 * after, and a composer left open can send an item it holds.
 */
export const RECIPE_COPY_SWEEP_RESTORE_WINDOW_MS = 7 * DAY_MS;
export const RECIPE_COPY_SWEEP_RESTORE_LIMIT = 100;

/**
 * A run start's generation row is written before it reuses an import, so a
 * buyer's run started since the candidates were read means an import removed in
 * this run may be in use: it is put back. The margin covers the clock of the
 * database against this one's.
 */
export const RECIPE_IMPORT_RESTORE_MARGIN_MS = 60 * 1000;

/** Deletion is off unless the operator sets this to `true`: the job then only reports. */
export const RECIPE_COPY_SWEEP_DELETE_FLAG = 'RECIPE_COPY_SWEEP_DELETE';

const GENERATION_INPUTS_BUCKET = 'generation_inputs';

export type RecipeFileKind = 'copy' | 'import';

export interface RecipeFileSweepDeletion {
  bucketId: string;
  name: string;
  kind: RecipeFileKind;
}

export interface RecipeFileSweepPlan {
  deletions: RecipeFileSweepDeletion[];
  /** Rows the database handed back that this rule refuses: another folder, too young, unreadable, repeated. */
  refused: number;
  /** Rows the batch bound left for a later run. */
  deferred: number;
}

export function isRecipeCopySweepDeletionEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment[RECIPE_COPY_SWEEP_DELETE_FLAG] === 'true';
}

/** Which of the two kinds a stored object is, by its bucket and exact folder, or null for anything else. */
export function recipeFileKind(bucketId: string, name: string): RecipeFileKind | null {
  if (bucketId === RECIPE_FILES_BUCKET) {
    const copy = parseGenerationReferenceCopyPath(name);
    return copy && !copy.fileName.startsWith('.') ? 'copy' : null;
  }
  if (bucketId === GENERATION_INPUTS_BUCKET) {
    const imported = parseRecipeImportPath(name);
    return imported && !imported.fileName.startsWith('.') ? 'import' : null;
  }
  return null;
}

/** The copy an import was made from, as its object name in the recipe files. */
export function recipeImportSourceCopy(importName: string): string | null {
  const imported = parseRecipeImportPath(importName);
  return imported
    ? `${generationReferenceCopyFolder(imported.ownerUserId, imported.generationId)}${imported.fileName}`
    : null;
}

/**
 * The files one run removes, from the candidates the database named: each in
 * one of the two folders, written before `nowMs - graceMs`, once, oldest first
 * as handed back, at most `limit`.
 */
export function planRecipeFileSweep(
  candidates: unknown,
  options: { nowMs: number; graceMs?: number; limit?: number },
): RecipeFileSweepPlan {
  const graceMs = Math.max(options.graceMs ?? RECIPE_COPY_SWEEP_GRACE_MS, RECIPE_COPY_SWEEP_GRACE_MS);
  const limit = Math.max(0, Math.min(options.limit ?? RECIPE_COPY_SWEEP_BATCH_LIMIT, RECIPE_COPY_SWEEP_BATCH_LIMIT));
  const writtenBefore = options.nowMs - graceMs;
  const rows = Array.isArray(candidates) ? candidates : [];
  const seen = new Set<string>();
  const deletions: RecipeFileSweepDeletion[] = [];
  let refused = 0;
  let deferred = 0;

  for (const row of rows) {
    const candidate = row as { bucketId?: unknown; name?: unknown; createdAt?: unknown } | null;
    const bucketId = typeof candidate?.bucketId === 'string' ? candidate.bucketId : null;
    const name = typeof candidate?.name === 'string' ? candidate.name : null;
    const createdAtMs = typeof candidate?.createdAt === 'string' ? Date.parse(candidate.createdAt) : Number.NaN;
    const kind = bucketId && name ? recipeFileKind(bucketId, name) : null;
    const key = `${bucketId}/${name}`;
    if (!bucketId || !name || !kind || !Number.isFinite(createdAtMs) || createdAtMs >= writtenBefore || seen.has(key)) {
      refused += 1;
      continue;
    }
    seen.add(key);
    if (deletions.length >= limit) {
      deferred += 1;
      continue;
    }
    deletions.push({ bucketId, name, kind });
  }

  return { deletions, refused, deferred };
}
