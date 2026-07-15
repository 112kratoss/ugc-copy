import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadState = vi.hoisted(() => ({
  inspectUriUpload: vi.fn(),
  uploadUriToSignedUrl: vi.fn(),
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: vi.fn(),
}));

vi.mock('../lib/env', () => ({
  env: { supabaseUrl: 'https://storage.example.com' },
  getMissingMobileEnvKeys: () => [],
}));

vi.mock('../lib/upload-file', async () => {
  const actual = await vi.importActual<typeof import('../lib/upload-file')>('../lib/upload-file');
  return {
    ...actual,
    inspectUriUpload: (...args: unknown[]) => uploadState.inspectUriUpload(...args),
    uploadUriToSignedUrl: (...args: unknown[]) => uploadState.uploadUriToSignedUrl(...args),
  };
});

describe('mobile media uploads', () => {
  beforeEach(() => {
    uploadState.inspectUriUpload.mockReset();
    uploadState.uploadUriToSignedUrl.mockReset();
    uploadState.inspectUriUpload.mockResolvedValue({
      mimeType: 'image/png',
      sizeBytes: 3,
    });
    uploadState.uploadUriToSignedUrl.mockResolvedValue(undefined);
  });

  it('rejects unsupported client upload buckets before file or storage work', async () => {
    const { uploadPickedMedia } = await import('../lib/media');

    await expect(uploadPickedMedia('file:///image.png', {
      bucket: 'generated_images',
      fileName: 'image.png',
      mimeType: 'image/png',
    })).rejects.toThrow('Unsupported mobile upload bucket.');

    expect(uploadState.inspectUriUpload).not.toHaveBeenCalled();
    expect(uploadState.uploadUriToSignedUrl).not.toHaveBeenCalled();
  });

  it('streams picked media to an exact server-issued signed upload target', async () => {
    const createMediaUpload = vi.fn(async () => ({
      success: true,
      bucket: 'uploads' as const,
      path: 'user-1/server-issued-reference.png',
      storagePath: 'uploads/user-1/server-issued-reference.png',
      token: 'upload-token',
      signedUploadUrl: 'https://storage.example.com/storage/v1/object/upload/sign/uploads/user-1/server-issued-reference.png?token=upload-token',
      expiresInSeconds: 7200,
    }));
    const createMediaReadUrl = vi.fn(async () => ({
      success: true,
      signedUrl: 'https://storage.example.com/uploads/user-1/signed.png',
      expiresInSeconds: 3600,
    }));
    const onProgress = vi.fn();
    const controller = new AbortController();
    const { uploadPickedMedia } = await import('../lib/media');

    await expect(uploadPickedMedia('file:///image.png', {
      api: { createMediaUpload, createMediaReadUrl },
      fileName: '../reference image?.png',
      mimeType: 'image/png',
      kind: 'image',
      sizeBytes: 3,
      signal: controller.signal,
      onProgress,
    })).resolves.toMatchObject({
      fileName: 'reference-image-.png',
      storagePath: 'uploads/user-1/server-issued-reference.png',
      signedUrl: 'https://storage.example.com/uploads/user-1/signed.png',
      kind: 'image',
    });

    expect(createMediaUpload).toHaveBeenCalledWith({
      fileName: 'reference-image-.png',
      mimeType: 'image/png',
      kind: 'image',
      sizeBytes: 3,
    });
    expect(uploadState.uploadUriToSignedUrl).toHaveBeenCalledWith(
      'file:///image.png',
      'https://storage.example.com/storage/v1/object/upload/sign/uploads/user-1/server-issued-reference.png?token=upload-token',
      {
        mimeType: 'image/png',
        onProgress,
        signal: controller.signal,
        sizeBytes: 3,
      }
    );
    expect(createMediaReadUrl).toHaveBeenCalledWith({
      storagePath: 'uploads/user-1/server-issued-reference.png',
    });
  });

  it('constructs a scoped signed target when an older API omits its redundant URL', async () => {
    const createMediaUpload = vi.fn(async () => ({
      success: true,
      bucket: 'uploads' as const,
      path: 'user-1/server-issued.png',
      storagePath: 'uploads/user-1/server-issued.png',
      token: 'upload-token',
      signedUploadUrl: null,
      expiresInSeconds: 7200,
    }));
    const createMediaReadUrl = vi.fn(async () => ({
      success: true,
      signedUrl: 'https://storage.example.com/read',
      expiresInSeconds: 3600,
    }));
    const { uploadPickedMedia } = await import('../lib/media');

    await uploadPickedMedia('file:///image.png', {
      api: { createMediaUpload, createMediaReadUrl },
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    });

    expect(uploadState.uploadUriToSignedUrl).toHaveBeenCalledWith(
      'file:///image.png',
      'https://storage.example.com/storage/v1/object/upload/sign/uploads/user-1/server-issued.png?token=upload-token',
      expect.any(Object)
    );
  });

  it('rejects a signed target on a different origin before native upload', async () => {
    const { uploadPickedMedia } = await import('../lib/media');

    await expect(uploadPickedMedia('file:///image.png', {
      api: {
        createMediaUpload: vi.fn(async () => ({
          success: true,
          bucket: 'uploads' as const,
          path: 'user-1/file.png',
          storagePath: 'uploads/user-1/file.png',
          token: 'upload-token',
          signedUploadUrl: 'https://evil.example/storage/v1/object/upload/sign/uploads/user-1/file.png?token=upload-token',
          expiresInSeconds: 7200,
        })),
        createMediaReadUrl: vi.fn(),
      },
      fileName: 'file.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    } as never)).rejects.toThrow('upload destination');

    expect(uploadState.uploadUriToSignedUrl).not.toHaveBeenCalled();
  });

  it('uploads video template inputs with the run-scoped streaming contract', async () => {
    uploadState.inspectUriUpload.mockResolvedValueOnce({ mimeType: 'video/mp4', sizeBytes: 3 });
    const signTemplateRunInput = vi.fn(async () => ({
      success: true,
      bucket: 'template_inputs' as const,
      path: 'user-1/run-1/reference/server-issued.mp4',
      storagePath: 'template_inputs/user-1/run-1/reference/server-issued.mp4',
      token: 'template-upload-token',
      signedUploadUrl: 'https://storage.example.com/storage/v1/object/upload/sign/template_inputs/user-1/run-1/reference/server-issued.mp4?token=template-upload-token',
      expiresInSeconds: 900,
    }));
    const finalizeTemplateRunInput = vi.fn(async () => ({ success: true, run: {} }));
    const { uploadTemplateRunInput } = await import('../lib/media');

    await uploadTemplateRunInput('file:///reference.mp4', {
      api: { signTemplateRunInput, finalizeTemplateRunInput } as never,
      runId: 'run-1',
      slotKey: 'reference',
      kind: 'video',
      fileName: '../reference clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 3,
    });

    expect(signTemplateRunInput).toHaveBeenCalledWith('run-1', {
      slotKey: 'reference',
      fileName: 'reference-clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 3,
    });
    expect(uploadState.uploadUriToSignedUrl).toHaveBeenCalledWith(
      'file:///reference.mp4',
      expect.stringContaining('/storage/v1/object/upload/sign/template_inputs/'),
      expect.objectContaining({ mimeType: 'video/mp4', sizeBytes: 3 })
    );
    expect(finalizeTemplateRunInput).toHaveBeenCalledWith('run-1', {
      inputs: [{ slotKey: 'reference', storagePath: 'template_inputs/user-1/run-1/reference/server-issued.mp4' }],
    });
  });

  it('streams sanitized profile images to a profile-scoped signed target', async () => {
    const createProfileMediaUpload = vi.fn(async () => ({
      success: true,
      bucket: 'profiles' as const,
      path: 'user-1/avatar-server-issued-avatar-image-.png',
      token: 'profile-upload-token',
      signedUploadUrl: 'https://storage.example.com/storage/v1/object/upload/sign/profiles/user-1/avatar-server-issued-avatar-image-.png?token=profile-upload-token',
      publicUrl: 'https://storage.example.com/profiles/user-1/avatar.png',
      expiresInSeconds: 7200,
    }));
    const { uploadProfileImage } = await import('../lib/media');

    await expect(uploadProfileImage('file:///avatar.png', {
      api: { createProfileMediaUpload },
      role: 'avatar',
      fileName: '../avatar image?.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    })).resolves.toBe('https://storage.example.com/profiles/user-1/avatar.png');

    expect(createProfileMediaUpload).toHaveBeenCalledWith({
      role: 'avatar',
      fileName: 'avatar-image-.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    });
    expect(uploadState.uploadUriToSignedUrl).toHaveBeenCalledWith(
      'file:///avatar.png',
      expect.stringContaining('/storage/v1/object/upload/sign/profiles/'),
      expect.objectContaining({ mimeType: 'image/png', sizeBytes: 3 })
    );
  });
});
