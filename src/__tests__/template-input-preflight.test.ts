import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  MAX_TEMPLATE_IMAGE_INPUT_BYTES,
  validateTemplateInputBlob,
  validateTemplateInputDescriptor,
} from '@/lib/template-input-preflight';
import type { TemplateInputSlot } from '@/lib/media-template-types';

const imageSlot: TemplateInputSlot = {
  key: 'vehicle',
  kind: 'image',
  label: 'Your vehicle',
  required: true,
};

async function imageBlob(width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg') {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 50, b: 60 },
    },
  });
  const body = await pipeline[format]().toBuffer();
  return new Blob([body], { type: format === 'jpeg' ? 'image/jpeg' : `image/${format}` });
}

describe('template input provider preflight', () => {
  it('accepts provider-compatible image types and usable dimensions', async () => {
    await expect(validateTemplateInputBlob({
      blob: await imageBlob(512, 512, 'webp'),
      objectPath: 'user/run/staging/vehicle/reference.webp',
      slot: imageSlot,
    })).resolves.toBeUndefined();
  });

  it('rejects tiny images before reserving generation credits', async () => {
    await expect(validateTemplateInputBlob({
      blob: await imageBlob(92, 92),
      objectPath: 'user/run/staging/vehicle/thumbnail.jpeg',
      slot: imageSlot,
    })).rejects.toMatchObject({
      code: 'INPUT_IMAGE_TOO_SMALL',
      status: 400,
      message: 'Your vehicle is too small. Use an image at least 256×256 px.',
    });
  });

  it('rejects unsupported or misleading image payloads', async () => {
    expect(() => validateTemplateInputDescriptor({
      kind: 'image',
      mimeType: 'image/heic',
      sizeBytes: 1024,
    })).toThrow('Upload a JPEG, PNG, or WebP image up to 30MB.');

    expect(() => validateTemplateInputDescriptor({
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: MAX_TEMPLATE_IMAGE_INPUT_BYTES + 1,
    })).toThrow('Upload a JPEG, PNG, or WebP image up to 30MB.');

    await expect(validateTemplateInputBlob({
      blob: new Blob(['not-an-image'], { type: 'image/png' }),
      objectPath: 'user/run/staging/vehicle/fake.png',
      slot: imageSlot,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT_FILE', status: 400 });
  });
});
