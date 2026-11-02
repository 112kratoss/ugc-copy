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

/**
 * Other names pickers give formats the lists above hold. An iPhone's document
 * picker reports `UTType(filenameExtension:).preferredMIMEType`, which is
 * audio/x-m4a for an .m4a (Voice Memos, most phone recordings) and audio/vnd.wave
 * for a .wav, and Chrome types an .m4a file audio/x-m4a too. Every signer reads
 * an alias as the listed name, keeps the upload under it and answers with it, so
 * the file is stored under the name Kie's docs list.
 */
export const STORAGE_MEDIA_MIME_TYPE_ALIASES = {
  'audio/x-m4a': 'audio/mp4',
  'audio/vnd.wave': 'audio/wav',
} as const satisfies Record<string, (typeof STORAGE_MEDIA_MIME_TYPES.audio)[number]>;

const ALL_STORAGE_MEDIA_MIME_TYPES = [
  ...STORAGE_MEDIA_MIME_TYPES.image,
  ...STORAGE_MEDIA_MIME_TYPES.video,
  ...STORAGE_MEDIA_MIME_TYPES.audio,
] as const;

export const STORAGE_BUCKET_ALLOWED_MIME_TYPES = {
  // Storage judges the content-type header the upload itself carries. An app
  // installed before the sign step answered with a type sends its picker's name
  // there, so the bucket it stages media in takes the aliases too. Into the other
  // buckets the server writes listed names, and clients send the type their signer
  // answers with or upload types no alias covers (profile pictures).
  uploads: [...ALL_STORAGE_MEDIA_MIME_TYPES, ...Object.keys(STORAGE_MEDIA_MIME_TYPE_ALIASES)],
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

/** The name the lists keep for a type a client names: an alias reads as the type it names. */
export function canonicalStorageMediaMimeType(mimeType: string): string {
  const normalized = normalizedMimeType(mimeType);
  return Object.hasOwn(STORAGE_MEDIA_MIME_TYPE_ALIASES, normalized)
    ? STORAGE_MEDIA_MIME_TYPE_ALIASES[normalized as keyof typeof STORAGE_MEDIA_MIME_TYPE_ALIASES]
    : normalized;
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
