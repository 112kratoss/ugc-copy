import 'server-only';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import { providerTrackFolder, SEEDANCE_ASSET_TRACKS_FOLDER } from '@/lib/generation-provider-tracks';
import { mediaEncoderCommand, MediaOutputLimitError } from '@/lib/media-encoder-limit';
import { referenceTrackLinkExtension } from '@/lib/provider-input-limits';
import {
  ID3V2_HEADER_BYTES,
  id3v2TagLength,
  REFERENCE_TRACK_HEAD_BYTES,
  referenceTrackContainer,
} from '@/lib/reference-track-format';
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
/**
 * What ffmpeg says when the machine, not the track, failed it. Not "Cannot allocate memory":
 * ffmpeg says that of a damaged file too, one whose header asks for an impossible allocation.
 */
const HOST_FAULT = /No space left on device|Too many open files|Permission denied/;

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

/** A file can carry more than one ID3v2 tag, one after another; more than this is no track. */
const MAX_ID3V2_TAGS = 4;

/**
 * The track's first bytes after any ID3v2 tags, which can hold megabytes of cover art before
 * the first frame, and whether it had one: what `referenceTrackContainer` reads.
 */
async function readTrackHead(filePath: string): Promise<{ head: Uint8Array; tagged: boolean }> {
  const file = await open(filePath, 'r');
  try {
    let offset = 0;
    let tagged = false;
    for (let tag = 0; tag < MAX_ID3V2_TAGS; tag += 1) {
      const header = Buffer.alloc(ID3V2_HEADER_BYTES);
      const { bytesRead } = await file.read(header, 0, ID3V2_HEADER_BYTES, offset);
      const length = id3v2TagLength(header.subarray(0, bytesRead));
      if (length === 0) break;
      tagged = true;
      offset += length;
    }
    const head = Buffer.alloc(REFERENCE_TRACK_HEAD_BYTES);
    const { bytesRead } = await file.read(head, 0, REFERENCE_TRACK_HEAD_BYTES, offset);
    return { head: head.subarray(0, bytesRead), tagged };
  } finally {
    await file.close();
  }
}

/**
 * Converts a reference track to a WAV its provider takes, and answers the bytes, or null when
 * the provider takes the track as it is.
 *
 * Kie judges a track by its link's extension before it fetches anything, and refuses one its
 * model does not list; a run sent one failed after the hold. It then decodes whatever it
 * fetched, so a track whose extension it takes but whose bytes are something else (AAC named
 * `.mp3`, an `.m4a` renamed `.wav`) failed after the hold as well: such a track is converted
 * too, its real type read from its bytes (reference-track-format). The start converts before it
 * holds anything, so a track that cannot be converted is refused at no cost to the creator, and
 * stores the copy only once the run is held (`storeConvertedReferenceTrack`), so a start that is
 * refused keeps nothing. Seedance's Prepare converts the same way and keeps its copy apart
 * (`storeSeedanceAssetTrack`).
 *
 * A track whose extension the provider takes but that cannot be read here (a link of a host the
 * remote import does not fetch from, a stored type it does not take, a storage error) goes as
 * it is, as every such track went before its bytes were read: reading it only ever adds a
 * conversion, never a refusal of a track the provider was sent before.
 *
 * Throws `ReferenceTrackUnreadableError` when a track that must be converted is not audio ffmpeg
 * can convert, or is too long; anything else (storage, a fetch, the encoder or the machine) is
 * not the track's fault.
 */
export async function convertReferenceTrackIfRefused(params: {
  supabase: SupabaseClient;
  userId: string;
  /** The link the track is sent as, as the provider would have fetched it. */
  link: string;
  /** The extensions the provider takes (provider-input-limits: `providerReferenceTrackFormats`). */
  formats: readonly string[];
}): Promise<Buffer | null> {
  const claimed = referenceTrackLinkExtension(params.link);
  if (!claimed || !params.formats.includes(claimed)) return withTrackFile(params, encodeWav);

  let read = false;
  try {
    return await withTrackFile(params, async (filePath, leaseFd) => {
      const container = referenceTrackContainer(await readTrackHead(filePath));
      read = true;
      if (container === claimed) return null;
      logBackendWarning('reference_track_extension_mismatch', { claimed, container });
      return encodeWav(filePath, leaseFd);
    });
  } catch (error) {
    if (read) throw error;
    logBackendWarning('reference_track_not_read', { claimed, error });
    return null;
  }
}

/**
 * Keeps a converted track in its held run's folder (generation-provider-tracks) and answers the
 * link the provider is sent, with the file's path in `generation_inputs`. The run keeps the
 * creator's own track as its input; this copy is the provider's, and goes with the run.
 */
