#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import ffmpegStaticPath from 'ffmpeg-static';

const FFMPEG_TRACE_PATTERN = /(?:^|\/)ffmpeg-static(?:@[^/]*)?(?:\/node_modules\/ffmpeg-static)?\/ffmpeg(?:\.exe)?$/;

export function traceContainsFfmpeg(files) {
  return Array.isArray(files) && files.some((file) => (
    typeof file === 'string'
    && FFMPEG_TRACE_PATTERN.test(file.replaceAll('\\', '/'))
  ));
}

export async function findTraceManifests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTraceManifests(entryPath);
    return entry.name.endsWith('.nft.json') ? [entryPath] : [];
  }));
  return nested.flat();
}

export async function findFfmpegTraceManifests(nextDirectory) {
  const serverDirectory = path.join(nextDirectory, 'server');
  const manifests = await findTraceManifests(serverDirectory);
  const matches = [];

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (traceContainsFfmpeg(manifest.files)) matches.push(manifestPath);
  }

  return matches;
}

export async function verifyFfmpegBuildArtifact({
  nextDirectory = path.resolve('.next'),
  ffmpegPath = ffmpegStaticPath,
  runBinary = true,
} = {}) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not install a binary for this platform.');
  }

  await access(ffmpegPath, fsConstants.X_OK);
  const traceManifests = await findFfmpegTraceManifests(nextDirectory);
  if (traceManifests.length === 0) {
    throw new Error('Next.js did not include the FFmpeg binary in any server output trace.');
  }

  if (runBinary) {
    const result = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0 || !result.stdout.toLowerCase().includes('ffmpeg version')) {
      throw result.error ?? new Error(`Packaged FFmpeg smoke check failed with status ${result.status ?? 'unknown'}.`);
    }
  }

  return { ffmpegPath, traceManifests };
}

async function main() {
  const result = await verifyFfmpegBuildArtifact();
  console.log(`FFmpeg is executable and traced by ${result.traceManifests.length} server bundle(s).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
