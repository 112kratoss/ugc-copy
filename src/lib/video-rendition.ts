import { spawn } from 'child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { getFfmpegPath } from '@/lib/video-poster';

/**
 * Showcase feed renditions.
 *
 * Provider output arrives wildly over-encoded for its resolution — a 656x1376
 * clip routinely lands at ~23 Mbps — and the feed autoplays it on scroll. That
 * makes Storage egress, not disk, the first ceiling we hit. A rendition is a
 * small, faststart copy the feed streams instead; the source object stays
 * untouched and is still what the full viewer and downloads serve.
 */

/** Long edge cap. Portrait clips end up 720x1280 at most, landscape 1280x720. */
export const RENDITION_MAX_WIDTH = 720;
export const RENDITION_MAX_HEIGHT = 1280;
export const RENDITION_CRF = 30;
export const RENDITION_MAX_BITRATE = '1400k';
export const RENDITION_BUFSIZE = '2800k';
export const RENDITION_AUDIO_BITRATE = '64k';
export const RENDITION_FRAMERATE = 30;
/** Keyframe every 2s at 30fps, so looping and seeking stay responsive. */
export const RENDITION_GOP = 60;
export const RENDITION_CONTENT_TYPE = 'video/mp4';

/**
 * Sources longer than this also get a teaser: a short, muted head of the clip
 * that the feed streams instead of the full rendition. Feed previews are
 * glanced at, not watched, so beyond ~30s the extra length is pure egress.
 */
export const TEASER_MIN_SOURCE_SECONDS = 30;
/**
 * Teaser length. Also why the teaser is encoded before the full rendition: an
 * 8s input never approaches RENDITION_TIMEOUT_MS, so the teaser survives
 * exactly when the full transcode of a long source dies.
 */
export const TEASER_SECONDS = 8;

/**
 * Inputs above this never reach ffmpeg. A serverless invocation has neither the
 * disk nor the CPU budget, and a rendition that times out is worse than none.
 */
export const RENDITION_MAX_INPUT_BYTES = 512 * 1024 * 1024;
export const RENDITION_TIMEOUT_MS = 120_000;
/**
 * Only keep a rendition that is meaningfully smaller. An already-lean upload
 * would otherwise get a near-identical twin stored and served for no gain.
 */
export const RENDITION_MIN_SAVING_RATIO = 0.85;

export type VideoRenditionResult = {
  buffer: Buffer;
  bytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
};

export type VideoProbeResult = {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
};

export class VideoRenditionSkipped extends Error {
  readonly reason: 'too-large' | 'not-smaller';

  constructor(reason: 'too-large' | 'not-smaller', message: string) {
    super(message);
    this.name = 'VideoRenditionSkipped';
    this.reason = reason;
  }
}

/**
 * Fit inside the cap box without ever upscaling. The `min(cap, input)` pair
 * clamps the target to the source, `decrease` preserves aspect, and
 * `force_divisible_by=2` keeps dimensions even for yuv420p.
 */
export function buildRenditionScaleFilter(): string {
  return `scale='min(${RENDITION_MAX_WIDTH},iw)':'min(${RENDITION_MAX_HEIGHT},ih)'`
    + ':force_original_aspect_ratio=decrease:force_divisible_by=2';
}

export function buildRenditionArgs(
  inputPath: string,
  outputPath: string,
  options: { maxDurationSeconds?: number; stripAudio?: boolean } = {},
): string[] {
  return [
    '-y',
    '-i',
    inputPath,
    // Explicit mapping: provider output does not reliably put video on stream 0,
    // and the trailing `?` keeps silent sources from failing the encode.
    '-map',
    '0:v:0',
    ...(options.stripAudio ? ['-an'] : ['-map', '0:a:0?']),
    ...(options.maxDurationSeconds !== undefined ? ['-t', String(options.maxDurationSeconds)] : []),
    '-vf',
    buildRenditionScaleFilter(),
    '-r',
    String(RENDITION_FRAMERATE),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    String(RENDITION_CRF),
    '-maxrate',
    RENDITION_MAX_BITRATE,
    '-bufsize',
    RENDITION_BUFSIZE,
    '-g',
    String(RENDITION_GOP),
    ...(options.stripAudio
      ? []
      : ['-c:a', 'aac', '-b:a', RENDITION_AUDIO_BITRATE, '-ac', '1']),
    // moov atom up front so playback starts before the whole file arrives.
    '-movflags',
    '+faststart',
    outputPath,
  ];
}

