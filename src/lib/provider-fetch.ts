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
  return withRequestTrace({ requestId }, operation);
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
  const requestId = getActiveRequestTrace()?.requestId;
  return {
    type: 'provider_fetch',
    serviceName,
    ...(requestId ? { requestId } : {}),
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
