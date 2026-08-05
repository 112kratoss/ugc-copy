import { describe, expect, it, vi } from 'vitest';

import {
  UploadCancelledError,
  getUploadExtension,
  inspectUriUpload,
  runWeightedUploadQueue,
  uploadUriToSignedUrl,
} from '../lib/upload-file';

describe('mobile upload file helpers', () => {
  it('inspects native file metadata without reading a file-sized JS body', async () => {
    const inspectFile = vi.fn(async () => ({
      exists: true,
      mimeType: 'image/png',
      sizeBytes: 4,
    }));

    const upload = await inspectUriUpload('file:///avatar.png', {
      mimeType: null,
      sizeBytes: null,
      inspectFile,
    });

    expect(inspectFile).toHaveBeenCalledWith('file:///avatar.png');
    expect(upload).toEqual({ mimeType: 'image/png', sizeBytes: 4 });
    expect(upload).not.toHaveProperty('body');
  });

  it('uses the native file size instead of trusting stale picker metadata', async () => {
    await expect(inspectUriUpload('file:///clip.mp4', {
      mimeType: 'video/mp4; charset=binary',
      sizeBytes: 10,
      inspectFile: async () => ({ exists: true, mimeType: 'video/mp4', sizeBytes: 25 }),
    })).resolves.toEqual({ mimeType: 'video/mp4', sizeBytes: 25 });
  });

  it('rejects missing and empty selected files before requesting an upload intent', async () => {
    await expect(inspectUriUpload('file:///gone.png', {
      inspectFile: async () => ({ exists: false, sizeBytes: 0 }),
    })).rejects.toThrow('no longer available');

    await expect(inspectUriUpload('file:///empty.png', {
      inspectFile: async () => ({ exists: true, sizeBytes: 0 }),
    })).rejects.toThrow('determine the selected file size');
  });

  it('streams a signed PUT with progress without exposing a JS upload body', async () => {
    const onProgress = vi.fn();
    const uploadAsync = vi.fn(async () => ({ status: 200, body: '{"Key":"uploads/file.png"}' }));
    const createUploadTask = vi.fn(async (_url, _uri, _options, progress) => {
      progress({ totalBytesSent: 5, totalBytesExpectedToSend: 10 });
      return { uploadAsync, cancelAsync: vi.fn(async () => undefined) };
    });

    await uploadUriToSignedUrl(
      'file:///file.png',
      'https://storage.example.com/storage/v1/object/upload/sign/uploads/file.png?token=signed',
      {
        mimeType: 'image/png',
        sizeBytes: 10,
        onProgress,
        createUploadTask,
      }
    );

    expect(createUploadTask).toHaveBeenCalledWith(
      expect.stringContaining('token=signed'),
      'file:///file.png',
      {
        headers: {
          // Publish copies staged objects into the public bucket carrying this
          // header, so it has to match the public 300s policy.
          'cache-control': 'max-age=300',
          'content-type': 'image/png',
          'x-upsert': 'false',
        },
        httpMethod: 'PUT',
        uploadType: 0,
      },
      expect.any(Function)
    );
    expect(uploadAsync).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      bytesSent: 5,
      totalBytes: 10,
      fraction: 0.5,
    });
    expect(onProgress).toHaveBeenLastCalledWith({ bytesSent: 10, totalBytes: 10, fraction: 1 });
  });

  it('cancels the native task when its abort signal fires', async () => {
    const controller = new AbortController();
    let finishUpload: ((value: null) => void) | undefined;
    const cancelAsync = vi.fn(async () => {
      finishUpload?.(null);
    });
    const uploadAsync = vi.fn(() => new Promise<null>((resolve) => {
      finishUpload = resolve;
    }));
    const createUploadTask = vi.fn(async () => ({ uploadAsync, cancelAsync }));

    const upload = uploadUriToSignedUrl('file:///clip.mp4', 'https://storage.example.com/upload', {
      mimeType: 'video/mp4',
      sizeBytes: 20,
      signal: controller.signal,
      createUploadTask,
    });
    await vi.waitFor(() => expect(uploadAsync).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(upload).rejects.toBeInstanceOf(UploadCancelledError);
    expect(cancelAsync).toHaveBeenCalledTimes(1);
  });

  it('returns a safe server error for failed native uploads', async () => {
    await expect(uploadUriToSignedUrl('file:///clip.mp4', 'https://storage.example.com/upload', {
      mimeType: 'video/mp4',
      sizeBytes: 20,
      createUploadTask: async () => ({
        cancelAsync: vi.fn(async () => undefined),
        uploadAsync: vi.fn(async () => ({ status: 413, body: '{"message":"File is too large"}' })),
      }),
    })).rejects.toThrow('File is too large');
  });

  it('runs two images concurrently but gives each video the full upload budget', async () => {
    const releases = new Map<string, () => void>();
    const starts: string[] = [];
    const queue = runWeightedUploadQueue([
      { item: 'image-1', kind: 'image' },
      { item: 'image-2', kind: 'image' },
      { item: 'video-1', kind: 'video' },
      { item: 'image-3', kind: 'image' },
    ], async (item) => {
      starts.push(item);
      await new Promise<void>((resolve) => releases.set(item, resolve));
      return `${item}:uploaded`;
    });

    await vi.waitFor(() => expect(starts).toEqual(['image-1', 'image-2']));
    releases.get('image-1')?.();
    await Promise.resolve();
    expect(starts).toEqual(['image-1', 'image-2']);

    releases.get('image-2')?.();
    await vi.waitFor(() => expect(starts).toEqual(['image-1', 'image-2', 'video-1']));
    releases.get('video-1')?.();
    await vi.waitFor(() => expect(starts).toEqual(['image-1', 'image-2', 'video-1', 'image-3']));
    releases.get('image-3')?.();

    await expect(queue).resolves.toMatchObject({
      failures: [],
      successes: [
        { index: 0, result: 'image-1:uploaded' },
        { index: 1, result: 'image-2:uploaded' },
        { index: 2, result: 'video-1:uploaded' },
        { index: 3, result: 'image-3:uploaded' },
      ],
    });
  });

  it('normalizes common image upload extensions', () => {
    expect(getUploadExtension('image/jpeg', 'photo.jpeg')).toBe('jpg');
    expect(getUploadExtension('image/heic', null)).toBe('heic');
    expect(getUploadExtension('', 'photo')).toBe('bin');
  });
});
