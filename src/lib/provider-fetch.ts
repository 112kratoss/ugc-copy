import { logBackendWarning } from '@/lib/backend-logger';
import { getActiveRequestTrace } from '@/lib/request-trace';
import { recordProviderDependencyEvent } from '@/lib/provider-dependency-telemetry';
import { withRequestTrace } from '@/lib/request-trace';

export const PROVIDER_TASK_CREATE_TIMEOUT_MS = 30_000;
export const PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS = 30_000;
export const PROVIDER_STATUS_POLL_TIMEOUT_MS = 10_000;
export const PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;
export const EXTERNAL_API_REQUEST_TIMEOUT_MS = 5_000;
export const PROVIDER_SLOW_FETCH_WARNING_MS = 15_000;

export type ProviderFetchTelemetryOutcome = 'success' | 'http_error' | 'timeout' | 'network_error';

export type ProviderFetchTelemetryEvent = {
  type: 'provider_fetch';
  serviceName: string;
  requestId?: string;
  modelId?: string;
  outcome: ProviderFetchTelemetryOutcome;
  method: string;
  host: string | null;
  providerTaskId?: string;
  timeoutMs: number;
  durationMs: number;
  status?: number;
  ok?: boolean;
  errorName?: string;
};

export class ExternalServiceTimeoutError extends Error {
  constructor(
    public serviceName: string,
    public timeoutMs: number,
  ) {
    super(`${serviceName} request timed out after ${timeoutMs}ms.`);
    this.name = 'ExternalServiceTimeoutError';
  }
}

export function withProviderFetchRequestId<T>(
  requestId: string,
  operation: () => T
): T {
  return withRequestTrace({ ...getActiveRequestTrace(), requestId }, operation);
}

/**
 * Attribute every provider call made inside `operation` to a generation model.
 *
 * Merges into any active trace rather than replacing it, so wrapping a provider
 * call in a model scope never drops the request id the surrounding API route
 * established. A blank or missing model is a no-op: telemetry then records the
 * call as unattributed, which is the honest result for provider traffic that
 * genuinely has no model behind it.
 */
export function withProviderModel<T>(
  modelId: string | null | undefined,
  operation: () => T
): T {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  if (!trimmed) return operation();

  const active = getActiveRequestTrace();
  return withRequestTrace(
    { requestId: active?.requestId ?? '', ...active, providerModelId: trimmed },
    operation,
  );
}

type ProviderFetchInit = RequestInit & {
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
};

function createProviderTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  const abortSignal = globalThis.AbortSignal;
  if (!abortSignal || typeof abortSignal.timeout !== 'function') {
    return undefined;
  }

  return abortSignal.timeout(timeoutMs);
}

function isAbortLikeError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && ((error as { name?: unknown }).name === 'TimeoutError' || (error as { name?: unknown }).name === 'AbortError')
  );
}

function getProviderFetchMethod(input: RequestInfo | URL, init: ProviderFetchInit): string {
  if (init.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function parseProviderFetchUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(input);
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url);
  } catch {
    return null;
  }

  return null;
}

function getProviderTaskId(url: URL | null): string | undefined {
  if (!url) return undefined;
  return url.searchParams.get('taskId')
    ?? url.searchParams.get('assetId')
    ?? url.searchParams.get('predictionId')
    ?? undefined;
}

function getErrorName(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name)
    : undefined;
}

function roundDurationMs(durationMs: number) {
  return Math.max(0, Math.round(durationMs));
}

function emitProviderFetchTelemetry(event: ProviderFetchTelemetryEvent) {
  if (event.outcome !== 'success' || event.durationMs >= PROVIDER_SLOW_FETCH_WARNING_MS) {
    // Intentionally not routed through the structured logger: this call site
    // already emits a typed telemetry object whose exact shape is asserted by
    // tests and consumed by `recordProviderDependencyEvent`. Changing it would
    // alter a contract rather than improve queryability.
    // eslint-disable-next-line no-console
    console.warn('[provider-fetch]', event);
    void recordProviderDependencyEvent(event);
  }
}

