import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
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
 * - a creation of the account made since the file was uploaded names it and
 *   still reads it: it is still rendering (the provider fetches the signed
 *   link, and the kept copy is made after the task is created), or it finished
 *   without a kept copy of the file (each run start copies its inputs into
 *   `generation_inputs`, recording the file as the copy's `sourceStoragePath`;
 *   a creation with no kept inputs at all reads the file itself). Every such
 *   creation is asked, not only the canvas's runs': a duplicate canvas deleted
 *   before this one made some too.
 * Shares and templates never name it: a share drops every input's file and a
 * template publish copies its fixed inputs into its own bucket.
 *
 * Only `workflow-input-` files in the account's own folder are ever removed: a
 * creation's output shown on the canvas belongs to the creation. Every read is
 * paged until a page comes back empty, since PostgREST answers at most its
 * max_rows a request without saying so; a read that fails removes nothing.
 */

const WORKFLOW_UPLOAD_BUCKETS = ['generated_images', 'generated_videos', 'generated_audio'] as const;
const WORKFLOW_INPUT_FILE_PREFIX = 'workflow-input-';
const RENDERED_STATUSES = new Set(['succeeded', 'failed']);
/** Rows a page asks for; reading goes on until a page comes back empty. */
const PAGE_SIZE = 500;
/** Creation ids a kept-input read filters on at once, to keep its URL short. */
const ID_CHUNK = 100;
/** A creation is asked about a file from a day before the file was written: clocks differ. */
const UPLOAD_CLOCK_MARGIN_MS = 24 * 60 * 60 * 1000;

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

type Page<T> = { data: T[] | null; error: unknown };

/**
 * Every row a keyset-paged read finds: page after page, ordered by `id` and
 * picked up after the last id read, until a page comes back empty. A page
 * shorter than asked for is no end: PostgREST cuts a page to its max_rows
 * without an error.
 */
async function readEveryPage<T extends { id: string }>(
  read: (afterId: string | null) => PromiseLike<Page<T>>,
  what: string,
): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { data, error } = await read(afterId);
    if (error) throw Object.assign(new Error(`Could not read ${what}.`), { cause: error });
    const page = data ?? [];
    if (page.length === 0) return rows;
    const lastId = page[page.length - 1].id;
    if (afterId !== null && !(lastId > afterId)) throw new Error(`Paging ${what} did not move on.`);
    rows.push(...page);
    afterId = lastId;
  }
}

/**
 * When each file was written, from Storage. A file already gone is left out
 * (there is nothing to remove); any other failure throws, and keeps them all.
 */
async function readUploadTimes(
  client: SupabaseClient,
  uploads: WorkflowInputUpload[],
): Promise<Map<WorkflowInputUpload, number>> {
  const times = new Map<WorkflowInputUpload, number>();
  for (const upload of uploads) {
    const { data, error } = await client.storage.from(upload.bucket).info(upload.filePath);
    if (error || !data) {
      const failure = error as { statusCode?: string; status?: number; message?: string } | null;
      if (failure?.statusCode === '404' || failure?.status === 404 || /not found/i.test(failure?.message ?? '')) continue;
      throw Object.assign(new Error('Could not describe an input file.'), { cause: error });
    }
    const writtenAt = Date.parse(String((data as { createdAt?: string }).createdAt ?? ''));
    if (!Number.isFinite(writtenAt)) throw new Error('An input file has no creation time.');
    times.set(upload, writtenAt);
  }
  return times;
}

async function findStillReadUploads(
  client: SupabaseClient,
  userId: string,
  uploads: WorkflowInputUpload[],
  uploadTimes: Map<WorkflowInputUpload, number>,
): Promise<Set<string>> {
  const kept = new Set<string>();

  const canvases = await readEveryPage<{ id: string; graph: unknown }>((afterId) => {
    let query = client.from('workflow_canvases').select('id, graph').eq('user_id', userId)
      .order('id', { ascending: true }).limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query;
  }, "the account's canvases");
  const serializedCanvases = canvases.map((canvas) => JSON.stringify(canvas.graph ?? null));
  for (const upload of uploads) {
    if (serializedCanvases.some((serialized) => namesUpload(serialized, upload))) kept.add(upload.storagePath);
  }

  const asked = uploads.filter((upload) => !kept.has(upload.storagePath));
  if (asked.length === 0) return kept;
  const since = new Date(Math.min(...asked.map((upload) => uploadTimes.get(upload)!)) - UPLOAD_CLOCK_MARGIN_MS).toISOString();
  const generations = await readEveryPage<{ id: string; status: string | null; workflow_settings: unknown }>((afterId) => {
    let query = client.from('generations').select('id, status, workflow_settings').eq('user_id', userId)
      .gte('created_at', since).order('id', { ascending: true }).limit(PAGE_SIZE);
    if (afterId) query = query.gt('id', afterId);
    return query;
  }, "the account's creations");
  const naming = generations
    .map((generation) => ({ generation, serialized: JSON.stringify(generation.workflow_settings ?? null) }))
    .filter(({ serialized }) => asked.some((upload) => namesUpload(serialized, upload)));

  const copiedSources = new Map<string, Set<string>>();
  const namingIds = naming.map(({ generation }) => generation.id);
  for (let start = 0; start < namingIds.length; start += ID_CHUNK) {
    const chunk = namingIds.slice(start, start + ID_CHUNK);
    const copies = await readEveryPage<{ id: string; generation_id: string; metadata: Record<string, unknown> | null }>((afterId) => {
      let query = client.from('generation_input_media').select('id, generation_id, metadata').in('generation_id', chunk)
        .order('id', { ascending: true }).limit(PAGE_SIZE);
      if (afterId) query = query.gt('id', afterId);
      return query;
    }, "the creations' kept inputs");
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
  }

  for (const upload of asked) {
    for (const { generation, serialized } of naming) {
      if (!namesUpload(serialized, upload)) continue;
      const rendering = !RENDERED_STATUSES.has(generation.status ?? '');
      const copied = copiedSources.get(generation.id)?.has(upload.storagePath) ?? false;
      if (rendering || !copied) kept.add(upload.storagePath);
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
  }: {
    userId: string;
    canvasId: string;
    uploads: WorkflowInputUpload[];
  },
): Promise<void> {
  if (uploads.length === 0) return;

  let kept: Set<string>;
  let present: WorkflowInputUpload[];
  try {
    const uploadTimes = await readUploadTimes(client, uploads);
    present = uploads.filter((upload) => uploadTimes.has(upload));
    kept = present.length === 0 ? new Set() : await findStillReadUploads(client, userId, present, uploadTimes);
  } catch (error) {
    logBackendWarning('workflow_upload_cleanup_skipped', { canvasId, error });
    return;
  }

  const byBucket = new Map<string, string[]>();
  for (const upload of present) {
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
