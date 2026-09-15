/**
 * A bounded, on-device log of media failures and recoveries.
 *
 * The intermittent blank-media incident of 2026-09-15 left no trace: store crash
 * reports do not capture stalls that never crash, and the app was restarted
 * before anything was recorded (2026-09-16 Creations reliability audit). This
 * keeps the last events of the session in memory so the next occurrence can be
 * captured before a restart — long-press the version line in Settings to copy
 * the report.
 *
 * Nothing identifying leaves this module unhashed: media are named by a hash of
 * their cache key, never by URL, so signed tokens, storage paths and prompts
 * cannot end up in a report.
 */

export type MediaDiagnosticEvent = {
  at: number;
  kind: 'image' | 'video';
  event: 'error' | 'stall' | 'retry' | 'latched' | 'recovered';
  /** Where the media was drawn: `profile-grid`, `profile-feed`, `viewer`, `feed`. */
  surface: string;
  /** An 8-character hash of the media's cache key or address. */
  subject: string;
  attempt: number;
  /** A stall stage, or what kind of error: `http`, `decode`, `load`. */
  stage?: string;
  /** The HTTP status an error named, when it named one. */
  status?: number;
};

const EVENT_LIMIT = 200;
const REPORTED_EVENT_LIMIT = 50;

const events: MediaDiagnosticEvent[] = [];
const session = {
  id: createSessionId(),
  startedAt: Date.now(),
};

function createSessionId() {
  const random = globalThis.crypto?.randomUUID?.();
  return (random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).slice(0, 13);
}

