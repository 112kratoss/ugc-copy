import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getUploadsBucketPath,
  isUploadsStoragePath,
  normalizeSubmittedElementDescriptors,
  type ImageElementDescriptor,
} from '@/lib/image-elements';
import { buildMediaProxyUrl, getStoredMediaLocation } from '@/lib/media-urls';
import { normalizeRemixMediaAssetDescriptor, type RemixMediaAssetDescriptor } from '@/lib/remix-source';
import type { SeedanceAssetCollections, SeedanceAssetMetadata } from '@/lib/seedance-assets';

const GENERATION_INPUTS_BUCKET = 'generation_inputs';

export type GenerationInputMediaType = 'image' | 'video' | 'audio';

type GenerationInputMediaRole =
  | 'reference_image'
  | 'start_frame'
  | 'end_frame'
  | 'reference_video'
  | 'reference_audio'
  | 'character_image'
  | 'motion_reference_video';

export interface GenerationInputMediaItem {
  id: string;
  generationId: string;
  mediaType: GenerationInputMediaType;
  role: GenerationInputMediaRole | string;
  label: string;
  url: string | null;
  storagePath: string | null;
  sourceGenerationId: string | null;
  sortOrder: number;
  metadata: Record<string, unknown>;
}

export interface PersistGenerationInputCandidate {
  mediaType: GenerationInputMediaType;
  role: GenerationInputMediaRole;
  label?: string | null;
  sourceUrl?: string | null;
  sourceStoragePath?: string | null;
  sourceGenerationId?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown> | null;
}

interface GenerationInputMediaRow {
  id: string;
  generation_id: string;
  user_id: string;
  media_type: GenerationInputMediaType;
  role: string;
  label: string | null;
  storage_path: string;
  source_generation_id: string | null;
  sort_order: number | null;
  metadata: Record<string, unknown> | null;
}

interface LegacyGenerationReference {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  output_url: string | null;
  showcase_asset_path?: string | null;
}

const INPUT_MEDIA_WORKFLOW_KEYS = new Set([
  'elements',
  'startFrame',
  'endFrame',
  'referenceImageUrls',
  'referenceVideoUrls',
  'referenceAudioUrls',
  'klingVideoElements',
  'seedanceAssets',
  'characterImage',
  'referenceVideo',
  'compiledPrompt',
  'promptMode',
]);

const STORAGE_BUCKETS = new Set([
  'uploads',
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
]);

function normalizeLabel(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || 'input';
}

function inferExtension(source: string | null | undefined, contentType: string | null | undefined, mediaType: GenerationInputMediaType): string {
  const normalizedContentType = contentType?.toLowerCase() ?? '';
  if (normalizedContentType.includes('png')) return 'png';
  if (normalizedContentType.includes('jpeg') || normalizedContentType.includes('jpg')) return 'jpg';
  if (normalizedContentType.includes('webp')) return 'webp';
  if (normalizedContentType.includes('gif')) return 'gif';
  if (normalizedContentType.includes('mp4')) return 'mp4';
  if (normalizedContentType.includes('quicktime')) return 'mov';
  if (normalizedContentType.includes('webm')) return 'webm';
  if (normalizedContentType.includes('mpeg') || normalizedContentType.includes('mp3')) return 'mp3';
  if (normalizedContentType.includes('wav') || normalizedContentType.includes('wave')) return 'wav';
  if (normalizedContentType.includes('ogg')) return 'ogg';
  if (normalizedContentType.includes('flac')) return 'flac';

  const rawSource = source ?? '';
  try {
    const pathname = rawSource.startsWith('http') ? new URL(rawSource).pathname : rawSource;
    const candidate = pathname.split('?')[0]?.split('.').pop()?.toLowerCase();
    if (candidate && /^[a-z0-9]{2,5}$/.test(candidate)) {
      return candidate;
    }
  } catch {
    // Fall through to media defaults.
  }

  if (mediaType === 'image') return 'jpg';
  if (mediaType === 'audio') return 'mp3';
  return 'mp4';
}

