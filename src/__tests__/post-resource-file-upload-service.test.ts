import { describe, expect, it, vi } from 'vitest';

import { uploadPostResourceFileForRoute, type PostResourceFileUploadClient } from '@/lib/post-resource-file-upload-service';

function createClient({
  allowed = true,
  storageError = null as Error | null,
} = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 30,
      remaining: allowed ? 29 : 0,
      retryAfterSeconds: allowed ? 0 : 47,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const upload = vi.fn(async () => ({
    data: storageError ? null : { path: 'user-1/upload-id-guide.pdf' },
    error: storageError,
  }));
  const from = vi.fn(() => ({ upload }));

  return {
    client: {
      rpc,
      storage: { from },
    } satisfies PostResourceFileUploadClient,
    rpc,
    from,
    upload,
  };
}

function formDataWithFile(file: File) {
  const formData = new FormData();
  formData.set('file', file);
  return formData;
}

describe('uploadPostResourceFileForRoute', () => {
  it('rate limits before multipart parsing or storage work', async () => {
    const client = createClient({ allowed: false });
    const readFormData = vi.fn(async () => formDataWithFile(new File(['hello'], 'guide.pdf', { type: 'application/pdf' })));

    const result = await uploadPostResourceFileForRoute({
      client: client.client,
      userId: 'user-1',
      readFormData,
      createUploadId: () => 'upload-id',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 47,
      },
    });
    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-file:upload',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(readFormData).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('rejects unsafe resource files after the upload limit check', async () => {
    const client = createClient();

    const result = await uploadPostResourceFileForRoute({
      client: client.client,
      userId: 'user-1',
      readFormData: vi.fn(async () => formDataWithFile(new File(['<script />'], 'demo.html', { type: 'text/html' }))),
      createUploadId: () => 'upload-id',
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: {
        error: 'Upload a safe image, video, audio, workflow, document, or archive resource file.',
      },
    });
    expect(client.rpc).toHaveBeenCalledOnce();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('rejects an unsupported MIME type even when the resource extension is allowed', async () => {
    const client = createClient();

    const result = await uploadPostResourceFileForRoute({
      client: client.client,
      userId: 'user-1',
      readFormData: vi.fn(async () => formDataWithFile(new File(['fake'], 'guide.pdf', {
        type: 'application/x-uncommon-document',
      }))),
      createUploadId: () => 'upload-id',
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('normalizes generic mobile workflow exports to their canonical storage MIME type', async () => {
    const client = createClient();

    const result = await uploadPostResourceFileForRoute({
      client: client.client,
      userId: 'user-1',
      readFormData: vi.fn(async () => formDataWithFile(new File(['{}'], 'campaign.workflow', {
        type: 'application/octet-stream',
      }))),
      createUploadId: () => 'upload-id',
    });

    expect(result).toMatchObject({
      ok: true,
      body: {
        attachment: { contentType: 'application/json' },
      },
    });
    expect(client.upload).toHaveBeenCalledWith(
      'user-1/upload-id-campaign.workflow',
      expect.any(File),
      expect.objectContaining({ contentType: 'application/json' }),
    );
  });

  it('uploads allowed files with sanitized storage paths and returns attachment metadata', async () => {
    const client = createClient();

    const result = await uploadPostResourceFileForRoute({
      client: client.client,
      userId: 'user-1',
      readFormData: vi.fn(async () => formDataWithFile(new File(['hello'], 'Launch Guide.PDF', { type: 'application/pdf' }))),
      createUploadId: () => 'upload-id',
    });

    expect(client.from).toHaveBeenCalledWith('post_resource_files');
    expect(client.upload).toHaveBeenCalledWith('user-1/upload-id-launch-guide.pdf', expect.any(File), {
      cacheControl: '3600',
      contentType: 'application/pdf',
      upsert: false,
    });
    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        attachment: {
          label: 'Launch Guide.PDF',
          kind: 'file',
          storagePath: 'user-1/upload-id-launch-guide.pdf',
          contentType: 'application/pdf',
          sizeBytes: 5,
        },
      },
    });
  });

  it.each([
    ['reference.jpg', 'image/jpeg'],
    ['reference.mp4', 'video/mp4'],
    ['reference.mp3', 'audio/mpeg'],
  ])('uploads private media resource %s', async (fileName, contentType) => {
    const client = createClient();

    const result = await uploadPostResourceFileForRoute({
      client: client.client,
      userId: 'user-1',
      readFormData: vi.fn(async () => formDataWithFile(new File(['media'], fileName, { type: contentType }))),
      createUploadId: () => 'upload-id',
    });

    expect(result).toMatchObject({
      ok: true,
      body: { attachment: { contentType, storagePath: `user-1/upload-id-${fileName}` } },
    });
  });

  it('returns a stable storage failure response', async () => {
    const client = createClient({ storageError: new Error('storage outage') });

    const result = await uploadPostResourceFileForRoute({
      client: client.client,
      userId: 'user-1',
      readFormData: vi.fn(async () => formDataWithFile(new File(['hello'], 'guide.pdf', { type: 'application/pdf' }))),
      createUploadId: () => 'upload-id',
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to upload resource file.' },
    });
  });
});
