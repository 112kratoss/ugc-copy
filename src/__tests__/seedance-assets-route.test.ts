import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveStoredMediaUrlMock = vi.fn(async (_supabase: unknown, value: string) => {
  if (value.startsWith('uploads/')) {
    return `https://signed.example.com/${value}`;
  }

  return value;
});

let rateLimitAllowed = true;
let serviceRpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

function createServiceClientMock() {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      serviceRpcCalls.push({ fn, args });
      if (fn === 'check_backend_rate_limit') {
        return {
          data: {
            allowed: rateLimitAllowed,
            limit: 60,
            remaining: rateLimitAllowed ? 59 : 0,
            retryAfterSeconds: rateLimitAllowed ? 0 : 42,
            resetAt: '2026-06-21T06:30:00.000Z',
          },
          error: null,
        };
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    }),
  };
}

vi.mock('@/lib/server-helpers', () => ({
  authenticateRequest: vi.fn(async () => ({
    userId: 'user-1',
    supabase: {},
  })),
  createServiceClient: vi.fn(() => createServiceClientMock()),
  requireKieApiKey: vi.fn(() => 'test-key'),
  resolveStoredMediaUrl: resolveStoredMediaUrlMock,
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/seedance-assets route', () => {
  beforeEach(() => {
    vi.resetModules();
    rateLimitAllowed = true;
    serviceRpcCalls = [];
    resolveStoredMediaUrlMock.mockClear();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates Seedance assets using the official playground endpoint', async () => {
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
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
          'x-request-id': 'seedance-assets-success-1',
        },
        body: JSON.stringify({
          url: 'uploads/user-1/reference.mp4',
          assetType: 'Video',
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'seedance-assets-success-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kie.ai/api/v1/playground/createAsset',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
        signal: timeoutSignal,
        body: JSON.stringify({
          assetType: 'Video',
          url: 'https://signed.example.com/uploads/user-1/reference.mp4',
        }),
      })
    );
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(await response.json()).toMatchObject({
      success: true,
      assetId: 'asset-123',
      status: 'processing',
      sourceUrl: 'https://signed.example.com/uploads/user-1/reference.mp4',
    });
  });

  it('normalizes getAsset responses into app-friendly statuses', async () => {
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
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
        signal: timeoutSignal,
      })
    );
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(await response.json()).toMatchObject({
      success: true,
      assetId: 'asset-456',
      assetType: 'Audio',
      status: 'active',
      sourceUrl: 'https://signed.example.com/uploads/user-1/ref.wav',
    });
  });

  it('rate limits Seedance asset creation before resolving media or calling the provider', async () => {
    rateLimitAllowed = false;
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
          'x-request-id': 'seedance-assets-rate-limit-1',
        },
        body: JSON.stringify({
          url: 'uploads/user-1/reference.mp4',
          assetType: 'Video',
        }),
      }) as never
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'seedance-assets-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(serviceRpcCalls).toHaveLength(1);
    expect(serviceRpcCalls[0]).toMatchObject({
      fn: 'check_backend_rate_limit',
      args: {
        p_scope: 'seedance-assets:create',
        p_subject_key: 'user-1',
      },
    });
    expect(resolveStoredMediaUrlMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
