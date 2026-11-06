/**
 * What a reference track's bytes are, read from the start of the file.
 *
 * Kie takes a track by its link's extension (provider-input-limits: `REFERENCE_TRACK_FORMATS`)
 * and then decodes whatever it fetched, so a name that lies about its bytes (an iPhone `.m4a`
 * renamed `.mp3`, AAC saved as `.wav`) passed the extension check and failed after the hold.
 * A track whose bytes are not what its extension says is converted like one Kie refuses
 * (reference-track-conversion). Reading too little only ever converts a track that needed none,
 * which costs a second or two and never a run, so the checks are strict.
 */

/** The containers a track link's extension can claim, by that extension. */
export type ReferenceTrackContainer = 'mp3' | 'wav' | 'aac' | 'ogg';

/** How much of a track, after any ID3 tags, the check reads: a WAV's `fmt ` chunk sits well inside it. */
export const REFERENCE_TRACK_HEAD_BYTES = 4096;

/** The ID3v2 header's length; the tag's own length follows in it. */
export const ID3V2_HEADER_BYTES = 10;

/**
 * The length of the ID3v2 tag that starts `bytes`, header and footer included, or 0 when no
 * tag starts there. MP3 and raw AAC files carry one in front of their first frame, holding
 * cover art as often as not, so it can run to megabytes.
 */
export function id3v2TagLength(bytes: Uint8Array): number {
  if (bytes.length < ID3V2_HEADER_BYTES) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0; // "ID3"
  if (bytes[3] === 0xff || bytes[4] === 0xff) return 0;
  const size = bytes.subarray(6, 10);
  // A synchsafe integer: seven bits a byte.
  if (size.some((byte) => byte & 0x80)) return 0;
  const length = (size[0] << 21) | (size[1] << 14) | (size[2] << 7) | size[3];
  const footer = bytes[5] & 0x10 ? ID3V2_HEADER_BYTES : 0;
  return ID3V2_HEADER_BYTES + length + footer;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function uint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) + bytes[offset + 3] * 0x1000000;
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Whether a RIFF/WAVE file holds plain PCM, which is what a provider that lists "wav" decodes:
 * a WAV can wrap MP3, ADPCM or floats too. Its `fmt ` chunk is looked for within the bytes read.
 */
function isPcmWave(bytes: Uint8Array): boolean {
  if (!ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WAVE')) return false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = uint32(bytes, offset + 4);
    if (ascii(bytes, offset, 'fmt ')) {
      if (size < 16 || offset + 8 + 2 > bytes.length) return false;
      const format = uint16(bytes, offset + 8);
      if (format === WAVE_FORMAT_PCM) return true;
      // WAVE_FORMAT_EXTENSIBLE names its codec in the first two bytes of its sub-format GUID.
      return format === WAVE_FORMAT_EXTENSIBLE && size >= 40 && offset + 8 + 26 <= bytes.length
        && uint16(bytes, offset + 8 + 24) === WAVE_FORMAT_PCM;
    }
    // Chunks are padded to an even length.
    offset += 8 + size + (size & 1);
  }
  return false;
}

/** An MPEG-1, 2 or 2.5 Layer III frame header: what an `.mp3` holds. */
function isMp3Frame(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[1] >> 3) & 0x03;
  const layer = (bytes[1] >> 1) & 0x03;
  const bitrate = bytes[2] >> 4;
  const sampleRate = (bytes[2] >> 2) & 0x03;
  return version !== 0x01 && layer === 0x01 && bitrate !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03;
}

/** An ADTS frame header (raw AAC, as a `.aac` file holds): a 12-bit sync word and layer 0. */
function isAdtsFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0 && ((bytes[2] >> 2) & 0x0f) < 13;
}

/**
 * The container a track's bytes are, from `head`, its first bytes after any ID3v2 tags
 * (`tagged` when it had one), or null when they are none an extension can claim, or audio a
 * provider that names the container may not decode (a WAV that is not PCM). An `.m4a` (an
 * MPEG-4 `ftyp` box), WebM, FLAC, CAF and the rest are null.
 */
export function referenceTrackContainer({ head, tagged }: { head: Uint8Array; tagged: boolean }): ReferenceTrackContainer | null {
  if (isMp3Frame(head)) return 'mp3';
  if (isAdtsFrame(head) || ascii(head, 0, 'ADIF')) return 'aac';
  // ID3 tags front MPEG audio only.
  if (tagged) return null;
  if (isPcmWave(head)) return 'wav';
  if (ascii(head, 0, 'OggS')) return 'ogg';
  return null;
}
