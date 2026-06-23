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

  return {
    ok: true,
    signedUrl: data.signedUrl,
  };
}
