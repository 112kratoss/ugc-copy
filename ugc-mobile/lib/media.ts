import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { env, getMissingMobileEnvKeys } from './env';
import {
  getUploadExtension,
  inspectUriUpload,
  UploadCancelledError,
  uploadUriToSignedUrl,
  type UriUploadProgress,
} from './upload-file';
import type { MagicbookletApiClient } from './api-client';
import type { MediaUploadKind } from './types';

export interface UploadedMedia {
  signedUrl: string;
  storagePath: string;
  mimeType: string;
  fileName: string;
  kind: MediaUploadKind;
  durationSeconds?: number | null;
  sizeBytes?: number | null;
}

const CLIENT_UPLOAD_BUCKETS = new Set(['uploads']);
const TEMPLATE_INPUT_BUCKET = 'template_inputs';
const RESOURCE_FILES_BUCKET = 'post_resource_files';
// Mirrors MAX_POST_RESOURCE_FILE_SIZE_BYTES in
// src/lib/post-resource-file-upload-service.ts. Checked here as well so an
// oversized pick fails before the bytes are pushed anywhere.
const MAX_RESOURCE_FILE_SIZE_BYTES = 50 * 1024 * 1024;

const REFERENCE_MEDIA_FAMILY_BY_EXTENSION = new Map<string, 'image' | 'video' | 'audio'>([
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['png', 'image'],
  ['webp', 'image'],
  ['gif', 'image'],
  ['heic', 'image'],
  ['heif', 'image'],
  ['mp4', 'video'],
  ['m4v', 'video'],
  ['mov', 'video'],
  ['webm', 'video'],
  ['mp3', 'audio'],
  ['wav', 'audio'],
  ['m4a', 'audio'],
  ['aac', 'audio'],
  ['ogg', 'audio'],
  ['flac', 'audio'],
]);

function getFileNameExtension(fileName: string | null | undefined): string | null {
  const baseName = fileName?.split(/[\\/]/).filter(Boolean).pop()?.trim() ?? '';
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return null;
  return baseName.slice(dotIndex + 1).toLowerCase();
}

function validateReferenceMediaFile(fileName: string | null | undefined, mimeType: string): void {
  const extensionFamily = REFERENCE_MEDIA_FAMILY_BY_EXTENSION.get(getFileNameExtension(fileName) ?? '');
  const normalizedMimeType = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const mimeFamily = /^(image|video|audio)\//.exec(normalizedMimeType)?.[1] ?? null;

  if (
    !extensionFamily
    || (mimeFamily !== null && mimeFamily !== extensionFamily)
    || (mimeFamily === null && normalizedMimeType !== 'application/octet-stream')
  ) {
    throw new Error('Choose an image, video, or audio file for reference media.');
  }
}

function throwIfUploadCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new UploadCancelledError();
}

async function awaitAbortAware<T>(signal: AbortSignal | undefined, operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    // The API client intentionally wraps fetch failures in ApiError. Restore
    // the upload-specific cancellation shape so the editor offers Retry
    // instead of presenting an aborted sign/finalize request as a network bug.
    if (signal?.aborted) throw new UploadCancelledError();
    throw error;
  }
}

function assertClientUploadBucket(bucket: string) {
  if (!CLIENT_UPLOAD_BUCKETS.has(bucket)) {
    throw new Error('Unsupported mobile upload bucket.');
  }
}

function sanitizeUploadFileName(fileName: string | null | undefined, fallback: string) {
  const rawName = fileName?.split(/[\\/]/).filter(Boolean).pop() ?? fallback;
  const sanitized = rawName
    .replace(/[^\w.-]+/g, '-')
    .replace(/^\.+/, '')
    .trim();

  return sanitized || fallback;
}

export async function pickMediaList(
  mediaType: 'image' | 'video' | 'mixed',
  options: {
    allowsMultipleSelection?: boolean;
  } = {}
) {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: mediaType === 'image' ? ['images'] : mediaType === 'video' ? ['videos'] : ['images', 'videos'],
    quality: 0.92,
    allowsMultipleSelection: options.allowsMultipleSelection ?? false,
  });

  if (result.canceled) {
    return [];
  }

  return result.assets;
}

