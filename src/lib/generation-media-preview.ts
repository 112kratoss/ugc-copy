import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { spawn } from 'child_process';

import type { SupabaseClient } from '@supabase/supabase-js';
import ffmpegStaticPath from 'ffmpeg-static';
import sharp from 'sharp';

import { getMediaContentHash, getPreviewThumbhash } from '@/lib/media-preview-metadata';

const PREVIEW_MAX_SIZE = 720;

export function buildGenerationPreviewPath(storagePath: string, contentHash: string) {
  const normalized = storagePath.replace(/^\/+/, '');
  const extensionIndex = normalized.lastIndexOf('.');
  const slashIndex = normalized.lastIndexOf('/');
  const basePath = extensionIndex > slashIndex
    ? normalized.slice(0, extensionIndex)
    : normalized;
  return `${basePath}.preview.${contentHash}.webp`;
}

export function isImageGenerationPreview(category: string | null | undefined, contentType: string | null | undefined) {
  return category === 'image' || contentType?.startsWith('image/');
}

export function isVideoGenerationPreview(category: string | null | undefined, contentType: string | null | undefined) {
  return category === 'video' || category === 'motion' || contentType?.startsWith('video/');
}

export async function createGenerationOutputPreview({
  body,
  category,
  contentType,
  storagePath,
  supabase,
}: {
  body: Blob;
  category: string | null | undefined;
  contentType: string | null | undefined;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const resolvedContentType = contentType || body.type || null;
  if (isImageGenerationPreview(category, resolvedContentType)) {
    return createGenerationImagePreview({ body, storagePath, supabase });
  }

  if (!isVideoGenerationPreview(category, resolvedContentType)) {
    return null;
  }

  return createGenerationVideoPoster({
    body,
    storagePath,
    supabase,
  });
}

export async function createGenerationVideoPoster({
  body,
  storagePath,
  supabase,
}: {
  body: Blob;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const poster = await createVideoPosterBuffer(body);
  return uploadGenerationPreview({ preview: poster, storagePath, supabase });
}

async function createGenerationImagePreview({
  body,
  storagePath,
  supabase,
}: {
  body: Blob;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const input = Buffer.from(await body.arrayBuffer());
  const preview = await sharp(input)
    .rotate()
    .resize({
      width: PREVIEW_MAX_SIZE,
      height: PREVIEW_MAX_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 72 })
    .toBuffer();

  return uploadGenerationPreview({ preview, storagePath, supabase });
}

async function uploadGenerationPreview({
  preview,
  storagePath,
  supabase,
}: {
  preview: Buffer;
  storagePath: string;
  supabase: SupabaseClient;
}) {
  const previewStoragePath = buildGenerationPreviewPath(storagePath, getMediaContentHash(preview));
  const location = getStorageLocation(previewStoragePath);
  if (!location) return null;

  const upload = await supabase.storage
    .from(location.bucket)
    .upload(location.filePath, preview, {
      cacheControl: '31536000',
      contentType: 'image/webp',
      upsert: true,
    });

  if (upload.error) {
    throw upload.error;
  }

  return {
    previewStoragePath,
    previewThumbhash: await getPreviewThumbhash(preview),
    previewStatus: 'ready' as const,
  };
}

export async function createVideoPosterBuffer(body: Blob) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'generation-poster-'));
  const inputPath = path.join(tempDir, 'input-video');
  const framePath = path.join(tempDir, 'frame.jpg');

  try {
    await writeFile(inputPath, Buffer.from(await body.arrayBuffer()));
    try {
      await runFfmpeg(inputPath, framePath, '00:00:01.000');
    } catch {
      await runFfmpeg(inputPath, framePath, '00:00:00.000');
    }

    const frame = await readFile(framePath);
    return sharp(frame)
      .rotate()
      .resize({
        width: PREVIEW_MAX_SIZE,
        height: PREVIEW_MAX_SIZE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 72 })
      .toBuffer();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runFfmpeg(inputPath: string, framePath: string, seekTime: string) {
  const ffmpegPath = getFfmpegPath();
  const args = [
    '-y',
    '-ss',
    seekTime,
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    framePath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr: Buffer[] = [];

    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code ?? 'unknown'}: ${Buffer.concat(stderr).toString('utf8')}`));
    });
  });
}

function getFfmpegPath() {
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH;
  }

  if (ffmpegStaticPath) return ffmpegStaticPath;

  return 'ffmpeg';
}

function getStorageLocation(storagePath: string) {
  const normalized = storagePath.replace(/^\/+/, '');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return null;
  }

  return {
    bucket: normalized.slice(0, slashIndex),
    filePath: normalized.slice(slashIndex + 1),
  };
}
