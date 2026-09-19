import 'server-only';

import { logBackendRouteError } from '@/lib/backend-logger';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  MOBILE_PLAYBACK_METRICS_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import { getClientNetworkKey } from '@/lib/client-network-key';
import { createServiceClient } from '@/lib/server-helpers';

export const MAX_PLAYBACK_METRICS_BYTES = 8 * 1024;
export const MAX_PLAYBACK_METRICS_BUCKETS = 4;
export const MAX_PLAYBACK_METRICS_SAMPLES = 32;
/** A start or a stall longer than this is not a measurement the app would send. */
const MAX_DURATION_MS = 120_000;
/** Totals are bounded by what one session can hold: a day of the app. */
const MAX_TOTAL_MS = 24 * 3_600_000;
const MAX_COUNT = 100_000;

const SURFACES = new Set(['feed', 'viewer']);
const START_KINDS = new Set(['cold', 'warm']);
const PLATFORMS = new Set(['ios', 'android']);
const NETWORKS = new Set(['wifi', 'cellular', 'none', 'other', 'unknown']);
const SESSION_PATTERN = /^[A-Za-z0-9-]{8,40}$/;
const APP_FIELD_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const OS_PATTERN = /^[A-Za-z0-9._ -]{1,16}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._ +()-]{1,40}$/;

type MobilePlaybackMetricsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getRateLimitKey?: (headers: Headers) => string;
  logError?: typeof logBackendRouteError;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
};

