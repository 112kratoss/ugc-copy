// @vitest-environment node
// Node's Blob, which the server streams a track from: jsdom's has no stream().
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  convertReferenceTrackIfRefused,
  ReferenceTrackUnreadableError,
  removeConvertedReferenceTracks,
  storeConvertedReferenceTrack,
  storeSeedanceAssetTrack,
} from '@/lib/reference-track-conversion';
import { RemoteMediaSecurityError } from '@/lib/remote-media-security';
import { getFfmpegPath } from '@/lib/video-poster';
import { probeVideoFile } from '@/lib/video-rendition';

// The remote half is staged-remote-media's own (its tests fetch through it); here it stages fixtures.
const stagedRemoteMedia = vi.hoisted(() => ({ stageAllowlistedRemoteMedia: vi.fn() }));
vi.mock('@/lib/staged-remote-media', () => stagedRemoteMedia);

const UPLOADED = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1/1-voice-memo.m4a?token=t';
const UPLOADED_OBJECT = 'uploads/user-1/1-voice-memo.m4a';
// What Kie lists for every model that takes a track but Seedance 2.5 (provider-input-limits).
const KIE_FORMATS = ['wav', 'mp3'] as const;

function encodeFixture(file: string, args: string[]) {
  const encoded = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', ...args, '-y', file], { encoding: 'utf8' });
  if (encoded.status !== 0) throw new Error(`Could not encode the track fixture: ${encoded.stderr}`);
}

/** A track converted to WAV: these tracks' extensions are ones the provider refuses, so a WAV always comes back. */
async function converted(params: Parameters<typeof convertReferenceTrackIfRefused>[0]): Promise<Buffer> {
  const wav = await convertReferenceTrackIfRefused(params);
  if (!wav) throw new Error('The track was sent as it is, not converted.');
  return wav;
}

