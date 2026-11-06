import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

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
import { reuseRecipeFile as defaultReuseRecipeFile } from '@/lib/generation-reference-copy-import';
import { providerReferenceTrackFormats } from '@/lib/provider-input-limits';
import { recipeCopyOfSource } from '@/lib/recipe-file-paths';
import { recordPreparedSeedanceAsset } from '@/lib/seedance-asset-provenance';
import { resolveOwnedStoredMediaUrl as defaultResolveStoredMediaUrl } from '@/lib/server-helpers';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';

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

/**
 * The models that run prepared assets (`isSeedance2VideoModelId`). An asset is prepared before
 * the run names its model and runs on any of them, so its track is held to the formats every one
 * takes: WAV and MP3 today (2.5 also takes AAC and Ogg, the others do not).
 */
const SEEDANCE_ASSET_MODEL_IDS = ['seedance-2', 'seedance-2-fast', 'seedance-2-mini', 'seedance-2-5'] as const;

function seedanceAssetTrackFormats(): readonly string[] {
  const [first = [], ...rest] = SEEDANCE_ASSET_MODEL_IDS.map((modelId) => providerReferenceTrackFormats(modelId) ?? []);
  return first.filter((format) => rest.every((formats) => formats.includes(format)));
}

/**
 * The link Kie is sent for an audio asset: the creator's own when Seedance takes it as it is,
 * judged by its extension and its bytes, or else a WAV copy kept for Kie to fetch
 * (`storeSeedanceAssetTrack`). Answers a refusal instead when the track cannot be converted.
 */
async function seedanceAssetTrackLink({
  adminSupabase,
  resolvedUrl,
  userId,
}: {
  adminSupabase: SupabaseClient;
  resolvedUrl: string;
  userId: string;
}): Promise<{ ok: true; url: string } | { ok: false; result: SeedanceAssetRouteResult }> {
  const {
    convertReferenceTrackIfRefused,
    ReferenceTrackUnreadableError,
    storeSeedanceAssetTrack,
  } = await import('@/lib/reference-track-conversion');
  try {
    const wav = await convertReferenceTrackIfRefused({
      supabase: adminSupabase,
      userId,
      link: resolvedUrl,
      formats: seedanceAssetTrackFormats(),
    });
    if (!wav) return { ok: true, url: resolvedUrl };
    return { ok: true, url: await storeSeedanceAssetTrack({ supabase: adminSupabase, userId, wav }) };
  } catch (error) {
    if (error instanceof ReferenceTrackUnreadableError) {
      return {
        ok: false,
        result: {
          ok: false,
          status: 400,
          body: {
            error: error.tooLong
              ? 'This track is too long for Seedance. Use a shorter track.'
              : 'We could not convert this track for Seedance. Add it again as an MP3 or WAV file.',
          },
        },
      };
    }
    logBackendError('seedance_asset_track_conversion_failed', { error });
    return {
      ok: false,
      result: { ok: false, status: 500, body: { error: 'We could not prepare your audio track. Try again in a moment.' } },
    };
  }
}

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

/**
 * Seedance's Prepare: makes a Kie asset of one of the creator's own files (or their import of a
 * recipe file their unlock still covers), records which file it runs, and answers its id. An
 * audio track Seedance would not take is converted to WAV first and Kie is sent that copy
 * (`seedanceAssetTrackLink`); a track that cannot be converted is refused before Kie is asked.
 */
