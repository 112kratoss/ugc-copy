import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_MEDIA_MIME_TYPES, isAllowedStorageMediaMimeType } from '@/lib/storage-upload-mime-policy';
import { MEDIA_OBJECT_NOT_FOUND_CODE } from '@/lib/temporary-media-read-url';
import { MAX_UPLOAD_BYTES_BY_KIND } from '@/lib/temporary-media-upload-sign';

const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  from: vi.fn(),
  upload: vi.fn(),
  uploadToSignedUrl: vi.fn(),
  createSignedUrl: vi.fn(),
}));

/**
 * Captures the raw PUT the helper now issues. supabase-js is no longer the
 * transport: it posts through fetch, which cannot report upload progress or be
 * cancelled, so the upload goes out over XHR instead.
 */
function stubXhr() {
  const sent: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];

  class FakeXhr {
    status = 200;
    responseText = '';
    upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private request = { method: '', url: '', headers: {} as Record<string, string> };

    open(method: string, url: string) {
      this.request.method = method;
      this.request.url = url;
    }

    setRequestHeader(key: string, value: string) {
      this.request.headers[key] = value;
    }

    send(body: unknown) {
      sent.push({ ...this.request, body });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
      this.onload?.();
    }

    abort() {
      this.onabort?.();
    }
  }

  vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
  return sent;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: supabaseMocks.getSession,
    },
    storage: {
      from: supabaseMocks.from,
    },
  },
}));

describe('uploadMediaToTemporaryStorage', () => {
  beforeEach(() => {
    supabaseMocks.getSession.mockReset();
    supabaseMocks.from.mockReset();
    supabaseMocks.upload.mockReset();
    supabaseMocks.uploadToSignedUrl.mockReset();
    supabaseMocks.createSignedUrl.mockReset();

    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'access-token',
          user: { id: 'user-1' },
        },
      },
      error: null,
    });
    supabaseMocks.uploadToSignedUrl.mockResolvedValue({ error: null });
    supabaseMocks.createSignedUrl.mockResolvedValue({ data: null, error: new Error('client read signing should not run') });
    supabaseMocks.from.mockReturnValue({
      upload: supabaseMocks.upload,
      uploadToSignedUrl: supabaseMocks.uploadToSignedUrl,
      createSignedUrl: supabaseMocks.createSignedUrl,
    });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/uploads/media/sign') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            uploadId: '11111111-1111-4111-8111-111111111111',
            bucket: 'uploads',
            path: 'user-1/reference.png',
            storagePath: 'uploads/user-1/reference.png',
            token: 'upload-token',
            signedUploadUrl: 'https://storage.example.test/upload',
            expiresInSeconds: 7200,
          }),
        };
      }

      if (url === '/api/uploads/finalize') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            bucket: 'uploads',
            path: 'user-1/reference.png',
            storagePath: 'uploads/user-1/reference.png',
            contentType: 'image/png',
            sizeBytes: 11,
          }),
        };
      }

      if (url === '/api/uploads/media/read-url') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            signedUrl: 'https://storage.example.test/signed/reference.png',
            expiresInSeconds: 3600,
          }),
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not reserve storage for a cancelled upload', async () => {
    const { uploadMediaToTemporaryStorage } = await import('@/lib/temporary-media-upload');
    const signal = AbortSignal.abort();
    await expect(uploadMediaToTemporaryStorage(new File(['image'], 'image.png'), { signal }))
      .rejects.toMatchObject({ name: 'UploadCancelledError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  // A creator's press uploads for the account it was pressed for: another account signing in from
  // another tab meanwhile would have the file staged in that account's folder.
  it('goes up only under the session of the account it is for', async () => {
    stubXhr();
    const { uploadMediaToTemporaryStorage } = await import('@/lib/temporary-media-upload');
    await expect(uploadMediaToTemporaryStorage(new File(['image'], 'image.png', { type: 'image/png' }), { userId: 'user-2' }))
      .rejects.toMatchObject({ name: 'UploadCancelledError' });
    expect(fetch).not.toHaveBeenCalled();

    await expect(uploadMediaToTemporaryStorage(new File(['image'], 'image.png', { type: 'image/png' }), { userId: 'user-1' }))
      .resolves.toMatchObject({ storagePath: 'uploads/user-1/reference.png' });
  });

  it('carries cancellation through preparation, finalization and preview signing', async () => {
    stubXhr();
    const { uploadMediaToTemporaryStorage } = await import('@/lib/temporary-media-upload');
    const signal = new AbortController().signal;
    await uploadMediaToTemporaryStorage(new File(['image'], 'image.png', { type: 'image/png' }), { signal });
    for (const endpoint of ['/api/uploads/media/sign', '/api/uploads/finalize', '/api/uploads/media/read-url']) {
      expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ signal }));
    }
  });

  it('uploads temporary media through a backend-issued signed upload intent', async () => {
    const sent = stubXhr();
    const { uploadMediaToTemporaryStorage } = await import('@/lib/temporary-media-upload');
    const file = new File(['image-bytes'], 'Reference Image.PNG', { type: 'image/png' });
    const progress: number[] = [];

    await expect(uploadMediaToTemporaryStorage(file, {
      onProgress: ({ fraction }) => progress.push(fraction),
    })).resolves.toEqual({
      signedUrl: 'https://storage.example.test/signed/reference.png',
      storagePath: 'uploads/user-1/reference.png',
    });

    expect(fetch).toHaveBeenCalledWith('/api/uploads/media/sign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer access-token',
      },
      body: JSON.stringify({
        fileName: 'Reference Image.PNG',
        mimeType: 'image/png',
        kind: 'image',
        sizeBytes: file.size,
      }),
    });
    // The signed URL from the sign response is used directly; supabase-js is no
    // longer in the upload path at all.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'PUT',
      url: 'https://storage.example.test/upload',
      headers: {
        // Publish copies staged objects into the public bucket carrying this
        // header, so it has to match the public 300s policy.
        'cache-control': 'max-age=86400',
        'content-type': 'image/png',
        'x-upsert': 'false',
      },
      body: file,
    });
    expect(supabaseMocks.uploadToSignedUrl).not.toHaveBeenCalled();
    expect(progress).toEqual([0.5, 1]);
    expect(fetch).toHaveBeenCalledWith('/api/uploads/media/read-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer access-token',
      },
      body: JSON.stringify({
        storagePath: 'uploads/user-1/reference.png',
      }),
    });
    expect(supabaseMocks.createSignedUrl).not.toHaveBeenCalled();
    expect(supabaseMocks.upload).not.toHaveBeenCalled();
  });

  it('takes its options second, with no owner id it never read', async () => {
    const sent = stubXhr();
    const { uploadMediaToTemporaryStorage } = await import('@/lib/temporary-media-upload');
    const progress: number[] = [];

    await expect(uploadMediaToTemporaryStorage(
      new File(['image-bytes'], 'reference.png', { type: 'image/png' }),
      { onProgress: ({ fraction }) => progress.push(fraction) },
    )).resolves.toMatchObject({ storagePath: 'uploads/user-1/reference.png' });
    expect(sent).toHaveLength(1);
    expect(progress).toEqual([0.5, 1]);

    await expect(uploadMediaToTemporaryStorage(new File(['image'], 'image.png'), { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: 'UploadCancelledError' });
  });
});