function createProviderFetchTelemetryEvent({
  input,
  init,
  serviceName,
  timeoutMs,
  durationMs,
  outcome,
  response,
  error,
}: {
  input: RequestInfo | URL;
  init: ProviderFetchInit;
  serviceName: string;
  timeoutMs: number;
  durationMs: number;
  outcome: ProviderFetchTelemetryOutcome;
  response?: Response;
  error?: unknown;
}): ProviderFetchTelemetryEvent {
  const url = parseProviderFetchUrl(input);
  const providerTaskId = getProviderTaskId(url);
  const trace = getActiveRequestTrace();
  const requestId = trace?.requestId;
  const modelId = trace?.providerModelId;
  return {
    type: 'provider_fetch',
    serviceName,
    ...(requestId ? { requestId } : {}),
    ...(modelId ? { modelId } : {}),
    outcome,
    method: getProviderFetchMethod(input, init),
    host: url?.host ?? null,
    ...(providerTaskId ? { providerTaskId } : {}),
    timeoutMs,
    durationMs: roundDurationMs(durationMs),
    ...(response ? { status: response.status, ok: response.ok } : {}),
    ...(error ? { errorName: getErrorName(error) } : {}),
  };
}

async function fetchWithTelemetry({
  input,
  init,
  timeoutMs,
  fetcher,
  serviceName,
  timeoutSignal,
}: {
  input: RequestInfo | URL;
  init: ProviderFetchInit;
  timeoutMs: number;
  fetcher: typeof fetch;
  serviceName: string;
  timeoutSignal?: AbortSignal;
}) {
  const requestInit = timeoutSignal ? { ...init, signal: timeoutSignal } : init;
  const startedAtMs = performance.now();

  try {
    const response = await fetcher(input, requestInit);
    emitProviderFetchTelemetry(createProviderFetchTelemetryEvent({
      input,
      init: requestInit,
      serviceName,
      timeoutMs,
      durationMs: performance.now() - startedAtMs,
      outcome: response.ok ? 'success' : 'http_error',
      response,
    }));
    return response;
  } catch (error: unknown) {
    const timedOut = Boolean(timeoutSignal?.aborted && isAbortLikeError(error));
    emitProviderFetchTelemetry(createProviderFetchTelemetryEvent({
      input,
      init: requestInit,
      serviceName,
      timeoutMs,
      durationMs: performance.now() - startedAtMs,
      outcome: timedOut ? 'timeout' : 'network_error',
      error,
    }));

    if (timedOut) {
      throw new ExternalServiceTimeoutError(serviceName, timeoutMs);
    }

    throw error;
  }
}

export function fetchWithProviderTimeout(
  input: RequestInfo | URL,
  init: ProviderFetchInit,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
  serviceName = 'External service',
): Promise<Response> {
  if (init.signal) {
    return fetchWithTelemetry({ input, init, timeoutMs, fetcher, serviceName });
  }

  const signal = createProviderTimeoutSignal(timeoutMs);
  if (!signal) {
    return fetchWithTelemetry({ input, init, timeoutMs, fetcher, serviceName });
  }

  return fetchWithTelemetry({ input, init, timeoutMs, fetcher, serviceName, timeoutSignal: signal });
}

export function isExternalServiceTimeoutError(error: unknown): error is ExternalServiceTimeoutError {
  return error instanceof ExternalServiceTimeoutError;
}

// ─── Bounded retry ────────────────────────────────────────────────────────────

/**
 * Retry is opt-in and defaults to idempotent methods only.
 *
 * Retrying a task-creation POST could bill a user twice for one generation, so
 * a non-idempotent request is only retried when the caller has proven the
 * request carries a provider-side idempotency key.
 */
export type ProviderRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Only set when the request is provably safe to duplicate. */
  retryNonIdempotent?: boolean;
};

export const PROVIDER_STATUS_POLL_RETRY_POLICY: ProviderRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};

export const PROVIDER_MEDIA_DOWNLOAD_RETRY_POLICY: ProviderRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
};

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;

