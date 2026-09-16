import 'server-only';

import { logBackendRouteError, logBackendWarning } from '@/lib/backend-logger';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  MOBILE_MEDIA_DIAGNOSTICS_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import { getClientNetworkKey } from '@/lib/client-network-key';
import { createServiceClient } from '@/lib/server-helpers';

export const MAX_MEDIA_DIAGNOSTICS_BYTES = 16 * 1024;
export const MAX_MEDIA_DIAGNOSTIC_EVENTS = 20;

const EVENT_KINDS = new Set(['image', 'video']);
const EVENT_NAMES = new Set(['error', 'stall', 'retry', 'latched', 'recovered']);
const TOKEN_PATTERN = /^[a-z][a-z-]{0,31}$/;
const SUBJECT_PATTERN = /^[0-9a-f]{8}$/;
const SESSION_PATTERN = /^[A-Za-z0-9-]{8,40}$/;
const APP_FIELD_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

type MobileMediaDiagnosticsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getRateLimitKey?: (headers: Headers) => string;
  logError?: typeof logBackendRouteError;
  logWarning?: typeof logBackendWarning;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
};

function resolveDependencies(dependencies: MobileMediaDiagnosticsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getRateLimitKey: dependencies?.getRateLimitKey ?? getClientNetworkKey,
    logError: dependencies?.logError ?? logBackendRouteError,
    logWarning: dependencies?.logWarning ?? logBackendWarning,
    readBoundedJsonBody: dependencies?.readBoundedJsonBody ?? readBoundedJsonBody,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalAppField(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && APP_FIELD_PATTERN.test(value) ? value : undefined;
}

type MediaDiagnosticEvent = {
  at: string;
  kind: string;
  event: string;
  surface: string;
  subject: string;
  attempt: number;
  stage: string | null;
  status: number | null;
};

/**
 * Accepts only the shape the app's diagnostics log produces: enumerated event
 * names, short lowercase tokens, and media named by an 8-character hash. There
 * is nowhere in it for an address, a token or a prompt to ride along, so a
 * report cannot leak one into the logs even from a modified client.
 */
function parseEvent(value: unknown): MediaDiagnosticEvent | null {
  if (!isRecord(value)) return null;
  const { at, kind, event, surface, subject, attempt, stage, status } = value;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  if (typeof kind !== 'string' || !EVENT_KINDS.has(kind)) return null;
  if (typeof event !== 'string' || !EVENT_NAMES.has(event)) return null;
  if (typeof surface !== 'string' || !TOKEN_PATTERN.test(surface)) return null;
  if (typeof subject !== 'string' || !SUBJECT_PATTERN.test(subject)) return null;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0 || attempt > 10) return null;
  if (stage !== undefined && stage !== null && (typeof stage !== 'string' || !TOKEN_PATTERN.test(stage))) return null;
  if (status !== undefined && status !== null
    && (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599)) return null;

  return {
    at: new Date(at).toISOString(),
    kind,
    event,
    surface,
    subject,
    attempt,
    stage: typeof stage === 'string' ? stage : null,
    status: typeof status === 'number' ? status : null,
  };
}

function parseReport(value: unknown) {
  if (!isRecord(value)) return null;
  const { sessionId, app, events } = value;
  if (typeof sessionId !== 'string' || !SESSION_PATTERN.test(sessionId)) return null;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_MEDIA_DIAGNOSTIC_EVENTS) return null;

  const appRecord = isRecord(app) ? app : {};
  const version = optionalAppField(appRecord.version);
  const build = optionalAppField(appRecord.build);
  const update = optionalAppField(appRecord.update);
  if (version === undefined || build === undefined || update === undefined) return null;

  const parsedEvents = events.map(parseEvent);
  if (parsedEvents.some((event) => event === null)) return null;

  return {
    sessionId,
    app: { version, build, update },
    events: parsedEvents as MediaDiagnosticEvent[],
  };
}

async function handleMediaDiagnosticsPost(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
      ...MOBILE_MEDIA_DIAGNOSTICS_RATE_LIMIT,
      key: dependencies.getRateLimitKey(request.headers),
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }
    dependencies.logError('Media diagnostics rate limit failed:', error);
    return Response.json({ error: 'Failed to check media diagnostics limits.' }, { status: 500 });
  }

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return Response.json({ error: 'Unsupported media diagnostics content type.' }, { status: 415 });
  }

  let body;
  try {
    body = await dependencies.readBoundedJsonBody(request, MAX_MEDIA_DIAGNOSTICS_BYTES);
  } catch (error) {
    dependencies.logError('Media diagnostics body read failed:', error);
    return Response.json({ error: 'Failed to read media diagnostics.' }, { status: 500 });
  }
  if (!body.ok) {
    return Response.json(
      { error: body.reason === 'too_large' ? 'Media diagnostics are too large.' : 'Invalid media diagnostics.' },
      { status: body.reason === 'too_large' ? 413 : 400 },
    );
  }

  const report = parseReport(body.value);
  if (!report) {
    return Response.json({ error: 'Invalid media diagnostics.' }, { status: 400 });
  }

  dependencies.logWarning('mobile_media_diagnostics', {
    sessionId: report.sessionId,
    appVersion: report.app.version,
    appBuild: report.app.build,
    appUpdate: report.app.update,
    platform: request.headers.get('x-magicbooklet-platform')?.slice(0, 16) ?? null,
    stalls: report.events.filter((event) => event.event === 'stall').length,
    failures: report.events.filter((event) => event.event === 'latched').length,
    events: report.events,
  });

  return new Response(null, { status: 204 });
}

/**
 * Sampled media-failure reports from the mobile app's diagnostics log
 * (2026-09-16 Creations reliability audit, C6): stalls that never crash are
 * invisible to store crash reports, so the app sends a bounded sample here and
 * the backend logs it. Nothing is stored in the database.
 */
export async function postMobileMediaDiagnosticsRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobileMediaDiagnosticsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMediaDiagnosticsPost(request, resolveDependencies(dependencies)),
    request,
  );
}
