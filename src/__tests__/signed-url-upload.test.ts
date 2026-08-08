import { describe, expect, it, vi } from 'vitest';

import { resolveSignedUploadUrl, uploadFileToSignedUrl } from '@/lib/signed-url-upload';
import { isUploadCancelledError } from '@/lib/upload-queue';

type FakeXhrOptions = {
  status?: number;
  responseText?: string;
  autoComplete?: boolean;
};

function fakeXhrFactory(options: FakeXhrOptions = {}) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  let instance: FakeXhr | null = null;

  class FakeXhr {
    status = options.status ?? 200;
    responseText = options.responseText ?? '';
    upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    aborted = false;
    private request = { method: '', url: '', headers: {} as Record<string, string> };

    open(method: string, url: string) {
      this.request.method = method;
      this.request.url = url;
    }

    setRequestHeader(key: string, value: string) {
      this.request.headers[key] = value;
    }

    send(body: unknown) {
      calls.push({ ...this.request, body });
      if (options.autoComplete === false) return;
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      this.onload?.();
    }

    abort() {
      this.aborted = true;
      this.onabort?.();
    }

    fail() {
      this.onerror?.();
    }
  }

  const createRequest = () => {
    instance = new FakeXhr();
    return instance as unknown as XMLHttpRequest;
  };

  return { calls, createRequest, getInstance: () => instance };
}

const file = new File(['bytes'], 'shot.png', { type: 'image/png' });

describe('uploadFileToSignedUrl', () => {
  it('PUTs with the same headers the mobile client sends to this endpoint', async () => {
    const xhr = fakeXhrFactory();
    await uploadFileToSignedUrl(file, 'https://storage.example.test/upload', {
      mimeType: 'image/png',
      createRequest: xhr.createRequest,
    });

    expect(xhr.calls[0]).toMatchObject({
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
  });

  it('reports byte progress and always finishes at a full bar', async () => {
    const xhr = fakeXhrFactory();
    const fractions: number[] = [];

    await uploadFileToSignedUrl(file, 'https://storage.example.test/upload', {
      mimeType: 'image/png',
      onProgress: ({ fraction }) => fractions.push(fraction),
      createRequest: xhr.createRequest,
    });

    expect(fractions[0]).toBe(0.5);
    expect(fractions.at(-1)).toBe(1);
  });

  it('surfaces the server message for a rejected upload', async () => {
    const xhr = fakeXhrFactory({ status: 413, responseText: '{"message":"File is too large"}' });
    await expect(uploadFileToSignedUrl(file, 'https://storage.example.test/upload', {
      mimeType: 'image/png',
      createRequest: xhr.createRequest,
    })).rejects.toThrow('File is too large');
  });

  it('falls back to a generic message when the body is not JSON', async () => {
    const xhr = fakeXhrFactory({ status: 500, responseText: '<html>gateway</html>' });
    await expect(uploadFileToSignedUrl(file, 'https://storage.example.test/upload', {
      mimeType: 'image/png',
      createRequest: xhr.createRequest,
    })).rejects.toThrow('Upload failed with status 500.');
  });

  it('rejects without opening a request when the signal is already aborted', async () => {
    const xhr = fakeXhrFactory();
    const controller = new AbortController();
    controller.abort();

    await expect(uploadFileToSignedUrl(file, 'https://storage.example.test/upload', {
      mimeType: 'image/png',
      signal: controller.signal,
      createRequest: xhr.createRequest,
    })).rejects.toSatisfy(isUploadCancelledError);
    expect(xhr.calls).toHaveLength(0);
  });

  it('aborts the in-flight request when the signal fires mid-upload', async () => {
    const xhr = fakeXhrFactory({ autoComplete: false });
    const controller = new AbortController();

    const upload = uploadFileToSignedUrl(file, 'https://storage.example.test/upload', {
      mimeType: 'image/png',
      signal: controller.signal,
      createRequest: xhr.createRequest,
    });

    controller.abort();

    await expect(upload).rejects.toSatisfy(isUploadCancelledError);
    expect(xhr.getInstance()?.aborted).toBe(true);
  });

  it('reports a connection failure in plain language', async () => {
    const xhr = fakeXhrFactory({ autoComplete: false });
    const upload = uploadFileToSignedUrl(file, 'https://storage.example.test/upload', {
      mimeType: 'image/png',
      createRequest: xhr.createRequest,
    });

    xhr.getInstance()?.fail();
    await expect(upload).rejects.toThrow('Check your connection');
  });
});

describe('resolveSignedUploadUrl', () => {
  it('uses the URL the sign response already provides', () => {
    expect(resolveSignedUploadUrl({
      bucket: 'uploads',
      path: 'user-1/a.png',
      token: 'tok',
      signedUploadUrl: 'https://storage.example.test/upload',
    })).toBe('https://storage.example.test/upload');
  });

  it('reconstructs the URL when the sign response omits it', () => {
    const url = new URL(resolveSignedUploadUrl({
      bucket: 'uploads',
      path: 'user-1/a.png',
      token: 'tok',
      signedUploadUrl: null,
      supabaseUrl: 'https://project.supabase.co/',
    }));

    expect(url.pathname).toBe('/storage/v1/object/upload/sign/uploads/user-1/a.png');
    expect(url.searchParams.get('token')).toBe('tok');
  });

  it('refuses to guess when there is no base URL at all', () => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    expect(() => resolveSignedUploadUrl({
      bucket: 'uploads',
      path: 'user-1/a.png',
      token: 'tok',
      signedUploadUrl: null,
    })).toThrow('Media upload response was invalid.');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', previous ?? '');
  });
});
