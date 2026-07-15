import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { env, getMissingMobileEnvKeys } from './env';
import {
  getUploadExtension,
  inspectUriUpload,
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

export async function pickResourceDocument() {
  const result = await DocumentPicker.getDocumentAsync({
    type: [
      'application/json',
      'application/pdf',
      'application/zip',
      'application/x-zip-compressed',
      'application/gzip',
      'text/*',
      '*/*',
    ],
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
