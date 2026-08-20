import 'server-only';

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolvePostResourceStorageLocation } from '@/lib/viewer-unlock-file-url-service';

const RETAINED_BUCKET = 'post_resource_files';

type PurchasedRevisionRetentionRow = {
  revision_id: string;
  bundle_id: string;
  post_id: string | null;
  generation_id: string | null;
  allow_remix: boolean;
  attachments: unknown;
  resource_items: unknown;
};

type GenerationInputRow = {
  id: string;
  generation_id: string;
  media_type: 'image' | 'video' | 'audio';
  role: string;
  label: string | null;
  storage_path: string;
  sort_order: number | null;
};

type RetainedMappingRow = {
  revision_id: string;
  source_bucket: string;
  source_path: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function storagePathsFromJson(value: unknown): string[] {
  return jsonArray(value)
    .map((item) => typeof item.storagePath === 'string' ? item.storagePath : '')
    .filter(Boolean);
}

function retainedPathFor(revisionId: string, sourceBucket: string, sourcePath: string): string {
  const digest = createHash('sha256')
    .update(`${sourceBucket}:${sourcePath}`)
    .digest('hex')
    .slice(0, 24);
  const sourceName = sourcePath.split('/').pop() || 'resource-file';
  const safeName = sourceName
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-120) || 'resource-file';
  return `retained/${revisionId}/${digest}-${safeName}`;
}

function generationReferenceType(mediaType: GenerationInputRow['media_type']) {
  if (mediaType === 'image') return 'reference_image';
  if (mediaType === 'audio') return 'reference_audio';
  return 'reference_video';
}

function generationReferenceRole(role: string) {
  if (role === 'character_image') return 'character_reference';
  if (role === 'start_frame' || role === 'end_frame') return 'before_input';
  if (role === 'reference_video' || role === 'reference_audio' || role === 'motion_reference_video') {
    return 'supporting_workflow';
  }
  return 'style_reference';
}

function generationReferenceContentType(mediaType: GenerationInputRow['media_type']) {
  if (mediaType === 'image') return 'image/*';
  if (mediaType === 'audio') return 'audio/*';
  return 'video/*';
}

function buildLegacySupplementItems(
  rows: GenerationInputRow[],
  existingStoragePaths: Set<string>,
) {
  return rows
    .filter((row) => row.storage_path && !existingStoragePaths.has(row.storage_path))
    .sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0))
    .map((row, index) => ({
      id: `retained-generation-reference-${row.id}`,
      scope: { kind: 'all' },
      type: generationReferenceType(row.media_type),
      role: generationReferenceRole(row.role),
      sectionId: null,
      title: row.label?.trim() || `Reference ${index + 1}`,
      description: null,
      textContent: null,
      externalUrl: null,
      storagePath: row.storage_path,
      contentType: generationReferenceContentType(row.media_type),
      sizeBytes: null,
      workflowSnapshot: null,
      sortOrder: index,
      isPrimary: index === 0,
      remixUse: 'reference_only',
    }));
}

async function copyOrConfirmExisting(
  admin: SupabaseClient,
  sourceBucket: string,
  sourcePath: string,
  retainedPath: string,
) {
  const sourceStorage = admin.storage.from(sourceBucket);
  const { error: copyError } = await sourceStorage.copy(sourcePath, retainedPath, {
    destinationBucket: RETAINED_BUCKET,
  });

  if (!copyError) return;

  const { data: existing, error: infoError } = await admin.storage
    .from(RETAINED_BUCKET)
    .info(retainedPath);
  if (!infoError && existing) return;

  throw new Error(`Could not retain purchased resource ${sourceBucket}/${sourcePath}.`);
}

/**
 * Copies every platform-managed object referenced by a creator's purchased
 * revisions into a neutral prefix. Any failure aborts before source storage or
 * Auth is deleted; completed copies and mappings make the next retry cheap and
 * idempotent.
 */