/** ffmpeg-static ships no ffprobe, so dimensions and duration come from stderr. */
export function parseVideoProbeOutput(output: string): VideoProbeResult {
  const durationMatch = /Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(output);
  let durationSeconds: number | null = null;
  if (durationMatch) {
    const [, hours, minutes, seconds, fraction] = durationMatch;
    durationSeconds = Number(hours) * 3600
      + Number(minutes) * 60
      + Number(seconds)
      + (fraction ? Number(`0.${fraction}`) : 0);
    durationSeconds = Math.round(durationSeconds * 1000) / 1000;
  }

  const videoStreamMatch = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Video:.*/.exec(output);
  let width: number | null = null;
  let height: number | null = null;
  if (videoStreamMatch) {
    // Skip any `WxH` inside a bracketed hint such as [SAR 1:1 DAR 16:9].
    const dimensionMatch = /,\s*(\d{2,5})x(\d{2,5})(?:[,\s[]|$)/.exec(videoStreamMatch[0]);
    if (dimensionMatch) {
      width = Number(dimensionMatch[1]);
      height = Number(dimensionMatch[2]);
    }
  }

  return { width, height, durationSeconds };
}

async function runFfmpeg(args: string[]): Promise<string> {
  const ffmpegPath = getFfmpegPath();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: RENDITION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const stderr: Buffer[] = [];

    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const output = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolve(output);
        return;
      }

      if (signal) {
        reject(new Error(`ffmpeg terminated by ${signal} after ${RENDITION_TIMEOUT_MS}ms.`));
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code ?? 'unknown'}: ${output.slice(-2000)}`));
    });
  });
}

export async function probeVideoFile(inputPath: string): Promise<VideoProbeResult> {
  // `-i` with no output makes ffmpeg exit non-zero after printing stream info.
  try {
    const output = await runFfmpeg(['-hide_banner', '-i', inputPath]);
    return parseVideoProbeOutput(output);
  } catch (error) {
    return parseVideoProbeOutput(error instanceof Error ? error.message : '');
  }
}

export async function createVideoRenditionFromFile(
  inputPath: string,
  sourceBytes: number,
): Promise<VideoRenditionResult> {
  const tempDir = await mkdtemp(path.join(/* turbopackIgnore: true */ tmpdir(), 'feed-rendition-'));
  const outputPath = path.join(/* turbopackIgnore: true */ tempDir, 'rendition.mp4');

  try {
    await runFfmpeg(buildRenditionArgs(inputPath, outputPath));

    const { size } = await stat(outputPath);
    if (size >= sourceBytes * RENDITION_MIN_SAVING_RATIO) {
      throw new VideoRenditionSkipped(
        'not-smaller',
        `Rendition (${size} bytes) is not meaningfully smaller than the source (${sourceBytes} bytes).`,
      );
    }

    const probe = await probeVideoFile(outputPath);
    return {
      buffer: await readFile(outputPath),
      bytes: size,
      width: probe.width,
      height: probe.height,
      durationSeconds: probe.durationSeconds,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Encodes the short muted head of a long clip for feed autoplay. Same encode
 * ladder as the full rendition, but capped at TEASER_SECONDS and without an
 * audio stream (the feed always plays muted). Deliberately no `not-smaller`
 * check: a trim is always worth keeping — its entire point is bounding what
 * the feed streams, not saving bytes over the source.
 */
export async function createVideoTeaserFromFile(inputPath: string): Promise<VideoRenditionResult> {
  const tempDir = await mkdtemp(path.join(/* turbopackIgnore: true */ tmpdir(), 'feed-teaser-'));
  const outputPath = path.join(/* turbopackIgnore: true */ tempDir, 'teaser.mp4');

  try {
    await runFfmpeg(buildRenditionArgs(inputPath, outputPath, {
      maxDurationSeconds: TEASER_SECONDS,
      stripAudio: true,
    }));

    const { size } = await stat(outputPath);
    const probe = await probeVideoFile(outputPath);
    return {
      buffer: await readFile(outputPath),
      bytes: size,
      width: probe.width,
      height: probe.height,
      durationSeconds: probe.durationSeconds,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Stages a source blob as a temp file and hands it to `work`, so one download
 * can feed the input probe, the teaser, and the full rendition without being
 * written three times. Applies the byte gate before anything touches disk.
 */
export async function withVideoInputFile<T>(
  body: Blob,
  work: (inputPath: string, sourceBytes: number) => Promise<T>,
): Promise<T> {
  const sourceBytes = body.size;
  if (sourceBytes > RENDITION_MAX_INPUT_BYTES) {
    throw new VideoRenditionSkipped(
      'too-large',
      `Source video is ${sourceBytes} bytes, above the ${RENDITION_MAX_INPUT_BYTES} byte rendition limit.`,
    );
  }

  const tempDir = await mkdtemp(path.join(/* turbopackIgnore: true */ tmpdir(), 'feed-rendition-src-'));
  const inputPath = path.join(/* turbopackIgnore: true */ tempDir, 'input-video');

  try {
    await pipeline(
      Readable.fromWeb(body.stream() as NodeReadableStream<Uint8Array>),
      createWriteStream(inputPath, { flags: 'wx' }),
    );
    return await work(inputPath, sourceBytes);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function createVideoRenditionBuffer(body: Blob): Promise<VideoRenditionResult> {
  return withVideoInputFile(body, (inputPath, sourceBytes) =>
    createVideoRenditionFromFile(inputPath, sourceBytes));
}
