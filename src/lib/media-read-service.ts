import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  MEDIA_READ_SIGN_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { isMediaBucket, type MediaBucket } from '@/lib/media-urls';

export type MediaReadRoutePayload = {
  bucket: MediaBucket;
  filePath: string;
  downloadFilename: string | null;
};

export type MediaReadRoutePayloadResult =
  | {
    ok: true;
    payload: MediaReadRoutePayload;
  }
  | {
    ok: false;
    status: 400;
    body: {
      error: string;
    };
  };

export type MediaReadSignedUrlResult =
  | {
    ok: true;
    signedUrl: string;
  }
  | {
    ok: false;
    status: 404 | 500;
    body: {
      error: string;
    };
  }
  | {
    ok: false;
    rateLimitError: BackendRateLimitError;
  };

const MEDIA_SIGNED_URL_TTL_SECONDS = 600;

/**
 * How much of a signature's life must remain for it to be handed out again.
 * A player that starts a range request on a nearly-expired URL would fail
 * mid-transfer, so the last two minutes are never reused.
 */
const SIGNATURE_REUSE_MARGIN_MS = 120_000;

/**
 * Bounded so a burst of distinct objects cannot grow this without limit. Each
 * entry is a few hundred bytes and the whole point is a short window, so a
 * small map covers the case that matters: one player asking for the same
 * object several times in a row.
 */
const MAX_CACHED_SIGNATURES = 256;

type CachedSignature = { signedUrl: string; reusableUntilMs: number };

/**
 * Signed URLs already minted for this instance, keyed by owner and object.
 *
 * iOS asks for the same object three times to open one video — a content
 * information request, the data request, and the remainder — and each went
 * through the route and minted a fresh signature. That is three signing round
 * trips per open, and three against the 300-per-10-minutes signing limit,
 * which is what would start answering 429 (shown to the viewer as "Video
 * couldn't load") under fast scrolling.
 *
 * The key includes the user id, so one viewer's capability can never be handed
 * to another, and the download filename, because a download-disposition URL is
 * a different capability from a playback one.
 */
const signatureCache = new Map<string, CachedSignature>();

function getSignatureCacheKey(userId: string, payload: MediaReadRoutePayload): string {
  return [userId, payload.bucket, payload.filePath, payload.downloadFilename ?? ''].join('\n');
}

function readCachedSignature(key: string): string | null {
  const cached = signatureCache.get(key);
  if (!cached) return null;
  if (cached.reusableUntilMs <= Date.now()) {
    signatureCache.delete(key);
    return null;
  }
  // Refresh recency so the eviction below drops the coldest entry.
  signatureCache.delete(key);
  signatureCache.set(key, cached);
  return cached.signedUrl;
}

function storeSignature(key: string, signedUrl: string): void {
  signatureCache.set(key, {
    signedUrl,
    reusableUntilMs: Date.now() + MEDIA_SIGNED_URL_TTL_SECONDS * 1000 - SIGNATURE_REUSE_MARGIN_MS,
  });
  while (signatureCache.size > MAX_CACHED_SIGNATURES) {
    const oldest = signatureCache.keys().next();
    if (oldest.done) break;
    signatureCache.delete(oldest.value);
  }
}

/** Test seam: instances are per-process, so a test must be able to start clean. */
export function resetMediaSignatureCacheForTests(): void {
  signatureCache.clear();
}

function getDownloadFilename(filePath: string, requestedFilename: string | null): string {
  const fallbackFileName = filePath.split('/').pop() || 'download';
  return (requestedFilename?.trim() || fallbackFileName).replace(/[/\\"]/g, '-');
}

export function parseMediaReadRoutePayload({
  bucket,
  filePath,
  requestedFilename,
  shouldDownload,
}: {
  bucket: string | null;
  filePath: string | null;
  requestedFilename: string | null;
  shouldDownload: boolean;
}): MediaReadRoutePayloadResult {
  if (!bucket || !isMediaBucket(bucket) || !filePath) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid media path' },
    };
  }

  return {
    ok: true,
    payload: {
      bucket,
      filePath,
      downloadFilename: shouldDownload
        ? getDownloadFilename(filePath, requestedFilename)
        : null,
    },
  };
}

export async function createMediaReadSignedUrlForRoute({
  payload,
  rateLimitClient,
  userClient,
  userId,
}: {
  payload: MediaReadRoutePayload;
  rateLimitClient: Parameters<typeof enforceBackendRateLimit>[0];
  userClient: SupabaseClient;
  userId: string;
}): Promise<MediaReadSignedUrlResult> {
  // Checked before the rate limit on purpose. Re-handing out a signature this
  // instance already minted for this owner and object does no signing work, so
  // charging it against the signing budget would keep the 429 it exists to
  // prevent — and repeats are the whole pattern here: one iOS open asks for
  // the same object three times.
  const cacheKey = getSignatureCacheKey(userId, payload);
  const reusable = readCachedSignature(cacheKey);
  if (reusable) {
    return { ok: true, signedUrl: reusable };
  }

  try {
    await enforceBackendRateLimit(rateLimitClient, {
      ...MEDIA_READ_SIGN_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return {
        ok: false,
        rateLimitError: error,
      };
    }

    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to check media read limits.' },
    };
  }

  const signedUrlOptions = payload.downloadFilename
    ? { download: payload.downloadFilename }
    : undefined;
  const { data, error } = await userClient.storage
    .from(payload.bucket)
    .createSignedUrl(payload.filePath, MEDIA_SIGNED_URL_TTL_SECONDS, signedUrlOptions);

  if (error || !data?.signedUrl) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Failed to load media' },
    };
  }

  storeSignature(cacheKey, data.signedUrl);

  return {
    ok: true,
    signedUrl: data.signedUrl,
  };
}
