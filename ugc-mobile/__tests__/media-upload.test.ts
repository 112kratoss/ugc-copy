import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadState = vi.hoisted(() => ({
  getUser: vi.fn(),
  upload: vi.fn(),
  createSignedUrl: vi.fn(),
  getPublicUrl: vi.fn(),
  readUriUploadBody: vi.fn(),
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: vi.fn(),
}));

vi.mock('../lib/env', () => ({
  getMissingMobileEnvKeys: () => [],
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: uploadState.getUser,
    },
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, body: unknown, options: unknown) =>
          uploadState.upload(bucket, path, body, options),
        createSignedUrl: (path: string, expiresIn: number) =>
          uploadState.createSignedUrl(bucket, path, expiresIn),
        getPublicUrl: (path: string) =>
          uploadState.getPublicUrl(bucket, path),
      }),
    },
  },
}));

vi.mock('../lib/upload-file', async () => {
  const actual = await vi.importActual<typeof import('../lib/upload-file')>('../lib/upload-file');
  return {
    ...actual,
    readUriUploadBody: (...args: unknown[]) => uploadState.readUriUploadBody(...args),
  };
});

describe('mobile media uploads', () => {
  beforeEach(() => {
    uploadState.getUser.mockReset();
    uploadState.upload.mockReset();
    uploadState.createSignedUrl.mockReset();
    uploadState.getPublicUrl.mockReset();
    uploadState.readUriUploadBody.mockReset();
    uploadState.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    uploadState.readUriUploadBody.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]).buffer,
      mimeType: 'image/png',
      sizeBytes: 3,
    });
    uploadState.upload.mockResolvedValue({ error: null });
    uploadState.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://storage.example.com/uploads/user-1/signed.png' },
      error: null,
    });
    uploadState.getPublicUrl.mockReturnValue({
      data: { publicUrl: 'https://storage.example.com/profiles/user-1/avatar.png' },
    });
  });

  it('rejects unsupported client upload buckets before auth or storage work', async () => {
    const { uploadPickedMedia } = await import('../lib/media');

    await expect(uploadPickedMedia('file:///image.png', {
      bucket: 'generated_images',
      fileName: 'image.png',
      mimeType: 'image/png',
    })).rejects.toThrow('Unsupported mobile upload bucket.');

    expect(uploadState.getUser).not.toHaveBeenCalled();
    expect(uploadState.readUriUploadBody).not.toHaveBeenCalled();
    expect(uploadState.upload).not.toHaveBeenCalled();
  });

  it('sanitizes picked media file names before creating storage paths', async () => {
    const { uploadPickedMedia } = await import('../lib/media');

    await expect(uploadPickedMedia('file:///image.png', {
      fileName: '../bad name?.png',
      mimeType: 'image/png',
    })).resolves.toMatchObject({
      fileName: 'bad-name-.png',
      storagePath: expect.stringMatching(/^uploads\/user-1\/[^/]+-bad-name-\.png$/),
    });

    expect(uploadState.upload).toHaveBeenCalledWith(
      'uploads',
      expect.stringMatching(/^user-1\/[^/]+-bad-name-\.png$/),
      expect.any(ArrayBuffer),
      { contentType: 'image/png' },
    );
  });

  it('sanitizes profile image file names before public profile uploads', async () => {
    const { uploadProfileImage } = await import('../lib/media');

    await expect(uploadProfileImage('file:///avatar.png', {
      role: 'avatar',
      fileName: '../avatar image?.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    })).resolves.toBe('https://storage.example.com/profiles/user-1/avatar.png');

    expect(uploadState.upload).toHaveBeenCalledWith(
      'profiles',
      expect.stringMatching(/^user-1\/avatar-[0-9]+-avatar-image-\.png$/),
      expect.any(ArrayBuffer),
      { contentType: 'image/png', upsert: true },
    );
  });
});