function normalizeStoragePath(value: string | null | undefined): { bucket: string; filePath: string } | null {
  if (!value) {
    return null;
  }

  const mediaLocation = getStoredMediaLocation(value);
  if (mediaLocation) {
    return mediaLocation;
  }

  if (isUploadsStoragePath(value)) {
    return {
      bucket: 'uploads',
      filePath: getUploadsBucketPath(value),
    };
  }

  const [bucket, ...pathParts] = value.split('/');
  const filePath = pathParts.join('/');
  if (bucket && filePath && STORAGE_BUCKETS.has(bucket)) {
    return { bucket, filePath };
  }

  return null;
}

function isFetchableUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

async function downloadCandidateBlob(
  supabase: SupabaseClient,
  candidate: PersistGenerationInputCandidate
): Promise<{ blob: Blob; sourceName: string | null } | null> {
  const storageLocation = normalizeStoragePath(candidate.sourceStoragePath);

  if (storageLocation) {
    try {
      const { data, error } = await supabase.storage
        .from(storageLocation.bucket)
        .download(storageLocation.filePath);

      if (!error && data) {
        return {
          blob: data,
          sourceName: storageLocation.filePath,
        };
      }
    } catch (error) {
      console.warn('Failed to download generation input from storage, falling back to URL:', error);
    }
  }

  if (!isFetchableUrl(candidate.sourceUrl)) {
    return null;
  }

  const response = await fetch(candidate.sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download input media: ${response.status}`);
  }

  return {
    blob: await response.blob(),
    sourceName: candidate.sourceUrl,
  };
}

export async function persistGenerationInputMedia(params: {
  supabase: SupabaseClient;
  generationId: string | null | undefined;
  userId: string;
  candidates: PersistGenerationInputCandidate[];
}) {
  const { supabase, generationId, userId } = params;
  const candidates = params.candidates.filter(
    (candidate) => candidate.sourceStoragePath || isFetchableUrl(candidate.sourceUrl)
  );

  if (!generationId || candidates.length === 0) {
    return;
  }

  for (const [index, candidate] of candidates.entries()) {
    try {
      const downloaded = await downloadCandidateBlob(supabase, candidate);
      if (!downloaded) {
        continue;
      }

      const sortOrder = candidate.sortOrder ?? index;
      const extension = inferExtension(
        candidate.sourceStoragePath ?? candidate.sourceUrl,
        downloaded.blob.type,
        candidate.mediaType
      );
      const roleSegment = sanitizePathSegment(candidate.role);
      const filePath = `${userId}/${generationId}/${String(sortOrder).padStart(2, '0')}-${roleSegment}.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from(GENERATION_INPUTS_BUCKET)
        .upload(filePath, downloaded.blob, {
          contentType: downloaded.blob.type || undefined,
          upsert: true,
        });

      if (uploadError) {
        throw uploadError;
      }

      const storagePath = `${GENERATION_INPUTS_BUCKET}/${filePath}`;
      const metadata = {
        ...(candidate.metadata ?? {}),
        sourceStoragePath: candidate.sourceStoragePath ?? null,
        sourceUrl: candidate.sourceUrl ?? null,
      };

      const { error: insertError } = await supabase
        .from('generation_input_media')
        .insert({
          generation_id: generationId,
          user_id: userId,
          media_type: candidate.mediaType,
          role: candidate.role,
          label: normalizeLabel(candidate.label, getDefaultInputLabel(candidate.role, sortOrder)),
          storage_path: storagePath,
          source_generation_id: candidate.sourceGenerationId ?? null,
          sort_order: sortOrder,
          metadata,
        });

      if (insertError) {
        throw insertError;
      }
    } catch (error) {
      console.error('Failed to persist generation input media:', error);
    }
  }
}

