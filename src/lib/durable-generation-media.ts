import 'server-only';

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getStoredMediaLocation, type MediaBucket } from '@/lib/media-urls';
import { isAudioModel, isImageModel } from '@/lib/models';

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
  const bucket = getGenerationMediaBucket(params.generation);
  const kind = getGenerationMediaKind(params.generation);
  const contentType = params.blob.type || params.contentType || '';
  const extension = inferExtension(params.sourceName, contentType, kind);
  const filePath = `${params.generation.userId}/restored_${params.generation.id}_${randomUUID()}.${extension}`;
  const { error } = await params.supabase.storage
    .from(bucket)
    .upload(filePath, params.blob, {
      contentType: contentType || undefined,
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

async function loadShowcaseDerivative(
  supabase: SupabaseClient,
  showcaseAssetPath: string
): Promise<{ blob: Blob; sourceName: string } | null> {
  const { data, error } = await supabase.storage
    .from('showcase_media')
    .download(showcaseAssetPath);

  if (error || !data) {
    return null;
  }

  return {
    blob: data,
    sourceName: path.basename(showcaseAssetPath),
  };
}

async function loadOutputSource(
  supabase: SupabaseClient,
  outputUrl: string
): Promise<{ blob: Blob; sourceName: string } | null> {
  const storedLocation = getStoredMediaLocation(outputUrl);
  if (storedLocation) {
    const { data, error } = await supabase.storage
      .from(storedLocation.bucket)
      .download(storedLocation.filePath);

    if (error || !data) {
      return null;
    }

    return {
      blob: data,
      sourceName: path.basename(storedLocation.filePath),
    };
  }

  if (!outputUrl.startsWith('http')) {
    return null;
  }

  const response = await fetch(outputUrl);
  if (!response.ok) {
    return null;
  }

  return {
    blob: await response.blob(),
    sourceName: path.basename(new URL(outputUrl).pathname) || 'generation-media',
  };
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

  if (existingLocation && isGeneratedMediaBucket(existingLocation.bucket)) {
    return {
      outputUrl: params.generation.outputUrl!,
      createdLocation: null,
    };
  }

  const showcaseSource = params.generation.showcaseAssetPath
    ? await loadShowcaseDerivative(params.supabase, params.generation.showcaseAssetPath)
    : null;
  const source = showcaseSource ?? (
    params.generation.outputUrl
      ? await loadOutputSource(params.supabase, params.generation.outputUrl)
      : null
  );

  if (!source) {
    throw new Error('Generation media could not be loaded from its showcase derivative or original source.');
  }

  return persistGenerationMediaBlob({
    supabase: params.supabase,
    generation: params.generation,
    blob: source.blob,
    sourceName: source.sourceName,
  });
}