export async function pickMedia(mediaType: 'image' | 'video') {
  const assets = await pickMediaList(mediaType);

  if (!assets[0]) {
    return null;
  }

  return assets[0];
}

export async function pickAudioDocument() {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['audio/*'],
    multiple: false,
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets[0]) {
    return null;
  }

  return result.assets[0];
}

export type ResourceDocumentPickerMode = 'reference_media' | 'resource';

const REFERENCE_MEDIA_DOCUMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/x-m4v',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
] as const;

// Keep this aligned with ALLOWED_RESOURCE_FILE_TYPES in the web upload
// service. Including the specific aliases matters on Android, where providers
// commonly report YAML, gzip, and CSV files under different safe MIME names.
const RESOURCE_DOCUMENT_TYPES = [
  ...REFERENCE_MEDIA_DOCUMENT_TYPES,
  'application/csv',
  'application/json',
  'application/pdf',
  'application/gzip',
  'application/octet-stream',
  'application/x-yaml',
  'application/x-gzip',
  'application/zip',
  'application/x-zip-compressed',
  'application/yaml',
  'text/comma-separated-values',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/x-markdown',
  'text/x-yaml',
  'text/yaml',
] as const;

export async function pickResourceDocument(mode: ResourceDocumentPickerMode = 'resource') {
  const result = await DocumentPicker.getDocumentAsync({
    // Deliberately no '*/*' entry: with the wildcard present the picker offers
    // every file on the device and the allowlist becomes decoration. Reference
    // cards are narrower still so a PDF or archive cannot later be mislabeled
    // as reference media.
    type: mode === 'reference_media'
      ? [...REFERENCE_MEDIA_DOCUMENT_TYPES]
      : [...RESOURCE_DOCUMENT_TYPES],
    multiple: false,
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets[0]) {
    return null;
  }

  return result.assets[0];
}

export async function uploadPickedMedia(
  uri: string,
  options: {
    api?: Pick<MagicbookletApiClient, 'createMediaUpload' | 'createMediaReadUrl'>;
    bucket?: string;
    fileName?: string | null;
    mimeType?: string | null;
    kind?: MediaUploadKind;
    durationSeconds?: number | null;
    sizeBytes?: number | null;
    signal?: AbortSignal;
    onProgress?: (progress: UriUploadProgress) => void;
  } = {}
): Promise<UploadedMedia> {
  const bucket = options.bucket ?? 'uploads';
  assertClientUploadBucket(bucket);

  const missingEnvKeys = getMissingMobileEnvKeys();
  if (missingEnvKeys.length > 0) {
    throw new Error(`Configure mobile uploads first: ${missingEnvKeys.join(', ')}`);
  }

  const upload = await inspectUriUpload(uri, {
    mimeType: options.mimeType,
    sizeBytes: options.sizeBytes,
  });
  const mimeType = upload.mimeType;
  const kind = options.kind ?? (mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image');
  const extension = getUploadExtension(mimeType, options.fileName);
  const fileName = sanitizeUploadFileName(options.fileName, `${Date.now()}.${extension || 'bin'}`);

  if (!options.api) {
    throw new Error('Media uploads must be authorized by the app API.');
  }

  const uploadIntent = await options.api.createMediaUpload({
    fileName,
    mimeType,
    kind,
    sizeBytes: upload.sizeBytes,
  });
  assertClientUploadBucket(uploadIntent.bucket);

  await uploadUriToSignedUrl(uri, resolveSignedUploadUrl(uploadIntent), {
    mimeType,
    onProgress: options.onProgress,
    signal: options.signal,
    sizeBytes: upload.sizeBytes,
  });

  const readUrl = await options.api.createMediaReadUrl({
    storagePath: uploadIntent.storagePath,
  });

  return {
    signedUrl: readUrl.signedUrl,
    storagePath: uploadIntent.storagePath,
    mimeType,
    fileName,
    kind,
    durationSeconds: options.durationSeconds ?? null,
    sizeBytes: upload.sizeBytes,
  };
}

export async function uploadTemplateRunInput(
  uri: string,
  options: {
    api: Pick<MagicbookletApiClient, 'signTemplateRunInput' | 'finalizeTemplateRunInput'>;
    runId: string;
    slotKey: string;
    kind?: 'image' | 'video';
    fileName?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    signal?: AbortSignal;
    onProgress?: (progress: UriUploadProgress) => void;
  }
) {
  const missingEnvKeys = getMissingMobileEnvKeys();
  if (missingEnvKeys.length > 0) {
    throw new Error(`Configure mobile uploads first: ${missingEnvKeys.join(', ')}`);
  }

  const upload = await inspectUriUpload(uri, {
    mimeType: options.mimeType,
    sizeBytes: options.sizeBytes,
    defaultMimeType: options.kind === 'video' ? 'video/mp4' : 'image/jpeg',
  });
  const expectedKind = options.kind ?? 'image';
  if (!upload.mimeType.startsWith(`${expectedKind}/`)) {
    throw new Error(`Choose a ${expectedKind} file.`);
  }

  const extension = getUploadExtension(upload.mimeType, options.fileName);
  const fileName = sanitizeUploadFileName(
    options.fileName,
    `${options.slotKey}.${extension || (expectedKind === 'video' ? 'mp4' : 'jpg')}`
  );
  const uploadIntent = await options.api.signTemplateRunInput(options.runId, {
    slotKey: options.slotKey,
    fileName,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
  });

  if (uploadIntent.bucket !== TEMPLATE_INPUT_BUCKET) {
    throw new Error('Unsupported template input upload bucket.');
  }

  await uploadUriToSignedUrl(uri, resolveSignedUploadUrl(uploadIntent), {
    mimeType: upload.mimeType,
    onProgress: options.onProgress,
    signal: options.signal,
    sizeBytes: upload.sizeBytes,
  });

  return options.api.finalizeTemplateRunInput(options.runId, {
    inputs: [{ slotKey: options.slotKey, storagePath: uploadIntent.storagePath }],
  });
}

/**
 * Uploads a resource-bundle attachment the same way the web composer does:
 * sign, PUT the bytes straight to storage, then finalize so the server can
 * confirm the object matches the intent it issued. The old multipart route is
 * retired and answers 410, so this path is the only one that works.
 */
export async function uploadResourceDocument(
  uri: string,
  options: {
    api: Pick<MagicbookletApiClient, 'signPostResourceFileUpload' | 'finalizePostResourceFileUpload'>;
    fileName?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    mediaOnly?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: UriUploadProgress) => void;
  }
) {
  const missingEnvKeys = getMissingMobileEnvKeys();
  if (missingEnvKeys.length > 0) {
    throw new Error(`Configure mobile uploads first: ${missingEnvKeys.join(', ')}`);
  }

  const upload = await inspectUriUpload(uri, {
    mimeType: options.mimeType,
    sizeBytes: options.sizeBytes,
  });

  if (options.mediaOnly) validateReferenceMediaFile(options.fileName, upload.mimeType);

  if (upload.sizeBytes > MAX_RESOURCE_FILE_SIZE_BYTES) {
    throw new Error('Resource files must be 50MB or smaller.');
  }

  const extension = getFileNameExtension(options.fileName)
    ?? getUploadExtension(upload.mimeType, options.fileName);
  const fileName = sanitizeUploadFileName(
    options.fileName,
    extension ? `resource.${extension}` : 'resource'
  );
  throwIfUploadCancelled(options.signal);
  const uploadIntent = await awaitAbortAware(
    options.signal,
    options.api.signPostResourceFileUpload({
      fileName,
      contentType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
    }, options.signal),
  );

  if (uploadIntent.bucket !== RESOURCE_FILES_BUCKET) {
    throw new Error('Unsupported resource upload bucket.');
  }

  throwIfUploadCancelled(options.signal);
  await uploadUriToSignedUrl(uri, resolveSignedUploadUrl(uploadIntent), {
    // The server signs for the content type it resolved, not the one the
    // picker guessed, so send that back or finalize rejects the object.
    mimeType: uploadIntent.expected.contentType,
    onProgress: options.onProgress,
    signal: options.signal,
    sizeBytes: upload.sizeBytes,
  });

  throwIfUploadCancelled(options.signal);
  const finalized = await awaitAbortAware(
    options.signal,
    options.api.finalizePostResourceFileUpload({
      path: uploadIntent.path,
      fileName,
      contentType: uploadIntent.expected.contentType,
      sizeBytes: upload.sizeBytes,
    }, options.signal),
  );
  throwIfUploadCancelled(options.signal);

  return finalized.attachment;
}

export async function uploadProfileImage(
  uri: string,
  options: {
    api?: Pick<MagicbookletApiClient, 'createProfileMediaUpload'>;
    role: 'avatar' | 'cover';
    fileName?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    signal?: AbortSignal;
    onProgress?: (progress: UriUploadProgress) => void;
  }
) {
  const missingEnvKeys = getMissingMobileEnvKeys();
  if (missingEnvKeys.length > 0) {
    throw new Error(`Configure mobile uploads first: ${missingEnvKeys.join(', ')}`);
  }

  const upload = await inspectUriUpload(uri, {
    mimeType: options.mimeType,
    sizeBytes: options.sizeBytes,
    defaultMimeType: 'image/jpeg',
  });
  const mimeType = upload.mimeType;
  const sizeBytes = upload.sizeBytes;

  if (!mimeType.startsWith('image/')) {
    throw new Error('Choose an image file.');
  }

  if (sizeBytes > 5 * 1024 * 1024) {
    throw new Error('Use an image smaller than 5MB.');
  }

  const extension = getUploadExtension(mimeType, options.fileName);
  const originalName = sanitizeUploadFileName(options.fileName, `${options.role}.${extension || 'jpg'}`);

  if (!options.api) {
    throw new Error('Profile media uploads must be authorized by the app API.');
  }

  const uploadIntent = await options.api.createProfileMediaUpload({
    role: options.role,
    fileName: originalName,
    mimeType,
    sizeBytes,
  });

  if (uploadIntent.bucket !== 'profiles') {
    throw new Error('Unsupported profile upload bucket.');
  }

  await uploadUriToSignedUrl(uri, resolveSignedUploadUrl(uploadIntent), {
    mimeType,
    onProgress: options.onProgress,
    signal: options.signal,
    sizeBytes,
  });

  if (!uploadIntent.publicUrl) {
    throw new Error('Could not create profile image URL.');
  }

  return uploadIntent.publicUrl;
}

function resolveSignedUploadUrl(intent: {
  bucket: string;
  path: string;
  signedUploadUrl: string | null;
  token: string;
}) {
  let storageOrigin: URL;
  try {
    storageOrigin = new URL(env.supabaseUrl);
  } catch {
    throw new Error('Mobile storage is not configured correctly.');
  }

  const encodedObjectPath = [intent.bucket, ...intent.path.split('/')]
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const basePath = storageOrigin.pathname.replace(/\/$/, '');
  const expectedPath = `${basePath}/storage/v1/object/upload/sign/${encodedObjectPath}`;
  const signedUrl = intent.signedUploadUrl
    ? new URL(intent.signedUploadUrl)
    : new URL(expectedPath, storageOrigin.origin);

  if (
    signedUrl.origin !== storageOrigin.origin
    || signedUrl.pathname !== expectedPath
    || signedUrl.username
    || signedUrl.password
  ) {
    throw new Error('The upload destination returned by the server is invalid.');
  }

  const signedToken = signedUrl.searchParams.get('token');
  if (signedToken && signedToken !== intent.token) {
    throw new Error('The upload authorization returned by the server is invalid.');
  }
  signedUrl.searchParams.set('token', intent.token);
  return signedUrl.toString();
}