function getDefaultInputLabel(role: string, index: number): string {
  if (role === 'start_frame') return 'Start frame';
  if (role === 'end_frame') return 'End frame';
  if (role === 'reference_video') return 'Reference video';
  if (role === 'reference_audio') return 'Reference audio';
  if (role === 'character_image') return 'Character image';
  if (role === 'motion_reference_video') return 'Motion reference video';
  return `Reference image ${index + 1}`;
}

async function buildStoredInputUrl(
  supabase: SupabaseClient,
  storagePath: string,
  mode: 'proxy' | 'signed'
): Promise<string | null> {
  const location = getStoredMediaLocation(storagePath);
  if (!location) {
    return isFetchableUrl(storagePath) ? storagePath : null;
  }

  if (mode === 'proxy') {
    return buildMediaProxyUrl(location.bucket, location.filePath);
  }

  const { data, error } = await supabase.storage
    .from(location.bucket)
    .createSignedUrl(location.filePath, 3600);

  if (error || !data?.signedUrl) {
    console.error(`Failed to sign generation input ${storagePath}:`, error);
    return null;
  }

  return data.signedUrl;
}

function mapInputMediaRow(row: GenerationInputMediaRow, url: string | null): GenerationInputMediaItem {
  return {
    id: row.id,
    generationId: row.generation_id,
    mediaType: row.media_type,
    role: row.role,
    label: normalizeLabel(row.label, getDefaultInputLabel(row.role, row.sort_order ?? 0)),
    url,
    storagePath: row.storage_path,
    sourceGenerationId: row.source_generation_id,
    sortOrder: row.sort_order ?? 0,
    metadata: row.metadata ?? {},
  };
}

export async function loadGenerationInputMediaMap(params: {
  supabase: SupabaseClient;
  generationIds: string[];
  urlMode: 'proxy' | 'signed';
}): Promise<Map<string, GenerationInputMediaItem[]>> {
  const generationIds = Array.from(new Set(params.generationIds.filter(Boolean)));
  const inputMap = new Map<string, GenerationInputMediaItem[]>();

  if (generationIds.length === 0) {
    return inputMap;
  }

  try {
    const { data, error } = await params.supabase
      .from('generation_input_media')
      .select('id, generation_id, user_id, media_type, role, label, storage_path, source_generation_id, sort_order, metadata')
      .in('generation_id', generationIds)
      .order('sort_order', { ascending: true });

    if (error) {
      throw error;
    }

    for (const row of (data ?? []) as GenerationInputMediaRow[]) {
      const url = await buildStoredInputUrl(params.supabase, row.storage_path, params.urlMode);
      const item = mapInputMediaRow(row, url);
      const nextItems = inputMap.get(row.generation_id) ?? [];
      nextItems.push(item);
      inputMap.set(row.generation_id, nextItems);
    }
  } catch (error) {
    console.error('Failed to load generation input media:', error);
  }

  return inputMap;
}

async function resolveLegacyStorageUrl(
  supabase: SupabaseClient,
  storagePath: string
): Promise<string | null> {
  const location = normalizeStoragePath(storagePath);
  if (!location) {
    return isFetchableUrl(storagePath) ? storagePath : null;
  }

  const { data, error } = await supabase.storage
    .from(location.bucket)
    .createSignedUrl(location.filePath, 3600);

  if (error || !data?.signedUrl) {
    console.error(`Failed to sign legacy generation input ${storagePath}:`, error);
    return null;
  }

  return data.signedUrl;
}

