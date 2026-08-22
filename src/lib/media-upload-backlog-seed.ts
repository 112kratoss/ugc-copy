import type { SupabaseClient } from '@supabase/supabase-js';

import type { LegacyGenerationRow } from '@/lib/generation-input-media-repair';
import {
  extractUploadsPathsFromWorkflowSettings,
  LEGACY_GUARD_SCAN_LIMIT,
  MEDIA_UPLOAD_INTENTS_TABLE,
  normalizeUploadIntentPath,
} from '@/lib/media-upload-staging-paths';
import type { UploadIntentKind } from '@/lib/media-upload-reclaim';
import { iterateStorageObjectsV2 } from '@/lib/storage-list-v2';

/**
 * Seeds `media_upload_intents` rows for staged objects that predate the table.
 *
 * The reclaim sweep only sees objects with intent rows, so everything uploaded
 * before the tracking migration is invisible to it -- permanently. Rather than
 * writing a second deletion path that would need its own policy and its own
 * guard, this backfills the rows and lets the existing sweep collect them under
 * one policy, one guard, and one log.
 *
 * Categorisation is re-derived at run time, never hard-coded: the shape of the
 * backlog changes between when it is measured and when it is drained.
 */

const UPLOADS_BUCKET = 'uploads';
const GENERATION_INPUTS_BUCKET = 'generation_inputs';
const GENERATION_INPUT_MEDIA_TABLE = 'generation_input_media';
const STORAGE_PAGE_SIZE = 1000;

export type BacklogCategory =
  /** A durable copy already exists, so the staging object is redundant. */
  | 'durable_copy_exists'
  /** A generation with no durable rows still reads this file. */
  | 'legacy_generation_reference'
  /** Nothing references it -- an abandoned composer or pre-generation upload. */
  | 'unreferenced';

export type BacklogObject = {
  storagePath: string;
  sizeBytes: number | null;
  mimeType: string | null;
  createdAt: string | null;
};

export type CategorizedBacklogObject = BacklogObject & {
  category: BacklogCategory;
  kind: UploadIntentKind;
};

export type BacklogSeedPlan = {
  objects: CategorizedBacklogObject[];
  counts: Record<BacklogCategory, { objects: number; bytes: number }>;
  alreadyTracked: number;
  /**
   * Objects whose path does not start with a user id, so no intent row can be
   * written for them -- `user_id` is NOT NULL and references auth.users.
   *
   * These are survivors of a retired upload scheme that wrote to `images/...`
   * and `videos/...` at the bucket root. Reported rather than silently skipped:
   * they are real bytes that this system will never collect, so the operator
   * has to see them and decide.
   */
  unattributable: { objects: number; bytes: number; samplePaths: string[] };
};

/**
 * Staged objects are laid out as `{userId}/{uploadId}-{fileName}`. Anything else
 * predates that scheme and cannot be attributed to an owner from its path.
 */
const USER_SCOPED_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

export function isUserScopedStagedPath(storagePath: string): boolean {
  return USER_SCOPED_PATH.test(storagePath);
}

export type StorageDriftReport = {
  /** `generation_inputs` objects with no row pointing at them. */
  orphanedObjects: string[];
  /** Rows whose durable object is missing -- these block account deletion. */
  missingObjects: string[];
};

export function inferUploadIntentKind(mimeType: string | null, storagePath: string): UploadIntentKind {
  const normalized = (mimeType ?? '').toLowerCase();
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('image/')) return 'image';

  const extension = storagePath.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'webm', 'm4v'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'].includes(extension)) return 'audio';
  return 'image';
}

/**
 * Categorise one staged object.
 *
 * Legacy references win over durable copies: if any generation still reads the
 * file directly, it is load-bearing regardless of what else may have copied it.
 */
export function categorizeBacklogObject(
  object: BacklogObject,
  sets: { legacyReferenced: Set<string>; durableCopied: Set<string> },
): CategorizedBacklogObject {
  const category: BacklogCategory = sets.legacyReferenced.has(object.storagePath)
    ? 'legacy_generation_reference'
    : sets.durableCopied.has(object.storagePath)
      ? 'durable_copy_exists'
      : 'unreferenced';

  return {
    ...object,
    category,
    kind: inferUploadIntentKind(object.mimeType, object.storagePath),
  };
}

