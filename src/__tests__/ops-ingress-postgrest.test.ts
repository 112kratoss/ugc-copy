// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAppVersionRouteResponse } from '@/lib/app-version-route-adapter-service';
import { postCspReportRouteResponse } from '@/lib/csp-report-route-adapter-service';
import { postMobileMediaDiagnosticsRouteResponse } from '@/lib/mobile-media-diagnostics-route-adapter-service';
import { postMobilePlaybackMetricsRouteResponse } from '@/lib/mobile-playback-metrics-route-adapter-service';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;
const ingress = [
  { path: '/api/security/csp-report', scope: 'security:csp-report', limit: 120 },
  { path: '/api/mobile/media-diagnostics', scope: 'mobile:media-diagnostics', limit: 30 },
  { path: '/api/mobile/playback-metrics', scope: 'mobile:playback-metrics', limit: 30 },
] as const;

describe.skipIf(!configPath || !connectionString)('operations ingress through actual HTTP and PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let server: Server;
  let origin: string;
  let key: string;
  let session: string;
  let fail: 'rate' | 'insert' | null;
  let warnings: Array<{ message: string; fields: unknown }>;
  let thrown: string[];

  const diagnostic = (at = Date.now()) => ({
    sessionId: session,
    app: { version: '0.0.5', build: '1' },
    events: [{ at, kind: 'video', event: 'stall', surface: 'viewer', subject: 'a1b2c3d4', attempt: 0, status: 503 }],
  });
  const playback = () => ({
    sessionId: session,
    device: { platform: 'ios', os: '18', network: 'other' },
    spanMs: 1000,
    buckets: [{ surface: 'viewer', kind: 'cold', starts: 2, startTotalMs: 100, startMaxMs: 60, samples: [40, 60], stalls: 1, stallTotalMs: 80, stallMaxMs: 80 }],
  });
  const valid = (path: string) => path.includes('csp')
    ? { 'csp-report': { 'document-uri': 'https://audit.local/create?token=fixture-secret', 'blocked-uri': 'inline', 'effective-directive': 'script-src' } }
    : path.includes('diagnostics') ? diagnostic() : playback();
  const send = async (path: string, body: unknown, contentType = 'application/json') => {
    const result = await fetch(origin + path, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'x-vercel-forwarded-for': key, 'x-forwarded-for': 'spoof-' + key, 'x-request-id': key },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    expect(result.headers.get('x-request-id')).toBe(key);
    return result;
  };

  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['127.0.0.1', 'localhost']).toContain(new URL(config.API_URL).hostname);
    expect(['127.0.0.1', 'localhost']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
    const options = { auth: { persistSession: false, autoRefreshToken: false } };
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      ...options,
      global: { fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if ((fail === 'rate' && path === '/rest/v1/rpc/check_backend_rate_limit')
          || (fail === 'insert' && path === '/rest/v1/playback_metrics')) {
          return Response.json({ code: 'XX000', message: 'Isolated audit outage' }, { status: 503 });
        }
        return fetch(input, init);
      } },
    });
    anon = createClient(config.API_URL, config.ANON_KEY, options);
    server = createServer(async (incoming, outgoing) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
        }
        const request = new Request(origin + incoming.url, {
          method: incoming.method,
          headers,
          ...(incoming.method === 'POST' ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
        } as RequestInit);
        const dependencies = {
          createServiceClient: () => admin,
          logError: () => {},
          logWarning: (message: string, fields: unknown) => { warnings.push({ message, fields }); },
        };
        const response = incoming.url === '/api/security/csp-report'
          ? await postCspReportRouteResponse({ request, dependencies })
          : incoming.url === '/api/mobile/media-diagnostics'
            ? await postMobileMediaDiagnosticsRouteResponse({ request, dependencies })
            : incoming.url === '/api/mobile/playback-metrics'
              ? await postMobilePlaybackMetricsRouteResponse({ request, dependencies })
              : await getAppVersionRouteResponse({ request, environment: { RELEASE_GIT_SHA: 'fixture-release', VERCEL_GIT_COMMIT_SHA: 'fixture-fallback' } });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        thrown.push(error instanceof Error ? error.name : 'unknown');
        outgoing.writeHead(500, { 'Cache-Control': 'private, no-store', 'x-request-id': key });
        outgoing.end('Isolated bridge caught an unhandled route exception');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Loopback server unavailable');
    origin = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(() => {
    key = 'audit-ops-' + randomUUID();
    session = randomUUID();
    fail = null;
    warnings = [];
    thrown = [];
  });
  afterEach(async () => {
    await db.query('delete from public.playback_metrics where session_id=$1', [session]);
    await db.query('delete from public.backend_rate_limits where subject_key=any($1::text[])', [[key, 'spoof-' + key]]);
    expect((await db.query('select id from public.playback_metrics where session_id=$1', [session])).rows).toEqual([]);
    expect((await db.query('select scope from public.backend_rate_limits where subject_key=any($1::text[])', [[key, 'spoof-' + key]])).rows).toEqual([]);
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.end();
  });

  it.each(ingress)('accepts a valid anonymous $path through the real limiter', async ({ path, scope }) => {
    expect((await send(path, valid(path))).status).toBe(204);
    expect(thrown).toEqual([]);
    expect((await db.query('select scope,subject_key,request_count from public.backend_rate_limits where subject_key=any($1::text[])', [[key, 'spoof-' + key]])).rows).toEqual([{ scope, subject_key: key, request_count: 1 }]);
    if (path.includes('playback')) {
      expect((await db.query('select starts,start_samples,stalls from public.playback_metrics where session_id=$1', [session])).rows).toEqual([{ starts: 2, start_samples: [40, 60], stalls: 1 }]);
    } else {
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain('fixture-secret');
    }
  });
  it('accepts Reporting API CSP arrays and strips URL query/fragment from logged labels', async () => {
    const result = await send(ingress[0].path, [{ type: 'csp-violation', body: { documentURL: 'https://audit.local/create?token=fixture-secret#fixture-secret', blockedURL: 'https://assets.local/a.js?token=fixture-secret' } }], 'application/reports+json');
    expect(result.status).toBe(204);
    expect(JSON.stringify(warnings)).not.toContain('fixture-secret');
  });
  it.each(ingress)('rejects unsupported content type for $path', async ({ path }) => {
    expect((await send(path, valid(path), 'text/plain')).status).toBe(415);
    expect(warnings).toEqual([]);
  });
  it.each(ingress)('rejects malformed JSON for $path', async ({ path }) => {
    expect((await send(path, '{invalid')).status).toBe(400);
    expect(warnings).toEqual([]);
  });
  it.each(ingress)('counts actual streamed bytes without Content-Length for $path', async ({ path }) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ extra: 'x'.repeat(20 * 1024) })));
      controller.close();
    } });
    const result = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': key }, body, duplex: 'half' } as RequestInit);
    expect(result.status).toBe(413);
    expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    expect(warnings).toEqual([]);
  });
  it.each(ingress)('enforces the actual SQL bucket and Retry-After for $path', async ({ path, scope, limit }) => {
    const admission = await admin.rpc('check_backend_rate_limit', { p_scope: scope, p_subject_key: key, p_limit: limit, p_window_seconds: 600 });
    expect(admission.error).toBeNull();
    await db.query('update public.backend_rate_limits set request_count=$1 where scope=$2 and subject_key=$3', [limit, scope, key]);
    const result = await send(path, valid(path));
    expect(result.status).toBe(429);
    expect(Number(result.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await result.json()).code).toBe('RATE_LIMITED');
    expect(warnings).toEqual([]);
    expect((await db.query('select id from public.playback_metrics where session_id=$1', [session])).rows).toEqual([]);
  });
  it.each(ingress)('fails closed on a real limiter transport outage for $path', async ({ path }) => {
    fail = 'rate';
    expect((await send(path, valid(path))).status).toBe(500);
    expect(thrown).toEqual([]);
    expect(warnings).toEqual([]);
  });
  it('does not acknowledge failed playback inserts and succeeds on retry', async () => {
    fail = 'insert';
    expect((await send(ingress[2].path, playback())).status).toBe(500);
    expect((await db.query('select id from public.playback_metrics where session_id=$1', [session])).rows).toEqual([]);
    fail = null;
    expect((await send(ingress[2].path, playback())).status).toBe(204);
    expect((await db.query('select id from public.playback_metrics where session_id=$1', [session])).rows).toHaveLength(1);
  });
  it('denies anonymous direct playback writes and limiter RPC calls', async () => {
    expect((await anon.from('playback_metrics').insert({ session_id: session })).error).not.toBeNull();
    expect((await anon.rpc('check_backend_rate_limit', { p_scope: ingress[0].scope, p_subject_key: key, p_limit: 120, p_window_seconds: 600 })).error).not.toBeNull();
  });
  it.each([8_640_000_000_000_001, Number.MAX_VALUE])('rejects a finite timestamp outside the Date range: %s', async at => {
    const result = await send(ingress[1].path, diagnostic(at));
    expect({ status: result.status, thrown }).toEqual({ status: 400, thrown: [] });
    expect(warnings).toEqual([]);
  });
  it('preserves the accepted Date boundary in diagnostics', async () => {
    expect((await send(ingress[1].path, diagnostic(8_640_000_000_000_000))).status).toBe(204);
    expect(JSON.stringify(warnings)).toContain('+275760-09-13T00:00:00.000Z');
  });
  it('serves the release build and compatibility policy without caching', async () => {
    const result = await fetch(origin + '/api/app-version', { headers: { 'x-request-id': key } });
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toContain('no-store');
    expect(await result.json()).toMatchObject({ buildId: 'fixture-release', mobileCompatibility: { minimumApiVersion: 1, minimumAppVersion: '0.0.5' } });
  });
});
