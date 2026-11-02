import 'server-only';

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

import { providerTrackFolder } from '@/lib/generation-provider-tracks';
import { mediaEncoderCommand, MediaOutputLimitError } from '@/lib/media-encoder-limit';
import { MAX_REMOTE_MEDIA_BYTES, RemoteMediaSecurityError } from '@/lib/remote-media-security';
import { stageAllowlistedRemoteMedia } from '@/lib/staged-remote-media';
import { createMediaScratchWorkspace } from '@/lib/staging-workspace';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';
import { toStorageUploadBody } from '@/lib/storage-upload-body';
import { getFfmpegPath } from '@/lib/video-poster';
import { withVideoInputFile } from '@/lib/video-rendition';

const GENERATION_INPUTS_BUCKET = 'generation_inputs';
// As long as the link to any other input of the run (resolveOwnedStoredMediaUrl).
const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * The captured Seedance 2 and 2 Fast pages give a reference track 10 MB at most
 * (docs/model-api-references/bytedance/), the live ones of 2026-11-02 15 MB, as do Wan 3.0's and
 * MiniMax H3's, and Wan 2.7's 30 MB: the copy is held to the smallest. A 16-bit stereo WAV at
 * 44.1 kHz fills it in about 56 seconds, and no model takes a track over 30, so a copy is never
 * cut: a longer track is refused.
 */
const TRACK_COPY_MAX_BYTES = 9765 * 1024;
const TRACK_CONVERSION_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARACTERS = 2000;

/**
 * The containers an audio upload can be (storage-upload-mime-policy: MP3, MPEG-4, WAV, AAC,
 * Ogg, WebM), and the FLAC, CAF and AIFF a picker can hand over under one of those names, by
 * ffmpeg's demuxer names. ffmpeg reads any of its formats by content alone, and a playlist named
 * .m4a would open whatever its entries name: no other demuxer reads a track, and the track is
 * read as a file, nothing else.
 */
const TRACK_DEMUXERS = 'mp3,mov,mp4,m4a,3gp,3g2,mj2,wav,aac,ogg,matroska,webm,flac,caf,aiff';

/** Exit codes of the encoder's limit wrapper (media-encoder-limit): it could not set the limit, or start ffmpeg. */
const ENCODER_START_EXIT_CODES = new Set([125, 126, 127]);
/** What ffmpeg says when the machine, not the track, failed it. */
const HOST_FAULT = /No space left on device|Cannot allocate memory|Too many open files|Permission denied/;

/**
 * A track that cannot be made into a copy its provider takes: one ffmpeg cannot read as audio,
 * or one longer than any model takes (`tooLong`). A new file is the fix, not a retry.
 */
export class ReferenceTrackUnreadableError extends Error {
  constructor(message: string, readonly tooLong = false) {
    super(message);
    this.name = 'ReferenceTrackUnreadableError';
  }
}

/**
 * Runs `work` on the track as a local file. The caller's own stored object is sized before it
 * is read, since a download is held in memory whole and any object of theirs can be sent as a
 * track, and is read from storage, which reaches a local stack's http links too. Anything else
 * is fetched under the remote import's host, address, type and size checks, so the service key
 * never reads an object outside the caller's own folders.
 */
async function withTrackFile<T>(
  params: { supabase: SupabaseClient; userId: string; link: string },
  work: (filePath: string, leaseFd: number) => Promise<T>,
): Promise<T> {
  const location = getUserOwnedStoredMediaLocation(params.link, params.userId);
  if (location) {
    const bucket = params.supabase.storage.from(location.bucket);
    const { data: info, error: infoError } = await bucket.info(location.filePath);
    if (infoError || !info) throw new Error(`The track could not be found in storage: ${infoError?.message ?? 'no details'}`);
    const tooLarge = (bytes: number) => new ReferenceTrackUnreadableError(`The track is ${bytes} bytes, more than any audio upload holds.`, true);
    if (typeof info.size === 'number' && info.size > MAX_REMOTE_MEDIA_BYTES.audio) throw tooLarge(info.size);
    const { data, error } = await bucket.download(location.filePath);
    if (error || !data) throw new Error(`The track could not be read from storage: ${error?.message ?? 'no data'}`);
    if (data.size > MAX_REMOTE_MEDIA_BYTES.audio) throw tooLarge(data.size);
    return withVideoInputFile(data, (inputPath, _sourceBytes, leaseFd) => work(inputPath, leaseFd));
  }

  let staged: Awaited<ReturnType<typeof stageAllowlistedRemoteMedia>>;
  try {
    staged = await stageAllowlistedRemoteMedia({ url: params.link, kind: 'audio' });
  } catch (error) {
    // Its host passed when the run's media was resolved, so a refusal now is the file's, unless
    // the host answered busy.
    const status = error instanceof RemoteMediaSecurityError ? error.status : null;
    if (error instanceof RemoteMediaSecurityError && !(status !== null && (status >= 500 || status === 429 || status === 408))) {
      throw new ReferenceTrackUnreadableError(error.message, /exceeds the allowed size/.test(error.message));
    }
    throw error;
  }
  try {
    return await work(staged.filePath, staged.readerLeaseFd);
  } finally {
    await staged.cleanup();
  }
}

