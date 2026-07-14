import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import ffmpegStaticPath from 'ffmpeg-static';
import sharp from 'sharp';

const PREVIEW_MAX_SIZE = 720;

export async function createVideoPosterBuffer(body: Blob) {
  const tempDir = await mkdtemp(path.join(/* turbopackIgnore: true */ tmpdir(), 'generation-poster-'));
  const inputPath = path.join(/* turbopackIgnore: true */ tempDir, 'input-video');
  const framePath = path.join(/* turbopackIgnore: true */ tempDir, 'frame.jpg');

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

export function getFfmpegPath() {
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH;
  }

  if (!ffmpegStaticPath) {
    throw new Error('ffmpeg-static does not provide a binary for this platform. Configure FFMPEG_PATH.');
  }

  return ffmpegStaticPath;
}
