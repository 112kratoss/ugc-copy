import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import rawSharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createGenerationImagePreview } from '@/lib/generation-media-preview';
import sharp, { IMAGE_DECODER_FORMATS, sniffRasterFormat } from '@/lib/image-decoder';
import { createPostMediaPreview } from '@/lib/post-media-preview';
import { encodeSupportPhoto } from '@/lib/support-photos';

/**
 * Security audit, 2026-11-26. An upload is admitted on the type it declares:
 * Storage and `upload-finalization.ts` read the Content-Type the client sent,
 * never the bytes. So a file stored as `image/png` can be anything, and sharp
 * picks its decoder from the bytes. Before this rule an SVG labelled as a PNG
 * went to librsvg (GHSA-wq5f-xc86-pv6w: memory corruption, possible remote
 * code execution) from the publish, profile, support and template paths.
 *
 * The rule: the server decodes only what begins as one of the raster formats
 * it stores, whatever a file calls itself, and only through
 * `src/lib/image-decoder.ts`, which reads the first bytes before sharp does.
 */

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>',
);

function sample() {
  return rawSharp({ create: { width: 64, height: 48, channels: 3, background: '#7c3aed' } });
}

/** A Storage stand-in that fails the test if anything is written to it. */
function storageThatMustStayEmpty() {
  const upload = vi.fn(async () => ({ error: null }));
  return {
    upload,
    supabase: {
      storage: { from: () => ({ upload, download: async () => ({ error: null, data: null }) }) },
    } as never,
  };
}

describe('the server decodes only the raster formats it stores', () => {
  it('reads JPEG, PNG, WebP, GIF and AVIF', async () => {
    const inputs = {
      jpeg: await sample().jpeg().toBuffer(),
      png: await sample().png().toBuffer(),
      webp: await sample().webp().toBuffer(),
      gif: await sample().gif().toBuffer(),
      heif: await sample().avif().toBuffer(),
    };
    for (const [format, bytes] of Object.entries(inputs)) {
      const metadata = await sharp(bytes).metadata();
      expect(metadata.format).toBe(format);
      expect(IMAGE_DECODER_FORMATS).toContain(format);
      expect(sniffRasterFormat(bytes)).toBe(format);
      // A decode to pixels, not only a header read.
      await expect(sharp(bytes).resize(8).webp().toBuffer()).resolves.toBeInstanceOf(Buffer);
    }
  });

  it('refuses SVG and TIFF bytes before any decoder sees them', async () => {
    const tiff = await sample().tiff().toBuffer();
    expect(() => sharp(SVG)).toThrow(/unsupported image format/i);
    expect(() => sharp(new Uint8Array(SVG))).toThrow(/unsupported image format/i);
    expect(() => sharp(SVG.buffer.slice(SVG.byteOffset, SVG.byteOffset + SVG.byteLength) as ArrayBuffer))
      .toThrow(/unsupported image format/i);
    expect(() => sharp(tiff)).toThrow(/unsupported image format/i);
  });

  it('refuses markup hidden behind a picture\'s first bytes, and compressed SVG', () => {
    // GIF's and WebP's signatures are printable text; libvips looks for `<svg`
    // near the start of a file.
    for (const disguise of [
      Buffer.concat([Buffer.from('GIF89a'), SVG]),
      Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WEBP'), SVG]),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<SVG xmlns="http://www.w3.org/2000/svg"/>')]),
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ]) {
      expect(sniffRasterFormat(disguise)).toBeNull();
      expect(() => sharp(disguise)).toThrow(/unsupported image format/i);
    }
  });

  it('reads a file\'s first bytes too, and takes no stream', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'magicbooklet-image-decoder-'));
    try {
      const svgFile = path.join(directory, 'picture.png');
      const pngFile = path.join(directory, 'real.png');
      await writeFile(svgFile, SVG);
      await writeFile(pngFile, await sample().png().toBuffer());
      expect(() => sharp(svgFile)).toThrow(/unsupported image format/i);
      await expect(sharp(pngFile).metadata()).resolves.toMatchObject({ format: 'png' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    // A stream's bytes cannot be read ahead of the decoder.
    expect(() => (sharp as unknown as () => unknown)()).toThrow(/unsupported image format/i);
    expect(() => sharp({ failOn: 'error' })).toThrow(/unsupported image format/i);
  });

  it('leaves the library whole for code that draws its own SVG', async () => {
    // Next's ImageResponse rasterises the SVG it draws with the same sharp in
    // the same process. Switching the SVG loader off process-wide (the first
    // form of this rule) broke the blog's social cards at build.
    const drawn = await rawSharp(SVG).png().toBuffer();
    expect((await rawSharp(drawn).metadata()).format).toBe('png');
  });

  it('still builds pictures from raw pixels and from nothing', async () => {
    const { data, info } = await sharp(await sample().png().toBuffer()).raw().toBuffer({ resolveWithObject: true });
    await expect(sharp(data, { raw: info }).png().toBuffer()).resolves.toBeInstanceOf(Buffer);
    await expect(
      sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).webp().toBuffer(),
    ).resolves.toBeInstanceOf(Buffer);
  });
});

describe('an SVG stored as a PNG is not rendered', () => {
  it('makes no post preview', async () => {
    const { supabase, upload } = storageThatMustStayEmpty();
    await expect(createPostMediaPreview({
      body: new Blob([SVG], { type: 'image/png' }),
      contentType: 'image/png',
      storagePath: 'post_media/11111111-1111-4111-8111-111111111111/post/picture.png',
      supabase,
    })).rejects.toThrow(/unsupported image format/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it('makes no creation preview', async () => {
    const { supabase, upload } = storageThatMustStayEmpty();
    await expect(createGenerationImagePreview({
      body: new Blob([SVG], { type: 'image/png' }),
      storagePath: 'generated_images/11111111-1111-4111-8111-111111111111/picture.png',
      supabase,
    })).rejects.toThrow(/unsupported image format/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it('is an unreadable support photo', async () => {
    await expect(encodeSupportPhoto(SVG)).resolves.toEqual({ ok: false, code: 'PHOTO_UNREADABLE' });
  });
});

describe('every decode goes through the allowlist', () => {
  const root = path.join(process.cwd(), 'src');
  const DECODER = path.join(root, 'lib', 'image-decoder.ts');

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const file = path.join(directory, name);
      if (statSync(file).isDirectory()) return name === '__tests__' ? [] : sourceFiles(file);
      return /\.(ts|tsx|mts|mjs)$/.test(name) ? [file] : [];
    });
  }

  it('imports sharp in one module only', () => {
    // A type-only import decodes nothing. Anything else reaches the library
    // without the check image-decoder.ts makes first.
    const direct = /(?:(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]sharp['"]|import\(\s*['"]sharp['"]\s*\)|require\(\s*['"]sharp['"]\s*\))/;
    const offenders = sourceFiles(root)
      .filter((file) => file !== DECODER && direct.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('runs on a sharp that carries the librsvg fix', () => {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const [major, minor, patch] = manifest.dependencies.sharp.replace(/^[^0-9]*/, '').split('.').map(Number);
    // 0.35.5 ships librsvg 2.63.2. The check keeps an upload's SVG from the
    // decoder either way; the version covers the SVG the app draws itself.
    expect(major > 0 || minor > 35 || (minor === 35 && patch >= 5)).toBe(true);
  });
});
