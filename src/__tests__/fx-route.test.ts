import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('/api/fx route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('subsets supported rates and returns cache headers', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: 'success',
        base_code: 'INR',
        time_last_update_utc: 'Sat, 04 Apr 2026 00:02:31 +0000',
        rates: {
          USD: 0.0119,
          EUR: 0.011,
          GBP: 0.0094,
          AUD: 0.0184,
          CAD: 0.0161,
          SGD: 0.016,
          JPY: 1.7,
        },
      }),
    } as Response);

    const { GET } = await import('@/app/api/fx/route');
    const response = await GET(new Request('http://localhost/api/fx') as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400'
    );

    const data = await response.json();
    expect(data).toEqual({
      base: 'INR',
      updatedAt: 'Sat, 04 Apr 2026 00:02:31 +0000',
      rates: {
        USD: 0.0119,
        EUR: 0.011,
        GBP: 0.0094,
        AUD: 0.0184,
        CAD: 0.0161,
        SGD: 0.016,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.er-api.com/v6/latest/INR',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
  });

  it('returns 503 when upstream fails', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);

    const { GET } = await import('@/app/api/fx/route');
    const response = await GET(new Request('http://localhost/api/fx') as never);

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'fx_unavailable' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.er-api.com/v6/latest/INR',
      expect.any(Object)
    );
  });
});