export async function createSeedanceAssetForRoute({
  adminSupabase,
  apiKey,
  body,
  fetcher = fetch,
  resolveStoredMediaUrl = defaultResolveStoredMediaUrl,
  reuseRecipeFile = defaultReuseRecipeFile,
  recordPreparedAsset = recordPreparedSeedanceAsset,
  userId,
}: {
  adminSupabase: SupabaseClient;
  apiKey: string;
  body: SeedanceAssetRouteBody;
  fetcher?: typeof fetch;
  resolveStoredMediaUrl?: ResolveStoredMediaUrl;
  reuseRecipeFile?: (params: { source: string; viewerUserId: string }) => ReturnType<typeof defaultReuseRecipeFile>;
  recordPreparedAsset?: typeof recordPreparedSeedanceAsset;
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

    logBackendError('seedance_asset_rate_limit_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to check Seedance asset limits.' } };
  }

  try {
    // A recipe file (a bought recipe's copy, the buyer's import of one, or a kept input of theirs marked
    // as one) is prepared only while the unlock still covers it, and from the buyer's own import of the
    // copy, so the asset is theirs (2026-11-03 re-review): a picture of a person restored from a recipe
    // runs on Seedance 2 only as a prepared asset. No remix of the buyer's creation is handed it.
    const recipeFile = await reuseRecipeFile({ source: normalizedUrl, viewerUserId: userId });
    if (recipeFile?.outcome === 'failed') {
      return { ok: false, status: 500, body: { error: 'We could not prepare a file from a recipe you unlocked. Please try again.' } };
    }
    if (recipeFile?.outcome === 'not-eligible') {
      return { ok: false, status: 400, body: { error: 'Asset media must belong to the authenticated user.' } };
    }
    if (!recipeFile && !getUserOwnedStoredMediaLocation(normalizedUrl, userId)) {
      return {
        ok: false,
        status: 400,
        body: { error: 'Asset media must belong to the authenticated user.' },
      };
    }
    const resolvedUrl = recipeFile ? recipeFile.signedUrl : await resolveStoredMediaUrl(adminSupabase, normalizedUrl, userId);
    if (!resolvedUrl) {
      return {
        ok: false,
        status: 400,
        body: { error: 'Asset media must belong to the authenticated user.' },
      };
    }
    // Seedance 2 takes WAV and MP3 tracks only: a track it would not take (an iPhone `.m4a`, AAC,
    // Ogg, WebM, or a file whose extension lies about its bytes) is converted first, as the video
    // start converts one. Kie is sent the copy; the creator keeps their own file's link, and the
    // asset is recorded as that file.
    let providerUrl = resolvedUrl;
    if (normalizedAssetType === 'Audio') {
      const track = await seedanceAssetTrackLink({ adminSupabase, resolvedUrl, userId });
      if (!track.ok) return track.result;
      providerUrl = track.url;
    }
    const response = await fetchWithProviderTimeout('https://api.kie.ai/api/v1/playground/createAsset', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assetType: normalizedAssetType,
        url: providerUrl,
      }),
    }, PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS, fetcher, 'KIE Seedance asset creation');

    const data = await parseResponse(response);
    const payload = extractAssetPayloadValue(data) ?? data;
    const rawStatus = extractRawStatus(payload) ?? 'processing';
    const assetId = extractAssetId(payload);

    // Which file the asset runs, and whose (owner, 2026-11-04): a start refuses an asset prepared from
    // a recipe file its caller can no longer use (`checkSeedanceAssetsUsable`). An id not recorded is
    // never handed out, since a start could not tell what it runs.
    if (assetId) {
      const recorded = await recordPreparedAsset({
        adminSupabase,
        assetId,
        ownerUserId: userId,
        source: normalizedUrl,
        recipeFile: recipeFile ? recipeCopyOfSource(recipeFile.storagePath, new Set([userId])) ?? '' : null,
        recordedFrom: 'prepare',
      });
      if (!recorded) {
        return { ok: false, status: 500, body: { error: 'Failed to create Seedance asset' } };
      }
    }

    return {
      ok: true,
      body: createProviderPayload({
        assetId,
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

    return {
      ok: true,
      body: createProviderPayload({
        assetId: extractAssetId(payload) ?? assetId,
        assetType: normalizeAssetType(payloadRecord.assetType ?? null),
        payload,
        rawStatus,
        // Kie's answer can carry the link the asset was made from: its
        // creator's upload. Asset ids go to the remixers the inputs are handed
        // to (owner, 2026-10-29), so the read gives the state alone, and both
        // creators keep the link they already hold.
        sourceUrl: null,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load Seedance asset';
    return { ok: false, status: 500, body: { error: message } };
  }
}
