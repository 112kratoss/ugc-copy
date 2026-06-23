import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  const getUser = vi.fn();
  const createSignedUrl = vi.fn();
  const rpc = vi.fn(async () => ({
    data: {
      allowed: true,
      limit: 300,
      remaining: 299,
      retryAfterSeconds: 0,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const download = vi.fn();
  const storageFrom = vi.fn(() => ({
    createSignedUrl,
    download,
  }));
  const createUserClient = vi.fn(() => ({
    auth: { getUser },
    storage: { from: storageFrom },
  }));
  const serviceClient = { rpc };
  const createServiceClient = vi.fn(() => serviceClient);

  return {
    createServiceClient,
    createSignedUrl,
    createUserClient,
    download,
    getUser,
    rpc,
    serviceClient,
    storageFrom,
  };
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => mocks.createServiceClient(),
  createUserClient: (request: Request) => mocks.createUserClient(request),
  isMediaBucket: (bucket: string) => (
    bucket === 'generated_images'
    || bucket === 'generated_videos'
    || bucket === 'generated_audio'
    || bucket === 'generation_inputs'
  ),
}));

function mediaRequest(query: string, headers: Record<string, string> = { Authorization: 'Bearer token' }) {
  return new NextRequest(`http://localhost/api/media?${query}`, { headers });
}

describe('/api/media route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createSignedUrl.mockReset();
    mocks.createServiceClient.mockClear();
    mocks.createUserClient.mockClear();
    mocks.download.mockReset();
    mocks.getUser.mockReset();
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: true,
        limit: 300,
        remaining: 299,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
    mocks.storageFrom.mockClear();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    mocks.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://project.supabase.co/storage/v1/object/sign/generated_images/user/file.jpg?token=abc' },
      error: null,
    });
    mocks.download.mockResolvedValue({
      data: new Blob(['image-bytes'], { type: 'image/jpeg' }),
      error: null,
    });
  });

  it('rejects invalid media paths before creating a Supabase client', async () => {
    const { GET } = await import('@/app/api/media/route');
    const response = await GET(mediaRequest('bucket=avatars&path=user%2Ffile.jpg'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid media path' });
    expect(mocks.createUserClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('requires an authenticated user before signing storage media', async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error('missing session'),
    });

    const { GET } = await import('@/app/api/media/route');
    const response = await GET(mediaRequest('bucket=generated_images&path=user%2Ffile.jpg'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('rate limits authenticated media signing before creating a storage signed URL', async () => {
    const { GET } = await import('@/app/api/media/route');
    const response = await GET(mediaRequest('bucket=generated_images&path=user%2Ffile.jpg'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://project.supabase.co/storage/v1/object/sign/generated_images/user/file.jpg?token=abc'
    );
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'media-read:sign',
      p_subject_key: 'user-1',
      p_limit: 300,
      p_window_seconds: 600,
    });
    expect(mocks.storageFrom).toHaveBeenCalledWith('generated_images');
    expect(mocks.createSignedUrl).toHaveBeenCalledWith('user/file.jpg', 600, undefined);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('returns 429 before storage signing when media reads exceed the backend rate limit', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        allowed: false,
        limit: 300,
        remaining: 0,
        retryAfterSeconds: 25,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { GET } = await import('@/app/api/media/route');
    const response = await GET(mediaRequest('bucket=generated_images&path=user%2Ffile.jpg'));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('25');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(mocks.storageFrom).not.toHaveBeenCalled();
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('passes a sanitized download filename to the signed URL options', async () => {
    const { GET } = await import('@/app/api/media/route');
    await GET(mediaRequest(
      'bucket=generated_videos&path=user%2Fclip.mp4&download=1&filename=my%2Fbad%22clip.mp4'
    ));

    expect(mocks.storageFrom).toHaveBeenCalledWith('generated_videos');
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(
      'user/clip.mp4',
      600,
      { download: 'my-bad-clip.mp4' }
    );
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
