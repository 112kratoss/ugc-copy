/**
 * The one place the server loads sharp, with every decoder switched off but
 * those of the raster formats it stores.
 *
 * An upload is admitted on the type it declares: Storage and
 * `upload-finalization.ts` read the Content-Type the client sent, never the
 * bytes. sharp does the opposite and picks its decoder from the bytes, so a
 * file stored as `image/png` reached whichever decoder its content named. An
 * SVG went to librsvg (GHSA-wq5f-xc86-pv6w, 2026-11: memory corruption that can
 * become remote code execution), a TIFF to libtiff, and so on, from the
 * publish, profile, support-photo and template-input paths.
 *
 * So the list is an allowlist, not a block of SVG alone: a format added to
 * libvips later, or one nobody thought of, is refused until it is named here.
 * A refused file fails as an undecodable one always has ("Input buffer contains
 * unsupported image format"), which every caller already handles.
 *
 * The switch is process-wide and set when this module is first loaded, so
 * everything that decodes must import sharp from here.
 * `image-decoder-allowlist.test.ts` fails on a direct `from 'sharp'` anywhere
 * else under `src/` (a type-only import is fine). Scripts that draw the
 * repository's own SVG artwork import sharp themselves and are not served.
 *
 * No `server-only` here: backfill and audit scripts load these modules under
 * tsx, where that import throws.
 */
import sharp from 'sharp';

/** What `metadata().format` says for a file the server will decode. AVIF reads as `heif`. */
export const IMAGE_DECODER_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'heif'] as const;

/**
 * libvips' loader classes for those formats, from a buffer and from a file
 * (`generation-media-preview.ts` and the video poster read files). Pixels
 * handed over raw and pictures made with `create` use no loader.
 */
const ALLOWED_LOADERS = [
  'VipsForeignLoadJpegBuffer',
  'VipsForeignLoadJpegFile',
  'VipsForeignLoadPngBuffer',
  'VipsForeignLoadPngFile',
  'VipsForeignLoadWebpBuffer',
  'VipsForeignLoadWebpFile',
  'VipsForeignLoadNsgifBuffer',
  'VipsForeignLoadNsgifFile',
  'VipsForeignLoadHeifBuffer',
  'VipsForeignLoadHeifFile',
];

// Blocking the base class blocks every loader under it, present and future.
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ALLOWED_LOADERS });

export default sharp;
export type { Metadata, Sharp } from 'sharp';
