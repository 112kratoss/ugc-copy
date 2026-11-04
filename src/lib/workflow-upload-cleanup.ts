import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
import { LEGACY_GUARD_SCAN_LIMIT } from '@/lib/media-upload-staging-paths';
import { getCanonicalStoredMediaLocation, getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';

/**
 * The files a workflow canvas's input nodes were given, and what happens to
 * them when the canvas is deleted.
 *
 * An input node's file is uploaded once into the owner's folder of a generated
 * bucket as `<user>/workflow-input-<upload>-<name>` (workflow-asset-upload-sign)
 * and named by the canvas graph's `storagePath`. Deleting the canvas cascades
 * to its history, runs and steps, so after it nothing of the canvas names the
 * file. It goes then, unless:
 * - another canvas of the account names it (a duplicate, a pasted node);
 * - a creation still reads it: one the canvas's runs made that names it and is
 *   still rendering, or finished without a kept copy of it (each run start
 *   copies its inputs into `generation_inputs`, recording the file as the
 *   copy's `sourceStoragePath`); or one with no kept inputs at all
 *   (`list_generations_missing_durable_input_media`) that names it.
 * Shares and templates never name it: a share drops every input's file and a
 * template publish copies its fixed inputs into its own bucket.
 *
 * Only `workflow-input-` files in the account's own folder are ever removed: a
 * creation's output shown on the canvas belongs to the creation. A read that
 * fails, or a scan that may be cut short, removes nothing.
 */

const WORKFLOW_UPLOAD_BUCKETS = ['generated_images', 'generated_videos', 'generated_audio'] as const;
const WORKFLOW_INPUT_FILE_PREFIX = 'workflow-input-';
const RENDERED_STATUSES = new Set(['succeeded', 'failed']);

export type WorkflowInputUpload = {
  bucket: string;
  filePath: string;
  /** `<bucket>/<path>`, the form graphs and creations store it in. */
  storagePath: string;
};

function collectStoragePaths(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStoragePaths(entry, output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'storagePath' && typeof entry === 'string' && entry.trim()) output.add(entry);
    else collectStoragePaths(entry, output);
  }
}

/** The account's own input files a stored graph names, never anything else it shows. */
export function listWorkflowInputUploads(graph: unknown, userId: string): WorkflowInputUpload[] {
  const values = new Set<string>();
  collectStoragePaths(graph, values);
  const uploads = new Map<string, WorkflowInputUpload>();
  for (const value of values) {
    const location = getUserOwnedStoredMediaLocation(value, userId, { allowedBuckets: WORKFLOW_UPLOAD_BUCKETS });
    if (!location) continue;
    const name = location.filePath.slice(userId.length + 1);
    if (!name.startsWith(WORKFLOW_INPUT_FILE_PREFIX) || name.includes('/')) continue;
    const storagePath = `${location.bucket}/${location.filePath}`;
    uploads.set(storagePath, { bucket: location.bucket, filePath: location.filePath, storagePath });
  }
  return [...uploads.values()];
}

/** Whether a stored value names the file, by its stored form or its object path, plain or URL-encoded. */
function namesUpload(serialized: string, upload: WorkflowInputUpload): boolean {
  return [upload.storagePath, upload.filePath, encodeURI(upload.filePath), encodeURIComponent(upload.filePath)]
    .some((form) => serialized.includes(form));
}

type ReadResult<T> = { data: T[] | null; error: unknown };

async function readRows<T>(query: PromiseLike<ReadResult<T>>, what: string): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(`Could not read ${what}.`), { cause: error });
  return data ?? [];
}

/**
 * The creations the canvas's runs made, read before the canvas's delete
 * cascades to its runs and steps. Null when they could not be read.
 */
export async function readWorkflowRunGenerationIds(
  client: SupabaseClient,
  canvasId: string,
): Promise<string[] | null> {
  try {
    const runs = await readRows<{ id: string }>(
      client.from('workflow_canvas_runs').select('id').eq('canvas_id', canvasId),
      'the canvas runs',
    );
    if (runs.length === 0) return [];
    const steps = await readRows<{ generation_id: string | null }>(
      client.from('workflow_canvas_run_steps').select('generation_id').in('run_id', runs.map((run) => run.id)),
      'the canvas run steps',
    );
    return [...new Set(steps.flatMap((step) => (step.generation_id ? [step.generation_id] : [])))];
  } catch (error) {
    logBackendWarning('workflow_upload_cleanup_skipped', { canvasId, error });
    return null;
  }
}

