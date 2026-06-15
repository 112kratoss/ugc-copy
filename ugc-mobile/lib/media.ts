import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { getMissingMobileEnvKeys } from './env';
import { supabase } from './supabase';
import { getUploadExtension, readUriUploadBody } from './upload-file';

export interface UploadedMedia {
  signedUrl: string;
  storagePath: string;
  mimeType: string;
  fileName: string;
  kind: 'image' | 'video' | 'audio';
  durationSeconds?: number | null;
  sizeBytes?: number | null;
}

export async function pickMediaList(
  mediaType: 'image' | 'video',
  options: {
    allowsMultipleSelection?: boolean;
  } = {}
) {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: mediaType === 'image' ? ['images'] : ['videos'],
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
    bucket?: string;
    fileName?: string | null;
    mimeType?: string | null;
    kind?: 'image' | 'video' | 'audio';
    durationSeconds?: number | null;
    sizeBytes?: number | null;
  } = {}
): Promise<UploadedMedia> {
  const missingEnvKeys = getMissingMobileEnvKeys();
  if (missingEnvKeys.length > 0) {
    throw new Error(`Configure mobile uploads first: ${missingEnvKeys.join(', ')}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error('Please sign in before uploading media.');
  }

  const uploadBody = await readUriUploadBody(uri, {
    mimeType: options.mimeType,
    sizeBytes: options.sizeBytes,
  });
  const mimeType = uploadBody.mimeType;
  const extension = getUploadExtension(mimeType, options.fileName);
  const fileName = options.fileName ?? `${Date.now()}.${extension || 'bin'}`;
  const storageKey = `${user.id}/${Math.random().toString(36).slice(2)}-${fileName}`;
  const bucket = options.bucket ?? 'uploads';

  const { error: uploadError } = await supabase.storage.from(bucket).upload(storageKey, uploadBody.body, {
    contentType: mimeType,
  });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storageKey, 3600);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message ?? 'Could not create signed media URL.');
  }

  return {
    signedUrl: data.signedUrl,
    storagePath: `${bucket}/${storageKey}`,
    mimeType,
    fileName,
    kind: options.kind ?? (mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image'),
    durationSeconds: options.durationSeconds ?? null,
    sizeBytes: uploadBody.sizeBytes,
  };
}

export async function uploadProfileImage(
  uri: string,
  options: {
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error('Please sign in before uploading profile media.');
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
  const originalName = options.fileName?.replace(/[^\w.-]/g, '-') || `${options.role}.${extension || 'jpg'}`;
  const storageKey = `${user.id}/${options.role}-${Date.now()}-${originalName}`;
  const bucket = 'profiles';

  const { error: uploadError } = await supabase.storage.from(bucket).upload(storageKey, uploadBody.body, {
    contentType: mimeType,
    upsert: true,
  });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(bucket).getPublicUrl(storageKey);

  if (!publicUrl) {
    throw new Error('Could not create profile image URL.');
  }

  return publicUrl;
}