/** Storage holding `objects` by bucket and path; `sizes` overrides what info() reports. */
function storageMock(
  objects: Record<string, Uint8Array<ArrayBuffer>>,
  options: { sizes?: Record<string, number>; infoError?: boolean; uploadError?: Record<string, unknown>; signError?: boolean } = {},
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
          if (options.signError) return { data: null, error: { message: 'Signing failed' } };
          return { data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/${bucket}/${filePath}?token=s` }, error: null };
        }),
      })),
    },
  };
  return { supabase: supabase as unknown as SupabaseClient, calls, uploads };
}

describe('convertReferenceTrackIfRefused', () => {
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

    const wav = await converted({ supabase, userId: 'user-1', link: UPLOADED, formats: KIE_FORMATS });

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

    const stereo = await converted({ supabase, userId: 'user-1', link: link('stereo'), formats: KIE_FORMATS });
    const surround = await converted({ supabase, userId: 'user-1', link: link('surround'), formats: KIE_FORMATS });

    expect((await probe(stereo)).stderr).toMatch(/Audio: pcm_s16le[^\n]*(?:stereo|2 channels)/);
    expect((await probe(surround)).stderr).toMatch(/Audio: pcm_s16le[^\n]*(?:stereo|2 channels)/);
    expect(await convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link: link('stereo'), formats: KIE_FORMATS })).toEqual(stereo);
  });

  it('refuses a file ffmpeg cannot read as unreadable', async () => {
    const noise = new Uint8Array(4096).map((_, index) => (index * 7919) % 251);
    const { supabase } = storageMock({ [UPLOADED_OBJECT]: noise });

    const conversion = convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link: UPLOADED, formats: KIE_FORMATS });
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
      const damaged = convertReferenceTrackIfRefused({ supabase: storageMock({ [UPLOADED_OBJECT]: fixtures.memo }).supabase, userId: 'user-1', link: UPLOADED, formats: KIE_FORMATS });
      await expect(damaged).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
      await expect(damaged).rejects.toThrow(/Cannot allocate memory/);

      process.env.FFMPEG_PATH = await say('ffmpeg-enospc', 'Error writing trailer: No space left on device');
      const full = convertReferenceTrackIfRefused({ supabase: storageMock({ [UPLOADED_OBJECT]: fixtures.memo }).supabase, userId: 'user-1', link: UPLOADED, formats: KIE_FORMATS });
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

    const conversion = convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link: UPLOADED, formats: KIE_FORMATS });
    await expect(conversion).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
    // ffmpeg 6.0 (macOS) stops at the format whitelist; the Linux build CI and Vercel run refuses
    // an HLS playlist without an .m3u8 name before that.
    await expect(conversion).rejects.toThrow(/Format not on whitelist|Not detecting m3u8\/hls with non standard extension/);
  });

  it('refuses a track whose WAV copy would pass Kie’s 10 MB file limit as too long, rather than cutting it', async () => {
    const { supabase } = storageMock({ [UPLOADED_OBJECT]: fixtures.long });

    await expect(convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link: UPLOADED, formats: KIE_FORMATS }))
      .rejects.toMatchObject({ name: 'ReferenceTrackUnreadableError', tooLong: true, message: 'The track is longer than any model takes.' });
  });

  it('refuses an object larger than any audio upload without reading it into memory', async () => {
    // Any object of the caller's can be sent as a track: a 250 MB video upload among them.
    const { supabase, calls } = storageMock({ [UPLOADED_OBJECT]: fixtures.memo }, { sizes: { [UPLOADED_OBJECT]: 250 * 1024 * 1024 } });

    await expect(convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link: UPLOADED, formats: KIE_FORMATS }))
      .rejects.toMatchObject({ name: 'ReferenceTrackUnreadableError', tooLong: true });
    expect(calls).toEqual([`info ${UPLOADED_OBJECT}`]);
  });

  it('answers a storage failure, or an encoder that cannot start, as not the track’s fault', async () => {
    const unreachable = storageMock({ [UPLOADED_OBJECT]: fixtures.memo }, { infoError: true });
    const conversion = convertReferenceTrackIfRefused({ supabase: unreachable.supabase, userId: 'user-1', link: UPLOADED, formats: KIE_FORMATS });
    await expect(conversion).rejects.toThrow('The track could not be found in storage');
    await expect(conversion).rejects.not.toBeInstanceOf(ReferenceTrackUnreadableError);

    const previous = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = path.join(directory, 'no-such-ffmpeg');
    try {
      const { supabase } = storageMock({ [UPLOADED_OBJECT]: fixtures.memo });
      const broken = convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link: UPLOADED, formats: KIE_FORMATS });
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
      const wav = await converted({ supabase, userId: 'user-1', link, formats: KIE_FORMATS });
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
    await expect(convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link, formats: KIE_FORMATS })).rejects.toMatchObject({ name: 'ReferenceTrackUnreadableError', tooLong: false });
    refuse(new RemoteMediaSecurityError('Remote media request failed with status 404.', { status: 404 }));
    await expect(convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link, formats: KIE_FORMATS })).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
    refuse(new RemoteMediaSecurityError('Remote media exceeds the allowed size.'));
    await expect(convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link, formats: KIE_FORMATS })).rejects.toMatchObject({ tooLong: true });

    refuse(new RemoteMediaSecurityError('Remote media request failed with status 503.', { status: 503 }));
    await expect(convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link, formats: KIE_FORMATS })).rejects.not.toBeInstanceOf(ReferenceTrackUnreadableError);
    refuse(new TypeError('fetch failed'));
    await expect(convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link, formats: KIE_FORMATS })).rejects.not.toBeInstanceOf(ReferenceTrackUnreadableError);
  });
});

describe('convertReferenceTrackIfRefused: a track whose extension the provider takes', () => {
  let directory = '';
  const tracks: Record<'adts' | 'm4a' | 'mp3' | 'wav' | 'floatWav' | 'ogg', Uint8Array<ArrayBuffer>> = {} as never;
  const encoders = spawnSync(getFfmpegPath(), ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
  const hasEncoder = (encoder: string) => new RegExp(`^\\s*A\\S*\\s+${encoder}\\s`, 'm').test(encoders);

  const signed = (fileName: string) => `https://project.supabase.co/storage/v1/object/sign/uploads/user-1/1-${fileName}?token=t`;

  /** Storage holding `bytes` as the caller's `1-<fileName>`, and the link it is sent as. */
  function stored(fileName: string, bytes: Uint8Array<ArrayBuffer>) {
    return { ...storageMock({ [`uploads/user-1/1-${fileName}`]: bytes }), link: signed(fileName) };
  }

  /** An ID3v2.3 tag holding one PRIV frame of `payloadBytes`, as cover art or an encoder's private data would. */
  function bigId3Tag(payloadBytes: number): Uint8Array<ArrayBuffer> {
    const body = Buffer.concat([Buffer.from('owner@example.com\u0000', 'latin1'), Buffer.alloc(payloadBytes, 0x55)]);
    const frame = Buffer.alloc(10);
    frame.write('PRIV', 0, 'latin1');
    frame.writeUInt32BE(body.length, 4);
    const size = frame.length + body.length;
    const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    return new Uint8Array(Buffer.concat([header, frame, body]));
  }

  /** MPEG-1 Layer III frames at 128 kb/s and 44.1 kHz carrying silence, for an ffmpeg build without LAME. */
  function handBuiltMp3(): Uint8Array<ArrayBuffer> {
    const frame = Buffer.alloc(417);
    frame.set([0xff, 0xfb, 0x90, 0x64]);
    return new Uint8Array(Buffer.concat(Array.from({ length: 40 }, () => frame)));
  }

  /** Runs `work` with an encoder that cannot start: an answer then proves nothing was encoded. */
  async function withoutEncoder<T>(work: () => Promise<T>): Promise<T> {
    const previous = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = path.join(directory, 'no-such-ffmpeg');
    try {
      return await work();
    } finally {
      if (previous === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = previous;
    }
  }

  function mismatches(warn: { mock: { calls: unknown[][] } }) {
    return warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((record) => JSON.stringify(record).includes('reference_track_extension_mismatch'));
  }

  async function expectWav(wav: Buffer | null) {
    expect(wav).not.toBeNull();
    expect(wav!.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(wav!.subarray(8, 12).toString('latin1')).toBe('WAVE');
    const file = path.join(directory, `${randomUUID()}.wav`);
    await writeFile(file, wav!);
    expect(spawnSync(getFfmpegPath(), ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr).toMatch(/Audio: pcm_s16le[^\n]*44100 Hz/);
  }

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'magicbooklet-track-sniff-'));
    const encode = async (name: keyof typeof tracks, args: string[]) => {
      const file = path.join(directory, `fixture-${name}`);
      encodeFixture(file, ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', ...args]);
      tracks[name] = new Uint8Array(await readFile(file));
    };
    await encode('adts', ['-c:a', 'aac', '-b:a', '64k', '-f', 'adts']);
    await encode('m4a', ['-c:a', 'aac', '-b:a', '64k', '-f', 'ipod']);
    await encode('wav', ['-c:a', 'pcm_s16le', '-f', 'wav']);
    await encode('floatWav', ['-c:a', 'pcm_f32le', '-f', 'wav']);
    const oggCodec = hasEncoder('libvorbis') ? 'libvorbis' : hasEncoder('libopus') ? 'libopus' : 'flac';
    await encode('ogg', ['-c:a', oggCodec, '-f', 'ogg']);
    if (hasEncoder('libmp3lame')) await encode('mp3', ['-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3']);
    else tracks.mp3 = handBuiltMp3();
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('sends a real MP3 named .mp3 and a PCM WAV named .wav as they are, encoding nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const [fileName, bytes] of [['beat.mp3', tracks.mp3], ['take.wav', tracks.wav]] as const) {
        const { supabase, link, uploads } = stored(fileName, bytes);
        await expect(withoutEncoder(() => convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link, formats: KIE_FORMATS })), fileName)
          .resolves.toBeNull();
        expect(uploads).toEqual([]);
      }
      expect(mismatches(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads past an ID3 tag longer than the bytes it checks, and more than one', async () => {
    const tag = bigId3Tag(20_000);
    expect(tag.length).toBeGreaterThan(4096);
    for (const bytes of [
      new Uint8Array(Buffer.concat([tag, tracks.mp3])),
      new Uint8Array(Buffer.concat([tag, bigId3Tag(100), tracks.mp3])),
    ]) {
      const { supabase, link } = stored('cover-art.mp3', bytes);
      await expect(withoutEncoder(() => convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link, formats: KIE_FORMATS })))
        .resolves.toBeNull();
    }
  });

  it('converts AAC named .mp3 and an .m4a renamed .wav, as their names lie about them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const aac = stored('beat.mp3', tracks.adts);
      await expectWav(await convertReferenceTrackIfRefused({ supabase: aac.supabase, userId: 'user-1', link: aac.link, formats: KIE_FORMATS }));
      const memo = stored('voice-memo.wav', tracks.m4a);
      await expectWav(await convertReferenceTrackIfRefused({ supabase: memo.supabase, userId: 'user-1', link: memo.link, formats: KIE_FORMATS }));
      expect(mismatches(warn)).toEqual([
        expect.objectContaining({ claimed: 'mp3', container: 'aac' }),
        expect.objectContaining({ claimed: 'wav', container: null }),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('converts a float WAV named .wav to 16-bit PCM', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { supabase, link } = stored('take.wav', tracks.floatWav);
      await expectWav(await convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link, formats: KIE_FORMATS }));
    } finally {
      warn.mockRestore();
    }
  });

  it('sends an Ogg named .ogg as it is to a provider that takes Ogg, and converts it named .mp3', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const formats = ['wav', 'mp3', 'aac', 'ogg'];
      const ogg = stored('beat.ogg', tracks.ogg);
      await expect(withoutEncoder(() => convertReferenceTrackIfRefused({ supabase: ogg.supabase, userId: 'user-1', link: ogg.link, formats })))
        .resolves.toBeNull();
      // Refused by its extension where Ogg is not listed.
      await expectWav(await convertReferenceTrackIfRefused({ supabase: ogg.supabase, userId: 'user-1', link: ogg.link, formats: KIE_FORMATS }));
      const renamed = stored('beat.mp3', tracks.ogg);
      await expectWav(await convertReferenceTrackIfRefused({ supabase: renamed.supabase, userId: 'user-1', link: renamed.link, formats }));
      // ADTS named .aac goes as it is where AAC is listed.
      const aac = stored('beat.aac', tracks.adts);
      await expect(withoutEncoder(() => convertReferenceTrackIfRefused({ supabase: aac.supabase, userId: 'user-1', link: aac.link, formats })))
        .resolves.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('converts a real MP3 named .MP3: Kie reads the extension exactly', async () => {
    const { supabase, link } = stored('BEAT.MP3', tracks.mp3);
    await expectWav(await convertReferenceTrackIfRefused({ supabase, userId: 'user-1', link, formats: KIE_FORMATS }));
  });
});

