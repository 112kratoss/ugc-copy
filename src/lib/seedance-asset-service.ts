import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  enforceBackendRateLimit,
  SEEDANCE_ASSET_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import {
  normalizeSeedanceAssetStatus,
  type SeedanceAssetKind,
} from '@/lib/seedance-assets';
import {
  fetchWithProviderTimeout,
  PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS,
} from '@/lib/provider-fetch';
import { resolveStoredMediaUrl as defaultResolveStoredMediaUrl } from '@/lib/server-helpers';

type SeedanceAssetRouteBody = {
  url?: unknown;
  assetType?: unknown;
};

type SeedanceAssetRouteBodySuccess = {
  success: true;
  assetId: string | null;
  assetType: SeedanceAssetKind | null;
  status: ReturnType<typeof normalizeSeedanceAssetStatus>;
  rawStatus: string;
  error: string | null;
  sourceUrl: string | null;
  lastCheckedAt: string;
};

export type SeedanceAssetRouteResult =
  | {
      ok: true;
      body: SeedanceAssetRouteBodySuccess;
    }
  | {
      ok: false;
      status: 400 | 429 | 500;
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    };

type ResolveStoredMediaUrl = typeof defaultResolveStoredMediaUrl;

function extractAssetPayloadValue<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'object' && value !== null && 'data' in value) {
    return extractAssetPayloadValue<T>((value as { data?: unknown }).data);
  }

  return value as T;
}

function extractAssetId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [record.assetId, record.asset_id, record.id, record.taskId];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function extractRawStatus(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [
    record.status,
    record.state,
    record.assetStatus,
    record.asset_state,
    record.taskStatus,
    record.task_state,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function extractErrorMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [record.error, record.message, record.msg, record.failMsg];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok || (data?.code && data.code !== 200)) {
    throw new Error(
      (typeof data?.msg === 'string' && data.msg)
      || (typeof data?.message === 'string' && data.message)
      || 'Seedance asset request failed'
    );
  }

  return data;
}

function normalizeAssetType(value: unknown): SeedanceAssetKind | null {
  if (value === 'Image' || value === 'Video' || value === 'Audio') {
    return value;
  }

  return null;
}

function createRateLimitResult(error: BackendRateLimitError): SeedanceAssetRouteResult {
  return {
    ok: false,
    status: 429,
    headers: {
      'Retry-After': String(error.retryAfterSeconds),
      'X-RateLimit-Limit': String(error.state.limit),
      'X-RateLimit-Remaining': String(error.state.remaining),
      'X-RateLimit-Reset': error.state.resetAt,
    },
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

function createProviderPayload({
  assetId,
  assetType,
  payload,
  rawStatus,
  sourceUrl,
}: {
  assetId: string | null;
  assetType: SeedanceAssetKind | null;
  payload: unknown;
  rawStatus: string;
  sourceUrl: string | null;
}): SeedanceAssetRouteBodySuccess {
  return {
    success: true,
    assetId,
    assetType,
    status: normalizeSeedanceAssetStatus(rawStatus),
    rawStatus,
    error: extractErrorMessage(payload),
    sourceUrl,
    lastCheckedAt: new Date().toISOString(),
  };
}

export async function createSeedanceAssetForRoute({
  adminSupabase,
  apiKey,
  body,
  fetcher = fetch,
  resolveStoredMediaUrl = defaultResolveStoredMediaUrl,
  userId,
}: {
  adminSupabase: SupabaseClient;
  apiKey: string;
  body: SeedanceAssetRouteBody;
  fetcher?: typeof fetch;
  resolveStoredMediaUrl?: ResolveStoredMediaUrl;
  userId: string;
}): Promise<SeedanceAssetRouteResult> {
  const normalizedAssetType = normalizeAssetType(body.assetType);
  const normalizedUrl = typeof body.url === 'string' ? body.url.trim() : '';

  if (!normalizedUrl) {
    return { ok: false, status: 400, body: { error: 'Missing url' } };
  }

  if (!normalizedAssetType) {
    return { ok: false, status: 400, body: { error: 'Invalid assetType' } };
  }

  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...SEEDANCE_ASSET_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    console.error('Seedance asset rate limit failed:', error);
    return { ok: false, status: 500, body: { error: 'Failed to check Seedance asset limits.' } };
  }

  try {
    const resolvedUrl = await resolveStoredMediaUrl(adminSupabase, normalizedUrl);
    const response = await fetchWithProviderTimeout('https://api.kie.ai/api/v1/playground/createAsset', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assetType: normalizedAssetType,
        url: resolvedUrl,
      }),
    }, PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS, fetcher, 'KIE Seedance asset creation');

    const data = await parseResponse(response);
    const payload = extractAssetPayloadValue(data) ?? data;
    const rawStatus = extractRawStatus(payload) ?? 'processing';

    return {
      ok: true,
      body: createProviderPayload({
        assetId: extractAssetId(payload),
        assetType: normalizedAssetType,
        payload,
        rawStatus,
        sourceUrl: resolvedUrl,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create Seedance asset';
    return { ok: false, status: 500, body: { error: message } };
  }
}

export async function getSeedanceAssetForRoute({
  apiKey,
  assetId,
  fetcher = fetch,
}: {
  apiKey: string;
  assetId: string;
  fetcher?: typeof fetch;
}): Promise<SeedanceAssetRouteResult> {
  if (!assetId) {
    return { ok: false, status: 400, body: { error: 'Missing assetId' } };
  }

  try {
    const response = await fetchWithProviderTimeout(
      `https://api.kie.ai/api/v1/playground/getAsset?assetId=${encodeURIComponent(assetId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
      PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS,
      fetcher,
      'KIE Seedance asset status'
    );

    const data = await parseResponse(response);
    const payload = extractAssetPayloadValue(data) ?? data;
    const rawStatus = extractRawStatus(payload) ?? 'processing';
    const payloadRecord = typeof payload === 'object' && payload !== null
      ? payload as Record<string, unknown>
      : {};
    const sourceUrl = typeof payloadRecord.url === 'string'
      ? String(payloadRecord.url)
      : null;

    return {
      ok: true,
      body: createProviderPayload({
        assetId: extractAssetId(payload) ?? assetId,
        assetType: normalizeAssetType(payloadRecord.assetType ?? null),
        payload,
        rawStatus,
        sourceUrl,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load Seedance asset';
    return { ok: false, status: 500, body: { error: message } };
  }
}
