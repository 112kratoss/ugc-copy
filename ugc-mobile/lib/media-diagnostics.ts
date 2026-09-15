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

export function recordMediaDiagnostic(input: Omit<MediaDiagnosticEvent, 'at'>) {
  events.push({ ...input, subject: hashMediaSubject(input.subject), at: Date.now() });
  if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
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
}
