import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  from: vi.fn(),
  upload: vi.fn(),
  uploadToSignedUrl: vi.fn(),
  createSignedUrl: vi.fn(),
}));

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

describe('uploadWorkflowAssetWithSignedIntent', () => {
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
      if (url === '/api/uploads/workflow-asset/sign') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            bucket: 'generated_images',
            path: 'user-1/workflow-input-reference.png',
            storagePath: 'generated_images/user-1/workflow-input-reference.png',
            token: 'workflow-token',
            signedUploadUrl: 'https://storage.example.test/upload',
            expiresInSeconds: 7200,
          }),
        };
      }

      if (url === '/api/uploads/workflow-asset/read-url') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            signedUrl: 'https://storage.example.test/signed/workflow-input.png',
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

  it('uploads workflow assets through a backend-issued signed upload intent', async () => {
    const { uploadWorkflowAssetWithSignedIntent } = await import('@/lib/workflow-asset-upload');
    const file = new File(['image-bytes'], 'Reference Image.PNG', { type: 'image/png' });

    await expect(uploadWorkflowAssetWithSignedIntent(file, 'generated_images')).resolves.toEqual({
      signedUrl: 'https://storage.example.test/signed/workflow-input.png',
      storagePath: 'generated_images/user-1/workflow-input-reference.png',
    });

    expect(fetch).toHaveBeenCalledWith('/api/uploads/workflow-asset/sign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer access-token',
      },
      body: JSON.stringify({
        bucket: 'generated_images',
        fileName: 'Reference Image.PNG',
        mimeType: 'image/png',
        sizeBytes: file.size,
      }),
    });
    expect(supabaseMocks.from).toHaveBeenCalledWith('generated_images');
    expect(supabaseMocks.uploadToSignedUrl).toHaveBeenCalledWith(
      'user-1/workflow-input-reference.png',
      'workflow-token',
      file,
      { contentType: 'image/png' }
    );
    expect(fetch).toHaveBeenCalledWith('/api/uploads/workflow-asset/read-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer access-token',
      },
      body: JSON.stringify({
        storagePath: 'generated_images/user-1/workflow-input-reference.png',
      }),
    });
    expect(supabaseMocks.createSignedUrl).not.toHaveBeenCalled();
    expect(supabaseMocks.upload).not.toHaveBeenCalled();
  });
});
