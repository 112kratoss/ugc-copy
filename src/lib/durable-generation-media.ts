import 'server-only';

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getStoredMediaLocation, type MediaBucket } from '@/lib/media-urls';
import { isAudioModel, isImageModel } from '@/lib/models';
import { openAllowlistedRemoteMedia } from '@/lib/remote-media-security';
import { isStorageObjectOwnedByUser } from '@/lib/storage-ownership';

export type GeneratedMediaBucket = Extract<MediaBucket, 'generated_images' | 'generated_videos' | 'generated_audio'>;
export type GenerationMediaKind = 'image' | 'video' | 'audio';

export interface DurableGenerationMediaRecord {
  id: string;
  userId: string;
  model: string;
  category: string | null;
  outputUrl: string | null;
  showcaseAssetPath?: string | null;
}

export interface CreatedGenerationMediaLocation {
  bucket: GeneratedMediaBucket;
  filePath: string;
}

function isGeneratedMediaBucket(bucket: MediaBucket): bucket is GeneratedMediaBucket {
  return bucket === 'generated_images' || bucket === 'generated_videos' || bucket === 'generated_audio';
}

export function getGenerationMediaKind(
  generation: Pick<DurableGenerationMediaRecord, 'category' | 'model'>
): GenerationMediaKind {
  if (generation.category === 'audio' || isAudioModel(generation.model)) {
    return 'audio';
  }

  if (generation.category === 'image' || isImageModel(generation.model)) {
    return 'image';
  }

  return 'video';
}

export function getGenerationMediaBucket(
  generation: Pick<DurableGenerationMediaRecord, 'category' | 'model'>
): GeneratedMediaBucket {
  const kind = getGenerationMediaKind(generation);
  if (kind === 'audio') {
    return 'generated_audio';
  }

  if (kind === 'image') {
    return 'generated_images';
  }

  return 'generated_videos';
}

export function isCompatibleGenerationMediaType(
  generation: Pick<DurableGenerationMediaRecord, 'category' | 'model'>,
  contentType: string
): boolean {
  const kind = getGenerationMediaKind(generation);
  return contentType.toLowerCase().startsWith(`${kind}/`);
}

function inferExtension(sourceName: string, contentType: string, kind: GenerationMediaKind): string {
  const normalizedContentType = contentType.toLowerCase();
  if (normalizedContentType.includes('png')) return 'png';
  if (normalizedContentType.includes('jpeg') || normalizedContentType.includes('jpg')) return 'jpg';
  if (normalizedContentType.includes('webp')) return 'webp';
  if (normalizedContentType.includes('gif')) return 'gif';
  if (normalizedContentType.includes('quicktime')) return 'mov';
  if (normalizedContentType.includes('webm')) return 'webm';
  if (normalizedContentType.includes('mp4')) return 'mp4';
  if (normalizedContentType.includes('mpeg') || normalizedContentType.includes('mp3')) return 'mp3';
  if (normalizedContentType.includes('wav') || normalizedContentType.includes('wave')) return 'wav';
  if (normalizedContentType.includes('ogg')) return 'ogg';
  if (normalizedContentType.includes('flac')) return 'flac';

  const extension = path.extname(sourceName).replace('.', '').toLowerCase();
  if (/^[a-z0-9]{2,8}$/.test(extension)) {
    return extension;
  }

  if (kind === 'image') return 'jpg';
  if (kind === 'audio') return 'mp3';
  return 'mp4';
}

function inferContentType(sourceName: string, kind: GenerationMediaKind): string {
  const extension = path.extname(sourceName).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.webm') return kind === 'audio' ? 'audio/webm' : 'video/webm';
  if (extension === '.mp4' || extension === '.m4v') return kind === 'audio' ? 'audio/mp4' : 'video/mp4';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.ogg') return 'audio/ogg';
  if (kind === 'image') return 'image/jpeg';
  if (kind === 'audio') return 'audio/mpeg';
  return 'video/mp4';
}