/** Runs ffmpeg with its output held to `maxOutputBytes`, telling a track it cannot read from a machine that failed it. */
async function runFfmpeg(args: string[], leaseFds: number[], maxOutputBytes: number): Promise<void> {
  const command = await mediaEncoderCommand(getFfmpegPath(), args, maxOutputBytes);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      stdio: ['ignore', 'ignore', 'pipe', ...leaseFds],
      timeout: TRACK_CONVERSION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    // Only the end is reported, and a damaged file can make ffmpeg write a line per packet.
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARACTERS);
    });
    // Settled on close only, once the encoder has let go of the leased workspaces.
    let processError: Error | undefined;
    child.on('error', (error) => { processError = error; });
    child.on('close', (code, signal) => {
      if (processError) { reject(processError); return; }
      if (signal === 'SIGXFSZ') { reject(new MediaOutputLimitError(maxOutputBytes)); return; }
      if (code === 0) { resolve(); return; }
      if (signal) {
        // A track this short that is still being read at the deadline is one ffmpeg chokes on.
        reject(new ReferenceTrackUnreadableError(`ffmpeg was stopped by ${signal} after ${TRACK_CONVERSION_TIMEOUT_MS}ms: ${stderr}`));
        return;
      }
      reject(ENCODER_START_EXIT_CODES.has(code ?? -1) || HOST_FAULT.test(stderr)
        ? new Error(`ffmpeg could not convert the track (exit ${code ?? 'unknown'}): ${stderr}`)
        : new ReferenceTrackUnreadableError(`ffmpeg exited with code ${code ?? 'unknown'}: ${stderr}`));
    });
  });
}

/**
 * The track as a 16-bit WAV at 44.1 kHz, the one format every model that takes a track lists,
 * in its own channels (a mono voice memo stays mono, more than two are folded to stereo). Byte
 * for byte the same each time for the same track: nothing of the run or the time is written in.
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
      '-af', 'aformat=channel_layouts=mono|stereo', '-ar', '44100', '-c:a', 'pcm_s16le',
      '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
      '-f', 'wav', '-y', outputPath,
    ], [inputLeaseFd, output.readerLeaseFd], TRACK_COPY_MAX_BYTES);
    // Read before the workspace goes: `finally` runs once this await settles.
    return await readFile(outputPath);
  } catch (error) {
    if (error instanceof MediaOutputLimitError) {
      throw new ReferenceTrackUnreadableError('The track is longer than any model takes.', true);
    }
    throw error;
  } finally {
    await output.cleanup();
  }
}

/**
 * Converts a reference track to a WAV its provider takes, and answers the bytes.
 *
 * Kie judges a track by its link's extension before it fetches anything, and refuses one its
 * model does not list (provider-input-limits: `referenceTrackNeedsConversion`); a run sent one
 * failed after the hold. The start converts such a track before it holds anything, so one that
 * cannot be converted is refused at no cost to the creator, and stores the copy only once the
 * run is held (`storeConvertedReferenceTrack`), so a start that is refused keeps nothing.
 *
 * Throws `ReferenceTrackUnreadableError` when the track is not audio ffmpeg can convert, or is
 * too long; anything else (storage, a fetch, the encoder or the machine) is not the track's fault.
 */
export async function convertReferenceTrack(params: {
  supabase: SupabaseClient;
  userId: string;
  /** The link the run resolved for the track, as the provider would have fetched it. */
  link: string;
}): Promise<Buffer> {
  return withTrackFile(params, encodeWav);
}

/**
 * Keeps a converted track in its held run's folder (generation-provider-tracks) and answers the
 * link the provider is sent. The run keeps the creator's own track as its input; this copy is the
 * provider's, and goes with the run.
 */
export async function storeConvertedReferenceTrack(params: {
  supabase: SupabaseClient;
  userId: string;
  generationId: string;
  /** Its place among the run's converted tracks, which names the file. */
  index: number;
  wav: Buffer;
}): Promise<string> {
  const { supabase } = params;
  const filePath = `${providerTrackFolder(params.userId, params.generationId)}/${String(params.index).padStart(2, '0')}.wav`;
  const upload = await supabase.storage
    .from(GENERATION_INPUTS_BUCKET)
    .upload(filePath, toStorageUploadBody(params.wav, 'audio/wav'), { contentType: 'audio/wav', upsert: false });
  if (upload.error) throw new Error(`The converted track could not be stored: ${upload.error.message}`);

  const signed = await supabase.storage
    .from(GENERATION_INPUTS_BUCKET)
    .createSignedUrl(filePath, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(`The converted track could not be signed: ${signed.error?.message ?? 'no link'}`);
  }
  return signed.data.signedUrl;
}
