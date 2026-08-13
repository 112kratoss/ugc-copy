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

describe('post video duration limit', () => {
  it('converts picker milliseconds to seconds', async () => {
    const { assetDurationSeconds } = await import('../lib/media');

    expect(assetDurationSeconds(8000)).toBe(8);
    expect(assetDurationSeconds(0)).toBe(0);
    expect(assetDurationSeconds(null)).toBeNull();
    expect(assetDurationSeconds(undefined)).toBeNull();
    expect(assetDurationSeconds(Number.NaN)).toBeNull();
  });

  it('flags only videos confidently over the limit', async () => {
    const { isPostVideoOverDurationLimit, POST_VIDEO_MAX_DURATION_SECONDS } = await import('../lib/media');
    const overLimitMs = (POST_VIDEO_MAX_DURATION_SECONDS + 1) * 1000;

    expect(isPostVideoOverDurationLimit({ type: 'video', duration: overLimitMs })).toBe(true);
    expect(isPostVideoOverDurationLimit({ mimeType: 'video/mp4', duration: overLimitMs })).toBe(true);
    // At the limit exactly is allowed.
    expect(isPostVideoOverDurationLimit({ type: 'video', duration: POST_VIDEO_MAX_DURATION_SECONDS * 1000 })).toBe(false);
    // Images are never gated, even with a bogus duration.
    expect(isPostVideoOverDurationLimit({ type: 'image', duration: overLimitMs })).toBe(false);
    // Unknown duration defers to the server-side probe.
    expect(isPostVideoOverDurationLimit({ type: 'video', duration: null })).toBe(false);
    expect(isPostVideoOverDurationLimit({ type: 'video' })).toBe(false);
  });

  it('names the limit in minutes in the user-facing message', async () => {
    const { POST_VIDEO_DURATION_LIMIT_MESSAGE } = await import('../lib/media');

    expect(POST_VIDEO_DURATION_LIMIT_MESSAGE).toBe('Videos must be 10 minutes or shorter.');
  });
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

  it('uses a media-only picker for reference cards and the full safe allowlist elsewhere', async () => {
    const DocumentPicker = await import('expo-document-picker');
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: true, assets: null });
    const { pickResourceDocument } = await import('../lib/media');

    await pickResourceDocument('reference_media');
    const referenceTypes = vi.mocked(DocumentPicker.getDocumentAsync).mock.calls.at(-1)?.[0]?.type;
    expect(referenceTypes).toContain('image/png');
    expect(referenceTypes).toContain('video/mp4');
    expect(referenceTypes).toContain('audio/mpeg');
    expect(referenceTypes).not.toContain('application/pdf');

    await pickResourceDocument('resource');
    const resourceTypes = vi.mocked(DocumentPicker.getDocumentAsync).mock.calls.at(-1)?.[0]?.type;
    expect(resourceTypes).toContain('application/pdf');
    expect(resourceTypes).toContain('application/x-yaml');
    expect(resourceTypes).toContain('application/x-gzip');
    expect(resourceTypes).toContain('application/octet-stream');
    expect(resourceTypes).not.toContain('*/*');
  });

  it('rejects a non-media file before signing a reference-media upload', async () => {
    uploadState.inspectUriUpload.mockResolvedValueOnce({ mimeType: 'application/pdf', sizeBytes: 3 });
    const signPostResourceFileUpload = vi.fn();
    const finalizePostResourceFileUpload = vi.fn();
    const { uploadResourceDocument } = await import('../lib/media');

    await expect(uploadResourceDocument('file:///reference.pdf', {
      api: { signPostResourceFileUpload, finalizePostResourceFileUpload },
      fileName: 'reference.pdf',
      mimeType: 'application/pdf',
      mediaOnly: true,
      sizeBytes: 3,
    })).rejects.toThrow('Choose an image, video, or audio file for reference media.');

    expect(signPostResourceFileUpload).not.toHaveBeenCalled();
    expect(uploadState.uploadUriToSignedUrl).not.toHaveBeenCalled();
  });

  it('rejects reference-media extension and MIME-family mismatches before signing', async () => {
    const signPostResourceFileUpload = vi.fn();
    const finalizePostResourceFileUpload = vi.fn();
    const { uploadResourceDocument } = await import('../lib/media');

    await expect(uploadResourceDocument('file:///reference.pdf', {
      api: { signPostResourceFileUpload, finalizePostResourceFileUpload },
      fileName: 'reference.pdf',
      mimeType: 'image/png',
      mediaOnly: true,
      sizeBytes: 3,
    })).rejects.toThrow('Choose an image, video, or audio file for reference media.');

    uploadState.inspectUriUpload.mockResolvedValueOnce({ mimeType: 'video/mp4', sizeBytes: 3 });
    await expect(uploadResourceDocument('file:///reference.png', {
      api: { signPostResourceFileUpload, finalizePostResourceFileUpload },
      fileName: 'reference.png',
      mimeType: 'video/mp4',
      mediaOnly: true,
      sizeBytes: 3,
    })).rejects.toThrow('Choose an image, video, or audio file for reference media.');

    expect(signPostResourceFileUpload).not.toHaveBeenCalled();
    expect(uploadState.uploadUriToSignedUrl).not.toHaveBeenCalled();
  });

  it('accepts an octet-stream media pick by safe extension and forwards cancellation to sign and finalize', async () => {
    uploadState.inspectUriUpload.mockResolvedValueOnce({ mimeType: 'application/octet-stream', sizeBytes: 3 });
    const signPostResourceFileUpload = vi.fn(async () => ({
      success: true,
      bucket: 'post_resource_files' as const,
      path: 'user-1/server-issued-reference.png',
      token: 'upload-token',
      signedUploadUrl: 'https://storage.example.com/storage/v1/object/upload/sign/post_resource_files/user-1/server-issued-reference.png?token=upload-token',
      expiresInSeconds: 7200,
      expected: {
        fileName: 'reference.png',
        contentType: 'image/png',
        sizeBytes: 3,
      },
    }));
    const finalizePostResourceFileUpload = vi.fn(async () => ({
      success: true,
      attachment: {
        kind: 'file' as const,
        label: 'reference.png',
        storagePath: 'user-1/server-issued-reference.png',
        contentType: 'image/png',
        sizeBytes: 3,
      },
    }));
    const controller = new AbortController();
    const { uploadResourceDocument } = await import('../lib/media');

    await expect(uploadResourceDocument('file:///reference.png', {
      api: { signPostResourceFileUpload, finalizePostResourceFileUpload },
      fileName: 'reference.png',
      mimeType: 'application/octet-stream',
      mediaOnly: true,
      sizeBytes: 3,
      signal: controller.signal,
    })).resolves.toMatchObject({ storagePath: 'user-1/server-issued-reference.png' });

    expect(signPostResourceFileUpload).toHaveBeenCalledWith({
      fileName: 'reference.png',
      contentType: 'application/octet-stream',
      sizeBytes: 3,
    }, controller.signal);
    expect(finalizePostResourceFileUpload).toHaveBeenCalledWith({
      path: 'user-1/server-issued-reference.png',
      fileName: 'reference.png',
      contentType: 'image/png',
      sizeBytes: 3,
    }, controller.signal);
  });

  it('does not sign a resource upload that was already cancelled', async () => {
    const signPostResourceFileUpload = vi.fn();
    const finalizePostResourceFileUpload = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const { uploadResourceDocument } = await import('../lib/media');

    await expect(uploadResourceDocument('file:///reference.png', {
      api: { signPostResourceFileUpload, finalizePostResourceFileUpload },
      fileName: 'reference.png',
      mimeType: 'image/png',
      mediaOnly: true,
      sizeBytes: 3,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'UploadCancelledError' });

    expect(signPostResourceFileUpload).not.toHaveBeenCalled();
  });

  it('normalizes an API abort during resource signing to upload cancellation', async () => {
    const controller = new AbortController();
    const signPostResourceFileUpload = vi.fn(() => {
      controller.abort();
      return Promise.reject(new Error('fetch aborted'));
    });
    const finalizePostResourceFileUpload = vi.fn();
    const { uploadResourceDocument } = await import('../lib/media');

    await expect(uploadResourceDocument('file:///reference.png', {
      api: { signPostResourceFileUpload, finalizePostResourceFileUpload },
      fileName: 'reference.png',
      mimeType: 'image/png',
      mediaOnly: true,
      sizeBytes: 3,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'UploadCancelledError' });

    expect(uploadState.uploadUriToSignedUrl).not.toHaveBeenCalled();
    expect(finalizePostResourceFileUpload).not.toHaveBeenCalled();
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
