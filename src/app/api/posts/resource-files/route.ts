import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
  POST_RESOURCE_FILE_UPLOAD_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import type { PostResourceAttachment } from '@/lib/post-resource-bundles';

const RESOURCE_FILES_BUCKET = 'post_resource_files';
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const ALLOWED_RESOURCE_FILE_EXTENSIONS = new Set([
  '.json',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.yaml',
  '.yml',
  '.pdf',
  '.zip',
  '.gz',
  '.workflow',
]);
const ALLOWED_RESOURCE_FILE_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/gzip',
  'application/x-gzip',
  'application/zip',
  'application/x-zip-compressed',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/yaml',
]);
const BLOCKED_RESOURCE_FILE_EXTENSIONS = new Set([
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

function sanitizeFileName(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const stem = path.basename(fileName, extension).toLowerCase();
  const safeStem = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'resource';
  return `${safeStem}${extension || '.bin'}`;
}

function isAllowedResourceFile(file: File): boolean {
  const extension = path.extname(file.name).toLowerCase();
  const contentType = file.type.toLowerCase();

  if (BLOCKED_RESOURCE_FILE_EXTENSIONS.has(extension)) {
    return false;
  }

  if (contentType && ALLOWED_RESOURCE_FILE_TYPES.has(contentType)) {
    return true;
  }

  return ALLOWED_RESOURCE_FILE_EXTENSIONS.has(extension);
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

  const adminSupabase = createServiceClient();
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_RESOURCE_FILE_UPLOAD_RATE_LIMIT,
      key: user.id,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    console.error('Post resource file upload rate limit check failed:', error);
    return NextResponse.json({ error: 'Failed to check resource upload limits.' }, { status: 500 });
  }

  const formData = await request.formData();
  const file = formData.get('file');

  if (!(file instanceof File) || file.size <= 0) {
    return NextResponse.json({ error: 'Choose a workflow or resource file to upload.' }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: 'Resource files must be 50MB or smaller.' }, { status: 400 });
  }

  if (!isAllowedResourceFile(file)) {
    return NextResponse.json({
      error: 'Upload a safe workflow or resource file: JSON, text, markdown, CSV, YAML, PDF, ZIP, or workflow export.',
    }, { status: 400 });
  }

  const safeName = sanitizeFileName(file.name);
  const storagePath = `${user.id}/${randomUUID()}-${safeName}`;
  const { error: uploadError } = await adminSupabase.storage
    .from(RESOURCE_FILES_BUCKET)
    .upload(storagePath, file, {
      cacheControl: '3600',
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });

  if (uploadError) {
    console.error('Failed to upload post resource file:', uploadError);
    return NextResponse.json({ error: 'Failed to upload resource file.' }, { status: 500 });
  }

  const attachment: PostResourceAttachment = {
    label: file.name,
    kind: 'file',
    storagePath,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  };

  return NextResponse.json({
    success: true,
    attachment,
  });
}
