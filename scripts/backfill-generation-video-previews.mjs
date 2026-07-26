import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { createClient } from '@supabase/supabase-js';
import ffmpegStaticPath from 'ffmpeg-static';
import sharp from 'sharp';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PREVIEW_MAX_SIZE = 720;
const PAGE_SIZE = 100;
const dryRun = process.argv.includes('--dry-run');
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || 'ffmpeg';

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

function getStorageLocation(storagePath) {
  if (!storagePath || storagePath.startsWith('http')) {
    return null;
  }

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

function buildPreviewPath(outputUrl, row) {
  const location = getStorageLocation(outputUrl);
  if (!location) {
    return `generated_videos/${row.user_id}/generated_${row.id}.preview.webp`;
  }

  const extensionIndex = outputUrl.lastIndexOf('.');
  const slashIndex = outputUrl.lastIndexOf('/');
  const basePath = extensionIndex > slashIndex ? outputUrl.slice(0, extensionIndex) : outputUrl;
  return `${basePath}.preview.webp`;
}

async function loadPendingRows() {
  const rows = [];

  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('generations')
      .select('id, user_id, output_url, category')
      .in('category', ['video', 'motion'])
      .is('preview_url', null)
      .not('output_url', 'is', null)
      .order('completed_at', { ascending: true, nullsFirst: false })
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

async function downloadGenerationOutput(row) {
  const location = getStorageLocation(row.output_url);
  if (!location) {
    const response = await fetch(row.output_url);
    if (!response.ok) {
      throw new Error(`Could not download external output (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  const { data, error } = await supabase.storage
    .from(location.bucket)
    .download(location.filePath);
  if (error || !data) {
    throw new Error(error?.message || 'Stored output could not be downloaded.');
  }

  return Buffer.from(await data.arrayBuffer());
}

async function extractPoster(videoBuffer) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'generation-poster-backfill-'));
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
  const outputBuffer = await downloadGenerationOutput(row);
  const preview = await extractPoster(outputBuffer);
  const previewStoragePath = buildPreviewPath(row.output_url, row);
  const location = getStorageLocation(previewStoragePath);
  if (!location) {
    throw new Error(`Invalid preview storage path: ${previewStoragePath}`);
  }

  if (!dryRun) {
    const upload = await supabase.storage
      .from(location.bucket)
      .upload(location.filePath, preview, {
        cacheControl: '300',
        contentType: 'image/webp',
        upsert: true,
      });
    if (upload.error) {
      throw upload.error;
    }

    const update = await supabase
      .from('generations')
      .update({ preview_url: previewStoragePath })
      .eq('id', row.id)
      .is('preview_url', null);
    if (update.error) {
      throw update.error;
    }
  }

  return previewStoragePath;
}

async function main() {
  const rows = await loadPendingRows();
  console.log(`Found ${rows.length} video/motion generation(s) without previews.`);

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
  console.error('Generation video preview backfill failed:', error);
  process.exit(1);
});