/**
 * How a category is seeded.
 *
 * Only `durable_copy_exists` is marked consumed, which makes it collectable by
 * the already-live consumed half of the sweep. Everything else is seeded
 * unconsumed so it stays behind the abandoned-reclaim gate: legacy references
 * are additionally held by the sweep's path guard until repair heals them, and
 * unreferenced objects wait for the mobile release that makes draft resume safe.
 */
export function getSeedConsumer(category: BacklogCategory): 'generation_input' | null {
  return category === 'durable_copy_exists' ? 'generation_input' : null;
}

async function listBucketObjects(
  client: SupabaseClient,
  bucket: string,
): Promise<BacklogObject[]> {
  const objects: BacklogObject[] = [];
  for await (const entry of iterateStorageObjectsV2(client, {
    bucket,
    pageSize: STORAGE_PAGE_SIZE,
  })) {
    const metadata = entry.metadata;
    objects.push({
      storagePath: entry.path,
      sizeBytes: typeof metadata?.size === 'number' ? metadata.size : null,
      mimeType: typeof metadata?.mimetype === 'string' ? metadata.mimetype : null,
      createdAt: entry.createdAt || null,
    });
  }
  return objects;
}

async function loadTrackedPaths(client: SupabaseClient): Promise<Set<string>> {
  const tracked = new Set<string>();
  for (let offset = 0; ; offset += STORAGE_PAGE_SIZE) {
    const { data, error } = await client
      .from(MEDIA_UPLOAD_INTENTS_TABLE)
      .select('storage_path')
      .range(offset, offset + STORAGE_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to read existing upload intents: ${error.message}`);
    }

    const rows = (data ?? []) as Array<{ storage_path: string }>;
    for (const row of rows) tracked.add(row.storage_path);
    if (rows.length < STORAGE_PAGE_SIZE) break;
  }

  return tracked;
}

/**
 * Staged paths a durable `generation_input_media` row was copied from.
 *
 * Persist records the source path in row metadata, so this is a direct statement
 * that the bytes were copied out -- far more reliable than re-deriving which
 * generations "look" durable.
 */
async function loadDurableCopiedPaths(
  client: SupabaseClient,
): Promise<{ copied: Set<string>; rowStoragePaths: Set<string> }> {
  const copied = new Set<string>();
  const rowStoragePaths = new Set<string>();

  for (let offset = 0; ; offset += STORAGE_PAGE_SIZE) {
    const { data, error } = await client
      .from(GENERATION_INPUT_MEDIA_TABLE)
      .select('storage_path, metadata')
      .range(offset, offset + STORAGE_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to read durable generation input media: ${error.message}`);
    }

    const rows = (data ?? []) as Array<{ storage_path: string; metadata: Record<string, unknown> | null }>;
    for (const row of rows) {
      if (row.storage_path) rowStoragePaths.add(row.storage_path);
      const source = row.metadata?.sourceStoragePath;
      if (typeof source === 'string' && source.includes('uploads/')) {
        copied.add(normalizeUploadIntentPath(source));
      }
    }

    if (rows.length < STORAGE_PAGE_SIZE) break;
  }

  return { copied, rowStoragePaths };
}

