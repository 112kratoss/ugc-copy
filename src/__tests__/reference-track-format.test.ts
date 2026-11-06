// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  id3v2TagLength,
  REFERENCE_TRACK_HEAD_BYTES,
  referenceTrackContainer,
} from '@/lib/reference-track-format';
import { getFfmpegPath } from '@/lib/video-poster';

const ENCODERS = spawnSync(getFfmpegPath(), ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
const hasEncoder = (encoder: string) => new RegExp(`^\\s*A\\S*\\s+${encoder}\\s`, 'm').test(ENCODERS);

const untagged = (head: Uint8Array) => referenceTrackContainer({ head, tagged: false });

function bytes(...parts: Array<string | number[] | Uint8Array>): Uint8Array {
  const chunks = parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part)));
  return new Uint8Array(Buffer.concat(chunks));
}

function le16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function le32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

/** An MPEG audio frame header: version 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 reserved; layer 1 = III, 2 = II, 3 = I. */
function mpegFrame({ version = 3, layer = 1, bitrate = 9, sampleRate = 0, crc = false } = {}): Uint8Array {
  const header = [0xff, 0xe0 | (version << 3) | (layer << 1) | (crc ? 0 : 1), (bitrate << 4) | (sampleRate << 2), 0xc4];
  return bytes(header, new Array(28).fill(0));
}

/** An ADTS header: `mpeg2` is the ID bit (1 = MPEG-2, 0 = MPEG-4); with a CRC, protection_absent is 0. */
function adtsFrame({ mpeg2 = false, crc = false, samplingIndex = 4 } = {}): Uint8Array {
  return bytes([0xff, 0xf0 | (mpeg2 ? 0x08 : 0) | (crc ? 0 : 1), (1 << 6) | (samplingIndex << 2), 0x80, 0x02, 0x1f, 0xfc], new Array(16).fill(0));
}

function chunk(id: string, body: Uint8Array | number[]): Uint8Array {
  const data = Uint8Array.from(body);
  return bytes(id, le32(data.length), data, data.length & 1 ? [0] : []);
}

function fmtChunk(format: number, { channels = 2, bits = 16 } = {}): Uint8Array {
  const blockAlign = (channels * bits) / 8;
  return chunk('fmt ', [...le16(format), ...le16(channels), ...le32(44100), ...le32(44100 * blockAlign), ...le16(blockAlign), ...le16(bits)]);
}

