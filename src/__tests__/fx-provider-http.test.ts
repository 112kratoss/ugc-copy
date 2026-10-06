// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFxRatesForRoute } from '@/lib/fx-rates-service';
import { getFxRouteResponse } from '@/lib/fx-route-adapter-service';

const validRates = { USD: 0.0119, EUR: 0.011, GBP: 0.0094, AUD: 0.0184, CAD: 0.0161, SGD: 0.016 };
const currencies = Object.keys(validRates) as Array<keyof typeof validRates>;
describe('FX route through actual loopback provider HTTP', () => {
  let server: Server, origin: string;
  let payload: unknown;
  let mode: 'json' | 'malformed' | '503' | 'disconnect' = 'json';
  beforeAll(async () => {
    server = createServer((_request, response) => {
      if (mode === 'disconnect') { response.destroy(); return; }
      response.statusCode = mode === '503' ? 503 : 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(mode === 'malformed' ? '{invalid json' : JSON.stringify(payload));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Loopback server unavailable');
    origin = 'http://127.0.0.1:' + address.port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const response = () => getFxRouteResponse({
    request: new Request('http://audit.local/api/fx', { headers: { 'x-request-id': 'audit-fx-loopback' } }),
    dependencies: { loadFxRatesForRoute: () => loadFxRatesForRoute({ fetchImpl: async (input, init) => {
      expect(String(input)).toBe('https://open.er-api.com/v6/latest/INR');
      return fetch(origin + '/v6/latest/INR', init);
    } }) },
  });
  it('returns all supported positive rates and excludes unsupported values with public success caching', async () => {
    mode = 'json'; payload = { result: 'success', base_code: 'INR', time_last_update_utc: 'Audit fixture time', rates: { ...validRates, JPY: 1.7, OTHER: 'invalid' } };
    const result = await response();
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toContain('s-maxage=3600');
    expect(result.headers.get('x-request-id')).toBe('audit-fx-loopback');
    expect(await result.json()).toEqual({ base: 'INR', updatedAt: 'Audit fixture time', rates: validRates });
  });
  it.each(currencies.flatMap(currency => ['zero', 'negative', 'null', 'missing'].map(kind => ({ currency, kind }))))('does not publish an unsafe $currency rate: $kind', async ({ currency, kind }) => {
    mode = 'json';
    const rates: Record<string, unknown> = { ...validRates };
    if (kind === 'missing') delete rates[currency]; else rates[currency] = kind === 'zero' ? 0 : kind === 'negative' ? -0.001 : null;
    payload = { result: 'success', base_code: 'INR', rates };
    const result = await response();
    expect(result.status).toBe(503);
    expect(result.headers.get('Cache-Control')).toContain('no-store');
    expect(await result.json()).toEqual({ error: 'fx_unavailable' });
  });
  it.each(['malformed', '503', 'disconnect'] as const)('returns an uncached unavailable response for provider %s', async failure => {
    mode = failure; payload = null;
    const result = await response();
    expect(result.status).toBe(503); expect(result.headers.get('Cache-Control')).toContain('no-store');
    expect(await result.json()).toEqual({ error: 'fx_unavailable' });
  });
});
