import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  const authGetUser = vi.fn();
  const rpc = vi.fn();
  const single = vi.fn();
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const serviceFrom = vi.fn(() => ({ select }));
  const createSignedUrl = vi.fn();
  const getPublicUrl = vi.fn();
  const storageFrom = vi.fn(() => ({ createSignedUrl, getPublicUrl }));
  const createServiceClient = vi.fn(() => ({
    rpc,
    from: serviceFrom,
    storage: { from: storageFrom },
  }));

  return {
    authGetUser,
    createServiceClient,
    createSignedUrl,
    eq,
    getPublicUrl,
    rpc,
    select,
    serviceFrom,
    single,
    storageFrom,
  };
});

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: mocks.authGetUser,
    },
  }),
  createServiceClient: () => mocks.createServiceClient(),
  getStoredMediaLocation: (outputUrl: string) => {
    if (!outputUrl.startsWith('generated_images/')) return null;
    return {
      bucket: 'generated_images',
      filePath: outputUrl.replace('generated_images/', ''),
    };
  },
}));

function buildRequest(id = 'generation-1') {
  return new NextRequest(`http://localhost/api/showcase/preview?id=${id}`, {
    headers: { Authorization: 'Bearer token' },
  });
}

describe('/api/showcase/preview route', () => {
  beforeEach(() => {
    mocks.authGetUser.mockReset();
    mocks.createServiceClient.mockClear();
    mocks.createSignedUrl.mockReset();
    mocks.eq.mockClear();
    mocks.getPublicUrl.mockReset();
    mocks.rpc.mockReset();
    mocks.select.mockClear();
    mocks.serviceFrom.mockClear();
    mocks.single.mockReset();
    mocks.storageFrom.mockClear();

    mocks.authGetUser.mockResolvedValue({
      data: { user: { id: 'viewer-1' } },
      error: null,
    });
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: true,
        limit: 240,
        remaining: 239,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
    mocks.single.mockResolvedValue({
      data: {
        output_url: 'generated_images/user-1/preview.png',
        showcase_asset_path: null,
        is_public: true,
      },
      error: null,
    });
    mocks.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://signed.example.com/preview.png' },
      error: null,
    });
  });

  it('rejects unauthenticated preview requests before creating a service client', async () => {
    mocks.authGetUser.mockResolvedValue({
      data: { user: null },
      error: new Error('missing session'),
    });

    const { GET } = await import('@/app/api/showcase/preview/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('rate limits authenticated preview signing before loading or signing media', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: false,
        limit: 240,
        remaining: 0,
        retryAfterSeconds: 12,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { GET } = await import('@/app/api/showcase/preview/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(body).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 12,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'showcase-preview:read-url',
      p_subject_key: 'viewer-1',
      p_limit: 240,
      p_window_seconds: 600,
    });
    expect(mocks.serviceFrom).not.toHaveBeenCalled();
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('signs public stored generation media after the preview rate limit passes', async () => {
    const { GET } = await import('@/app/api/showcase/preview/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ url: 'https://signed.example.com/preview.png' });
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'showcase-preview:read-url',
      p_subject_key: 'viewer-1',
      p_limit: 240,
      p_window_seconds: 600,
    });
    expect(mocks.serviceFrom).toHaveBeenCalledWith('generations');
    expect(mocks.select).toHaveBeenCalledWith('output_url, showcase_asset_path, is_public');
    expect(mocks.eq).toHaveBeenCalledWith('id', 'generation-1');
    expect(mocks.storageFrom).toHaveBeenCalledWith('generated_images');
    expect(mocks.createSignedUrl).toHaveBeenCalledWith('user-1/preview.png', 3600);
  });
});