export async function storeConvertedReferenceTrack(params: {
  supabase: SupabaseClient;
  userId: string;
  generationId: string;
  /** Its place among the run's converted tracks, which names the file. */
  index: number;
  wav: Buffer;
  /** Told the file's path once it is stored, so a start refused after this can remove it. */
  onStored: (filePath: string) => void;
}): Promise<string> {
  const { supabase } = params;
  const filePath = `${providerTrackFolder(params.userId, params.generationId)}/${String(params.index).padStart(2, '0')}.wav`;
  const upload = await supabase.storage
    .from(GENERATION_INPUTS_BUCKET)
    .upload(filePath, toStorageUploadBody(params.wav, 'audio/wav'), { contentType: 'audio/wav', upsert: false });
  if (upload.error) throw new Error(`The converted track could not be stored: ${upload.error.message}`);
  params.onStored(filePath);

  const signed = await supabase.storage
    .from(GENERATION_INPUTS_BUCKET)
    .createSignedUrl(filePath, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(`The converted track could not be signed: ${signed.error?.message ?? 'no link'}`);
  }
  return signed.data.signedUrl;
}

/**
 * How long a Prepare copy is kept: its link lasts an hour (`SIGNED_URL_TTL_SECONDS`), after
 * which Kie can no longer fetch it, so a copy twice that old is no use to anyone.
 */
const SEEDANCE_ASSET_TRACK_KEEP_MS = 2 * SIGNED_URL_TTL_SECONDS * 1000;
/** How many of a user's copies one Prepare looks at, oldest first. */
const SEEDANCE_ASSET_TRACK_TIDY_LIMIT = 100;
/** A copy's name: when it was stored, in milliseconds, then a random id. */
const SEEDANCE_ASSET_TRACK_NAME = /^(\d{13})-[0-9a-f-]{36}\.wav$/;

/**
 * Keeps a track Seedance's Prepare converted (`convertReferenceTrackIfRefused`) where Kie can
 * fetch it, and answers the link it is sent: `generation_inputs/<userId>/seedance-asset-tracks/
 * <milliseconds>-<uuid>.wav`. The asset is Kie's once it is made, and the link lasts an hour, as
 * the creator's own track's did, so the copy is needed only while Kie fetches it: no row names
 * it. Each copy stored removes the user's copies past `SEEDANCE_ASSET_TRACK_KEEP_MS`, read from
 * their names (`tidySeedanceAssetTracks`); the orphan finder (storage-orphans) lists any left
 * once they are a week old, and account deletion clears the folder with the user's others.
 */
export async function storeSeedanceAssetTrack(params: {
  supabase: SupabaseClient;
  userId: string;
  wav: Buffer;
  now?: () => number;
}): Promise<string> {
  const { supabase } = params;
  const now = params.now ?? Date.now;
  const folder = `${params.userId}/${SEEDANCE_ASSET_TRACKS_FOLDER}`;
  const fileName = `${now()}-${randomUUID()}.wav`;
  const filePath = `${folder}/${fileName}`;
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
  await tidySeedanceAssetTracks({ supabase, folder, keep: fileName, cutoff: now() - SEEDANCE_ASSET_TRACK_KEEP_MS });
  return signed.data.signedUrl;
}

/**
 * Removes the user's Prepare copies stored before `cutoff`, never `keep`, the one just stored.
 * Their names start with when they were stored, so the listing in name order is oldest first,
 * and a name of any other shape is left alone. A failure is logged, not thrown: the copy just
 * stored is good, and the orphan finder lists anything left.
 */
async function tidySeedanceAssetTracks(params: {
  supabase: SupabaseClient;
  folder: string;
  keep: string;
  cutoff: number;
}): Promise<void> {
  try {
    const bucket = params.supabase.storage.from(GENERATION_INPUTS_BUCKET);
    const { data, error } = await bucket.list(params.folder, {
      limit: SEEDANCE_ASSET_TRACK_TIDY_LIMIT,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;
    const stale = (data ?? []).flatMap(({ name }) => {
      const storedAt = SEEDANCE_ASSET_TRACK_NAME.exec(name)?.[1];
      return storedAt && name !== params.keep && Number(storedAt) < params.cutoff ? [`${params.folder}/${name}`] : [];
    });
    if (stale.length === 0) return;
    const { error: removeError } = await bucket.remove(stale);
    if (removeError) throw removeError;
  } catch (error) {
    logBackendWarning('seedance_asset_track_tidy_failed', { error });
  }
}

/** Removes the copies a run stored for a provider that never took the run. A failure is logged, not thrown. */
export async function removeConvertedReferenceTracks(params: {
  supabase: SupabaseClient;
  filePaths: string[];
}): Promise<void> {
  try {
    const { error } = await params.supabase.storage.from(GENERATION_INPUTS_BUCKET).remove(params.filePaths);
    if (error) throw error;
  } catch (error) {
    logBackendError('failed_to_remove_unsent_reference_track_copies', { count: params.filePaths.length, error });
  }
}