describe('storeSeedanceAssetTrack', () => {
  const wav = Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ÿþ', 'latin1');
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('keeps the copy under the hash of its bytes, overwriting the same copy, and answers an hour’s link to it', async () => {
    const { supabase, calls, uploads } = storageMock({});

    const link = await storeSeedanceAssetTrack({ supabase, userId: 'user-1', wav });

    const filePath = `user-1/seedance-asset-tracks/${digest(wav)}.wav`;
    expect(filePath).toMatch(/^user-1\/seedance-asset-tracks\/[0-9a-f]{64}\.wav$/);
    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    expect(upload).toMatchObject({ bucket: 'generation_inputs', filePath });
    expect(upload.options).toEqual({ contentType: 'audio/wav', upsert: true });
    // A Node Buffer would be stored as its UTF-8 text (AGENTS.md); storage takes a Blob.
    expect(upload.body).toBeInstanceOf(Blob);
    expect(Buffer.isBuffer(upload.body)).toBe(false);
    expect((upload.body as Blob).type).toBe('audio/wav');
    expect(Buffer.from(await (upload.body as Blob).arrayBuffer())).toEqual(wav);
    expect(calls).toEqual([`sign generation_inputs/${filePath} 3600`]);
    expect(link).toBe(`https://project.supabase.co/storage/v1/object/sign/generation_inputs/${filePath}?token=s`);
  });

  it('names the same bytes the same file, and other bytes or another user another', async () => {
    const { supabase, uploads } = storageMock({});

    await storeSeedanceAssetTrack({ supabase, userId: 'user-1', wav });
    await storeSeedanceAssetTrack({ supabase, userId: 'user-1', wav: Buffer.from(wav) });
    await storeSeedanceAssetTrack({ supabase, userId: 'user-1', wav: Buffer.concat([wav, Buffer.from([0])]) });
    await storeSeedanceAssetTrack({ supabase, userId: 'user-2', wav });

    const paths = uploads.map((upload) => upload.filePath);
    expect(paths[0]).toBe(paths[1]);
    expect(new Set(paths).size).toBe(3);
    expect(paths[3]).toBe(`user-2/seedance-asset-tracks/${digest(wav)}.wav`);
  });

  it('throws when storage refuses the copy, signing nothing, or cannot sign it', async () => {
    const refused = storageMock({}, { uploadError: { message: 'Bucket quota exceeded' } });
    await expect(storeSeedanceAssetTrack({ supabase: refused.supabase, userId: 'user-1', wav }))
      .rejects.toThrow('The converted track could not be stored: Bucket quota exceeded');
    expect(refused.calls).toEqual([]);

    const unsigned = storageMock({}, { signError: true });
    await expect(storeSeedanceAssetTrack({ supabase: unsigned.supabase, userId: 'user-1', wav }))
      .rejects.toThrow('The converted track could not be signed: Signing failed');
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
