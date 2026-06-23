import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { getMissingMobileEnvKeys } from './env';
import { supabase } from './supabase';
import { getUploadExtension, readUriUploadBody } from './upload-file';
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
  } = {}
): Promise<UploadedMedia> {
  const bucket = options.bucket ?? 'uploads';
  assertClientUploadBucket(bucket);

  const missingEnvKeys = getMissingMobileEnvKeys();
  if (missingEnvKeys.length > 0) {
    throw new Error(`Configure mobile uploads first: ${missingEnvKeys.join(', ')}`);
  }

  const uploadBody = await readUriUploadBody(uri, {
    mimeType: options.mimeType,
    sizeBytes: options.sizeBytes,
  });
  const mimeType = uploadBody.mimeType;
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
    sizeBytes: uploadBody.sizeBytes,
  });
  assertClientUploadBucket(uploadIntent.bucket);

  const { error: uploadError } = await supabase.storage.from(uploadIntent.bucket).uploadToSignedUrl(uploadIntent.path, uploadIntent.token, uploadBody.body, {
    contentType: mimeType,
  });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

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
    sizeBytes: uploadBody.sizeBytes,
  };
}

export async function uploadProfileImage(
  uri: string,
  options: {
    api?: Pick<MagicbookletApiClient, 'createProfileMediaUpload'>;
    role: 'avatar' | 'cover';
    fileName?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
  }
) {
  const missingEnvKeys = getMissingMobileEnvKeys();
  if (missingEnvKeys.length > 0) {
    throw new Error(`Configure mobile uploads first: ${missingEnvKeys.join(', ')}`);
  }

  const uploadBody = await readUriUploadBody(uri, {
    mimeType: options.mimeType,
    sizeBytes: options.sizeBytes,
    defaultMimeType: 'image/jpeg',
  });
  const mimeType = uploadBody.mimeType;
  const sizeBytes = uploadBody.sizeBytes;

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

  const { error: uploadError } = await supabase.storage.from(uploadIntent.bucket).uploadToSignedUrl(uploadIntent.path, uploadIntent.token, uploadBody.body, {
    contentType: mimeType,
  });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  if (!uploadIntent.publicUrl) {
    throw new Error('Could not create profile image URL.');
  }

  return uploadIntent.publicUrl;
}