export async function retainPurchasedUnlockFiles(
  admin: SupabaseClient,
  creatorUserId: string,
): Promise<{ revisionsRetained: number; filesRetained: number }> {
  const { data, error } = await admin.rpc('list_creator_purchased_revisions_for_retention', {
    p_creator_user_id: creatorUserId,
  });
  if (error) throw new Error('Could not enumerate purchased unlock revisions.');

  const revisions = (data ?? []) as PurchasedRevisionRetentionRow[];
  if (revisions.length === 0) return { revisionsRetained: 0, filesRetained: 0 };

  const revisionIds = revisions.map((revision) => revision.revision_id);
  const generationIds = [...new Set(
    revisions
      .filter((revision) => revision.allow_remix)
      .map((revision) => revision.generation_id)
      .filter((value): value is string => Boolean(value)),
  )];

  const [{ data: existingSupplementData, error: supplementLoadError }, generationResult] = await Promise.all([
    admin
      .from('post_resource_bundle_revision_supplements')
      .select('revision_id, resource_items')
      .in('revision_id', revisionIds),
    generationIds.length > 0
      ? admin
          .from('generation_input_media')
          .select('id, generation_id, media_type, role, label, storage_path, sort_order')
          .eq('user_id', creatorUserId)
          .in('generation_id', generationIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (supplementLoadError) throw new Error('Could not inspect retained revision supplements.');
  if (generationResult.error) throw new Error('Could not inspect legacy generation references.');

  const supplements = new Map<string, Record<string, unknown>[]>(
    ((existingSupplementData ?? []) as Array<{ revision_id: string; resource_items: unknown }>)
      .map((row) => [row.revision_id, jsonArray(row.resource_items)]),
  );
  const generationRows = (generationResult.data ?? []) as GenerationInputRow[];

  for (const revision of revisions) {
    if (supplements.has(revision.revision_id) || !revision.allow_remix || !revision.generation_id) {
      continue;
    }

    const existingPaths = new Set([
      ...storagePathsFromJson(revision.attachments),
      ...storagePathsFromJson(revision.resource_items),
    ]);
    const items = buildLegacySupplementItems(
      generationRows.filter((row) => row.generation_id === revision.generation_id),
      existingPaths,
    );
    if (items.length === 0) continue;

    const { error: supplementWriteError } = await admin
      .from('post_resource_bundle_revision_supplements')
      .upsert({ revision_id: revision.revision_id, resource_items: items }, { onConflict: 'revision_id' });
    if (supplementWriteError) throw new Error('Could not preserve legacy generation references.');
    supplements.set(revision.revision_id, items);
  }

  const { data: mappingData, error: mappingLoadError } = await admin
    .from('post_resource_bundle_revision_files')
    .select('revision_id, source_bucket, source_path')
    .in('revision_id', revisionIds);
  if (mappingLoadError) throw new Error('Could not inspect retained resource mappings.');

  const existingMappings = new Set(
    ((mappingData ?? []) as RetainedMappingRow[])
      .map((row) => `${row.revision_id}:${row.source_bucket}:${row.source_path}`),
  );
  let filesRetained = 0;

  for (const revision of revisions) {
    const resourcePaths = [...new Set([
      ...storagePathsFromJson(revision.attachments),
      ...storagePathsFromJson(revision.resource_items),
      ...storagePathsFromJson(supplements.get(revision.revision_id) ?? []),
    ])];

    for (const resourcePath of resourcePaths) {
      const source = resolvePostResourceStorageLocation(resourcePath, creatorUserId);
      if (!source) {
        throw new Error('Could not retain purchased resource with an invalid storage path.');
      }
      const mappingIdentity = `${revision.revision_id}:${source.bucket}:${source.filePath}`;
      if (existingMappings.has(mappingIdentity)) continue;

      const retainedPath = retainedPathFor(
        revision.revision_id,
        source.bucket,
        source.filePath,
      );
      await copyOrConfirmExisting(admin, source.bucket, source.filePath, retainedPath);

      const { error: mappingWriteError } = await admin
        .from('post_resource_bundle_revision_files')
        .upsert({
          revision_id: revision.revision_id,
          source_bucket: source.bucket,
          source_path: source.filePath,
          retained_bucket: RETAINED_BUCKET,
          retained_path: retainedPath,
        }, { onConflict: 'revision_id,source_bucket,source_path' });
      if (mappingWriteError) throw new Error('Could not record retained resource mapping.');

      existingMappings.add(mappingIdentity);
      filesRetained += 1;
    }
  }

  return { revisionsRetained: revisions.length, filesRetained };
}