async function resolveLegacySourceGenerationUrl(params: {
  supabase: SupabaseClient;
  sourceGenerationId: string;
  ownerUserId: string | null;
  cache: Map<string, Promise<LegacyGenerationReference | null>>;
}): Promise<string | null> {
  const { supabase, sourceGenerationId, ownerUserId, cache } = params;

  if (!cache.has(sourceGenerationId)) {
    cache.set(
      sourceGenerationId,
      (async () => {
        const { data, error } = await supabase
          .from('generations')
          .select('id, user_id, is_public, output_url, showcase_asset_path')
          .eq('id', sourceGenerationId)
          .maybeSingle();

          if (error) {
            console.error('Failed to load legacy source generation input:', error);
            return null;
          }

          return data as LegacyGenerationReference | null;
      })()
    );
  }

  const sourceGeneration = await cache.get(sourceGenerationId)!;
  if (
    !sourceGeneration?.output_url ||
    (sourceGeneration.user_id !== ownerUserId && !sourceGeneration.is_public)
  ) {
    return null;
  }

  return resolveLegacyStorageUrl(supabase, sourceGeneration.output_url);
}

function createLegacyInputItem(params: {
  generationId: string;
  mediaType: GenerationInputMediaType;
  role: GenerationInputMediaRole;
  label: string;
  url: string | null;
  storagePath?: string | null;
  sourceGenerationId?: string | null;
  sortOrder: number;
  metadata?: Record<string, unknown>;
}): GenerationInputMediaItem {
  return {
    id: `legacy-${params.generationId}-${params.role}-${params.sortOrder}`,
    generationId: params.generationId,
    mediaType: params.mediaType,
    role: params.role,
    label: params.label,
    url: params.url,
    storagePath: params.storagePath ?? null,
    sourceGenerationId: params.sourceGenerationId ?? null,
    sortOrder: params.sortOrder,
    metadata: {
      legacy: true,
      ...(params.metadata ?? {}),
    },
  };
}

function getSeedanceAssets(value: unknown): SeedanceAssetCollections | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as SeedanceAssetCollections;
}

function getSeedanceSourceUrl(asset: SeedanceAssetMetadata | undefined): string | null {
  return typeof asset?.sourceUrl === 'string' && asset.sourceUrl.trim() ? asset.sourceUrl : null;
}

async function resolveDescriptorLegacyItem(params: {
  supabase: SupabaseClient;
  generationId: string;
  ownerUserId: string | null;
  descriptor: RemixMediaAssetDescriptor | null;
  mediaType: GenerationInputMediaType;
  role: GenerationInputMediaRole;
  fallbackLabel: string;
  sortOrder: number;
  sourceGenerationCache: Map<string, Promise<LegacyGenerationReference | null>>;
}): Promise<GenerationInputMediaItem | null> {
  const { descriptor } = params;
  if (!descriptor) {
    return null;
  }

  let url: string | null = null;
  if (descriptor.storagePath) {
    url = await resolveLegacyStorageUrl(params.supabase, descriptor.storagePath);
  } else if (descriptor.sourceGenerationId) {
    url = await resolveLegacySourceGenerationUrl({
      supabase: params.supabase,
      sourceGenerationId: descriptor.sourceGenerationId,
      ownerUserId: params.ownerUserId,
      cache: params.sourceGenerationCache,
    });
  }

  return createLegacyInputItem({
    generationId: params.generationId,
    mediaType: params.mediaType,
    role: params.role,
    label: normalizeLabel(descriptor.label, params.fallbackLabel),
    url,
    storagePath: descriptor.storagePath ?? null,
    sourceGenerationId: descriptor.sourceGenerationId ?? null,
    sortOrder: params.sortOrder,
  });
}

