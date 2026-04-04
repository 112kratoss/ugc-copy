import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveStoredMediaUrlMock = vi.fn(async (_supabase: unknown, value: string) => {
  if (value.startsWith('uploads/')) {
    return `https://signed.example.com/${value}`;
  }

  return value;
});

vi.mock('@/lib/server-helpers', () => ({
  authenticateRequest: vi.fn(async () => ({
    userId: 'user-1',
    supabase: {},
  })),
  createServiceClient: vi.fn(() => ({})),
  requireKieApiKey: vi.fn(() => 'test-key'),
  resolveStoredMediaUrl: resolveStoredMediaUrlMock,
}));

describe('/api/seedance-assets route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates Seedance assets using the official playground endpoint', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          assetId: 'asset-123',
          status: 'processing',
        },
      }),
    } as Response);

    const { POST } = await import('@/app/api/seedance-assets/route');
    const response = await POST(
      new Request('http://localhost/api/seedance-assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          url: 'uploads/user-1/reference.mp4',
          assetType: 'Video',
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kie.ai/api/v1/playground/createAsset',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
        body: JSON.stringify({
          assetType: 'Video',
          url: 'https://signed.example.com/uploads/user-1/reference.mp4',
        }),
      })
    );
    expect(await response.json()).toMatchObject({
      success: true,
      assetId: 'asset-123',
      status: 'processing',
      sourceUrl: 'https://signed.example.com/uploads/user-1/reference.mp4',
    });
  });

  it('normalizes getAsset responses into app-friendly statuses', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          assetId: 'asset-456',
          status: 'Success',
          assetType: 'Audio',
          url: 'https://signed.example.com/uploads/user-1/ref.wav',
        },
      }),
    } as Response);

    const { GET } = await import('@/app/api/seedance-assets/route');
    const response = await GET(
      new Request('http://localhost/api/seedance-assets?assetId=asset-456', {
        headers: {
          Authorization: 'Bearer token',
        },
      }) as never
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kie.ai/api/v1/playground/getAsset?assetId=asset-456',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      })
    );
    expect(await response.json()).toMatchObject({
      success: true,
      assetId: 'asset-456',
      assetType: 'Audio',
      status: 'active',
      sourceUrl: 'https://signed.example.com/uploads/user-1/ref.wav',
    });
  });
});
