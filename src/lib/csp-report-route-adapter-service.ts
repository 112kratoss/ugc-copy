import 'server-only';

import { logBackendWarning } from '@/lib/backend-logger';

const MAX_CSP_REPORT_BYTES = 16 * 1024;
const CSP_REPORT_CONTENT_TYPES = [
  'application/csp-report',
  'application/json',
  'application/reports+json',
];

type CspReportRouteDependencies = {
  logWarning?: typeof logBackendWarning;
};

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

export async function postCspReportRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: CspReportRouteDependencies;
  request: Request;
}) {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || !CSP_REPORT_CONTENT_TYPES.includes(contentType)) {
    return Response.json({ error: 'Unsupported CSP report content type.' }, {
      status: 415,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_CSP_REPORT_BYTES) {
    return Response.json({ error: 'CSP report is too large.' }, {
      status: 413,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_CSP_REPORT_BYTES) {
    return Response.json({ error: 'CSP report is too large.' }, {
      status: 413,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid CSP report.' }, {
      status: 400,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const report = normalizeReportTo(parsed) ?? normalizeLegacyReport(parsed);
  if (!report) {
    return Response.json({ error: 'Invalid CSP report.' }, {
      status: 400,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  (dependencies?.logWarning ?? logBackendWarning)('content_security_policy_violation', {
    ...reportFields(report),
    userAgent: boundedString(request.headers.get('user-agent'), 240),
  });

  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