export async function buildLegacyGenerationInputMedia(params: {
  supabase: SupabaseClient;
  generationId: string;
  ownerUserId: string | null;
  category: string | null;
  workflowSettings: Record<string, unknown>;
}): Promise<GenerationInputMediaItem[]> {
  const items: GenerationInputMediaItem[] = [];
  const sourceGenerationCache = new Map<string, Promise<LegacyGenerationReference | null>>();
  let sortOrder = 0;

  const pushElement = async (element: ImageElementDescriptor, index: number) => {
    let url: string | null = null;
    if (element.storagePath) {
      url = await resolveLegacyStorageUrl(params.supabase, element.storagePath);
    } else if (element.sourceGenerationId) {
      url = await resolveLegacySourceGenerationUrl({
        supabase: params.supabase,
        sourceGenerationId: element.sourceGenerationId,
        ownerUserId: params.ownerUserId,
        cache: sourceGenerationCache,
      });
    }

    items.push(createLegacyInputItem({
      generationId: params.generationId,
      mediaType: 'image',
      role: 'reference_image',
      label: normalizeLabel(element.displayName, `Reference image ${index + 1}`),
      url,
      storagePath: element.storagePath ?? null,
      sourceGenerationId: element.sourceGenerationId ?? null,
      sortOrder: sortOrder++,
      metadata: {
        id: element.id,
        displayName: element.displayName,
        handle: element.handle,
      },
    }));
  };

  for (const [index, element] of normalizeSubmittedElementDescriptors(params.workflowSettings.elements).entries()) {
    await pushElement(element, index);
  }

  const seedanceAssets = getSeedanceAssets(params.workflowSettings.seedanceAssets);
  for (const [index, asset] of (seedanceAssets?.images ?? []).entries()) {
    const sourceUrl = getSeedanceSourceUrl(asset);
    if (!sourceUrl || items.some((item) => item.url === sourceUrl || item.metadata.sourceUrl === sourceUrl)) {
      continue;
    }

    items.push(createLegacyInputItem({
      generationId: params.generationId,
      mediaType: 'image',
      role: 'reference_image',
      label: `Image reference ${index + 1}`,
      url: sourceUrl,
      sortOrder: sortOrder++,
      metadata: { seedanceAsset: asset, sourceUrl },
    }));
  }

  const startFrame = await resolveDescriptorLegacyItem({
    supabase: params.supabase,
    generationId: params.generationId,
    ownerUserId: params.ownerUserId,
    descriptor: normalizeRemixMediaAssetDescriptor(params.workflowSettings.startFrame, 'image'),
    mediaType: 'image',
    role: 'start_frame',
    fallbackLabel: 'Start frame',
    sortOrder: sortOrder++,
    sourceGenerationCache,
  });
  if (startFrame) items.push(startFrame);

  const endFrame = await resolveDescriptorLegacyItem({
    supabase: params.supabase,
    generationId: params.generationId,
    ownerUserId: params.ownerUserId,
    descriptor: normalizeRemixMediaAssetDescriptor(params.workflowSettings.endFrame, 'image'),
    mediaType: 'image',
    role: 'end_frame',
    fallbackLabel: 'End frame',
    sortOrder: sortOrder++,
    sourceGenerationCache,
  });
  if (endFrame) items.push(endFrame);

  for (const [index, asset] of (seedanceAssets?.videos ?? []).entries()) {
    const sourceUrl = getSeedanceSourceUrl(asset);
    if (!sourceUrl) continue;
    items.push(createLegacyInputItem({
      generationId: params.generationId,
      mediaType: 'video',
      role: 'reference_video',
      label: `Video reference ${index + 1}`,
      url: sourceUrl,
      sortOrder: sortOrder++,
      metadata: { seedanceAsset: asset, sourceUrl },
    }));
  }

  for (const [index, asset] of (seedanceAssets?.audios ?? []).entries()) {
    const sourceUrl = getSeedanceSourceUrl(asset);
    if (!sourceUrl) continue;
    items.push(createLegacyInputItem({
      generationId: params.generationId,
      mediaType: 'audio',
      role: 'reference_audio',
      label: `Audio reference ${index + 1}`,
      url: sourceUrl,
      sortOrder: sortOrder++,
      metadata: { seedanceAsset: asset, sourceUrl },
    }));
  }

  const characterImage = await resolveDescriptorLegacyItem({
    supabase: params.supabase,
    generationId: params.generationId,
    ownerUserId: params.ownerUserId,
    descriptor: normalizeRemixMediaAssetDescriptor(params.workflowSettings.characterImage, 'image'),
    mediaType: 'image',
    role: 'character_image',
    fallbackLabel: 'Character image',
    sortOrder: sortOrder++,
    sourceGenerationCache,
  });
  if (characterImage) items.push(characterImage);

  const referenceVideo = await resolveDescriptorLegacyItem({
    supabase: params.supabase,
    generationId: params.generationId,
    ownerUserId: params.ownerUserId,
    descriptor: normalizeRemixMediaAssetDescriptor(params.workflowSettings.referenceVideo, 'video'),
    mediaType: 'video',
    role: 'motion_reference_video',
    fallbackLabel: 'Motion reference video',
    sortOrder: sortOrder++,
    sourceGenerationCache,
  });
  if (referenceVideo) items.push(referenceVideo);

  return items;
}

