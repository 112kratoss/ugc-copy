import 'server-only';

import { logBackendRouteError, logBackendWarning } from '@/lib/backend-logger';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  CSP_REPORT_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import { getClientNetworkKey } from '@/lib/client-network-key';
import { createServiceClient } from '@/lib/server-helpers';

export const MAX_CSP_REPORT_BYTES = 16 * 1024;
const CSP_REPORT_CONTENT_TYPES = [
  'application/csp-report',
  'application/json',
  'application/reports+json',
];

/**
 * A browser extension's own code or files (Safari reports some as
 * `webkit-masked-url`): the visitor's add-on, which nothing here can change.
 */
const EXTENSION_SCHEMES = new Set([
  'chrome-extension',
  'moz-extension',
  'safari-extension',
  'safari-web-extension',
  'webkit-masked-url',
]);

/**
 * Documents no page of this site is. Code running in one was put there by
 * something else, such as an extension's frame, so what it trips is not the
 * site's to fix. A blocked `data:` or `about:` resource is
 * kept: the site's own code can ask for one, and the report says what an
 * enforcing policy would break.
 */
const FOREIGN_SOURCE_SCHEMES = new Set(['about', 'data']);

type CspReportRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getRateLimitKey?: (headers: Headers) => string;
  logError?: typeof logBackendRouteError;
  logWarning?: typeof logBackendWarning;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
};

function resolveDependencies(dependencies: CspReportRouteDependencies | undefined) {
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

function boundedString(value: unknown, max = 160): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : null;
}

function safeUrlLabel(value: unknown): string | null {
  const raw = boundedString(value, 2_048);
  if (!raw) return null;
  if (['inline', 'eval', 'self'].includes(raw)) return raw;
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 300);
  } catch {
    return 'non_url';
  }
}

function normalizeLegacyReport(value: unknown) {
  if (!isRecord(value)) return null;
  const report = isRecord(value['csp-report']) ? value['csp-report'] : value;
  return isRecord(report) ? report : null;
}

function normalizeReportTo(value: unknown) {
  if (!Array.isArray(value)) return null;
  const entry = value.find((candidate) => (
    isRecord(candidate)
    && candidate.type === 'csp-violation'
    && isRecord(candidate.body)
  ));
  return entry && isRecord(entry.body) ? entry.body : null;
}

/** A URL's scheme, or a browser's scheme-only form of one (`"data"`, `"chrome-extension"`), lower-cased. */
function uriScheme(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*([a-z][a-z0-9+.-]*)(?::|$)/i.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/** What a browser always sends with a violation: the directive it broke. */
function namesADirective(report: Record<string, unknown>): boolean {
  return [
    report['effective-directive'],
    report['violated-directive'],
    report.effectiveDirective,
    report.violatedDirective,
  ].some((value) => typeof value === 'string' && value.trim() !== '');
}

/** Whether a violation is someone else's code, not the site's: dropped before any database work. */
function isForeignViolation(report: Record<string, unknown>): boolean {
  const blocked = uriScheme(report['blocked-uri'] ?? report.blockedURL);
  const source = uriScheme(report['source-file'] ?? report.sourceFile);
  if ((blocked && EXTENSION_SCHEMES.has(blocked)) || (source && EXTENSION_SCHEMES.has(source))) return true;
  return source !== null && FOREIGN_SOURCE_SCHEMES.has(source);
}

function reportFields(report: Record<string, unknown>) {
  return {
    blockedResource: safeUrlLabel(report['blocked-uri'] ?? report.blockedURL),
    columnNumber: typeof report['column-number'] === 'number'
      ? report['column-number']
      : report.columnNumber,
    document: safeUrlLabel(report['document-uri'] ?? report.documentURL),
    effectiveDirective: boundedString(
      report['effective-directive'] ?? report.effectiveDirective,
    ),
    lineNumber: typeof report['line-number'] === 'number'
      ? report['line-number']
      : report.lineNumber,
    originalPolicy: boundedString(report['original-policy'] ?? report.originalPolicy, 500),
    sourceFile: safeUrlLabel(report['source-file'] ?? report.sourceFile),
    violatedDirective: boundedString(
      report['violated-directive'] ?? report.violatedDirective,
    ),
  };
}

/**
 * Everything that can be refused or dropped is, before the one database write:
 * the rate limit bounds what this public sink logs, so a body no browser sent
 * and a violation the site cannot act on cost no write at all.
 */
async function handleCspReportPost(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || !CSP_REPORT_CONTENT_TYPES.includes(contentType)) {
    return Response.json({ error: 'Unsupported CSP report content type.' }, { status: 415 });
  }

  let boundedBody;
  try {
    boundedBody = await dependencies.readBoundedJsonBody(request, MAX_CSP_REPORT_BYTES);
  } catch (error) {
    dependencies.logError('CSP report body read failed:', error);
    return Response.json({ error: 'Failed to read CSP report.' }, { status: 500 });
  }

  if (!boundedBody.ok) {
    return Response.json({
      error: boundedBody.reason === 'too_large'
        ? 'CSP report is too large.'
        : 'Invalid CSP report.',
    }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
  }

  const report = normalizeReportTo(boundedBody.value) ?? normalizeLegacyReport(boundedBody.value);
  if (!report || !namesADirective(report)) {
    return Response.json({ error: 'Invalid CSP report.' }, { status: 400 });
  }

  // Answered as any report is: a browser does nothing with the reply.
  if (isForeignViolation(report)) {
    return new Response(null, { status: 204 });
  }

  try {
    const serviceClient = dependencies.createServiceClient();
    await dependencies.enforceBackendRateLimit(serviceClient, {
      ...CSP_REPORT_RATE_LIMIT,
      key: dependencies.getRateLimitKey(request.headers),
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    dependencies.logError('CSP report rate limit failed:', error);
    return Response.json({ error: 'Failed to check CSP report limits.' }, { status: 500 });
  }

  dependencies.logWarning('content_security_policy_violation', {
    ...reportFields(report),
    userAgent: boundedString(request.headers.get('user-agent'), 240),
  });

  return new Response(null, {
    status: 204,
  });
}

export async function postCspReportRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: CspReportRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleCspReportPost(request, resolveDependencies(dependencies)),
    request,
  );
}