async function findStillReadUploads(
  client: SupabaseClient,
  userId: string,
  uploads: WorkflowInputUpload[],
  runGenerationIds: string[],
): Promise<Set<string>> {
  const kept = new Set<string>();

  const canvases = await readRows<{ graph: unknown }>(
    client.from('workflow_canvases').select('id, graph').eq('user_id', userId),
    "the account's canvases",
  );
  const serializedCanvases = canvases.map((canvas) => JSON.stringify(canvas.graph ?? null));
  for (const upload of uploads) {
    if (serializedCanvases.some((serialized) => namesUpload(serialized, upload))) kept.add(upload.storagePath);
  }

  if (runGenerationIds.length > 0) {
    const generations = await readRows<{ id: string; status: string | null; workflow_settings: unknown }>(
      client.from('generations').select('id, status, workflow_settings').in('id', runGenerationIds),
      "the canvas runs' creations",
    );
    const naming = generations.map((generation) => ({
      generation,
      serialized: JSON.stringify(generation.workflow_settings ?? null),
    }));
    const copies = naming.length === 0 ? [] : await readRows<{ generation_id: string; metadata: Record<string, unknown> | null }>(
      client.from('generation_input_media').select('generation_id, metadata').in('generation_id', naming.map(({ generation }) => generation.id)),
      "the canvas runs' kept inputs",
    );
    const copiedSources = new Map<string, Set<string>>();
    for (const copy of copies) {
      const source = copy.metadata?.sourceStoragePath;
      const location = typeof source === 'string'
        ? getCanonicalStoredMediaLocation(source, { allowedBuckets: WORKFLOW_UPLOAD_BUCKETS })
        : null;
      if (!location) continue;
      const sources = copiedSources.get(copy.generation_id) ?? new Set<string>();
      sources.add(`${location.bucket}/${location.filePath}`);
      copiedSources.set(copy.generation_id, sources);
    }
    for (const upload of uploads) {
      for (const { generation, serialized } of naming) {
        if (!namesUpload(serialized, upload)) continue;
        const rendering = !RENDERED_STATUSES.has(generation.status ?? '');
        const copied = copiedSources.get(generation.id)?.has(upload.storagePath) ?? false;
        if (rendering || !copied) kept.add(upload.storagePath);
      }
    }
  }

  const { data: legacy, error: legacyError } = await client.rpc('list_generations_missing_durable_input_media', {
    p_limit: LEGACY_GUARD_SCAN_LIMIT,
    p_max_attempts: null,
    p_created_before: new Date().toISOString(),
  });
  if (legacyError) throw Object.assign(new Error('Could not list creations without kept inputs.'), { cause: legacyError });
  const legacyRows = (legacy ?? []) as Array<{ user_id: string; workflow_settings: unknown }>;
  if (legacyRows.length >= LEGACY_GUARD_SCAN_LIMIT) {
    throw new Error('The scan of creations without kept inputs may be cut short.');
  }
  for (const row of legacyRows) {
    if (row.user_id !== userId) continue;
    const serialized = JSON.stringify(row.workflow_settings ?? null);
    for (const upload of uploads) {
      if (namesUpload(serialized, upload)) kept.add(upload.storagePath);
    }
  }

  return kept;
}

/**
 * Removes the input files a deleted canvas named that nothing reads any more.
 * Called once the canvas row is gone. Never throws.
 */
export async function removeUnreadWorkflowUploads(
  client: SupabaseClient,
  {
    userId,
    canvasId,
    uploads,
    runGenerationIds,
  }: {
    userId: string;
    canvasId: string;
    uploads: WorkflowInputUpload[];
    runGenerationIds: string[];
  },
): Promise<void> {
  if (uploads.length === 0) return;

  let kept: Set<string>;
  try {
    kept = await findStillReadUploads(client, userId, uploads, runGenerationIds);
  } catch (error) {
    logBackendWarning('workflow_upload_cleanup_skipped', { canvasId, error });
    return;
  }

  const byBucket = new Map<string, string[]>();
  for (const upload of uploads) {
    if (kept.has(upload.storagePath)) continue;
    byBucket.set(upload.bucket, [...(byBucket.get(upload.bucket) ?? []), upload.filePath]);
  }
  for (const [bucket, paths] of byBucket) {
    try {
      const { error } = await client.storage.from(bucket).remove(paths);
      if (error) throw error;
    } catch (error) {
      logBackendWarning('failed_to_remove_deleted_workflow_uploads', { canvasId, bucket, paths, error });
    }
  }
}