export function sanitizeWorkflowSettingsForRemix(
  workflowSettings: Record<string, unknown>,
  includeInputMedia: boolean
): Record<string, unknown> {
  if (includeInputMedia) {
    return workflowSettings;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workflowSettings)) {
    if (!INPUT_MEDIA_WORKFLOW_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export function toRemixImageElement(item: GenerationInputMediaItem, index: number): ImageElementDescriptor & { url: string | null } {
  const metadata = item.metadata ?? {};
  const handle = typeof metadata.handle === 'string' && metadata.handle.trim()
    ? metadata.handle
    : `@reference_${index + 1}`;
  const displayName = normalizeLabel(
    typeof metadata.displayName === 'string' ? metadata.displayName : item.label,
    `Reference image ${index + 1}`
  );

  return {
    id: typeof metadata.id === 'string' && metadata.id ? metadata.id : item.id,
    displayName,
    handle,
    storagePath: item.storagePath,
    sourceGenerationId: item.sourceGenerationId,
    url: item.url,
  };
}

export function toRemixAssetDescriptor(item: GenerationInputMediaItem): RemixMediaAssetDescriptor & { url: string | null } {
  return {
    kind: item.mediaType,
    label: item.label,
    storagePath: item.storagePath,
    sourceGenerationId: item.sourceGenerationId,
    url: item.url,
  };
}

export function collectImageInputCandidates(params: {
  resolvedImageUrls: string[];
  elements: ImageElementDescriptor[];
}): PersistGenerationInputCandidate[] {
  return params.resolvedImageUrls.map((sourceUrl, index) => {
    const element = params.elements[index];
    return {
      mediaType: 'image',
      role: 'reference_image',
      label: element?.displayName ?? `Reference image ${index + 1}`,
      sourceUrl,
      sourceStoragePath: element?.storagePath ?? null,
      sourceGenerationId: element?.sourceGenerationId ?? null,
      sortOrder: index,
      metadata: element
        ? {
            id: element.id,
            displayName: element.displayName,
            handle: element.handle,
          }
        : null,
    };
  });
}

export function collectSeedanceAssetCandidates(params: {
  assets: SeedanceAssetCollections | null | undefined;
  offset?: number;
}): PersistGenerationInputCandidate[] {
  const offset = params.offset ?? 0;
  const candidates: PersistGenerationInputCandidate[] = [];
  let sortOrder = offset;

  for (const [index, asset] of (params.assets?.videos ?? []).entries()) {
    candidates.push({
      mediaType: 'video',
      role: 'reference_video',
      label: `Video reference ${index + 1}`,
      sourceUrl: getSeedanceSourceUrl(asset),
      sortOrder: sortOrder++,
      metadata: { seedanceAsset: asset },
    });
  }

  for (const [index, asset] of (params.assets?.audios ?? []).entries()) {
    candidates.push({
      mediaType: 'audio',
      role: 'reference_audio',
      label: `Audio reference ${index + 1}`,
      sourceUrl: getSeedanceSourceUrl(asset),
      sortOrder: sortOrder++,
      metadata: { seedanceAsset: asset },
    });
  }

  return candidates;
}
