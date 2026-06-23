import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  SHOWCASE_PREVIEW_READ_URL_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getStoredMediaLocation } from '@/lib/media-urls';

type PreviewGenerationRow = {
  output_url?: string | null;
  showcase_asset_path?: string | null;
  is_public?: boolean | null;
};

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
    .select('output_url, showcase_asset_path, is_public')
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

  if (generation.showcase_asset_path) {
    const { data: publicData } = serviceClient.storage
      .from('showcase_media')
      .getPublicUrl(generation.showcase_asset_path);

    return {
      ok: true,
      body: { url: publicData.publicUrl },
    };
  }

  if (generation.output_url.startsWith('http')) {
    return {
      ok: true,
      body: { url: generation.output_url },
    };
  }

  const location = getStoredMediaLocation(generation.output_url);
  if (!location) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid media path' },
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