/** FNV-1a, 32 bits: stable across the session, and not reversible into the address. */
export function hashMediaSubject(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** What reaches the backend: stalls and final failures, never routine errors or recoveries. */
const REPORTED_EVENTS = new Set<MediaDiagnosticEvent['event']>(['stall', 'latched']);
/** Gathers a burst of failures into one report instead of one request each. */
export const MEDIA_DIAGNOSTICS_REPORT_DELAY_MS = 30_000;
export const MEDIA_DIAGNOSTICS_REPORT_SPACING_MS = 5 * 60_000;
export const MEDIA_DIAGNOSTICS_REPORTS_PER_SESSION = 3;
export const MEDIA_DIAGNOSTICS_EVENTS_PER_REPORT = 20;
/** The backend refuses a larger attempt count; a report carries at most this. */
const REPORTED_ATTEMPT_CEILING = 10;

export type MediaDiagnosticsReport = {
  sessionId: string;
  app: { version: string | null; build: string | null; update: string | null };
  events: MediaDiagnosticEvent[];
};

type MediaDiagnosticsReporter = {
  send: (report: MediaDiagnosticsReport) => Promise<unknown>;
  app: () => MediaDiagnosticsReport['app'];
};

/** Each recorded event's place in the session, which outlives the ring buffer's trimming. */
const sequenceOf = new WeakMap<MediaDiagnosticEvent, number>();
const reporting = {
  reporter: null as MediaDiagnosticsReporter | null,
  timer: null as ReturnType<typeof setTimeout> | null,
  recorded: 0,
  /** Everything up to this sequence was sent or passed over: no event is reported twice. */
  reportedThrough: 0,
  sentReports: 0,
  lastSentAt: 0,
};

export function recordMediaDiagnostic(input: Omit<MediaDiagnosticEvent, 'at'>) {
  const entry = { ...input, subject: hashMediaSubject(input.subject), at: Date.now() };
  reporting.recorded += 1;
  sequenceOf.set(entry, reporting.recorded);
  events.push(entry);
  if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
  if (REPORTED_EVENTS.has(entry.event)) scheduleSampledReport();
}

/**
 * Sends a bounded sample of this session's stalls and failures to the backend,
 * so an incident on someone else's phone leaves a trace too. Registered once
 * the API client exists; returns the unregister.
 *
 * Sampling keeps it cheap and quiet: only stalls and final failures, at most
 * `MEDIA_DIAGNOSTICS_EVENTS_PER_REPORT` per report, reports at least
 * `MEDIA_DIAGNOSTICS_REPORT_SPACING_MS` apart and no more than
 * `MEDIA_DIAGNOSTICS_REPORTS_PER_SESSION`. A report that fails is dropped,
 * never retried: diagnostics must not add load to a network that is failing.
 */
export function setMediaDiagnosticsReporter(reporter: MediaDiagnosticsReporter) {
  reporting.reporter = reporter;
  if (unreportedEvents().length) scheduleSampledReport();
  return () => {
    if (reporting.reporter !== reporter) return;
    reporting.reporter = null;
    if (reporting.timer) clearTimeout(reporting.timer);
    reporting.timer = null;
  };
}

function unreportedEvents() {
  return events.filter((entry) => (
    REPORTED_EVENTS.has(entry.event) && (sequenceOf.get(entry) ?? 0) > reporting.reportedThrough
  ));
}

function scheduleSampledReport() {
  if (!reporting.reporter || reporting.timer) return;
  if (reporting.sentReports >= MEDIA_DIAGNOSTICS_REPORTS_PER_SESSION) return;
  const spacingLeft = reporting.lastSentAt
    ? reporting.lastSentAt + MEDIA_DIAGNOSTICS_REPORT_SPACING_MS - Date.now()
    : 0;
  reporting.timer = setTimeout(flushSampledReport, Math.max(MEDIA_DIAGNOSTICS_REPORT_DELAY_MS, spacingLeft));
}

function flushSampledReport() {
  reporting.timer = null;
  const reporter = reporting.reporter;
  if (!reporter || reporting.sentReports >= MEDIA_DIAGNOSTICS_REPORTS_PER_SESSION) return;

  const pending = unreportedEvents();
  reporting.reportedThrough = reporting.recorded;
  if (!pending.length) return;

  reporting.sentReports += 1;
  reporting.lastSentAt = Date.now();
  const report: MediaDiagnosticsReport = {
    sessionId: session.id,
    app: reporter.app(),
    events: pending
      .slice(-MEDIA_DIAGNOSTICS_EVENTS_PER_REPORT)
      .map((entry) => ({ ...entry, attempt: Math.min(entry.attempt, REPORTED_ATTEMPT_CEILING) })),
  };
  try {
    void reporter.send(report).catch(() => undefined);
  } catch {
    // A sender that throws synchronously is dropped the same as one that rejects.
  }
}

/**
 * What an image error says about its cause, without its text: loader messages
 * can carry the full signed address. Only an HTTP status code survives.
 */
export function describeImageError(error: unknown): { stage: string; status?: number } {
  const message = typeof error === 'string'
    ? error
    : error && typeof error === 'object' && typeof (error as { error?: unknown }).error === 'string'
      ? (error as { error: string }).error
      : '';
  const status = /\b([45]\d\d)\b/.exec(message)?.[1];
  if (status) return { stage: 'http', status: Number(status) };
  return { stage: /decod/i.test(message) ? 'decode' : 'load' };
}

export function readMediaDiagnostics() {
  return { sessionId: session.id, startedAt: session.startedAt, events: events.slice() };
}

export function summarizeMediaDiagnostics(list: MediaDiagnosticEvent[]) {
  return {
    total: list.length,
    stalls: list.filter((entry) => entry.event === 'stall').length,
    failures: list.filter((entry) => entry.event === 'latched').length,
    recoveries: list.filter((entry) => entry.event === 'recovered').length,
  };
}

export function formatMediaDiagnosticsReport({
  versionLabel,
  diagnostics,
  now,
}: {
  versionLabel: string | null;
  diagnostics: ReturnType<typeof readMediaDiagnostics>;
  now: number;
}) {
  const summary = summarizeMediaDiagnostics(diagnostics.events);
  const recent = diagnostics.events.slice(-REPORTED_EVENT_LIMIT).map((entry) => [
    new Date(entry.at).toISOString(),
    entry.kind,
    entry.event,
    entry.surface,
    entry.subject,
    `attempt ${entry.attempt}`,
    entry.stage ?? '',
    entry.status ? `status ${entry.status}` : '',
  ].filter(Boolean).join(' '));

  return [
    'Magicbooklet media diagnostics',
    versionLabel ?? 'Version unknown',
    `Session ${diagnostics.sessionId}, started ${new Date(diagnostics.startedAt).toISOString()}, copied ${new Date(now).toISOString()}`,
    `Events ${summary.total} · stalls ${summary.stalls} · failures ${summary.failures} · recoveries ${summary.recoveries}`,
    ...recent,
  ].join('\n');
}

export function clearMediaDiagnosticsForTests() {
  events.length = 0;
  if (reporting.timer) clearTimeout(reporting.timer);
  Object.assign(reporting, {
    reporter: null,
    timer: null,
    recorded: 0,
    reportedThrough: 0,
    sentReports: 0,
    lastSentAt: 0,
  });
}
