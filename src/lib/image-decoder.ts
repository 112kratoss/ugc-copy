/**
 * The one place the server hands bytes to sharp, and only bytes that begin as
 * one of the raster formats it stores.
 *
 * An upload is admitted on the type it declares: Storage and
 * `upload-finalization.ts` read the Content-Type the client sent, never the
 * bytes. sharp does the opposite and picks its decoder from the bytes, so a
 * file stored as `image/png` reached whichever decoder its content named. An
 * SVG went to librsvg (GHSA-wq5f-xc86-pv6w, 2026-11: memory corruption that can
 * become remote code execution), a TIFF to libtiff, and so on, from the
 * publish, profile, support-photo and template-input paths.
 *
 * So every decode goes through `decodeImage` (this module's default export,
 * called exactly as sharp is), which reads the input's first bytes and refuses
 * anything that is not a JPEG, PNG, WebP, GIF or AVIF/HEIF before sharp is
 * given it. It is an allowlist: a format libvips learns later is refused until
 * it is named here. A refused file fails with the words an undecodable one
 * always has ("Input buffer contains unsupported image format"), which every
 * caller already handles.
 *
 * Why not switch the other decoders off in libvips (`sharp.block`): that
 * switch is process-wide, and Next's own `ImageResponse` rasterises the SVG it
 * draws with the same sharp in the same process. Blocking the SVG loader broke
 * the blog's social cards at build ("Error occurred prerendering page
 * …/opengraph-image", 2026-11-26). The check is therefore per input, and the
 * library is left as it is for code that draws its own SVG.
 *
 * `image-decoder-allowlist.test.ts` fails on a direct `from 'sharp'` anywhere
 * else under `src/` (a type-only import is fine): an import that skips this
 * module skips the check. Scripts that draw the repository's own SVG artwork
 * import sharp themselves and are not served.
 *
 * No `server-only` here: backfill and audit scripts load these modules under
 * tsx, where that import throws.
 */
import { closeSync, openSync, readSync } from 'node:fs';

import sharp, { type Sharp, type SharpOptions } from 'sharp';

/** What `metadata().format` says for a file the server will decode. AVIF reads as `heif`. */
export const IMAGE_DECODER_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'heif'] as const;
export type ImageDecoderFormat = (typeof IMAGE_DECODER_FORMATS)[number];

/** Enough of a file to hold any of the signatures, and the start of any markup hidden behind one. */
const HEAD_BYTES = 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** ISO base media brands that are still pictures; every other `ftyp` is a movie or a track. */
const HEIF_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

function ascii(head: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...head.subarray(start, start + length));
}

/**
 * The raster format a file's first bytes say it is, or null.
 *
 * GIF and WebP signatures are printable text, and libvips takes a file for SVG
 * when it finds `<svg` near the start. Its loaders are tried in a fixed order
 * that puts GIF and WebP first, but nothing here should rest on that order: a
 * head that carries `<svg` is no picture, whatever it begins with.
 */
export function sniffRasterFormat(head: Uint8Array): ImageDecoderFormat | null {
  if (head.length < 12) return null;
  if (ascii(head, 0, Math.min(head.length, HEAD_BYTES)).toLowerCase().includes('<svg')) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (PNG_SIGNATURE.every((byte, index) => head[index] === byte)) return 'png';
  const start = ascii(head, 0, 6);
  if (start === 'GIF87a' || start === 'GIF89a') return 'gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';
  if (ascii(head, 4, 4) === 'ftyp' && HEIF_BRANDS.has(ascii(head, 8, 4))) return 'heif';
  return null;
}

function headOfFile(path: string): Uint8Array {
  const head = new Uint8Array(HEAD_BYTES);
  const descriptor = openSync(path, 'r');
  try {
    return head.subarray(0, readSync(descriptor, head, 0, HEAD_BYTES, 0));
  } finally {
    closeSync(descriptor);
  }
}

function unsupported(source: 'buffer' | 'file'): Error {
  // libvips' own words for a file it cannot read, so logs and callers that
  // match on them see one case, not two.
  return new Error(`Input ${source} contains unsupported image format`);
}

function isPlainOptions(value: unknown): value is SharpOptions {
  return typeof value === 'object' && value !== null
    && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer) && !Array.isArray(value);
}

/**
 * sharp, for input the server did not make. Called as sharp is:
 * `decodeImage(bytes)`, `decodeImage(path)`, `decodeImage(bytes, options)`.
 *
 * Pixels handed over raw (`options.raw`) and pictures made from nothing
 * (`{ create }`, `{ text }`) decode no file and pass straight through. A stream
 * (no input at all) is refused: its bytes cannot be read ahead of the decoder,
 * and nothing here pipes one in.
 */
function decodeImage(options?: SharpOptions): Sharp;
function decodeImage(
  input: Buffer | ArrayBuffer | Uint8Array | Uint8ClampedArray | string,
  options?: SharpOptions,
): Sharp;
function decodeImage(
  input?: Buffer | ArrayBuffer | Uint8Array | Uint8ClampedArray | string | SharpOptions,
  options?: SharpOptions,
): Sharp {
  if (isPlainOptions(input)) {
    if (input.create || input.text) return sharp(input);
    throw unsupported('buffer');
  }
  if (input === undefined) throw unsupported('buffer');
  if (options?.raw) return sharp(input, options);

  if (typeof input === 'string') {
    if (!sniffRasterFormat(headOfFile(input))) throw unsupported('file');
    return sharp(input, options);
  }
  const head = input instanceof ArrayBuffer
    ? new Uint8Array(input, 0, Math.min(input.byteLength, HEAD_BYTES))
    : new Uint8Array(input.buffer, input.byteOffset, Math.min(input.byteLength, HEAD_BYTES));
  if (!sniffRasterFormat(head)) throw unsupported('buffer');
  return sharp(input, options);
}

export default decodeImage;
export type { Metadata, Sharp } from 'sharp';