describe('refreshTemporaryMediaUrl', () => {
  beforeEach(() => {
    supabaseMocks.getSession.mockReset();
    supabaseMocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'access-token', user: { id: 'user-1' } } },
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renews the link of media already staged instead of uploading it again', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      signedUrl: 'https://storage.example.test/signed/again.png',
      expiresInSeconds: 3600,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { refreshTemporaryMediaUrl } = await import('@/lib/temporary-media-upload');

    await expect(refreshTemporaryMediaUrl('uploads/user-1/reference.png'))
      .resolves.toBe('https://storage.example.test/signed/again.png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/uploads/media/read-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer access-token',
      },
      body: JSON.stringify({ storagePath: 'uploads/user-1/reference.png' }),
    });
  });

  it('says when the staged object is gone, so the creator uploads the file again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: MEDIA_OBJECT_NOT_FOUND_CODE,
      error: 'That upload is no longer available.',
    }), { status: 404 })));
    const { refreshTemporaryMediaUrl, TemporaryMediaReadUrlError } = await import('@/lib/temporary-media-upload');

    const error = await refreshTemporaryMediaUrl('uploads/user-1/old.png').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TemporaryMediaReadUrlError);
    expect(error).toMatchObject({
      message: 'That upload is no longer available.',
      status: 404,
      code: 'MEDIA_OBJECT_NOT_FOUND',
    });
  });

  it('keeps the status of a failure whose body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })));
    const { refreshTemporaryMediaUrl } = await import('@/lib/temporary-media-upload');

    await expect(refreshTemporaryMediaUrl('uploads/user-1/reference.png'))
      .rejects.toMatchObject({ status: 502, code: null, message: 'Failed to prepare media preview.' });
  });

  it('needs a signed-in session', async () => {
    supabaseMocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { refreshTemporaryMediaUrl } = await import('@/lib/temporary-media-upload');

    await expect(refreshTemporaryMediaUrl('uploads/user-1/reference.png')).rejects.toThrow('Please log in to upload files.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs nothing again under a session another account has taken since the press', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { refreshTemporaryMediaUrl } = await import('@/lib/temporary-media-upload');

    await expect(refreshTemporaryMediaUrl('uploads/user-1/reference.png', { userId: 'user-2' }))
      .rejects.toMatchObject({ name: 'UploadCancelledError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('TEMPORARY_MEDIA_UPLOAD_LIMITS', () => {
  it('holds the same byte caps as the sign step', async () => {
    const { TEMPORARY_MEDIA_UPLOAD_LIMITS } = await import('@/lib/temporary-media-upload');

    expect(TEMPORARY_MEDIA_UPLOAD_LIMITS.maxBytesByKind).toEqual(MAX_UPLOAD_BYTES_BY_KIND);
  });

  it('allows exactly the types the sign step allows', async () => {
    const { TEMPORARY_MEDIA_UPLOAD_LIMITS } = await import('@/lib/temporary-media-upload');
    const candidates = [
      ...Object.values(STORAGE_MEDIA_MIME_TYPES).flat(),
      'audio/x-m4a',
      'audio/flac',
      'video/x-matroska',
      'image/bmp',
      'image/svg+xml',
      'IMAGE/PNG',
      '',
    ];

    for (const kind of ['image', 'video', 'audio'] as const) {
      for (const type of candidates) {
        expect(TEMPORARY_MEDIA_UPLOAD_LIMITS.isAllowedMimeType(kind, type), `${kind} ${type}`)
          .toBe(isAllowedStorageMediaMimeType(kind, type));
      }
    }
    expect(TEMPORARY_MEDIA_UPLOAD_LIMITS.isAllowedMimeType('audio', 'audio/x-m4a')).toBe(false);
    expect(TEMPORARY_MEDIA_UPLOAD_LIMITS.isAllowedMimeType('video', 'video/quicktime')).toBe(true);
  });
});
