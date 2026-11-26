import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REFERENCE_MEDIA_DEMUXERS, TRACK_DEMUXERS, VIDEO_DEMUXERS } from '@/lib/media-demuxers';
import { buildVideoPosterArgs, getFfmpegPath } from '@/lib/video-poster';
import { buildDurationProbeArgs, buildRenditionArgs, probeVideoFile } from '@/lib/video-rendition';

/**
 * Security audit, 2026-11-26. An upload is admitted on the type it declares,
 * and ffmpeg picks its demuxer from the bytes. A text playlist stored as
 * `video/mp4` is read by the HLS demuxer, which then opens every entry the
 * playlist names: for the duration probe of a reference, which reads over
 * HTTPS, that is a request from the server to any host and port the uploader
 * chose. `reference-track-conversion.ts` already named its demuxers for this
 * reason; these tests hold every other ffmpeg input to the same rule.
 */

function optionBeforeInput(args: string[], option: string): string | undefined {
  const input = args.indexOf('-i');
  const at = args.indexOf(option);
  return at >= 0 && at < input ? args[at + 1] : undefined;
}

describe('every ffmpeg input names the containers it may be', () => {
  it('lists no demuxer that opens other files', () => {
    for (const list of [VIDEO_DEMUXERS, TRACK_DEMUXERS, REFERENCE_MEDIA_DEMUXERS]) {
      const names = list.split(',');
      for (const scripted of ['hls', 'applehttp', 'concat', 'dash', 'image2', 'lavfi', 'sdp', 'rtsp', 'tedcaptions', 'subfile']) {
        expect(names).not.toContain(scripted);
      }
    }
    // A reference is a clip or a track, so its probe reads either.
    expect(new Set(REFERENCE_MEDIA_DEMUXERS.split(','))).toEqual(
      new Set([...VIDEO_DEMUXERS.split(','), ...TRACK_DEMUXERS.split(',')]),
    );
  });

  it('holds the remote duration probe to HTTPS and to those containers', () => {
    const args = buildDurationProbeArgs('https://example.com/clip.mp4');
    expect(optionBeforeInput(args, '-protocol_whitelist')).toBe('https,tls,tcp');
    expect(optionBeforeInput(args, '-format_whitelist')).toBe(REFERENCE_MEDIA_DEMUXERS);
    expect(args.at(-1)).toBe('https://example.com/clip.mp4');
  });

  it('holds the rendition and the poster to local video files', () => {
    for (const args of [
      buildRenditionArgs('/tmp/in.mp4', '/tmp/out.mp4'),
      buildVideoPosterArgs('/tmp/in.mp4', '/tmp/frame.jpg', '00:00:01.000'),
    ]) {
      expect(optionBeforeInput(args, '-protocol_whitelist')).toBe('file');
      expect(optionBeforeInput(args, '-format_whitelist')).toBe(VIDEO_DEMUXERS);
    }
  });
});

describe('a playlist stored as a video is not followed', () => {
  let directory = '';
  let clip = '';
  let playlist = '';
  let remotePlaylist = '';

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'magicbooklet-ffmpeg-formats-'));
    clip = path.join(directory, 'clip.mp4');
    const encoded = spawnSync(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=2',
      '-y', clip,
    ], { encoding: 'utf8' });
    if (encoded.status !== 0) throw new Error(`Could not encode the fixture: ${encoded.stderr}`);

    // What an uploader can store under a video's name and type: a playlist
    // naming another file on this machine, and one naming another server.
    playlist = path.join(directory, 'looks-like-a-video.mp4');
    await writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n${clip}\n#EXT-X-ENDLIST\n`);
    remotePlaylist = path.join(directory, 'looks-like-a-reference.mp4');
    await writeFile(remotePlaylist, '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nhttps://127.0.0.1:9/segment.ts\n#EXT-X-ENDLIST\n');
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('reads a real clip', async () => {
    await expect(probeVideoFile(clip)).resolves.toMatchObject({ durationSeconds: 2 });
  });

  it('does not read another local file through a playlist', async () => {
    // Before the rule this answered the clip's two seconds: ffmpeg had opened
    // the file the playlist named.
    await expect(probeVideoFile(playlist)).resolves.toMatchObject({ durationSeconds: null });
  });

  it('does not connect where a playlist points', () => {
    // The probe's own arguments, with `file` added so the playlist can be read
    // from disk here; in production it arrives over HTTPS.
    const args = buildDurationProbeArgs(remotePlaylist);
    args[args.indexOf('-protocol_whitelist') + 1] = 'file,https,tls,tcp';
    const run = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', timeout: 20_000 });
    expect(run.stderr).not.toMatch(/Opening 'https:\/\/127\.0\.0\.1/);
    expect(run.stderr).toMatch(/not on whitelist/i);
  });

  it('still reads the containers a reference may be', () => {
    for (const [name, encoder] of [
      ['clip.webm', ['-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=1', '-c:v', 'libvpx', '-b:v', '50k']],
      ['clip.mov', ['-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=1']],
      ['track.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame']],
      ['track.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']],
      ['track.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac']],
      ['track.ogg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libvorbis']],
    ] as const) {
      const file = path.join(directory, name);
      const made = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', ...encoder, '-y', file], { encoding: 'utf8' });
      expect(made.status, `${name}: ${made.stderr}`).toBe(0);
      const args = buildDurationProbeArgs(file);
      args[args.indexOf('-protocol_whitelist') + 1] = 'file';
      const run = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', timeout: 20_000 });
      expect(run.stderr, name).toMatch(/Duration: 00:00:0[01]/);
    }
  });
});
