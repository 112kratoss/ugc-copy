import { spawn } from 'child_process';
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'fs/promises';
import { createMediaScratchWorkspace } from '@/lib/staging-workspace';
import path from 'path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { getFfmpegPath } from '@/lib/video-poster';
import { mediaEncoderCommand, MediaOutputLimitError } from '@/lib/media-encoder-limit';

// Generous headroom above the eight-second teaser bitrate, while bounding disk.
export const VIDEO_TEASER_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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

async function runFfmpeg(args: string[], signal?: AbortSignal, leaseFds: number[] = [], maxOutputBytes?: number): Promise<string> {
  signal?.throwIfAborted();
  const ffmpegPath = getFfmpegPath();
  const command = maxOutputBytes === undefined ? { executable: ffmpegPath, args }
    : await mediaEncoderCommand(ffmpegPath, args, maxOutputBytes);
  signal?.throwIfAborted();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      stdio: ['ignore', 'ignore', 'pipe', ...leaseFds],
      timeout: RENDITION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      ...(signal ? { signal } : {}),
    });
    const stderr: Buffer[] = [];

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    // Abort emits `error` before the process has released inherited leases.
    // Settle only on close so owner cleanup cannot race the encoder's exit.
    let processError: Error | undefined;
    child.on('error', (error) => { processError = error; });
    child.on('close', (code, signal) => {
      if (processError) { reject(processError); return; }
      if (signal === 'SIGXFSZ' && maxOutputBytes !== undefined) {
        reject(new MediaOutputLimitError(maxOutputBytes)); return;
      }
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

export async function probeVideoFile(inputPath: string, signal?: AbortSignal, sourceLeaseFd?: number): Promise<VideoProbeResult> {
  // `-i` with no output makes ffmpeg exit non-zero after printing stream info.
  try {
    const output = await runFfmpeg(['-hide_banner', '-i', inputPath], signal, sourceLeaseFd === undefined ? [] : [sourceLeaseFd]);
    return parseVideoProbeOutput(output);
  } catch (error) {
    signal?.throwIfAborted();
    return parseVideoProbeOutput(error instanceof Error ? error.message : '');
  }
}

export const MEDIA_DURATION_PROBE_TIMEOUT_MS = 20_000;

/**
 * A remote reference's length, read from its container header: nothing is
 * decoded or written. The whole stderr is kept, because a phone clip's metadata
 * can push the Duration line past the tail runFfmpeg reports on failure.
 *
 * Only HTTPS is readable. The input is a URL the server resolved, but ffmpeg
 * speaks many protocols, and none of the others should ever be reachable from
 * a generation request.
 */
export async function probeMediaDurationSeconds(input: string, signal?: AbortSignal): Promise<number | null> {
  signal?.throwIfAborted();
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(getFfmpegPath(), [
      '-hide_banner',
      '-nostdin',
      '-protocol_whitelist',
      'https,tls,tcp',
      '-i',
      input,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: MEDIA_DURATION_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      ...(signal ? { signal } : {}),
    });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    // With no output named, ffmpeg always exits non-zero once the header is printed.
    child.on('close', () => resolve(Buffer.concat(stderr).toString('utf8')));
  });
  const { durationSeconds } = parseVideoProbeOutput(output);
  return durationSeconds !== null && durationSeconds > 0 ? durationSeconds : null;
}