async function loadLegacyReferencedPaths(client: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await client.rpc('list_generations_missing_durable_input_media', {
    p_limit: LEGACY_GUARD_SCAN_LIMIT,
    p_max_attempts: null,
    p_created_before: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to list legacy-only generations: ${error.message}`);
  }

  const rows = (data ?? []) as LegacyGenerationRow[];
  if (rows.length >= LEGACY_GUARD_SCAN_LIMIT) {
    // Seeding on a truncated view would mark load-bearing files as collectable.
    throw new Error('Legacy generation scan was truncated; raise the scan limit before seeding.');
  }

  const referenced = new Set<string>();
  for (const row of rows) {
    for (const storagePath of extractUploadsPathsFromWorkflowSettings(row.workflow_settings)) {
      referenced.add(storagePath);
    }
  }

  return referenced;
}

function emptyCounts(): BacklogSeedPlan['counts'] {
  return {
    durable_copy_exists: { objects: 0, bytes: 0 },
    legacy_generation_reference: { objects: 0, bytes: 0 },
    unreferenced: { objects: 0, bytes: 0 },
  };
}

export async function buildBacklogSeedPlan(client: SupabaseClient): Promise<BacklogSeedPlan> {
  const [objects, tracked, durable, legacyReferenced] = await Promise.all([
    listBucketObjects(client, UPLOADS_BUCKET),
    loadTrackedPaths(client),
    loadDurableCopiedPaths(client),
    loadLegacyReferencedPaths(client),
  ]);

  const untracked = objects.filter((object) => !tracked.has(object.storagePath));
  const seedable = untracked.filter((object) => isUserScopedStagedPath(object.storagePath));
  const unattributable = untracked.filter((object) => !isUserScopedStagedPath(object.storagePath));

  const categorized = seedable.map((object) => categorizeBacklogObject(object, {
    legacyReferenced,
    durableCopied: durable.copied,
  }));

  const counts = emptyCounts();
  for (const object of categorized) {
    counts[object.category].objects += 1;
    counts[object.category].bytes += object.sizeBytes ?? 0;
  }

  return {
    objects: categorized,
    counts,
    alreadyTracked: objects.length - untracked.length,
    unattributable: {
      objects: unattributable.length,
      bytes: unattributable.reduce((total, object) => total + (object.sizeBytes ?? 0), 0),
      samplePaths: unattributable.slice(0, 5).map((object) => object.storagePath),
    },
  };
}

/**
 * Report both directions of durable-copy drift.
 *
 * Never deletes: `missingObjects` is the state that makes account deletion throw
 * (`retainPurchasedUnlockFiles` copies every row's object and aborts if one is
 * gone), and `orphanedObjects` is storage nothing can reach. Both are worth
 * seeing before they become an incident, and neither is safe to fix blindly.
 */
export async function buildStorageDriftReport(client: SupabaseClient): Promise<StorageDriftReport> {
  const [objects, durable] = await Promise.all([
    listBucketObjects(client, GENERATION_INPUTS_BUCKET),
    loadDurableCopiedPaths(client),
  ]);

  const objectPaths = new Set(objects.map((object) => `${GENERATION_INPUTS_BUCKET}/${object.storagePath}`));

  return {
    orphanedObjects: Array.from(objectPaths).filter((path) => !durable.rowStoragePaths.has(path)).sort(),
    missingObjects: Array.from(durable.rowStoragePaths)
      .filter((path) => path.startsWith(`${GENERATION_INPUTS_BUCKET}/`) && !objectPaths.has(path))
      .sort(),
  };
}

export function buildIntentSeedRow(object: CategorizedBacklogObject, userIdFallback?: string) {
  const consumer = getSeedConsumer(object.category);
  // The bucket lays objects out as `{userId}/{uploadId}-{fileName}`.
  const userId = object.storagePath.split('/')[0] || userIdFallback || '';
  const seededAt = object.createdAt ?? new Date().toISOString();

  return {
    user_id: userId,
    storage_path: object.storagePath,
    kind: object.kind,
    content_type: object.mimeType,
    declared_bytes: object.sizeBytes,
    // The object's own storage timestamp, so the 48h reclaim window is measured
    // from when the upload really happened rather than from the backfill.
    created_at: seededAt,
    consumed_at: consumer ? seededAt : null,
    consumed_by: consumer,
    storage_cleared_at: null,
  };
}

export async function seedBacklogIntents(
  client: SupabaseClient,
  objects: CategorizedBacklogObject[],
): Promise<{ inserted: number }> {
  if (objects.length === 0) {
    return { inserted: 0 };
  }

  let inserted = 0;
  const batchSize = 200;
  for (let index = 0; index < objects.length; index += batchSize) {
    const batch = objects.slice(index, index + batchSize).map((object) => buildIntentSeedRow(object));
    const { error } = await client
      .from(MEDIA_UPLOAD_INTENTS_TABLE)
      // A re-run must be harmless; storage_path is unique, so an object seeded
      // by an earlier run is simply left alone.
      .upsert(batch, { onConflict: 'storage_path', ignoreDuplicates: true });

    if (error) {
      throw new Error(`Failed to seed upload intents: ${error.message}`);
    }

    inserted += batch.length;
  }

  return { inserted };
}
