import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  const getUser = vi.fn();
  const createSignedUrl = vi.fn();
  const download = vi.fn();
  const storageFrom = vi.fn(() => ({
    createSignedUrl,
    download,
  }));
  const createUserClient = vi.fn(() => ({
    auth: { getUser },
    storage: { from: storageFrom },
  }));

  return {
    createSignedUrl,
    createUserClient,
    download,
    getUser,
    storageFrom,
  };
});

vi.mock('@/lib/server-helpers', () => ({
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
    mocks.createUserClient.mockClear();
    mocks.download.mockReset();
    mocks.getUser.mockReset();
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
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('redirects authenticated media reads to a short-lived Supabase signed URL', async () => {
    const { GET } = await import('@/app/api/media/route');
    const response = await GET(mediaRequest('bucket=generated_images&path=user%2Ffile.jpg'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://project.supabase.co/storage/v1/object/sign/generated_images/user/file.jpg?token=abc'
    );
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(mocks.storageFrom).toHaveBeenCalledWith('generated_images');
    expect(mocks.createSignedUrl).toHaveBeenCalledWith('user/file.jpg', 600, undefined);
    expect(mocks.download).not.toHaveBeenCalled();
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
