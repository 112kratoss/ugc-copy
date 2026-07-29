import { spawn } from 'child_process';
import { accessSync, constants as fsConstants, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import ffmpegStaticPath from 'ffmpeg-static';
import sharp from 'sharp';

const PREVIEW_MAX_SIZE = 720;

export async function createVideoPosterBuffer(body: Blob) {
  const tempDir = await mkdtemp(path.join(/* turbopackIgnore: true */ tmpdir(), 'generation-poster-'));
  const inputPath = path.join(/* turbopackIgnore: true */ tempDir, 'input-video');

  try {
    await pipeline(
      Readable.fromWeb(body.stream() as NodeReadableStream<Uint8Array>),
      createWriteStream(inputPath, { flags: 'wx' }),
    );
    return createVideoPosterBufferFromFile(inputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function createVideoPosterBufferFromFile(inputPath: string) {
  const tempDir = await mkdtemp(path.join(/* turbopackIgnore: true */ tmpdir(), 'generation-frame-'));
  const framePath = path.join(/* turbopackIgnore: true */ tempDir, 'frame.jpg');

  try {
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

let resolvedFfmpegPath: string | null = null;

/**
 * Locate an ffmpeg binary that is actually executable here.
 *
 * `ffmpeg-static` derives its path from `__dirname`, which a bundler can
 * rewrite to a build-time virtual root that does not exist at runtime. Probing
 * the candidates turns that into an error naming what was tried, rather than an
 * opaque ENOENT surfacing from a spawn deep inside a transcode. `process.cwd()`
 * is the function root on Vercel, where the traced copy lives.
 */
export function getFfmpegPath() {
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH;
  }

  if (resolvedFfmpegPath) {
    return resolvedFfmpegPath;
  }

  const candidates = [
    ffmpegStaticPath,
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      resolvedFfmpegPath = candidate;
      return candidate;
    } catch {
      // Fall through to the next candidate.
    }
  }

  throw new Error(
    `No executable ffmpeg binary found. Tried: ${candidates.join(', ') || '(none — ffmpeg-static ships no binary for this platform)'}. Set FFMPEG_PATH to override.`,
  );
}