function extensibleFmtChunk(subFormat: number): Uint8Array {
  const base = [...le16(0xfffe), ...le16(2), ...le32(44100), ...le32(44100 * 4), ...le16(4), ...le16(16)];
  // cbSize, valid bits, channel mask, then the sub-format GUID, whose first two bytes name the codec.
  const extension = [...le16(22), ...le16(16), ...le32(3), ...le16(subFormat), 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
  return chunk('fmt ', [...base, ...extension]);
}

function wave(...chunks: Uint8Array[]): Uint8Array {
  const body = bytes('WAVE', ...chunks, chunk('data', new Array(64).fill(0)));
  return bytes('RIFF', le32(body.length), body);
}

/** An ID3v2.4 header for a tag body of `size` bytes. */
function id3Header(size: number, { flags = 0, version = 4 } = {}): Uint8Array {
  return bytes('ID3', [version, 0, flags, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
}

describe('id3v2TagLength', () => {
  it('reads the synchsafe size and adds the header, and the footer when the flag says there is one', () => {
    // 0x00 0x00 0x02 0x01 is 2 * 128 + 1.
    expect(id3v2TagLength(bytes('ID3', [4, 0, 0, 0x00, 0x00, 0x02, 0x01]))).toBe(10 + 257);
    expect(id3v2TagLength(id3Header(0))).toBe(10);
    expect(id3v2TagLength(id3Header(3 * 1024 * 1024))).toBe(10 + 3 * 1024 * 1024);
    expect(id3v2TagLength(bytes('ID3', [4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f]))).toBe(10 + 0x0fffffff);
    expect(id3v2TagLength(id3Header(257, { flags: 0x10 }))).toBe(10 + 257 + 10);
    expect(id3v2TagLength(id3Header(257, { flags: 0x40 }))).toBe(10 + 257);
    expect(id3v2TagLength(id3Header(100, { version: 3 }))).toBe(110);
  });

  it('reads only the first ten bytes', () => {
    expect(id3v2TagLength(bytes(id3Header(20), new Array(100).fill(0xff)))).toBe(30);
  });

  it('is 0 for no tag, an invalid one, or too few bytes', () => {
    expect(id3v2TagLength(bytes('ID4', [4, 0, 0, 0, 0, 0, 1]))).toBe(0);
    expect(id3v2TagLength(bytes('id3', [4, 0, 0, 0, 0, 0, 1]))).toBe(0);
    expect(id3v2TagLength(bytes('ID3', [0xff, 0, 0, 0, 0, 0, 1]))).toBe(0);
    expect(id3v2TagLength(bytes('ID3', [4, 0xff, 0, 0, 0, 0, 1]))).toBe(0);
    for (let index = 6; index < 10; index += 1) {
      const header = id3Header(1);
      header[index] |= 0x80;
      expect(id3v2TagLength(header), `size byte ${index}`).toBe(0);
    }
    expect(id3v2TagLength(id3Header(1).subarray(0, 9))).toBe(0);
    expect(id3v2TagLength(new Uint8Array(0))).toBe(0);
    expect(id3v2TagLength(mpegFrame())).toBe(0);
  });
});

describe('referenceTrackContainer', () => {
  describe('MP3', () => {
    it('takes an MPEG-1, 2 or 2.5 Layer III frame, with or without a CRC', () => {
      for (const version of [3, 2, 0]) {
        expect(untagged(mpegFrame({ version })), `version ${version}`).toBe('mp3');
        expect(untagged(mpegFrame({ version, crc: true })), `version ${version} crc`).toBe('mp3');
      }
      expect(untagged(mpegFrame({ bitrate: 1, sampleRate: 2 }))).toBe('mp3');
      expect(untagged(mpegFrame({ bitrate: 14, sampleRate: 1 }))).toBe('mp3');
    });

    it('refuses Layer I and II, the reserved version, a free or bad bitrate, and the reserved sample rate', () => {
      expect(untagged(mpegFrame({ layer: 2 }))).toBeNull();
      expect(untagged(mpegFrame({ layer: 3 }))).toBeNull();
      expect(untagged(mpegFrame({ version: 1 }))).toBeNull();
      expect(untagged(mpegFrame({ bitrate: 0 }))).toBeNull();
      expect(untagged(mpegFrame({ bitrate: 15 }))).toBeNull();
      expect(untagged(mpegFrame({ sampleRate: 3 }))).toBeNull();
    });

    it('refuses a broken sync word or too few bytes', () => {
      const frame = mpegFrame();
      expect(untagged(bytes([0xfe], frame.subarray(1)))).toBeNull();
      expect(untagged(bytes([0xff, frame[1] & 0x1f], frame.subarray(2)))).toBeNull();
      expect(untagged(frame.subarray(0, 3))).toBeNull();
      expect(untagged(frame.subarray(0, 4))).toBe('mp3');
    });

    it('is MP3 after an ID3 tag too', () => {
      expect(referenceTrackContainer({ head: mpegFrame(), tagged: true })).toBe('mp3');
    });
  });

  describe('AAC', () => {
    it('takes an ADTS header with either ID bit, with or without a CRC', () => {
      for (const mpeg2 of [false, true]) {
        for (const crc of [false, true]) {
          expect(untagged(adtsFrame({ mpeg2, crc })), `mpeg2 ${mpeg2} crc ${crc}`).toBe('aac');
        }
      }
      expect(untagged(adtsFrame({ samplingIndex: 0 }))).toBe('aac');
      expect(untagged(adtsFrame({ samplingIndex: 12 }))).toBe('aac');
    });

    it('refuses a reserved sampling index, a non-zero layer, or a header cut short', () => {
      expect(untagged(adtsFrame({ samplingIndex: 13 }))).toBeNull();
      expect(untagged(adtsFrame({ samplingIndex: 15 }))).toBeNull();
      const layered = adtsFrame();
      // Layer II: ADTS's layer is always 0 (and layer 1 is MPEG Layer III, an MP3 header).
      layered[1] |= 0x04;
      expect(untagged(layered)).toBeNull();
      expect(untagged(adtsFrame().subarray(0, 6))).toBeNull();
    });

    it('takes ADIF, and AAC after an ID3 tag', () => {
      expect(untagged(bytes('ADIF', new Array(16).fill(0)))).toBe('aac');
      expect(referenceTrackContainer({ head: adtsFrame(), tagged: true })).toBe('aac');
      expect(referenceTrackContainer({ head: bytes('ADIF', [0, 0, 0]), tagged: true })).toBe('aac');
    });
  });

  describe('WAV', () => {
    it('takes PCM, and WAVE_FORMAT_EXTENSIBLE with a PCM sub-format', () => {
      expect(untagged(wave(fmtChunk(0x0001)))).toBe('wav');
      expect(untagged(wave(fmtChunk(0x0001, { channels: 1, bits: 8 })))).toBe('wav');
      expect(untagged(wave(extensibleFmtChunk(0x0001)))).toBe('wav');
    });

    it('refuses floats, MP3 or ADPCM in a WAV, and an extensible float', () => {
      expect(untagged(wave(fmtChunk(0x0003, { bits: 32 })))).toBeNull();
      expect(untagged(wave(fmtChunk(0x0055)))).toBeNull();
      expect(untagged(wave(fmtChunk(0x0011)))).toBeNull();
      expect(untagged(wave(extensibleFmtChunk(0x0003)))).toBeNull();
    });

    it('finds `fmt ` after other chunks, an odd-sized one padded to an even length', () => {
      expect(untagged(wave(chunk('JUNK', new Array(28).fill(0)), fmtChunk(0x0001)))).toBe('wav');
      expect(untagged(wave(chunk('JUNK', [1, 2, 3]), chunk('LIST', bytes('INFOISFT', le32(5), 'Lavf', [0])), fmtChunk(0x0001)))).toBe('wav');
      // Without the pad byte the next chunk is read one byte early, and no `fmt ` is found.
      const unpadded = bytes('WAVE', 'JUNK', le32(3), [1, 2, 3], fmtChunk(0x0001));
      expect(untagged(bytes('RIFF', le32(unpadded.length), unpadded))).toBeNull();
    });

    it('refuses a WAV whose `fmt ` lies beyond the bytes read, or is cut short within them', () => {
      const file = wave(chunk('JUNK', new Array(5000).fill(0)), fmtChunk(0x0001));
      expect(untagged(file)).toBe('wav');
      expect(untagged(file.subarray(0, REFERENCE_TRACK_HEAD_BYTES))).toBeNull();
      const pcm = wave(fmtChunk(0x0001));
      // RIFF + size + WAVE + the chunk's id and size: its format tag is the next two bytes.
      expect(untagged(pcm.subarray(0, 20))).toBeNull();
      expect(untagged(pcm.subarray(0, 22))).toBe('wav');
      const extensible = wave(extensibleFmtChunk(0x0001));
      expect(untagged(extensible.subarray(0, 20 + 25))).toBeNull();
      expect(untagged(extensible.subarray(0, 20 + 26))).toBe('wav');
    });

    it('refuses a `fmt ` too small to hold one, a RIFF that is not WAVE, and a WAV after an ID3 tag', () => {
      expect(untagged(wave(chunk('fmt ', [...le16(1), ...le16(2)])))).toBeNull();
      const extensibleShort = wave(chunk('fmt ', [...le16(0xfffe), ...le16(2), ...le32(44100), ...le32(176400), ...le16(4), ...le16(16)]));
      expect(untagged(extensibleShort)).toBeNull();
      const avi = wave(fmtChunk(0x0001));
      avi.set(Buffer.from('AVI ', 'latin1'), 8);
      expect(untagged(avi)).toBeNull();
      expect(referenceTrackContainer({ head: wave(fmtChunk(0x0001)), tagged: true })).toBeNull();
    });
  });

  it('takes Ogg, but not after an ID3 tag', () => {
    const ogg = bytes('OggS', [0, 2], new Array(22).fill(0));
    expect(untagged(ogg)).toBe('ogg');
    expect(referenceTrackContainer({ head: ogg, tagged: true })).toBeNull();
  });

  it('is null for an MPEG-4 `ftyp` (.m4a), WebM, FLAC, CAF, AIFF, and nothing at all', () => {
    expect(untagged(bytes(le32(0x20000000), 'ftypM4A ', [0, 0, 2, 0], 'M4A isommp42'))).toBeNull();
    expect(untagged(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01], 'webm'))).toBeNull();
    expect(untagged(bytes('fLaC', [0, 0, 0, 0x22], new Array(34).fill(0)))).toBeNull();
    expect(untagged(bytes('caff', [0, 1, 0, 0], 'desc'))).toBeNull();
    expect(untagged(bytes('FORM', le32(100), 'AIFF', 'COMM'))).toBeNull();
    expect(untagged(new Uint8Array(0))).toBeNull();
    expect(untagged(new Uint8Array(4096))).toBeNull();
  });
});

describe('referenceTrackContainer on files ffmpeg wrote', () => {
  let directory = '';

  /** The first `REFERENCE_TRACK_HEAD_BYTES` after up to four ID3v2 tags, as the conversion reads them. */
  function headOf(file: Uint8Array) {
    let offset = 0;
    let tagged = false;
    for (let tag = 0; tag < 4; tag += 1) {
      const length = id3v2TagLength(file.subarray(offset, offset + 10));
      if (length === 0) break;
      tagged = true;
      offset += length;
    }
    return { head: file.subarray(offset, offset + REFERENCE_TRACK_HEAD_BYTES), tagged };
  }

  async function encode(name: string, args: string[]): Promise<Uint8Array> {
    const file = path.join(directory, name);
    const result = spawnSync(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', ...args, '-y', file,
    ], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Could not encode ${name}: ${result.stderr}`);
    return new Uint8Array(await readFile(file));
  }

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'magicbooklet-track-format-'));
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  // The builds the dev Mac and CI run have LAME; the hand-built frames above cover a build without it.
  it.skipIf(!hasEncoder('libmp3lame'))('reads an MP3, ID3 tag and all, as mp3', async () => {
    const mp3 = await encode('track.mp3', ['-c:a', 'libmp3lame', '-b:a', '64k']);
    const { head, tagged } = headOf(mp3);
    expect(tagged).toBe(true);
    expect(referenceTrackContainer({ head, tagged })).toBe('mp3');
    // And without the tag.
    const bare = await encode('bare.mp3', ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '0', '-write_xing', '0']);
    expect(headOf(bare).tagged).toBe(false);
    expect(referenceTrackContainer(headOf(bare))).toBe('mp3');
  });

  it('reads ADTS AAC as aac', async () => {
    const aac = await encode('track.aac', ['-c:a', 'aac', '-b:a', '64k', '-f', 'adts']);
    expect(referenceTrackContainer(headOf(aac))).toBe('aac');
  });

  it('reads 16-bit WAV, stereo and extensible 5.1, as wav, and a float WAV as none', async () => {
    const wav = await encode('track.wav', ['-c:a', 'pcm_s16le', '-ac', '2', '-f', 'wav']);
    expect(referenceTrackContainer(headOf(wav))).toBe('wav');
    // More than two channels make ffmpeg write WAVE_FORMAT_EXTENSIBLE.
    const surround = await encode('surround.wav', ['-c:a', 'pcm_s16le', '-af', 'pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0', '-f', 'wav']);
    expect(surround[20] | (surround[21] << 8)).toBe(0xfffe);
    expect(referenceTrackContainer(headOf(surround))).toBe('wav');
    const float = await encode('float.wav', ['-c:a', 'pcm_f32le', '-f', 'wav']);
    expect(referenceTrackContainer(headOf(float))).toBeNull();
  });

  it('reads Ogg as ogg', async () => {
    const codec = hasEncoder('libvorbis') ? 'libvorbis' : hasEncoder('libopus') ? 'libopus' : 'flac';
    const ogg = await encode('track.ogg', ['-c:a', codec, '-f', 'ogg']);
    expect(referenceTrackContainer(headOf(ogg))).toBe('ogg');
  });

  it('reads an .m4a, a FLAC and a CAF as none', async () => {
    const m4a = await encode('track.m4a', ['-c:a', 'aac', '-b:a', '64k', '-f', 'ipod']);
    expect(referenceTrackContainer(headOf(m4a))).toBeNull();
    const flac = await encode('track.flac', ['-c:a', 'flac', '-f', 'flac']);
    expect(referenceTrackContainer(headOf(flac))).toBeNull();
    const caf = await encode('track.caf', ['-c:a', 'pcm_s16le', '-f', 'caf']);
    expect(referenceTrackContainer(headOf(caf))).toBeNull();
  });
});
