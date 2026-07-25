import { describe, expect, it, vi } from 'vitest';

import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';

import { getFxRouteResponse } from '@/lib/fx-route-adapter-service';

describe('fx route adapter service', () => {
  it('wraps the FX loader in provider request context and returns public hourly cache headers', async () => {
    const request = new Request('http://localhost/api/fx', {
      headers: { 'x-request-id': 'fx-adapter-success-1' },
    });
    const loadFxRatesForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        base: 'INR' as const,
        updatedAt: 'Tue, 23 Jun 2026 00:00:00 +0000',
        rates: {
          USD: 0.012,
          EUR: 0.011,
          GBP: 0.009,
          AUD: 0.018,
          CAD: 0.016,
          SGD: 0.015,
        },
      },
    }));
    const withProviderFetchRequestId = mockRequestIdPassthrough();

    const response = await getFxRouteResponse({
      request,
      dependencies: {
        loadFxRatesForRoute,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400',
    );
    expect(response.headers.get('x-request-id')).toBe('fx-adapter-success-1');
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('fx-adapter-success-1', expect.any(Function));
    await expect(response.json()).resolves.toMatchObject({
      base: 'INR',
      rates: {
        USD: 0.012,
      },
    });
  });

  it('returns no-store headers for unavailable upstream results', async () => {
    const response = await getFxRouteResponse({
      request: new Request('http://localhost/api/fx', {
        headers: { 'x-vercel-id': 'bom1::fx-adapter-error-1' },
      }),
      dependencies: {
        loadFxRatesForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 503 as const,
          body: { error: 'fx_unavailable' as const },
        })),
        withProviderFetchRequestId: mockRequestIdPassthrough(),
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('bom1::fx-adapter-error-1');
    await expect(response.json()).resolves.toEqual({ error: 'fx_unavailable' });
  });
});