export function isIdempotentProviderMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * A timeout is deliberately not retryable: the caller already waited its full
 * budget, so a retry would stack another full timeout onto user-visible latency.
 */
export function isRetryableProviderResponse(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers?.get?.('retry-after');
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }

  return null;
}

/**
 * Full jitter: a uniform sample from `[0, cappedExponentialDelay]`. Prevents a
 * provider blip from producing a synchronized retry stampede across instances.
 */
export function computeProviderRetryDelayMs(
  attempt: number,
  policy: ProviderRetryPolicy,
  random: () => number = Math.random,
): number {
  const exponentialDelayMs = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.round(random() * exponentialDelayMs);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Wraps `fetchWithProviderTimeout` with bounded, jittered retry.
 *
 * Retries only a network error raised before any response, or a retryable HTTP
 * status, and only when the method is idempotent (or explicitly opted in).
 * Timeouts and non-retryable statuses surface to the caller unchanged, so
 * existing error handling and credit refunds keep working.
 */
export async function fetchWithProviderRetry(
  input: RequestInfo | URL,
  init: ProviderFetchInit,
  timeoutMs: number,
  policy: ProviderRetryPolicy,
  fetcher: typeof fetch = fetch,
  serviceName = 'External service',
  options: { sleep?: (delayMs: number) => Promise<void>; random?: () => number } = {},
): Promise<Response> {
  const sleep = options.sleep ?? defaultSleep;
  const method = getProviderFetchMethod(input, init);
  const mayRetry = policy.retryNonIdempotent === true || isIdempotentProviderMethod(method);
  const maxAttempts = mayRetry ? Math.max(1, policy.maxAttempts) : 1;
  const host = parseProviderFetchUrl(input)?.host ?? null;

  let attempt = 0;

  for (;;) {
    attempt += 1;

    try {
      const response = await fetchWithProviderTimeout(input, init, timeoutMs, fetcher, serviceName);

      if (attempt >= maxAttempts || !isRetryableProviderResponse(response.status)) {
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(response);
      const delayMs = retryAfterMs ?? computeProviderRetryDelayMs(attempt, policy, options.random);
      emitProviderRetryTelemetry({ serviceName, host, method, attempt, maxAttempts, delayMs, status: response.status });
      await sleep(delayMs);
    } catch (error) {
      // A timeout already consumed the full budget; never stack another.
      if (attempt >= maxAttempts || isExternalServiceTimeoutError(error)) {
        throw error;
      }

      const delayMs = computeProviderRetryDelayMs(attempt, policy, options.random);
      emitProviderRetryTelemetry({
        serviceName,
        host,
        method,
        attempt,
        maxAttempts,
        delayMs,
        errorName: getErrorName(error),
      });
      await sleep(delayMs);
    }
  }
}

/**
 * A `fetchWithProviderTimeout`-shaped wrapper that retries idempotent status
 * polls.
 *
 * Deliberately signature-compatible so services which take
 * `fetchWithProviderTimeout` as an injected dependency can adopt retry by
 * swapping their default, without widening the contract their tests mock.
 */
export const fetchStatusPollWithRetry: typeof fetchWithProviderTimeout = (
  input,
  init,
  timeoutMs,
  fetcher = fetch,
  serviceName = 'External service',
) => fetchWithProviderRetry(
  input,
  init,
  timeoutMs,
  PROVIDER_STATUS_POLL_RETRY_POLICY,
  fetcher,
  serviceName,
);

function emitProviderRetryTelemetry(event: {
  serviceName: string;
  host: string | null;
  method: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  status?: number;
  errorName?: string;
}): void {
  logBackendWarning('provider_fetch_retry', {
    serviceName: event.serviceName,
    host: event.host,
    method: event.method,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    delayMs: event.delayMs,
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.errorName ? { errorName: event.errorName } : {}),
  });
}

export function withExternalServiceTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  serviceName: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ExternalServiceTimeoutError(serviceName, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise])
    .finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
}
