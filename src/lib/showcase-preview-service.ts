import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  SHOWCASE_PREVIEW_READ_URL_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  getCanonicalStoredMediaLocation,
  getUserOwnedStoredMediaLocation,
  parseCanonicalStorageObjectPath,
} from '@/lib/storage-ownership';

type PreviewGenerationRow = {
  user_id: string;
  output_url?: string | null;
  showcase_asset_path?: string | null;
  is_public?: boolean | null;
};

const GENERATION_MEDIA_BUCKETS = [
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
] as const;

function getCanonicalShowcaseAssetPath(value: string, generationId: string): string | null {
  const canonicalPath = parseCanonicalStorageObjectPath(value, { minimumSegments: 3 });
  if (!canonicalPath) return null;
  const [namespace, scopedGenerationId] = canonicalPath.split('/');
  return namespace === 'showcase' && scopedGenerationId === generationId
    ? canonicalPath
    : null;
}

function getSafeRemoteMediaUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.pathname.includes('/storage/v1/object/')
      ? value
      : null;
  } catch {
    return null;
  }
}

export type ShowcasePreviewResult =
  | {
    ok: true;
    body: {
      url: string;
    };
  }
  | {
    ok: false;
    status: 400 | 403 | 404 | 500;
    body: {
      error: string;
    };
  }
  | {
    ok: false;
    rateLimitError: BackendRateLimitError;
  };

export async function createShowcasePreviewForRoute({
  generationId,
  serviceClient,
  viewerUserId,
}: {
  generationId: string;
  serviceClient: SupabaseClient;
  viewerUserId: string;
}): Promise<ShowcasePreviewResult> {
  try {
    await enforceBackendRateLimit(serviceClient, {
      ...SHOWCASE_PREVIEW_READ_URL_RATE_LIMIT,
      key: viewerUserId,
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
      body: { error: 'Failed to check preview limits.' },
    };
  }

  const { data, error } = await serviceClient
    .from('generations')
    .select('user_id, output_url, showcase_asset_path, is_public')
    .eq('id', generationId)
    .single();
  const generation = data as PreviewGenerationRow | null;

  if (error || !generation) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Generation not found' },
    };
  }

  if (!generation.is_public) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Generation is private' },
    };
  }

  if (!generation.output_url) {
    return {
      ok: false,
      status: 404,
      body: { error: 'No media available' },
    };
  }

  if (typeof generation.user_id !== 'string' || generation.user_id.length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid media path' },
    };
  }

  if (generation.showcase_asset_path) {
    const showcaseAssetPath = getCanonicalShowcaseAssetPath(
      generation.showcase_asset_path,
      generationId,
    );
    if (!showcaseAssetPath) {
      return {
        ok: false,
        status: 400,
        body: { error: 'Invalid media path' },
      };
    }
    const { data: publicData } = serviceClient.storage
      .from('showcase_media')
      .getPublicUrl(showcaseAssetPath);

    return {
      ok: true,
      body: { url: publicData.publicUrl },
    };
  }

  const location = getUserOwnedStoredMediaLocation(
    generation.output_url,
    generation.user_id,
    { allowedBuckets: GENERATION_MEDIA_BUCKETS },
  );
  if (!location) {
    const remoteUrl = getSafeRemoteMediaUrl(generation.output_url);
    // A canonical Storage URL which failed the exact-owner check must never be
    // reclassified as a provider URL.
    const isStorageLocation = getCanonicalStoredMediaLocation(generation.output_url, {
      allowedBuckets: GENERATION_MEDIA_BUCKETS,
    }) !== null;
    if (!remoteUrl || isStorageLocation) {
      return {
        ok: false,
        status: 400,
        body: { error: 'Invalid media path' },
      };
    }
    return {
      ok: true,
      body: { url: remoteUrl },
    };
  }

  const { data: signedData, error: signError } = await serviceClient.storage
    .from(location.bucket)
    .createSignedUrl(location.filePath, 3600);

  if (signError || !signedData?.signedUrl) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to generate preview URL' },
    };
  }

  return {
    ok: true,
    body: { url: signedData.signedUrl },
  };
}
