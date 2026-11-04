// @vitest-environment node
// Node's Blob, which the server streams a track from: jsdom's has no stream().
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  convertReferenceTrack,
  ReferenceTrackUnreadableError,
  removeConvertedReferenceTracks,
  storeConvertedReferenceTrack,
} from '@/lib/reference-track-conversion';
import { RemoteMediaSecurityError } from '@/lib/remote-media-security';
import { getFfmpegPath } from '@/lib/video-poster';
import { probeVideoFile } from '@/lib/video-rendition';

// The remote half is staged-remote-media's own (its tests fetch through it); here it stages fixtures.
const stagedRemoteMedia = vi.hoisted(() => ({ stageAllowlistedRemoteMedia: vi.fn() }));
vi.mock('@/lib/staged-remote-media', () => stagedRemoteMedia);

const UPLOADED = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1/1-voice-memo.m4a?token=t';
const UPLOADED_OBJECT = 'uploads/user-1/1-voice-memo.m4a';

function encodeFixture(file: string, args: string[]) {
  const encoded = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', ...args, '-y', file], { encoding: 'utf8' });
  if (encoded.status !== 0) throw new Error(`Could not encode the track fixture: ${encoded.stderr}`);
}

/** Storage holding `objects` by bucket and path; `sizes` overrides what info() reports. */
function storageMock(
  objects: Record<string, Uint8Array<ArrayBuffer>>,
  options: { sizes?: Record<string, number>; infoError?: boolean; uploadError?: Record<string, unknown> } = {},
) {
  const calls: string[] = [];
  const uploads: Array<{ bucket: string; filePath: string; body: unknown; options: Record<string, unknown> }> = [];
  const supabase = {
    storage: {
      from: vi.fn((bucket: string) => ({
        info: vi.fn(async (filePath: string) => {
          calls.push(`info ${bucket}/${filePath}`);
          const bytes = objects[`${bucket}/${filePath}`];
          if (options.infoError || !bytes) return { data: null, error: { message: 'Object not found' } };
          return { data: { size: options.sizes?.[`${bucket}/${filePath}`] ?? bytes.byteLength }, error: null };
        }),
        download: vi.fn(async (filePath: string) => {
          calls.push(`download ${bucket}/${filePath}`);
          const bytes = objects[`${bucket}/${filePath}`];
          return bytes
            ? { data: new Blob([bytes], { type: 'audio/mp4' }), error: null }
            : { data: null, error: { message: 'Object not found' } };
        }),
        upload: vi.fn(async (filePath: string, body: unknown, uploadOptions: Record<string, unknown>) => {
          uploads.push({ bucket, filePath, body, options: uploadOptions });
          return { data: options.uploadError ? null : { path: filePath }, error: options.uploadError ?? null };
        }),
        createSignedUrl: vi.fn(async (filePath: string, expiresIn: number) => {
          calls.push(`sign ${bucket}/${filePath} ${expiresIn}`);
          return { data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/${bucket}/${filePath}?token=s` }, error: null };
        }),
      })),
    },
  };
  return { supabase: supabase as unknown as SupabaseClient, calls, uploads };
}

describe('convertReferenceTrack', () => {
  let directory = '';
  const fixtures: Record<'memo' | 'stereo' | 'surround' | 'long', Uint8Array<ArrayBuffer>> = {} as never;

  async function probe(wav: Buffer) {
    const file = path.join(directory, `${randomUUID()}.wav`);
    await writeFile(file, wav);
    return {
      stderr: spawnSync(getFfmpegPath(), ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr,
      durationSeconds: (await probeVideoFile(file)).durationSeconds,
    };
  }

  /** What stageAllowlistedRemoteMedia answers: the bytes in a file, with a lease the encoder can inherit. */
  async function staged(bytes: Uint8Array<ArrayBuffer>) {
    const filePath = path.join(directory, `staged-${randomUUID()}`);
    await writeFile(filePath, bytes);
    const handle = await open(filePath, 'r');
    return {
      filePath,
      readerLeaseFd: handle.fd,
      contentLength: bytes.byteLength,
      contentType: 'audio/mp4',
      sourceName: 'voice-memo.m4a',
      cleanup: vi.fn(async () => { await handle.close(); }),
    };
  }

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'magicbooklet-track-conversion-'));
    const encode = async (name: keyof typeof fixtures, args: string[]) => {
      const file = path.join(directory, `${name}.m4a`);
      encodeFixture(file, [...args, '-c:a', 'aac', '-b:a', '64k']);
      fixtures[name] = new Uint8Array(await readFile(file));
    };
    // An iPhone Voice Memo: AAC in an MPEG-4 container, mono, 48 kHz.
    await encode('memo', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2']);
    await encode('stereo', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '2']);
    await encode('surround', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', 'pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0']);
    // Seventy seconds, longer than any model takes: its WAV copy is past Kie's 10 MB file limit.
    await encode('long', ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=70', '-ac', '2']);
  });

  afterEach(() => {
    stagedRemoteMedia.stageAllowlistedRemoteMedia.mockReset();
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('converts an AAC .m4a the caller uploaded to a 16-bit PCM WAV in its own channels, sizing it before reading it', async () => {
    const { supabase, calls, uploads } = storageMock({ [UPLOADED_OBJECT]: fixtures.memo });

    const wav = await convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED });

    expect(calls).toEqual([`info ${UPLOADED_OBJECT}`, `download ${UPLOADED_OBJECT}`]);
    // Nothing is kept before the run is held.
    expect(uploads).toEqual([]);
    expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('latin1')).toBe('WAVE');
    const { stderr, durationSeconds } = await probe(wav);
    // A mono memo stays mono: a stereo copy would double its bytes for nothing.
    expect(stderr).toMatch(/Audio: pcm_s16le[^\n]*44100 Hz[^\n]*(?:mono|1 channels)/);
    expect(durationSeconds).toBeCloseTo(2, 1);
  });

  it('keeps stereo, folds more channels to stereo, and answers the same bytes for the same track', async () => {
    const { supabase } = storageMock({ 'uploads/user-1/1-stereo.m4a': fixtures.stereo, 'uploads/user-1/1-surround.m4a': fixtures.surround });
    const link = (name: string) => `https://project.supabase.co/storage/v1/object/sign/uploads/user-1/1-${name}.m4a?token=t`;

    const stereo = await convertReferenceTrack({ supabase, userId: 'user-1', link: link('stereo') });
    const surround = await convertReferenceTrack({ supabase, userId: 'user-1', link: link('surround') });

    expect((await probe(stereo)).stderr).toMatch(/Audio: pcm_s16le[^\n]*(?:stereo|2 channels)/);
    expect((await probe(surround)).stderr).toMatch(/Audio: pcm_s16le[^\n]*(?:stereo|2 channels)/);
    expect(await convertReferenceTrack({ supabase, userId: 'user-1', link: link('stereo') })).toEqual(stereo);
  });

  it('refuses a file ffmpeg cannot read as unreadable', async () => {
    const noise = new Uint8Array(4096).map((_, index) => (index * 7919) % 251);
    const { supabase } = storageMock({ [UPLOADED_OBJECT]: noise });

    const conversion = convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED });
    await expect(conversion).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
    await expect(conversion).rejects.toMatchObject({ tooLong: false, message: expect.stringMatching(/^ffmpeg exited with code/) });
  });

  it('reads "Cannot allocate memory" as the track’s fault, and a full disk as the machine’s', async () => {
    // A damaged header (a chunk table claiming 2^31 entries) makes ffmpeg 6.0 say this, while the
    // Linux build CI and Vercel run reads past it: a stand-in encoder says it on every machine.
    const say = async (name: string, message: string) => {
      const encoder = path.join(directory, name);
      await writeFile(encoder, `#!/bin/sh\necho '${message}' >&2\nexit 1\n`, { mode: 0o755 });
      return encoder;
    };
    const previous = process.env.FFMPEG_PATH;
    try {
      process.env.FFMPEG_PATH = await say('ffmpeg-enomem', '[mov,mp4,m4a] stco: Cannot allocate memory');
      const damaged = convertReferenceTrack({ supabase: storageMock({ [UPLOADED_OBJECT]: fixtures.memo }).supabase, userId: 'user-1', link: UPLOADED });
      await expect(damaged).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
      await expect(damaged).rejects.toThrow(/Cannot allocate memory/);

      process.env.FFMPEG_PATH = await say('ffmpeg-enospc', 'Error writing trailer: No space left on device');
      const full = convertReferenceTrack({ supabase: storageMock({ [UPLOADED_OBJECT]: fixtures.memo }).supabase, userId: 'user-1', link: UPLOADED });
      await expect(full).rejects.toThrow(/could not convert the track \(exit 1\)/);
      await expect(full).rejects.not.toBeInstanceOf(ReferenceTrackUnreadableError);
    } finally {
      if (previous === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = previous;
    }
  });

  it('opens nothing a playlist named .m4a points at', async () => {
    const playlist = new TextEncoder().encode('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n');
    const { supabase } = storageMock({ [UPLOADED_OBJECT]: playlist });

    const conversion = convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED });
    await expect(conversion).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
    // ffmpeg 6.0 (macOS) stops at the format whitelist; the Linux build CI and Vercel run refuses
    // an HLS playlist without an .m3u8 name before that.
    await expect(conversion).rejects.toThrow(/Format not on whitelist|Not detecting m3u8\/hls with non standard extension/);
  });

  it('refuses a track whose WAV copy would pass Kie’s 10 MB file limit as too long, rather than cutting it', async () => {
    const { supabase } = storageMock({ [UPLOADED_OBJECT]: fixtures.long });

    await expect(convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED }))
      .rejects.toMatchObject({ name: 'ReferenceTrackUnreadableError', tooLong: true, message: 'The track is longer than any model takes.' });
  });

  it('refuses an object larger than any audio upload without reading it into memory', async () => {
    // Any object of the caller's can be sent as a track: a 250 MB video upload among them.
    const { supabase, calls } = storageMock({ [UPLOADED_OBJECT]: fixtures.memo }, { sizes: { [UPLOADED_OBJECT]: 250 * 1024 * 1024 } });

    await expect(convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED }))
      .rejects.toMatchObject({ name: 'ReferenceTrackUnreadableError', tooLong: true });
    expect(calls).toEqual([`info ${UPLOADED_OBJECT}`]);
  });

  it('answers a storage failure, or an encoder that cannot start, as not the track’s fault', async () => {
    const unreachable = storageMock({ [UPLOADED_OBJECT]: fixtures.memo }, { infoError: true });
    const conversion = convertReferenceTrack({ supabase: unreachable.supabase, userId: 'user-1', link: UPLOADED });
    await expect(conversion).rejects.toThrow('The track could not be found in storage');
    await expect(conversion).rejects.not.toBeInstanceOf(ReferenceTrackUnreadableError);

    const previous = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = path.join(directory, 'no-such-ffmpeg');
    try {
      const { supabase } = storageMock({ [UPLOADED_OBJECT]: fixtures.memo });
      const broken = convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED });
      // The limit wrapper's exec fails (127 under dash, 126 under macOS's sh): the machine, not the memo.
      await expect(broken).rejects.toThrow(/could not convert the track \(exit 12[67]\)/);
      await expect(broken).rejects.not.toBeInstanceOf(ReferenceTrackUnreadableError);
    } finally {
      if (previous === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = previous;
    }
  });

  it('reads any other track through the remote import, never another account’s object with the service key', async () => {
    const { supabase, calls } = storageMock({ 'uploads/user-2/1-voice-memo.m4a': fixtures.memo });
    const stagings: Array<Awaited<ReturnType<typeof staged>>> = [];
    stagedRemoteMedia.stageAllowlistedRemoteMedia.mockImplementation(async () => {
      stagings.push(await staged(fixtures.memo));
      return stagings.at(-1);
    });

    const someoneElses = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-2/1-voice-memo.m4a?token=t';
    for (const link of [someoneElses, 'https://cdn.example.com/voice-memo.m4a']) {
      const wav = await convertReferenceTrack({ supabase, userId: 'user-1', link });
      expect(wav.subarray(8, 12).toString('latin1')).toBe('WAVE');
    }

    expect(stagedRemoteMedia.stageAllowlistedRemoteMedia.mock.calls).toEqual([
      [{ url: someoneElses, kind: 'audio' }],
      [{ url: 'https://cdn.example.com/voice-memo.m4a', kind: 'audio' }],
    ]);
    expect(calls).toEqual([]);
    for (const staging of stagings) expect(staging.cleanup).toHaveBeenCalledTimes(1);
  });

  it('reads a remote refusal as the file’s, unless the host answered busy', async () => {
    const { supabase } = storageMock({});
    const link = 'https://cdn.example.com/voice-memo.m4a';
    const refuse = (error: Error) => stagedRemoteMedia.stageAllowlistedRemoteMedia.mockRejectedValueOnce(error);

    refuse(new RemoteMediaSecurityError('Remote response is not valid audio media.'));
    await expect(convertReferenceTrack({ supabase, userId: 'user-1', link })).rejects.toMatchObject({ name: 'ReferenceTrackUnreadableError', tooLong: false });
    refuse(new RemoteMediaSecurityError('Remote media request failed with status 404.', { status: 404 }));
    await expect(convertReferenceTrack({ supabase, userId: 'user-1', link })).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
    refuse(new RemoteMediaSecurityError('Remote media exceeds the allowed size.'));
    await expect(convertReferenceTrack({ supabase, userId: 'user-1', link })).rejects.toMatchObject({ tooLong: true });

    refuse(new RemoteMediaSecurityError('Remote media request failed with status 503.', { status: 503 }));
    await expect(convertReferenceTrack({ supabase, userId: 'user-1', link })).rejects.not.toBeInstanceOf(ReferenceTrackUnreadableError);
    refuse(new TypeError('fetch failed'));
    await expect(convertReferenceTrack({ supabase, userId: 'user-1', link })).rejects.not.toBeInstanceOf(ReferenceTrackUnreadableError);
  });
});

