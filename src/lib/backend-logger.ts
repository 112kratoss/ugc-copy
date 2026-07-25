/**
 * Structured backend logging.
 *
 * Emits one JSON object per line so production logs can be queried by field
 * instead of by substring. The request id is pulled from the ambient request
 * trace, so call sites never thread it manually.
 *
 * Field shape is intentionally compatible with the pre-existing hand-rolled
 * `console.error(JSON.stringify({ level, msg, ... }))` call sites: `level` and
 * `msg` keep their meaning, and `ts`/`requestId` are added.
 */

import { getActiveRequestTrace } from '@/lib/request-trace';

export type BackendLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type BackendLogFields = Record<string, unknown>;

export type BackendLogRecord = {
  level: BackendLogLevel;
  msg: string;
  ts: string;
  requestId?: string;
} & BackendLogFields;

export type BackendLogSink = (record: BackendLogRecord) => void;

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const REDACTED = '[redacted]';
const MAX_STRING_LENGTH = 1_000;
const MAX_ARRAY_LENGTH = 20;
const MAX_DEPTH = 4;

/**
 * Keys whose values must never reach a log drain. Matched case-insensitively
 * against the whole key, so `apiKey`, `service_role_key`, and `Authorization`
 * are all covered.
 */
const SENSITIVE_KEY_PATTERN = /(password|secret|token|api[-_]?key|service[-_]?role|authorization|signature|cookie|credential|bearer)/i;

function truncate(value: string, max = MAX_STRING_LENGTH): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[+${value.length - max}]`;
}

function normalizeError(error: unknown): BackendLogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: truncate(error.message),
    };
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return { errorMessage: truncate(message) };
    }
  }

  if (typeof error === 'string') {
    return { errorMessage: truncate(error) };
  }

  return error === undefined ? {} : { errorMessage: truncate(String(error)) };
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;

  const valueType = typeof value;
  if (valueType === 'number') return Number.isFinite(value as number) ? value : String(value);
  if (valueType === 'boolean') return value;
  if (valueType === 'bigint') return String(value);
  if (valueType === 'string') return truncate(value as string);
  if (valueType === 'function' || valueType === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return normalizeError(value);

  if (depth >= MAX_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1));
    return value.length > MAX_ARRAY_LENGTH
      ? [...items, `[+${value.length - MAX_ARRAY_LENGTH} more]`]
      : items;
  }

  if (valueType === 'object') {
    return sanitizeFields(value as BackendLogFields, depth + 1);
  }

  return undefined;
}

function sanitizeFields(fields: BackendLogFields, depth = 0): BackendLogFields {
  const sanitized: BackendLogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;

    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = REDACTED;
      continue;
    }

    const sanitizedValue = sanitizeValue(value, depth);
    if (sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue;
    }
  }

  return sanitized;
}

function defaultSink(record: BackendLogRecord): void {
  const serialized = JSON.stringify(record);

  if (record.level === 'error') {
    console.error(serialized);
    return;
  }

  if (record.level === 'warn') {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}

let activeSink: BackendLogSink = defaultSink;

/**
 * Replaces the log sink. Intended for tests; returns a restore function so a
 * test never leaks its sink into the next one.
 */
export function setBackendLogSink(sink: BackendLogSink): () => void {
  const previousSink = activeSink;
  activeSink = sink;
  return () => {
    activeSink = previousSink;
  };
}

export function buildBackendLogRecord(
  level: BackendLogLevel,
  event: string,
  fields: BackendLogFields = {},
): BackendLogRecord {
  const { error, ...rest } = fields;
  const requestId = getActiveRequestTrace()?.requestId;

  return {
    level,
    msg: event,
    ts: new Date().toISOString(),
    ...(requestId ? { requestId } : {}),
    ...sanitizeFields(rest),
    ...sanitizeFields(normalizeError(error)),
  };
}

/**
 * Emits one structured log line.
 *
 * `event` is a stable snake_case name (for example `generation_start_failed`)
 * used as the primary log query key — never interpolate ids into it, pass them
 * as fields instead. An `error` field is normalized into `errorName` and
 * `errorMessage`.
 *
 * Logging never throws: a serialization failure degrades to a minimal record
 * rather than breaking the request that was being logged.
 */
export function logBackendEvent(
  level: BackendLogLevel,
  event: string,
  fields: BackendLogFields = {},
): void {
  try {
    if (!EVENT_NAME_PATTERN.test(event)) {
      activeSink({
        level: 'error',
        msg: 'backend_log_invalid_event_name',
        ts: new Date().toISOString(),
        invalidEvent: truncate(String(event), 120),
      });
      return;
    }

    activeSink(buildBackendLogRecord(level, event, fields));
  } catch (loggingError) {
    try {
      activeSink({
        level: 'error',
        msg: 'backend_log_emit_failed',
        ts: new Date().toISOString(),
        ...normalizeError(loggingError),
      });
    } catch {
      // A logger must never take down its caller.
    }
  }
}

export function logBackendDebug(event: string, fields?: BackendLogFields): void {
  logBackendEvent('debug', event, fields);
}

export function logBackendInfo(event: string, fields?: BackendLogFields): void {
  logBackendEvent('info', event, fields);
}

export function logBackendWarning(event: string, fields?: BackendLogFields): void {
  logBackendEvent('warn', event, fields);
}

export function logBackendError(event: string, fields?: BackendLogFields): void {
  logBackendEvent('error', event, fields);
}

/**
 * A `console.error`-compatible sink for route adapters that accept `logError`
 * as an injectable testing seam.
 *
 * Adapters call it with a human message plus a cause. That shape predates the
 * structured logger, so rather than rewrite every call site this normalizes it:
 * the message becomes a queryable field and the cause is error-normalized, and
 * the line still gains `ts`, the ambient `requestId`, and redaction.
 */
export const logBackendRouteError: (...args: unknown[]) => void = (...args) => {
  const [first, ...rest] = args;
  logBackendError('route_adapter_error', {
    ...(typeof first === 'string' ? { message: first } : {}),
    ...(rest.length === 1
      ? { error: rest[0] }
      : rest.length > 1
        ? { detail: rest }
        : {}),
    ...(typeof first !== 'string' && first !== undefined ? { error: first } : {}),
  });
};

export type BackendLogger = {
  debug: (event: string, fields?: BackendLogFields) => void;
  info: (event: string, fields?: BackendLogFields) => void;
  warn: (event: string, fields?: BackendLogFields) => void;
  error: (event: string, fields?: BackendLogFields) => void;
  child: (boundFields: BackendLogFields) => BackendLogger;
};

/**
 * Binds context carried by every line from one subsystem, for example
 * `createBackendLogger({ jobName })` inside a cron job.
 */
export function createBackendLogger(boundFields: BackendLogFields = {}): BackendLogger {
  const emit = (level: BackendLogLevel) => (event: string, fields: BackendLogFields = {}) => {
    logBackendEvent(level, event, { ...boundFields, ...fields });
  };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (childFields: BackendLogFields) => createBackendLogger({ ...boundFields, ...childFields }),
  };
}
