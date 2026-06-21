import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
  PROFILE_MEDIA_UPLOAD_SIGN_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

const PROFILE_MEDIA_BUCKET = 'profiles';
const SIGNED_UPLOAD_EXPIRES_IN_SECONDS = 2 * 60 * 60;
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;
const BLOCKED_PROFILE_IMAGE_EXTENSIONS = new Set(['.svg', '.html', '.htm', '.js', '.mjs']);

type ProfileMediaRole = 'avatar' | 'cover';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeFileName(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const stem = path.basename(fileName, extension).toLowerCase();
  const safeStem = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'profile';
  return `${safeStem}${extension || '.jpg'}`;
}

function normalizeRole(value: unknown): ProfileMediaRole | null {
  return value === 'avatar' || value === 'cover' ? value : null;
}

function inferImageExtension(mimeType: string, fileName: string | null): string {
  const extension = fileName ? path.extname(fileName).replace('.', '').toLowerCase() : '';
  if (extension) return extension;
  if (mimeType === 'image/jpeg') return 'jpg';
  const [, subtype] = mimeType.split('/');
  return subtype?.split('+')[0]?.trim() || 'jpg';
}

function validateProfileMediaMetadata(body: unknown): {
  fileName: string;
  mimeType: string;
  role: ProfileMediaRole;
} | { error: string } {
  if (!isRecord(body)) {
    return { error: 'Invalid profile media metadata.' };
  }

  const role = normalizeRole(body.role);
  if (!role) {
    return { error: 'Choose avatar or cover profile media.' };
  }

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
  if (!mimeType || mimeType === 'image/svg+xml' || !mimeType.startsWith('image/')) {
    return { error: 'Upload a valid image file.' };
  }

  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { error: 'Upload size is required.' };
  }

  if (sizeBytes > MAX_PROFILE_IMAGE_BYTES) {
    return { error: 'Profile images must be 5MB or smaller.' };
  }

  const rawFileName = typeof body.fileName === 'string' && body.fileName.trim()
    ? body.fileName
    : `${role}.${inferImageExtension(mimeType, null)}`;
  const fileName = sanitizeFileName(rawFileName);
  const extension = path.extname(fileName).toLowerCase();
  if (BLOCKED_PROFILE_IMAGE_EXTENSIONS.has(extension)) {
    return { error: 'This image type is not supported for profile media.' };
  }

  return {
    fileName,
    mimeType,
    role,
  };
}

export async function POST(request: NextRequest) {
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let metadata;
  try {
    metadata = validateProfileMediaMetadata(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid profile media metadata.' }, { status: 400 });
  }

  if ('error' in metadata) {
    return NextResponse.json({ error: metadata.error }, { status: 400 });
  }

  const adminSupabase = createServiceClient();
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...PROFILE_MEDIA_UPLOAD_SIGN_RATE_LIMIT,
      key: user.id,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    console.error('Profile media upload sign rate limit check failed:', error);
    return NextResponse.json({ error: 'Failed to check profile media upload limits.' }, { status: 500 });
  }

  const uploadPath = `${user.id}/${metadata.role}-${randomUUID()}-${metadata.fileName}`;
  const profileStorage = adminSupabase.storage.from(PROFILE_MEDIA_BUCKET);
  const { data, error } = await profileStorage.createSignedUploadUrl(uploadPath);

  if (error || !data?.token) {
    console.error('Failed to create profile media signed upload URL:', error);
    return NextResponse.json({ error: 'Failed to prepare profile media upload.' }, { status: 500 });
  }

  const {
    data: { publicUrl },
  } = profileStorage.getPublicUrl(uploadPath);

  if (!publicUrl) {
    return NextResponse.json({ error: 'Failed to prepare profile media URL.' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    bucket: PROFILE_MEDIA_BUCKET,
    path: uploadPath,
    token: data.token,
    signedUploadUrl: data.signedUrl ?? null,
    publicUrl,
    expiresInSeconds: SIGNED_UPLOAD_EXPIRES_IN_SECONDS,
  });
}
