import { beforeEach, describe, expect, it, vi } from 'vitest';

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
            bucket: 'uploads',
            path: 'user-1/reference.png',
            storagePath: 'uploads/user-1/reference.png',
            token: 'upload-token',
            signedUploadUrl: 'https://storage.example.test/upload',
            expiresInSeconds: 7200,
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

  it('uploads temporary media through a backend-issued signed upload intent', async () => {
    const sent = stubXhr();
    const { uploadMediaToTemporaryStorage } = await import('@/lib/temporary-media-upload');
    const file = new File(['image-bytes'], 'Reference Image.PNG', { type: 'image/png' });
    const progress: number[] = [];

    await expect(uploadMediaToTemporaryStorage(file, 'user-1', {
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
        'cache-control': 'max-age=300',
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
});
