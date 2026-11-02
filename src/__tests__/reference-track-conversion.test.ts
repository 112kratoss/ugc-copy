// @vitest-environment node
// Node's Blob, which the server streams a track from: jsdom's has no stream().
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  convertReferenceTrack,
  ReferenceTrackUnreadableError,
} from '@/lib/reference-track-conversion';
import { getFfmpegPath } from '@/lib/video-poster';
import { probeVideoFile } from '@/lib/video-rendition';

const UPLOADED = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1/1-voice-memo.m4a?token=t';
const COPY_LINK = /^https:\/\/project\.supabase\.co\/storage\/v1\/object\/sign\/generation_inputs\/user-1\/converted-tracks\/[0-9a-f]{64}\.wav\?token=s$/;

type UploadCall = { bucket: string; filePath: string; body: unknown; options: Record<string, unknown> };

function encodeFixture(file: string, args: string[]) {
  const encoded = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', ...args, '-y', file], { encoding: 'utf8' });
  if (encoded.status !== 0) throw new Error(`Could not encode the track fixture: ${encoded.stderr}`);
}

/** Storage holding `objects` by bucket and path, answering uploads with `uploadError` when given. */
function storageMock(objects: Record<string, Uint8Array<ArrayBuffer>>, uploadError: Record<string, unknown> | null = null) {
  const uploads: UploadCall[] = [];
  const downloads: string[] = [];
  const supabase = {
    storage: {
      from: vi.fn((bucket: string) => ({
        download: vi.fn(async (filePath: string) => {
          downloads.push(`${bucket}/${filePath}`);
          const bytes = objects[`${bucket}/${filePath}`];
          return bytes
            ? { data: new Blob([bytes], { type: 'audio/mp4' }), error: null }
            : { data: null, error: { message: 'Object not found' } };
        }),
        upload: vi.fn(async (filePath: string, body: unknown, options: Record<string, unknown>) => {
          uploads.push({ bucket, filePath, body, options });
          return { data: uploadError ? null : { path: filePath }, error: uploadError };
        }),
        createSignedUrl: vi.fn(async (filePath: string, expiresIn: number) => ({
          data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/${bucket}/${filePath}?token=s`, expiresIn },
          error: null,
        })),
      })),
    },
  };
  return { supabase: supabase as unknown as SupabaseClient, uploads, downloads };
}

describe('convertReferenceTrack', () => {
  let directory = '';
  let voiceMemo: Uint8Array<ArrayBuffer>;
  let longMemo: Uint8Array<ArrayBuffer>;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'magicbooklet-track-conversion-'));
    // An iPhone Voice Memo: AAC in an MPEG-4 container, mono, 48 kHz.
    const memo = path.join(directory, 'voice-memo.m4a');
    encodeFixture(memo, ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'aac', '-b:a', '64k']);
    voiceMemo = new Uint8Array(await readFile(memo));
    // Seventy seconds, longer than any model takes: its WAV copy is past Kie's 10 MB file limit.
    const long = path.join(directory, 'long-memo.m4a');
    encodeFixture(long, ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=70', '-c:a', 'aac', '-b:a', '32k']);
    longMemo = new Uint8Array(await readFile(long));
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('converts an AAC .m4a the caller uploaded to a 16-bit PCM WAV in their generation_inputs folder, and answers its link', async () => {
    const { supabase, uploads, downloads } = storageMock({ 'uploads/user-1/1-voice-memo.m4a': voiceMemo });

    const link = await convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED });

    expect(link).toMatch(COPY_LINK);
    expect(downloads).toEqual(['uploads/user-1/1-voice-memo.m4a']);
    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    expect(upload.bucket).toBe('generation_inputs');
    expect(link).toContain(upload.filePath);
    expect(upload.options).toMatchObject({ contentType: 'audio/wav', upsert: false });
    // A Node Buffer would be stored as its UTF-8 text (AGENTS.md); storage takes a Blob.
    expect(upload.body).toBeInstanceOf(Blob);
    const bytes = Buffer.from(await (upload.body as Blob).arrayBuffer());
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WAVE');

    const copy = path.join(directory, 'copy.wav');
    await writeFile(copy, bytes);
    const probe = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', copy], { encoding: 'utf8' });
    expect(probe.stderr).toMatch(/Audio: pcm_s16le[^\n]*44100 Hz[^\n]*(?:stereo|2 channels)/);
    const { durationSeconds } = await probeVideoFile(copy);
    expect(durationSeconds).toBeCloseTo(2, 1);
  });

  it('names the copy by its content, so the same track converted again finds its copy already there', async () => {
    const first = storageMock({ 'uploads/user-1/1-voice-memo.m4a': voiceMemo });
    const firstLink = await convertReferenceTrack({ supabase: first.supabase, userId: 'user-1', link: UPLOADED });

    const again = storageMock(
      { 'uploads/user-1/1-voice-memo.m4a': voiceMemo },
      { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' },
    );
    const secondLink = await convertReferenceTrack({ supabase: again.supabase, userId: 'user-1', link: UPLOADED });

    expect(secondLink).toBe(firstLink);
    expect(again.uploads[0].filePath).toBe(first.uploads[0].filePath);
  });

  it('refuses a file ffmpeg cannot read as unreadable, and keeps nothing', async () => {
    const noise = new Uint8Array(4096).map((_, index) => (index * 7919) % 251);
    const { supabase, uploads } = storageMock({ 'uploads/user-1/1-voice-memo.m4a': noise });

    const conversion = convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED });
    await expect(conversion).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
    await expect(conversion).rejects.toThrow(/^ffmpeg exited with code/);
    expect(uploads).toEqual([]);
  });

  it('opens nothing a playlist named .m4a points at', async () => {
    const playlist = new TextEncoder().encode('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n');
    const { supabase, uploads } = storageMock({ 'uploads/user-1/1-voice-memo.m4a': playlist });

    const conversion = convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED });
    await expect(conversion).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
    await expect(conversion).rejects.toThrow(/Format not on whitelist/);
    expect(uploads).toEqual([]);
  });

  it('refuses a track whose WAV copy would pass Kie’s 10 MB file limit, rather than cutting it', async () => {
    const { supabase, uploads } = storageMock({ 'uploads/user-1/1-voice-memo.m4a': longMemo });

    const conversion = convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED });
    await expect(conversion).rejects.toBeInstanceOf(ReferenceTrackUnreadableError);
    await expect(conversion).rejects.toThrow('The track is longer than any model takes.');
    expect(uploads).toEqual([]);
  });

  it('answers a storage failure as one, not as the creator’s file', async () => {
    const { supabase } = storageMock(
      { 'uploads/user-1/1-voice-memo.m4a': voiceMemo },
      { statusCode: '500', error: 'Internal', message: 'storage is down' },
    );

    const conversion = convertReferenceTrack({ supabase, userId: 'user-1', link: UPLOADED });
    await expect(conversion).rejects.toThrow();
    await expect(conversion).rejects.not.toBeInstanceOf(ReferenceTrackUnreadableError);
  });

  it('reads any other track through the allowlisted fetch, never another account’s object with the service key', async () => {
    const { supabase, uploads, downloads } = storageMock({ 'uploads/user-2/1-voice-memo.m4a': voiceMemo });
    const openRemoteMedia = vi.fn(async () => ({
      body: new Blob([voiceMemo]).stream(),
      contentLength: voiceMemo.byteLength,
      contentType: 'audio/mp4',
      sourceName: 'voice-memo.m4a',
    }));

    const someoneElses = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-2/1-voice-memo.m4a?token=t';
    await expect(convertReferenceTrack({ supabase, userId: 'user-1', link: someoneElses, openRemoteMedia }))
      .resolves.toMatch(COPY_LINK);
    await expect(convertReferenceTrack({ supabase, userId: 'user-1', link: 'https://cdn.example.com/voice-memo.m4a', openRemoteMedia }))
      .resolves.toMatch(COPY_LINK);

    expect(openRemoteMedia.mock.calls).toEqual([
      [{ url: someoneElses, kind: 'audio' }],
      [{ url: 'https://cdn.example.com/voice-memo.m4a', kind: 'audio' }],
    ]);
    expect(downloads).toEqual([]);
    expect(uploads.map((upload) => upload.filePath.split('/').slice(0, 2).join('/'))).toEqual([
      'user-1/converted-tracks',
      'user-1/converted-tracks',
    ]);
  });
});