describe('storeConvertedReferenceTrack', () => {
  const wav = Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ', 'latin1');

  it('keeps the copy in the held run’s own folder and answers a link to it', async () => {
    const { supabase, calls, uploads } = storageMock({});
    const onStored = vi.fn();

    const link = await storeConvertedReferenceTrack({ supabase, userId: 'user-1', generationId: 'gen-1', index: 3, wav, onStored });

    expect(onStored.mock.calls).toEqual([['user-1/gen-1/provider-tracks/03.wav']]);
    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    expect(upload).toMatchObject({ bucket: 'generation_inputs', filePath: 'user-1/gen-1/provider-tracks/03.wav' });
    expect(upload.options).toEqual({ contentType: 'audio/wav', upsert: false });
    // A Node Buffer would be stored as its UTF-8 text (AGENTS.md); storage takes a Blob.
    expect(upload.body).toBeInstanceOf(Blob);
    expect(Buffer.from(await (upload.body as Blob).arrayBuffer())).toEqual(wav);
    expect(calls).toEqual(['sign generation_inputs/user-1/gen-1/provider-tracks/03.wav 3600']);
    expect(link).toBe('https://project.supabase.co/storage/v1/object/sign/generation_inputs/user-1/gen-1/provider-tracks/03.wav?token=s');
  });

  it('throws when storage refuses the copy, an object already there included, and names no file stored', async () => {
    const { supabase } = storageMock({}, { uploadError: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } });
    const onStored = vi.fn();

    await expect(storeConvertedReferenceTrack({ supabase, userId: 'user-1', generationId: 'gen-1', index: 0, wav, onStored }))
      .rejects.toThrow('The converted track could not be stored: The resource already exists');
    expect(onStored).not.toHaveBeenCalled();
  });
});

describe('removeConvertedReferenceTracks', () => {
  it('removes the copies it is given, and logs a failure rather than throwing it', async () => {
    const removals: Array<{ bucket: string; paths: string[] }> = [];
    const client = (error: { message: string } | null) => ({
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            removals.push({ bucket, paths });
            return { data: null, error };
          },
        }),
      },
    }) as unknown as SupabaseClient;
    const filePaths = ['user-1/gen-1/provider-tracks/00.wav', 'user-1/gen-1/provider-tracks/01.wav'];

    await removeConvertedReferenceTracks({ supabase: client(null), filePaths });
    expect(removals).toEqual([{ bucket: 'generation_inputs', paths: filePaths }]);

    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(removeConvertedReferenceTracks({ supabase: client({ message: 'storage is down' }), filePaths })).resolves.toBeUndefined();
    expect(logError.mock.calls.flat().map(String).join('\n')).toContain('failed_to_remove_unsent_reference_track_copies');
    logError.mockRestore();
  });
});
