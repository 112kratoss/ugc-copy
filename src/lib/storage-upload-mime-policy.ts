export type StorageMediaKind = 'image' | 'video' | 'audio';

export const STORAGE_MEDIA_MIME_TYPES = {
  image: [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/heic',
    'image/heif',
  ],
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'],
  audio: [
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/x-wav',
    'audio/aac',
    'audio/ogg',
    'audio/webm',
  ],
} as const satisfies Record<StorageMediaKind, readonly string[]>;

const ALL_STORAGE_MEDIA_MIME_TYPES = [
  ...STORAGE_MEDIA_MIME_TYPES.image,
  ...STORAGE_MEDIA_MIME_TYPES.video,
  ...STORAGE_MEDIA_MIME_TYPES.audio,
] as const;

export const STORAGE_BUCKET_ALLOWED_MIME_TYPES = {
  uploads: ALL_STORAGE_MEDIA_MIME_TYPES,
  generation_inputs: ALL_STORAGE_MEDIA_MIME_TYPES,
  generated_images: STORAGE_MEDIA_MIME_TYPES.image,
  generated_videos: STORAGE_MEDIA_MIME_TYPES.video,
  generated_audio: STORAGE_MEDIA_MIME_TYPES.audio,
  profiles: STORAGE_MEDIA_MIME_TYPES.image,
} as const;

export type MimeRestrictedStorageBucket = keyof typeof STORAGE_BUCKET_ALLOWED_MIME_TYPES;

function normalizedMimeType(value: string): string {
  return value.trim().toLowerCase();
}

export function isAllowedStorageMediaMimeType(kind: StorageMediaKind, mimeType: string): boolean {
  return (STORAGE_MEDIA_MIME_TYPES[kind] as readonly string[]).includes(normalizedMimeType(mimeType));
}

export function isAllowedStorageBucketMimeType(
  bucket: MimeRestrictedStorageBucket,
  mimeType: string,
): boolean {
  return (STORAGE_BUCKET_ALLOWED_MIME_TYPES[bucket] as readonly string[]).includes(normalizedMimeType(mimeType));
}
