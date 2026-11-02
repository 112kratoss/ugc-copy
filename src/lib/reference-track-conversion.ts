import 'server-only';

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { SupabaseClient } from '@supabase/supabase-js';

import { mediaEncoderCommand, MediaOutputLimitError } from '@/lib/media-encoder-limit';
import { MAX_REMOTE_MEDIA_BYTES, openAllowlistedRemoteMedia } from '@/lib/remote-media-security';
import { createMediaScratchWorkspace } from '@/lib/staging-workspace';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';
import { getFfmpegPath } from '@/lib/video-poster';

const GENERATION_INPUTS_BUCKET = 'generation_inputs';
const CONVERTED_TRACKS_FOLDER = 'converted-tracks';
// As long as the link to any other input of the run (resolveOwnedStoredMediaUrl).
const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * The captured Seedance 2 and 2 Fast pages give a reference track 10 MB at most
 * (docs/model-api-references/bytedance/), and the live ones of 2026-11-02 15 MB, as Wan 3.0's
 * does: the copy is held to the smaller. A 16-bit stereo WAV at 44.1 kHz fills it in about 56
 * seconds, and no model takes a track over 30, so a copy is never cut: a longer track is refused.
 */
const TRACK_COPY_MAX_BYTES = 9765 * 1024;
const TRACK_CONVERSION_TIMEOUT_MS = 30_000;

/**
 * The containers an audio upload can be (storage-upload-mime-policy: MP3, MPEG-4, WAV, AAC,
 * Ogg, WebM), by ffmpeg's demuxer names. ffmpeg reads any of its formats by content alone, and
 * a playlist named .m4a would open whatever its entries name: no other demuxer reads a track,
 * and the track is read as a file, nothing else.
 */
const TRACK_DEMUXERS = 'mp3,mov,mp4,m4a,3gp,3g2,mj2,wav,aac,ogg,matroska,webm';

/** A track ffmpeg cannot turn into a copy the provider takes. A new upload is the fix, not a retry. */
export class ReferenceTrackUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceTrackUnreadableError';
  }
}

function isAlreadyExistsStorageError(error: { statusCode?: string | number; message?: string; error?: string }): boolean {
  return String(error.statusCode ?? '') === '409'
    || error.error === 'Duplicate'
    || /already exists/i.test(error.message ?? '');
}

/**
 * The track's bytes, with the most of them the input copy may hold. The caller's own stored
 * object is read from storage, which also reaches a local stack's http links. Anything else is
 * fetched as a remote file, under the import allowlist's host, address, type and size checks,
 * so the service key never reads an object outside the caller's own folders.
 */
async function openTrack(params: {
  supabase: SupabaseClient;
  userId: string;
  link: string;
  openRemoteMedia: typeof openAllowlistedRemoteMedia;
}): Promise<{ body: ReadableStream<Uint8Array>; maxBytes: number }> {
  const location = getUserOwnedStoredMediaLocation(params.link, params.userId);
  if (location) {
    const { data, error } = await params.supabase.storage.from(location.bucket).download(location.filePath);
    if (error || !data) throw new Error(`The track could not be read from storage: ${error?.message ?? 'no data'}`);
    if (data.size > MAX_REMOTE_MEDIA_BYTES.audio) {
      throw new ReferenceTrackUnreadableError(`The track is ${data.size} bytes, more than any audio upload holds.`);
    }
    return { body: data.stream(), maxBytes: data.size };
  }
  const media = await params.openRemoteMedia({ url: params.link, kind: 'audio' });
  return { body: media.body, maxBytes: MAX_REMOTE_MEDIA_BYTES.audio };
}

/** Runs ffmpeg with its output held to `maxOutputBytes`, answering its stderr's tail on failure. */
async function runFfmpeg(args: string[], leaseFds: number[], maxOutputBytes: number): Promise<void> {
  const command = await mediaEncoderCommand(getFfmpegPath(), args, maxOutputBytes);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      stdio: ['ignore', 'ignore', 'pipe', ...leaseFds],
      timeout: TRACK_CONVERSION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const stderr: Buffer[] = [];
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    // Settled on close only, once the encoder has let go of the leased workspaces.
    let processError: Error | undefined;
    child.on('error', (error) => { processError = error; });
    child.on('close', (code, signal) => {
      if (processError) { reject(processError); return; }
      if (signal === 'SIGXFSZ') { reject(new MediaOutputLimitError(maxOutputBytes)); return; }
      if (code === 0) { resolve(); return; }
      const output = Buffer.concat(stderr).toString('utf8').slice(-2000);
      reject(signal
        ? new Error(`ffmpeg terminated by ${signal} after ${TRACK_CONVERSION_TIMEOUT_MS}ms.`)
        : new ReferenceTrackUnreadableError(`ffmpeg exited with code ${code ?? 'unknown'}: ${output}`));
    });
  });
}

