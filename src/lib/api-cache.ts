export const API_CACHE_CONTROL = {
  publicCatalog: 'public, max-age=300, stale-while-revalidate=3600',
  publicShortEdge: 'public, s-maxage=60, stale-while-revalidate=300',
  publicHourlyEdge: 'public, s-maxage=3600, stale-while-revalidate=86400',
  privateNoStore: 'private, no-store',
  noStore: 'no-store',
  appVersionNoStore: 'no-store, no-cache, must-revalidate',
} as const;

type ApiCacheControl = (typeof API_CACHE_CONTROL)[keyof typeof API_CACHE_CONTROL];

type ApiCacheHeaderOptions = {
  etag?: string;
  vary?: string[];
};

const API_REQUEST_ID_HEADER = 'x-request-id';
const API_REQUEST_ID_FALLBACK_HEADERS = [
  API_REQUEST_ID_HEADER,
  'x-correlation-id',
  'x-vercel-id',
] as const;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:/=-]{1,128}$/;
const GENERATED_REQUEST_IDS = new WeakMap<Request, string>();

function generatedRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeApiRequestId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || !SAFE_REQUEST_ID_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

export function getApiRequestId(request: Request): string {
  for (const headerName of API_REQUEST_ID_FALLBACK_HEADERS) {
    const requestId = normalizeApiRequestId(request.headers.get(headerName));
    if (requestId) {
      return requestId;
    }
  }

  const cachedRequestId = GENERATED_REQUEST_IDS.get(request);
  if (cachedRequestId) {
    return cachedRequestId;
  }

  const requestId = generatedRequestId();
  GENERATED_REQUEST_IDS.set(request, requestId);
  return requestId;
}

export function createApiTraceHeaders(request: Request): Record<string, string> {
  return {
    [API_REQUEST_ID_HEADER]: getApiRequestId(request),
  };
}

export function createApiCacheHeaders(
  cacheControl: ApiCacheControl,
  options: ApiCacheHeaderOptions = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    'Cache-Control': cacheControl,
  };

  if (options.etag) {
    headers.ETag = options.etag;
  }

  if (options.vary?.length) {
    headers.Vary = Array.from(new Set(options.vary)).join(', ');
  }

  return headers;
}

export function createApiResponseHeaders(
  request: Request,
  cacheControl: ApiCacheControl,
  options: ApiCacheHeaderOptions = {}
): Record<string, string> {
  return {
    ...createApiCacheHeaders(cacheControl, options),
    ...createApiTraceHeaders(request),
  };
}

export function createPrivateNoStoreApiResponseHeaders(
  request: Request,
  options: ApiCacheHeaderOptions = {}
): Record<string, string> {
  return createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore, options);
}

export function applyApiResponseHeaders<T extends Response>(
  response: T,
  request: Request,
  cacheControl: ApiCacheControl,
  options: ApiCacheHeaderOptions = {}
): T {
  for (const [name, value] of Object.entries(createApiResponseHeaders(request, cacheControl, options))) {
    response.headers.set(name, value);
  }

  return response;
}

export function applyPrivateNoStoreApiResponseHeaders<T extends Response>(
  response: T,
  request: Request,
  options: ApiCacheHeaderOptions = {}
): T {
  return applyApiResponseHeaders(response, request, API_CACHE_CONTROL.privateNoStore, options);
}

export function getViewerAwareApiCacheControl(hasAuthorizationHeader: boolean): ApiCacheControl {
  return hasAuthorizationHeader ? API_CACHE_CONTROL.privateNoStore : API_CACHE_CONTROL.publicShortEdge;
}