async function persistGenerationMediaBody(params: {
  supabase: SupabaseClient;
  generation: Pick<DurableGenerationMediaRecord, 'id' | 'userId' | 'model' | 'category'>;
  body: Blob | ReadableStream<Uint8Array>;
  sourceName: string;
  contentType?: string | null;
}): Promise<{
  outputUrl: string;
  createdLocation: CreatedGenerationMediaLocation;
}> {
  const bucket = getGenerationMediaBucket(params.generation);
  const kind = getGenerationMediaKind(params.generation);
  const contentType = params.contentType
    || (params.body instanceof Blob ? params.body.type : '')
    || inferContentType(params.sourceName, kind);
  const extension = inferExtension(params.sourceName, contentType, kind);
  const filePath = `${params.generation.userId}/restored_${params.generation.id}_${randomUUID()}.${extension}`;
  const { error } = await params.supabase.storage
    .from(bucket)
    .upload(filePath, params.body, {
      contentType,
      upsert: false,
    });

  if (error) {
    throw new Error(`Failed to store private generation media: ${error.message}`);
  }

  return {
    outputUrl: `${bucket}/${filePath}`,
    createdLocation: {
      bucket,
      filePath,
    },
  };
}

export async function persistGenerationMediaBlob(params: {
  supabase: SupabaseClient;
  generation: Pick<DurableGenerationMediaRecord, 'id' | 'userId' | 'model' | 'category'>;
  blob: Blob;
  sourceName: string;
  contentType?: string | null;
}): Promise<{
  outputUrl: string;
  createdLocation: CreatedGenerationMediaLocation;
}> {
  return persistGenerationMediaBody({
    ...params,
    body: params.blob,
  });
}

async function loadShowcaseDerivative(
  supabase: SupabaseClient,
  showcaseAssetPath: string,
  generationId: string,
  kind: GenerationMediaKind,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; sourceName: string } | null> {
  if (!showcaseAssetPath.startsWith(`showcase/${generationId}/`)) {
    return null;
  }
  const { data, error } = await supabase.storage
    .from('showcase_media')
    .download(showcaseAssetPath)
    .asStream();

  if (error || !data) {
    return null;
  }

  return {
    body: data,
    contentType: inferContentType(showcaseAssetPath, kind),
    sourceName: path.basename(showcaseAssetPath),
  };
}

async function loadOutputSource(
  supabase: SupabaseClient,
  outputUrl: string,
  userId: string,
  kind: GenerationMediaKind,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; sourceName: string } | null> {
  const sourceName = path.basename(outputUrl);
  const storedLocation = getStoredMediaLocation(outputUrl);
  if (storedLocation) {
    if (!isStorageObjectOwnedByUser(storedLocation.filePath, userId)) {
      return null;
    }
    const { data, error } = await supabase.storage
      .from(storedLocation.bucket)
      .download(storedLocation.filePath)
      .asStream();

    if (error || !data) {
      return null;
    }

    return {
      body: data,
      contentType: inferContentType(storedLocation.filePath, kind),
      sourceName: path.basename(storedLocation.filePath),
    };
  }

  if (!outputUrl.startsWith('http')) {
    return null;
  }

  try {
    const media = await openAllowlistedRemoteMedia({ url: outputUrl, kind });
    return {
      body: media.body,
      contentType: media.contentType,
      sourceName: media.sourceName || sourceName,
    };
  } catch {
    return null;
  }
}

export async function ensureDurableGenerationMedia(params: {
  supabase: SupabaseClient;
  generation: DurableGenerationMediaRecord;
}): Promise<{
  outputUrl: string;
  createdLocation: CreatedGenerationMediaLocation | null;
}> {
  const existingLocation = params.generation.outputUrl
    ? getStoredMediaLocation(params.generation.outputUrl)
    : null;

  if (
    existingLocation
    && isGeneratedMediaBucket(existingLocation.bucket)
    && isStorageObjectOwnedByUser(existingLocation.filePath, params.generation.userId)
  ) {
    return {
      outputUrl: params.generation.outputUrl!,
      createdLocation: null,
    };
  }

  const showcaseSource = params.generation.showcaseAssetPath
    ? await loadShowcaseDerivative(
        params.supabase,
        params.generation.showcaseAssetPath,
        params.generation.id,
        getGenerationMediaKind(params.generation),
      )
    : null;
  const source = showcaseSource ?? (
    params.generation.outputUrl
      ? await loadOutputSource(
          params.supabase,
          params.generation.outputUrl,
          params.generation.userId,
          getGenerationMediaKind(params.generation),
        )
      : null
  );

  if (!source) {
    throw new Error('Generation media could not be loaded from its showcase derivative or original source.');
  }

  return persistGenerationMediaBody({
    supabase: params.supabase,
    generation: params.generation,
    body: source.body,
    contentType: source.contentType,
    sourceName: source.sourceName,
  });
}