/**
 * The track as a 16-bit stereo WAV at 44.1 kHz, the one format every model that takes a track
 * lists. Byte for byte the same each time for the same track: nothing of the run or the time
 * is written into it.
 */
async function encodeWav(inputPath: string, inputLeaseFd: number): Promise<Buffer> {
  const output = await createMediaScratchWorkspace(TRACK_COPY_MAX_BYTES);
  try {
    const outputPath = path.join(output.mediaDirectory, 'track.wav');
    await runFfmpeg([
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-protocol_whitelist', 'file',
      '-format_whitelist', TRACK_DEMUXERS,
      '-i', inputPath,
      '-map', '0:a:0',
      '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le',
      '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
      '-f', 'wav', '-y', outputPath,
    ], [inputLeaseFd, output.readerLeaseFd], TRACK_COPY_MAX_BYTES);
    // Read before the workspace goes: `finally` runs once this await settles.
    return await readFile(outputPath);
  } catch (error) {
    if (error instanceof MediaOutputLimitError) {
      throw new ReferenceTrackUnreadableError('The track is longer than any model takes.');
    }
    throw error;
  } finally {
    await output.cleanup();
  }
}

/**
 * Converts a reference track to a WAV the provider takes and answers a link to the copy.
 *
 * Kie judges a track by its link's extension, before it fetches anything, and refuses one its
 * model does not list (provider-input-limits: `referenceTrackNeedsConversion`); a run sent one
 * failed after the hold. The start converts such a track before it holds anything, so a track
 * that cannot be converted is refused at no cost to the creator.
 *
 * The copy is kept in `generation_inputs/<userId>/converted-tracks/`, named by its content, so
 * a retried start or a second run of the same track finds the copy already there. It is the
 * provider's file only: the run keeps the creator's own track as its input, and the copy goes
 * with the account (the deletion sweep clears every one of its folders), as the copies of a
 * remix's inputs in `remix-imports/` do.
 *
 * Throws `ReferenceTrackUnreadableError` when the track is not audio ffmpeg can convert, or is
 * too long; anything else (storage, a fetch, the encoder itself) is not the track's fault.
 */
export async function convertReferenceTrack(params: {
  supabase: SupabaseClient;
  userId: string;
  /** The link the run resolved for the track, as the provider would have fetched it. */
  link: string;
  openRemoteMedia?: typeof openAllowlistedRemoteMedia;
}): Promise<string> {
  const { supabase, userId } = params;
  const track = await openTrack({ ...params, openRemoteMedia: params.openRemoteMedia ?? openAllowlistedRemoteMedia });

  let input: Awaited<ReturnType<typeof createMediaScratchWorkspace>>;
  try {
    input = await createMediaScratchWorkspace(track.maxBytes);
  } catch (error) {
    await track.body.cancel().catch(() => {});
    throw error;
  }
  let wav: Buffer;
  try {
    const inputPath = path.join(input.mediaDirectory, 'track');
    await pipeline(
      Readable.fromWeb(track.body as NodeReadableStream<Uint8Array>),
      createWriteStream(inputPath, { flags: 'wx' }),
    );
    await input.seal();
    wav = await encodeWav(inputPath, input.readerLeaseFd);
  } finally {
    await input.cleanup();
  }

  const filePath = `${userId}/${CONVERTED_TRACKS_FOLDER}/${createHash('sha256').update(wav).digest('hex')}.wav`;
  const upload = await supabase.storage
    .from(GENERATION_INPUTS_BUCKET)
    .upload(filePath, new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), {
      contentType: 'audio/wav',
      upsert: false,
    });
  if (upload.error && !isAlreadyExistsStorageError(upload.error)) {
    throw new Error(`The converted track could not be stored: ${upload.error.message}`);
  }

  const signed = await supabase.storage
    .from(GENERATION_INPUTS_BUCKET)
    .createSignedUrl(filePath, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(`The converted track could not be signed: ${signed.error?.message ?? 'no link'}`);
  }
  return signed.data.signedUrl;
}