export async function createVideoRenditionFromFile(
  inputPath: string,
  sourceBytes: number,
  options: { signal?: AbortSignal; sourceLeaseFd?: number } = {},
): Promise<VideoRenditionResult> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes <= 0 || sourceBytes > RENDITION_MAX_INPUT_BYTES) {
    throw new VideoRenditionSkipped('too-large', 'Source bytes are outside the rendition budget.');
  }
  // Anything at/above the savings threshold would already be discarded.
  const maxOutputBytes = Math.max(1024, Math.ceil(sourceBytes * RENDITION_MIN_SAVING_RATIO / 1024) * 1024);
  const workspace = await createMediaScratchWorkspace(maxOutputBytes);
  const outputPath = path.join(workspace.mediaDirectory, 'rendition.mp4');

  try {
    await runFfmpeg(buildRenditionArgs(inputPath, outputPath), options.signal,
      [options.sourceLeaseFd, workspace.readerLeaseFd].filter((fd): fd is number => fd !== undefined), maxOutputBytes);

    const { size } = await stat(outputPath);
    if (size >= sourceBytes * RENDITION_MIN_SAVING_RATIO) {
      throw new VideoRenditionSkipped(
        'not-smaller',
        `Rendition (${size} bytes) is not meaningfully smaller than the source (${sourceBytes} bytes).`,
      );
    }

    const probe = await probeVideoFile(outputPath, options.signal, workspace.readerLeaseFd);
    return {
      buffer: await readFile(outputPath),
      bytes: size,
      width: probe.width,
      height: probe.height,
      durationSeconds: probe.durationSeconds,
    };
  } catch (error) {
    if (error instanceof MediaOutputLimitError) {
      throw new VideoRenditionSkipped('not-smaller', 'Rendition exceeded its useful output size.');
    }
    throw error;
  } finally {
    await workspace.cleanup();
  }
}

/**
 * Encodes the short muted head of a long clip for feed autoplay. Same encode
 * ladder as the full rendition, but capped at TEASER_SECONDS and without an
 * audio stream (the feed always plays muted). Deliberately no `not-smaller`
 * check: a trim is always worth keeping — its entire point is bounding what
 * the feed streams, not saving bytes over the source.
 */
export async function createVideoTeaserFromFile(inputPath: string, sourceLeaseFd?: number): Promise<VideoRenditionResult> {
  const workspace = await createMediaScratchWorkspace(VIDEO_TEASER_MAX_OUTPUT_BYTES);
  const outputPath = path.join(workspace.mediaDirectory, 'teaser.mp4');

  try {
    await runFfmpeg(buildRenditionArgs(inputPath, outputPath, {
      maxDurationSeconds: TEASER_SECONDS,
      stripAudio: true,
    }), undefined, [sourceLeaseFd, workspace.readerLeaseFd].filter((fd): fd is number => fd !== undefined), VIDEO_TEASER_MAX_OUTPUT_BYTES);

    const { size } = await stat(outputPath);
    if (size >= VIDEO_TEASER_MAX_OUTPUT_BYTES) throw new MediaOutputLimitError(VIDEO_TEASER_MAX_OUTPUT_BYTES);
    const probe = await probeVideoFile(outputPath, undefined, workspace.readerLeaseFd);
    return {
      buffer: await readFile(outputPath),
      bytes: size,
      width: probe.width,
      height: probe.height,
      durationSeconds: probe.durationSeconds,
    };
  } finally {
    await workspace.cleanup();
  }
}

/**
 * Stages a source blob as a temp file and hands it to `work`, so one download
 * can feed the input probe, the teaser, and the full rendition without being
 * written three times. Applies the byte gate before anything touches disk.
 */
export async function withVideoInputFile<T>(
  body: Blob,
  work: (inputPath: string, sourceBytes: number, sourceLeaseFd: number) => Promise<T>,
): Promise<T> {
  const sourceBytes = body.size;
  if (sourceBytes > RENDITION_MAX_INPUT_BYTES) {
    throw new VideoRenditionSkipped(
      'too-large',
      `Source video is ${sourceBytes} bytes, above the ${RENDITION_MAX_INPUT_BYTES} byte rendition limit.`,
    );
  }

  const workspace = await createMediaScratchWorkspace(sourceBytes);
  const inputPath = path.join(workspace.mediaDirectory, 'input-video');

  try {
    await pipeline(
      Readable.fromWeb(body.stream() as NodeReadableStream<Uint8Array>),
      createWriteStream(inputPath, { flags: 'wx' }),
    );
    await workspace.seal();
    return await work(inputPath, sourceBytes, workspace.readerLeaseFd);
  } finally {
    await workspace.cleanup();
  }
}

export async function createVideoRenditionBuffer(body: Blob): Promise<VideoRenditionResult> {
  return withVideoInputFile(body, (inputPath, sourceBytes, sourceLeaseFd) =>
    createVideoRenditionFromFile(inputPath, sourceBytes, { sourceLeaseFd }));
}
