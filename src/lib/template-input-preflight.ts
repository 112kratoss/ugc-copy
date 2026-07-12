import 'server-only';

import path from 'node:path';

import sharp from 'sharp';

import {
  MediaTemplateError,
  type TemplateInputSlot,
  type TemplateMediaKind,
} from '@/lib/media-template-types';

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const IMAGE_EXTENSIONS = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const VIDEO_EXTENSIONS = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
]);

export const MAX_TEMPLATE_IMAGE_INPUT_BYTES = 30 * 1024 * 1024;
export const MAX_TEMPLATE_VIDEO_INPUT_BYTES = 100 * 1024 * 1024;
export const MIN_TEMPLATE_IMAGE_DIMENSION = 256;

export function getTemplateInputMimeTypes(kind: TemplateMediaKind): ReadonlySet<string> {
  return kind === 'image' ? IMAGE_MIME_TYPES : VIDEO_MIME_TYPES;
}

export function getTemplateInputMaxBytes(kind: TemplateMediaKind): number {
  return kind === 'image' ? MAX_TEMPLATE_IMAGE_INPUT_BYTES : MAX_TEMPLATE_VIDEO_INPUT_BYTES;
}

export function getTemplateInputExtensions(kind: TemplateMediaKind): readonly string[] {
  return Array.from(kind === 'image' ? IMAGE_EXTENSIONS.keys() : VIDEO_EXTENSIONS.keys());
}

function uploadRequirement(kind: TemplateMediaKind): string {
  return kind === 'image'
    ? 'Upload a JPEG, PNG, or WebP image up to 30MB.'
    : 'Upload an MP4, WebM, or MOV video up to 100MB.';
}

export function validateTemplateInputDescriptor(input: {
  kind: TemplateMediaKind;
  mimeType: string;
  sizeBytes: number;
}) {
  if (
    !getTemplateInputMimeTypes(input.kind).has(input.mimeType.trim().toLowerCase())
    || !Number.isFinite(input.sizeBytes)
    || input.sizeBytes <= 0
    || input.sizeBytes > getTemplateInputMaxBytes(input.kind)
  ) {
    throw new MediaTemplateError(uploadRequirement(input.kind), 400, 'INVALID_INPUT_FILE');
  }
}

function inferMimeType(objectPath: string, kind: TemplateMediaKind): string {
  const extension = path.posix.extname(objectPath).toLowerCase();
  return (kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS).get(extension) ?? '';
}

export async function validateTemplateInputBlob(input: {
  blob: Blob;
  objectPath: string;
  slot: TemplateInputSlot;
}) {
  const mimeType = input.blob.type.trim().toLowerCase() || inferMimeType(input.objectPath, input.slot.kind);
  validateTemplateInputDescriptor({
    kind: input.slot.kind,
    mimeType,
    sizeBytes: input.blob.size,
  });

  if (input.slot.kind !== 'image') return;

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(Buffer.from(await input.blob.arrayBuffer()), {
      failOn: 'warning',
      limitInputPixels: 100_000_000,
    }).metadata();
  } catch {
    throw new MediaTemplateError(
      `${input.slot.label} is not a readable JPEG, PNG, or WebP image.`,
      400,
      'INVALID_INPUT_FILE',
    );
  }

  if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw new MediaTemplateError(
      `${input.slot.label} must be a JPEG, PNG, or WebP image.`,
      400,
      'INVALID_INPUT_FILE',
    );
  }

  if (
    !metadata.width
    || !metadata.height
    || metadata.width < MIN_TEMPLATE_IMAGE_DIMENSION
    || metadata.height < MIN_TEMPLATE_IMAGE_DIMENSION
  ) {
    throw new MediaTemplateError(
      `${input.slot.label} is too small. Use an image at least ${MIN_TEMPLATE_IMAGE_DIMENSION}×${MIN_TEMPLATE_IMAGE_DIMENSION} px.`,
      400,
      'INPUT_IMAGE_TOO_SMALL',
    );
  }
}
