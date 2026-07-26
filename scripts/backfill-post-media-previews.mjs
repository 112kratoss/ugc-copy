import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import ffmpegStaticPath from 'ffmpeg-static';
import sharp from 'sharp';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
const PREVIEW_MAX_SIZE = 720;
const PAGE_SIZE = 100;
const dryRun = process.argv.includes('--dry-run');
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || 'ffmpeg';

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

function buildPreviewPath(storagePath) {
  const extensionIndex = storagePath.lastIndexOf('.');
  const basePath = extensionIndex > storagePath.lastIndexOf('/')
    ? storagePath.slice(0, extensionIndex)
    : storagePath;
  return `${basePath}.preview.webp`;
}

async function loadPendingRows() {
  const rows = [];

  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('post_media')
      .select('id, storage_path, media_kind, content_type, width, height')
      .in('media_kind', ['image', 'video'])
      .is('preview_storage_path', null)
      .not('storage_path', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, to);

    if (error) {
      throw error;
    }

    if (!data?.length) {
      break;
    }

    rows.push(...data);
    if (data.length < PAGE_SIZE) {
      break;
    }
  }

  return rows;
}

function isVideoRow(row) {
  return row.media_kind === 'video' || row.content_type?.startsWith('video/');
}

async function extractVideoPoster(videoBuffer) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'post-media-poster-backfill-'));
  const inputPath = path.join(tempDir, 'input-video');
  const framePath = path.join(tempDir, 'frame.jpg');

  try {
    await writeFile(inputPath, videoBuffer);
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

async function runFfmpeg(inputPath, framePath, seekTime) {
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

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
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

async function createPreview(row) {
  const { data, error } = await supabase.storage
    .from(SHOWCASE_MEDIA_BUCKET)
    .download(row.storage_path);
  if (error || !data) {
    throw new Error(error?.message || 'Original media could not be downloaded.');
  }

  const input = Buffer.from(await data.arrayBuffer());
  const video = isVideoRow(row);
  let metadata = { width: null, height: null };
  const output = video
    ? await extractVideoPoster(input)
    : await (async () => {
      const image = sharp(input).rotate();
      metadata = await image.metadata();
      return image
        .clone()
        .resize({
          width: PREVIEW_MAX_SIZE,
          height: PREVIEW_MAX_SIZE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 72 })
        .toBuffer();
    })();
  const previewStoragePath = buildPreviewPath(row.storage_path);

  if (!dryRun) {
    const upload = await supabase.storage
      .from(SHOWCASE_MEDIA_BUCKET)
      .upload(previewStoragePath, output, {
        cacheControl: '300',
        contentType: 'image/webp',
        upsert: true,
      });
    if (upload.error) {
      throw upload.error;
    }

    const update = await supabase
      .from('post_media')
      .update({
        preview_storage_path: previewStoragePath,
        width: row.width || metadata.width || null,
        height: row.height || metadata.height || null,
      })
      .eq('id', row.id)
      .is('preview_storage_path', null);
    if (update.error) {
      throw update.error;
    }
  }

  return previewStoragePath;
}

async function main() {
  const rows = await loadPendingRows();
  const videoCount = rows.filter(isVideoRow).length;
  console.log(`Found ${rows.length} post media item(s) without previews (${videoCount} video).`);

  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const path = await createPreview(row);
      completed += 1;
      console.log(`[ok] ${row.id} -> ${path}${dryRun ? ' (dry-run)' : ''}`);
    } catch (error) {
      failed += 1;
      console.error(`[fail] ${row.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  console.log(`Completed: ${completed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Post media preview backfill failed:', error);
  process.exit(1);
});
