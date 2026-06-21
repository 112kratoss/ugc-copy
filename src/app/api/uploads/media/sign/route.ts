import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
  TEMPORARY_MEDIA_UPLOAD_SIGN_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

const TEMPORARY_UPLOADS_BUCKET = 'uploads';
const SIGNED_UPLOAD_EXPIRES_IN_SECONDS = 2 * 60 * 60;
const MAX_UPLOAD_BYTES_BY_KIND = {
  image: 25 * 1024 * 1024,
  video: 250 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
} as const;
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.dmg',
  '.exe',
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.pkg',
  '.ps1',
  '.scr',
  '.sh',
  '.svg',
]);

type UploadKind = keyof typeof MAX_UPLOAD_BYTES_BY_KIND;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeFileName(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const stem = path.basename(fileName, extension).toLowerCase();
  const safeStem = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'media';
  return `${safeStem}${extension || '.bin'}`;
}

function normalizeUploadKind(value: unknown): UploadKind | null {
  return value === 'image' || value === 'video' || value === 'audio' ? value : null;
}

function inferExtension(mimeType: string, fileName: string | null): string {
  const extension = fileName ? path.extname(fileName).replace('.', '').toLowerCase() : '';
  if (extension) return extension;
  if (mimeType === 'image/jpeg') return 'jpg';
  const [, subtype] = mimeType.split('/');
  return subtype?.split('+')[0]?.trim() || 'bin';
}

function validateUploadMetadata(body: unknown): {
  fileName: string;
  kind: UploadKind;
  mimeType: string;
  sizeBytes: number;
} | { error: string } {
  if (!isRecord(body)) {
    return { error: 'Invalid upload metadata.' };
  }

  const kind = normalizeUploadKind(body.kind);
  if (!kind) {
    return { error: 'Choose image, video, or audio media to upload.' };
  }

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : '';
  if (!mimeType || mimeType === 'image/svg+xml' || !mimeType.startsWith(`${kind}/`)) {
    return { error: `Upload a valid ${kind} file.` };
  }

  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { error: 'Upload size is required.' };
  }

  const maxBytes = MAX_UPLOAD_BYTES_BY_KIND[kind];
  if (sizeBytes > maxBytes) {
    return { error: `${kind[0].toUpperCase()}${kind.slice(1)} uploads must be ${Math.floor(maxBytes / 1024 / 1024)}MB or smaller.` };
  }

  const rawFileName = typeof body.fileName === 'string' && body.fileName.trim()
    ? body.fileName
    : `media.${inferExtension(mimeType, null)}`;
  const fileName = sanitizeFileName(rawFileName);
  if (BLOCKED_UPLOAD_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
    return { error: 'This file type is not supported for media uploads.' };
  }

  return {
    fileName,
    kind,
    mimeType,
    sizeBytes,
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
    metadata = validateUploadMetadata(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid upload metadata.' }, { status: 400 });
  }

  if ('error' in metadata) {
    return NextResponse.json({ error: metadata.error }, { status: 400 });
  }

  const adminSupabase = createServiceClient();
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...TEMPORARY_MEDIA_UPLOAD_SIGN_RATE_LIMIT,
      key: user.id,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    console.error('Temporary media upload sign rate limit check failed:', error);
    return NextResponse.json({ error: 'Failed to check media upload limits.' }, { status: 500 });
  }

  const uploadPath = `${user.id}/${randomUUID()}-${metadata.fileName}`;
  const { data, error } = await adminSupabase.storage
    .from(TEMPORARY_UPLOADS_BUCKET)
    .createSignedUploadUrl(uploadPath);

  if (error || !data?.token) {
    console.error('Failed to create temporary media signed upload URL:', error);
    return NextResponse.json({ error: 'Failed to prepare media upload.' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    bucket: TEMPORARY_UPLOADS_BUCKET,
    path: uploadPath,
    storagePath: `${TEMPORARY_UPLOADS_BUCKET}/${uploadPath}`,
    token: data.token,
    signedUploadUrl: data.signedUrl ?? null,
    expiresInSeconds: SIGNED_UPLOAD_EXPIRES_IN_SECONDS,
  });
}