function resolveDependencies(dependencies: MobilePlaybackMetricsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getRateLimitKey: dependencies?.getRateLimitKey ?? getClientNetworkKey,
    logError: dependencies?.logError ?? logBackendRouteError,
    readBoundedJsonBody: dependencies?.readBoundedJsonBody ?? readBoundedJsonBody,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalField(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function boundedInteger(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
}

export type PlaybackMetricsRow = {
  session_id: string;
  platform: string;
  os_version: string;
  device_model: string | null;
  network: string;
  app_version: string | null;
  app_build: string | null;
  app_update: string | null;
  span_ms: number;
  surface: string;
  start_kind: string;
  starts: number;
  start_total_ms: number;
  start_max_ms: number;
  start_samples: number[];
  stalls: number;
  stall_total_ms: number;
  stall_max_ms: number;
};

/**
 * Accepts only the shape `lib/playback-metrics` produces: enumerated surfaces,
 * kinds, platforms and networks, bounded integers, at most four buckets of at
 * most 32 samples. There is nowhere in it for an address, a token, a user or a
 * medium to ride along, so a report cannot carry one even from a modified
 * client. Returns the rows to store, or null for anything else.
 */
export function parsePlaybackMetricsReport(value: unknown): PlaybackMetricsRow[] | null {
  if (!isRecord(value)) return null;
  const { sessionId, app, device, spanMs, buckets } = value;
  if (typeof sessionId !== 'string' || !SESSION_PATTERN.test(sessionId)) return null;
  if (!isRecord(device)) return null;
  if (typeof device.platform !== 'string' || !PLATFORMS.has(device.platform)) return null;
  if (typeof device.os !== 'string' || !OS_PATTERN.test(device.os)) return null;
  if (typeof device.network !== 'string' || !NETWORKS.has(device.network)) return null;
  const model = optionalField(device.model, MODEL_PATTERN);
  if (model === undefined) return null;
  const span = boundedInteger(spanMs, MAX_TOTAL_MS);
  if (span === undefined) return null;

  const appRecord = isRecord(app) ? app : {};
  const version = optionalField(appRecord.version, APP_FIELD_PATTERN);
  const build = optionalField(appRecord.build, APP_FIELD_PATTERN);
  const update = optionalField(appRecord.update, APP_FIELD_PATTERN);
  if (version === undefined || build === undefined || update === undefined) return null;

  if (!Array.isArray(buckets) || buckets.length === 0 || buckets.length > MAX_PLAYBACK_METRICS_BUCKETS) return null;
  const seen = new Set<string>();
  const rows: PlaybackMetricsRow[] = [];
  for (const bucket of buckets) {
    if (!isRecord(bucket)) return null;
    const { surface, kind, starts, startTotalMs, startMaxMs, samples, stalls, stallTotalMs, stallMaxMs } = bucket;
    if (typeof surface !== 'string' || !SURFACES.has(surface)) return null;
    if (typeof kind !== 'string' || !START_KINDS.has(kind)) return null;
    const id = `${surface}:${kind}`;
    if (seen.has(id)) return null;
    seen.add(id);
    const startCount = boundedInteger(starts, MAX_COUNT);
    const startTotal = boundedInteger(startTotalMs, MAX_TOTAL_MS);
    const startMax = boundedInteger(startMaxMs, MAX_DURATION_MS);
    const stallCount = boundedInteger(stalls, MAX_COUNT);
    const stallTotal = boundedInteger(stallTotalMs, MAX_TOTAL_MS);
    const stallMax = boundedInteger(stallMaxMs, MAX_DURATION_MS);
    if ([startCount, startTotal, startMax, stallCount, stallTotal, stallMax].some((field) => field === undefined)) return null;
    if (!Array.isArray(samples) || samples.length > MAX_PLAYBACK_METRICS_SAMPLES || samples.length > (startCount as number)) return null;
    const parsedSamples: number[] = [];
    for (const sample of samples) {
      const parsed = boundedInteger(sample, MAX_DURATION_MS);
      if (parsed === undefined) return null;
      parsedSamples.push(parsed);
    }
    if ((startCount as number) === 0 && (stallCount as number) === 0) return null;
    rows.push({
      session_id: sessionId,
      platform: device.platform,
      os_version: device.os,
      device_model: model,
      network: device.network,
      app_version: version,
      app_build: build,
      app_update: update,
      span_ms: span,
      surface,
      start_kind: kind,
      starts: startCount as number,
      start_total_ms: startTotal as number,
      start_max_ms: startMax as number,
      start_samples: parsedSamples,
      stalls: stallCount as number,
      stall_total_ms: stallTotal as number,
      stall_max_ms: stallMax as number,
    });
  }
  return rows;
}

async function handlePlaybackMetricsPost(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createServiceClient();
  try {
    await dependencies.enforceBackendRateLimit(supabase, {
      ...MOBILE_PLAYBACK_METRICS_RATE_LIMIT,
      key: dependencies.getRateLimitKey(request.headers),
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }
    dependencies.logError('Playback metrics rate limit failed:', error);
    return Response.json({ error: 'Failed to check playback metrics limits.' }, { status: 500 });
  }

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return Response.json({ error: 'Unsupported playback metrics content type.' }, { status: 415 });
  }

  let body;
  try {
    body = await dependencies.readBoundedJsonBody(request, MAX_PLAYBACK_METRICS_BYTES);
  } catch (error) {
    dependencies.logError('Playback metrics body read failed:', error);
    return Response.json({ error: 'Failed to read playback metrics.' }, { status: 500 });
  }
  if (!body.ok) {
    return Response.json(
      { error: body.reason === 'too_large' ? 'Playback metrics are too large.' : 'Invalid playback metrics.' },
      { status: body.reason === 'too_large' ? 413 : 400 },
    );
  }

  const rows = parsePlaybackMetricsReport(body.value);
  if (!rows) {
    return Response.json({ error: 'Invalid playback metrics.' }, { status: 400 });
  }

  const { error } = await supabase.from('playback_metrics').insert(rows);
  if (error) {
    dependencies.logError('Playback metrics insert failed:', error);
    return Response.json({ error: 'Failed to store playback metrics.' }, { status: 500 });
  }

  return new Response(null, { status: 204 });
}

/**
 * A session's aggregated video start-up and stall numbers from the mobile
 * app (`lib/playback-metrics`), stored one row per surface and start kind in
 * `playback_metrics` for the `playback_metrics_daily` view. Anonymous and
 * unauthenticated, like the media diagnostics: the report carries no
 * identity, and the session that sends it may be the one that is failing.
 */
export async function postMobilePlaybackMetricsRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobilePlaybackMetricsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePlaybackMetricsPost(request, resolveDependencies(dependencies)),
    request,
  );
}
